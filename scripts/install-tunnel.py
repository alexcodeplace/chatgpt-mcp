#!/usr/bin/env python3
"""Install the reviewed release beside existing binaries, never over a running ELF."""
import argparse
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile

VERSION = "0.0.14"
# Official SHA256SUMS.txt for v0.0.14, verified 2026-09-13.
DIGESTS = {
    "linux-amd64": "15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3",
    "linux-arm64": "2de3fb879a18edb847e0313592c912f1983685488290a7fdba7ac403e6a4fb0a",
    "darwin-amd64": "75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53",
    "darwin-arm64": "b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64",
    "windows-amd64": "784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5",
    "windows-arm64": "fa775db8897df543dd4ba66404f69492a2acfbc6a291f10df27aced064a16568",
}


def download(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(256 * 1024 * 1024 + 1)
                if len(data) > 256 * 1024 * 1024:
                    raise ValueError("release archive exceeds download budget")
                return data
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def verify_binary(path):
    proc = subprocess.run([str(path), "--version"], capture_output=True, text=True, timeout=10, check=True)
    if not re.match(r"^" + re.escape(VERSION) + r"(?:\+|\s|$)", proc.stdout.strip()):
        raise ValueError("installed tunnel-client does not match the reviewed version")


def install(destination):
    system = platform.system().lower()
    architecture = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
    target = f"{system}-{architecture}"
    if target not in DIGESTS:
        raise ValueError(f"unsupported platform: {target}")
    suffix = ".exe" if system == "windows" else ""
    binary = destination / ("tunnel-client" + suffix)
    if destination.exists():
        manifest = json.loads((destination / "manifest.json").read_text())
        if manifest.get("archiveSha256") != DIGESTS[target] or manifest.get("version") != VERSION:
            raise ValueError("existing installation identity mismatch; refusing to overwrite it")
        for name, digest in manifest["files"].items():
            if hashlib.sha256((destination / name).read_bytes()).hexdigest() != digest:
                raise ValueError("installed binary checksum mismatch")
        verify_binary(binary)
        return binary
    archive_name = f"tunnel-client-v{VERSION}-{target}.zip"
    archive = download(f"https://github.com/openai/tunnel-client/releases/download/v{VERSION}/{archive_name}")
    if hashlib.sha256(archive).hexdigest() != DIGESTS[target]:
        raise ValueError("release checksum mismatch; refusing installation")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staged = pathlib.Path(tempfile.mkdtemp(prefix=".tunnel-stage-", dir=destination.parent))
    try:
        files = {}
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            for name in ["tunnel-client" + suffix, "cloudflared" + suffix]:
                entries = [entry for entry in bundle.infolist() if pathlib.PurePosixPath(entry.filename).name == name and not entry.is_dir()]
                if len(entries) != 1 or entries[0].file_size > 256 * 1024 * 1024:
                    raise ValueError(f"archive must contain exactly one bounded {name}")
                data = bundle.read(entries[0])
                (staged / name).write_bytes(data)
                (staged / name).chmod(0o755)
                files[name] = hashlib.sha256(data).hexdigest()
        verify_binary(staged / binary.name)
        (staged / "manifest.json").write_text(json.dumps({"version": VERSION, "archive": archive_name, "archiveSha256": DIGESTS[target], "files": files}, indent=2) + "\n")
        os.rename(staged, destination)
        return binary
    finally:
        if staged.exists():
            shutil.rmtree(staged)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=pathlib.Path, default=pathlib.Path.home() / ".local/lib/tunnel-client" / VERSION)
    args = parser.parse_args()
    print(install(args.destination.expanduser().absolute()))
