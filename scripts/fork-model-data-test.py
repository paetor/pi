import hashlib
import io
import json
from pathlib import Path
import runpy
import tarfile
import unittest

extract_data = runpy.run_path(str(Path(__file__).with_name("fork-model-data.py")))["extract_data"]
VERSION = "1.1.0"
PREFIX = f"pi-{VERSION}/packages/ai/src/providers/data/"


def fixture(extra=None, digest_override=None):
    data = b'{"fixture":true}'
    manifest = json.dumps({"files": {"anthropic.json": digest_override or hashlib.sha256(data).hexdigest()}}).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, body in [(f"pi-{VERSION}/packages/ai/package.json", json.dumps({"version": VERSION}).encode()), (PREFIX + "anthropic.json", data), (PREFIX + ".manifest.json", manifest)]:
            member = tarfile.TarInfo(name); member.size = len(body); archive.addfile(member, io.BytesIO(body))
        if extra:
            member = tarfile.TarInfo(PREFIX + extra)
            if extra == "link.json": member.type = tarfile.SYMTYPE; member.linkname = "/fixture/not-readable"
            archive.addfile(member, io.BytesIO())
    blob = output.getvalue()
    return blob, hashlib.sha256(blob).hexdigest()


class Checks(unittest.TestCase):
    def test_exact_archive_and_inner_manifest(self):
        blob, digest = fixture()
        self.assertEqual(set(extract_data(blob, VERSION, digest)), {"anthropic.json", ".manifest.json"})

    def test_changed_archive_and_wrong_version_fail(self):
        blob, digest = fixture()
        with self.assertRaisesRegex(ValueError, "archive digest"):
            extract_data(blob + b"changed", VERSION, digest)
        with self.assertRaisesRegex(ValueError, "identity missing"):
            extract_data(blob, "1.1.1", digest)

    def test_traversal_links_and_duplicates_fail_without_extraction(self):
        for name in ["../escape.json", "link.json", "anthropic.json", "nested/file.json"]:
            with self.subTest(name=name):
                blob, digest = fixture(name)
                with self.assertRaisesRegex(ValueError, "Unsafe or duplicate"):
                    extract_data(blob, VERSION, digest)

    def test_inner_corruption_and_extra_files_fail(self):
        blob, digest = fixture(digest_override="0" * 64)
        with self.assertRaisesRegex(ValueError, "manifest digest"):
            extract_data(blob, VERSION, digest)
        blob, digest = fixture("unlisted.json")
        with self.assertRaisesRegex(ValueError, "file set mismatch"):
            extract_data(blob, VERSION, digest)


if __name__ == "__main__": unittest.main()
