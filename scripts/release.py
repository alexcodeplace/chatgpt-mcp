#!/usr/bin/env python3
"""Package and verify immutable MCP runtimes. Configuration and credentials are excluded."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys

sys.dont_write_bytecode = True
ALLOWED = ['dist/src', 'src', 'scripts', 'docs', 'node_modules', 'package.json', 'pnpm-lock.yaml',
           'config.example.json', 'config.full.example.json', 'README.md', 'SPEC.md']


def inventory(root):
    records = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name == 'release-manifest.json':
            continue
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target) or not path.resolve().is_relative_to(root.resolve()):
                raise ValueError(f'release symlink escapes its directory: {name}')
            records[name] = {'symlink': target}
        elif path.is_file():
            records[name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
    return records


def verify(root):
    manifest = json.loads((root / 'release-manifest.json').read_text())
    if manifest.get('schemaVersion') != 1 or not re.fullmatch(r'[a-f0-9]{40}', manifest.get('revision', '')):
        raise ValueError('invalid release identity')
    actual = inventory(root)
    if actual != manifest['files']:
        changed = sorted(name for name in set(actual) | set(manifest['files']) if actual.get(name) != manifest['files'].get(name))
        raise ValueError('release content mismatch: ' + ', '.join(changed[:10]))
    if not (root / 'dist/src/http.js').is_file():
        raise ValueError('release has no HTTP entrypoint')
    return manifest


def pack(source, destination, revision):
    if not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('a full source commit is required')
    if destination.exists():
        raise ValueError('release destination already exists; refusing to overwrite it')
    destination.mkdir(parents=True)
    try:
        for name in ALLOWED:
            path = source / name
            if not path.exists():
                raise ValueError(f'missing release input: {name}')
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir():
                shutil.copytree(path, target, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            else:
                shutil.copy2(path, target)
        files = inventory(destination)
        manifest = {'schemaVersion': 1, 'revision': revision, 'lockSha256': hashlib.sha256((source / 'pnpm-lock.yaml').read_bytes()).hexdigest(), 'tunnelVersion': '0.0.14', 'files': files}
        (destination / 'release-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
        verify(destination)
        for path in destination.rglob('*'):
            if path.is_symlink():
                continue
            path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
        destination.chmod(0o555)
        return manifest
    except Exception:
        # Preserve a failed staging directory for inspection, never touch another release.
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('pack')
    command.add_argument('--source', type=pathlib.Path, required=True)
    command.add_argument('--destination', type=pathlib.Path, required=True)
    command.add_argument('--revision', required=True)
    command = commands.add_parser('verify')
    command.add_argument('directory', type=pathlib.Path)
    args = parser.parse_args()
    result = verify(args.directory.resolve()) if args.command == 'verify' else pack(args.source.resolve(), args.destination.resolve(), args.revision)
    print(json.dumps({'revision': result['revision'], 'files': len(result['files']), 'lockSha256': result['lockSha256'], 'verified': True}))
