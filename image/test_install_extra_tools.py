"""Offline integrity checks for pinned third-party downloads."""

import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from install_extra_tools import download, verify_local


class DownloadTests(unittest.TestCase):
    def test_sha256_verified(self) -> None:
        payload = b"generic tool fixture"
        source = {
            "url": "https://invalid.example/tool",
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        with patch("install_extra_tools.urlopen", return_value=io.BytesIO(payload)):
            self.assertEqual(download(source), payload)

    def test_git_blob_verified(self) -> None:
        payload = b"word\n"
        source = {
            "url": "https://invalid.example/words",
            "git_blob_sha": hashlib.sha1(b"blob 5\0" + payload).hexdigest(),
        }
        with patch("install_extra_tools.urlopen", return_value=io.BytesIO(payload)):
            self.assertEqual(download(source), payload)

    def test_changed_download_rejected(self) -> None:
        with patch("install_extra_tools.urlopen", return_value=io.BytesIO(b"wrong")):
            with self.assertRaises(ValueError):
                download({"url": "https://invalid.example/tool", "sha256": "0" * 64})

    def test_local_vendor_size_and_hash_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tool.whl"
            path.write_bytes(b"fixture")
            source = {
                "bytes": 7,
                "sha256": hashlib.sha256(b"fixture").hexdigest(),
            }
            self.assertEqual(verify_local(path, source), path)
            source["bytes"] = 8
            with self.assertRaises(ValueError):
                verify_local(path, source)

    def test_pentest_sources_are_versioned_and_content_addressed(self) -> None:
        sources = json.loads((Path(__file__).parent / "sources.json").read_text())
        chisel = sources["chisel"]
        self.assertEqual(chisel["version"], "1.12.0")
        self.assertEqual(chisel["bytes"], 4_724_737)
        self.assertEqual(
            chisel["sha256"],
            "f3f180f1d93aa72cce4e6386f98cc06569a0146fbd65eb4423cf83e6434bcfe6",
        )
        expected = {
            "netexec",
            "python3-impacket",
            "impacket-scripts",
            "proxychains4",
            "smbclient",
            "samba-common-bin",
            "ldap-utils",
            "mariadb-client-core",
            "redis-tools",
            "python3-pymongo",
            "python3-bson",
            "sshpass",
            "rlwrap",
            "tini",
        }
        self.assertEqual(set(sources["apt_tools"]), expected)
        for name, source in sources["apt_tools"].items():
            with self.subTest(name=name):
                self.assertRegex(source["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(source["bytes"], 0)


if __name__ == "__main__":
    unittest.main()
