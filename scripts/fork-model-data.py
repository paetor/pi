#!/usr/bin/env python3
"""Hydrate only verified JSON model data from the matching public release archive."""
import hashlib
import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

LIMIT = 64 * 1024 * 1024


def extract_data(blob, version, expected_sha):
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("Invalid model-data release version")
    if len(blob) > LIMIT or hashlib.sha256(blob).hexdigest() != expected_sha:
        raise ValueError("Release source archive digest mismatch")
    prefix = f"pi-{version}/packages/ai/src/providers/data/"
    package_path = f"pi-{version}/packages/ai/package.json"
    contents, package, total = {}, None, 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        for member in archive:
            if member.name == package_path:
                if not member.isfile() or member.size > 1024 * 1024 or package is not None:
                    raise ValueError("Invalid archive package metadata")
                package = json.load(archive.extractfile(member))
            if not member.name.startswith(prefix) or member.name == prefix:
                continue
            name = member.name[len(prefix):]
            if not member.isfile() or not re.fullmatch(r"(?:[a-z0-9-]+|\.manifest)\.json", name) or name in contents:
                raise ValueError("Unsafe or duplicate model-data member")
            total += member.size
            if member.size > 16 * 1024 * 1024 or total > LIMIT or len(contents) >= 1000:
                raise ValueError("Model-data size bound exceeded")
            contents[name] = archive.extractfile(member).read()
    if not package or package.get("version") != version or ".manifest.json" not in contents:
        raise ValueError("Model-data release identity missing")
    manifest = json.loads(contents[".manifest.json"])
    files = manifest["files"]
    if set(files) != set(contents) - {".manifest.json"}:
        raise ValueError("Model-data manifest file set mismatch")
    for name, digest in files.items():
        if hashlib.sha256(contents[name]).hexdigest() != digest:
            raise ValueError("Model-data manifest digest mismatch")
        json.loads(contents[name])
    return contents


def main():
    root = Path(__file__).resolve().parent.parent
    policy = json.loads((root / ".github/fork-policy.json").read_text())
    pin = policy["modelDataSource"]
    version = policy["upstreamVersion"]
    if pin["version"] != version or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version) or not re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]):
        raise ValueError("Model-data pin does not match integrated upstream")
    # Only public JSON data is installed; no archive code is extracted or executed.
    url = f"https://github.com/earendil-works/pi/releases/download/v{version}/pi-{version}-source.tar.gz"
    with urllib.request.urlopen(url, timeout=60) as response:
        blob = response.read(LIMIT + 1)
    contents = extract_data(blob, version, pin["sha256"])
    target = root / "packages/ai/src/providers/data"
    if target.is_symlink():
        raise ValueError("Symlinked model-data directory")
    target.mkdir(parents=True, exist_ok=True)
    for name, body in contents.items():
        path = target / name
        if path.is_symlink():
            raise ValueError("Symlinked model-data file")
        path.write_bytes(body)
    print(f"Hydrated {len(contents)} verified model-data files from Pi {version} source {pin['sha256']}")


if __name__ == "__main__":
    main()
