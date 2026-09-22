#!/usr/bin/env python3
"""Own one router lifetime and reclaim only a proven stale private Unix socket."""
import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import socket
import stat
import sys

sys.dont_write_bytecode = True


def private_file(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('router configuration must be an owned private regular file')
    return path


def claim(settings_path):
    settings_path = private_file(settings_path)
    settings = json.loads(settings_path.read_text())
    socket_path = Path(settings['controlSocket'])
    registry = Path(settings['statePath'])
    if not socket_path.is_absolute() or not registry.is_absolute() or socket_path.parent != registry.parent:
        raise ValueError('router registry and control socket must share a private directory')
    directory = socket_path.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('router state directory must be owned and private')
    fd = os.open(directory / 'router.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lock_info = os.fstat(fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid() or lock_info.st_mode & 0o077:
            raise ValueError('unsafe router lifetime lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            info = socket_path.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError('refusing to replace a non-owned router socket')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(1)
                try:
                    client.connect(str(socket_path))
                except OSError as error:
                    if error.errno != errno.ECONNREFUSED:
                        raise ValueError('cannot prove that the previous router socket is stale') from None
                else:
                    raise ValueError('a live controller owns this socket without the lifetime lock')
            current = socket_path.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError('router socket changed while proving staleness')
            socket_path.unlink()
        os.set_inheritable(fd, True)
        return fd, settings
    except BaseException:
        os.close(fd)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--entry', type=Path, required=True)
    args = parser.parse_args()
    node = args.node.resolve(strict=True)
    entry = args.entry.resolve(strict=True)
    if not node.is_file() or not entry.is_file() or entry.name != 'main.js' or entry.parent.name != 'hotswap':
        raise ValueError('expected a pinned Node executable and compiled router entrypoint')
    fd, _ = claim(args.settings)
    try:
        os.execv(str(node), [str(node), str(entry), str(args.settings.resolve())])
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError):
        print('ROUTER_LIFETIME_START_REFUSED', file=sys.stderr)
        raise SystemExit(78)
