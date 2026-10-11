import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare-career.py"
SPEC = importlib.util.spec_from_file_location("prepare_career", SCRIPT)
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class PrepareCareerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.archive = self.root / "fixture.tar.gz"
        self.destination = self.root / "snapshot"

    def write_archive(self, entries):
        with tarfile.open(self.archive, "w:gz") as bundle:
            for entry in entries:
                if isinstance(entry, tarfile.TarInfo):
                    bundle.addfile(entry)
                else:
                    name, contents = entry
                    member = tarfile.TarInfo(name)
                    member.size = len(contents)
                    bundle.addfile(member, io.BytesIO(contents))
        return self.archive

    def index_fixture(self):
        return {
            "version": 2, "columns": prepare.COLUMNS,
            "employerColumns": prepare.EMPLOYER_COLUMNS, "shardPrefixLength": 2,
            "scope": {"records": prepare.EXPECTED_RECORDS,
                      "employers": prepare.EXPECTED_EMPLOYERS, "limited": False,
                      "visaClass": "H-1B", "statuses": ["Certified"]},
            "sources": [{"sha256": prepare.WORKBOOK_SHA256}], "employerRows": [],
        }

    def write_index(self, index):
        self.destination.mkdir(exist_ok=True)
        (self.destination / "career-index.json").write_text(json.dumps(index), encoding="utf-8")

    def test_matching_checksum_is_accepted(self):
        self.archive.write_bytes(b"tiny checksum fixture")
        digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with mock.patch.object(prepare, "ARCHIVE_SHA256", digest):
            prepare.verify_archive(self.archive)

    def test_checksum_mismatch_is_rejected(self):
        self.archive.write_bytes(b"not the pinned release")
        with self.assertRaisesRegex(ValueError, "checksum"):
            prepare.verify_archive(self.archive)

    def test_complete_tiny_archive_extracts_only_known_files(self):
        entries = [(prepare.INDEX_PATH, b"{}")]
        entries.extend((name, b"{}") for name in sorted(prepare.SHARD_PATHS))
        directory = tarfile.TarInfo("public/data/career/")
        directory.type = tarfile.DIRTYPE
        entries.insert(0, directory)
        self.write_archive(entries)
        self.assertEqual(prepare.extract_snapshot(self.archive, self.destination), 514)
        self.assertEqual(len(list((self.destination / "career").glob("*.json"))), 256)

    def test_path_traversal_is_rejected_without_writing_outside_staging(self):
        for name in ("../escape.json", "public/data/../escape.json",
                     "public/data/career/../00.json"):
            with self.subTest(path=name):
                self.write_archive([(name, b"{}")])
                with self.assertRaisesRegex(ValueError, "unsafe archive entry"):
                    prepare.extract_snapshot(self.archive, self.destination)
        self.assertFalse((self.root / "escape.json").exists())

    def test_symbolic_and_hard_links_are_rejected(self):
        for link_type in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            with self.subTest(link_type=link_type):
                member = tarfile.TarInfo(prepare.INDEX_PATH)
                member.type = link_type
                member.linkname = "/tmp/outside-fixture"
                self.write_archive([member])
                with self.assertRaisesRegex(ValueError, "unsafe archive entry"):
                    prepare.extract_snapshot(self.archive, self.destination)

    def test_unexpected_paths_are_rejected(self):
        for name in ("public/data/other.json", "/public/data/career-index.json",
                     "public/data/career/gg.json", "public/data/career/00.json/extra"):
            with self.subTest(path=name):
                self.write_archive([(name, b"{}")])
                with self.assertRaisesRegex(ValueError, "unsafe archive entry"):
                    prepare.extract_snapshot(self.archive, self.destination)

    def test_duplicate_entries_are_rejected(self):
        self.write_archive([(prepare.INDEX_PATH, b"{}"), (prepare.INDEX_PATH, b"{}")])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            prepare.extract_snapshot(self.archive, self.destination)

    def test_missing_index_or_shards_are_rejected(self):
        cases = [[(prepare.INDEX_PATH, b"{}")],
                 [(name, b"{}") for name in sorted(prepare.SHARD_PATHS)]]
        for entries in cases:
            with self.subTest(entries=len(entries)):
                self.write_archive(entries)
                with self.assertRaisesRegex(ValueError, "missing its index"):
                    prepare.extract_snapshot(self.archive, self.destination)

    def test_oversized_member_is_rejected_with_a_tiny_fixture(self):
        self.write_archive([(prepare.INDEX_PATH, b"12345")])
        with mock.patch.object(prepare, "MAX_FILE_BYTES", 4):
            with self.assertRaisesRegex(ValueError, "asset exceeds size"):
                prepare.extract_snapshot(self.archive, self.destination)

    def test_total_extracted_size_is_bounded(self):
        self.write_archive([(prepare.INDEX_PATH, b"{}"),
                            ("public/data/career/00.json", b"{}")])
        with mock.patch.object(prepare, "MAX_TOTAL_BYTES", 3):
            with self.assertRaisesRegex(ValueError, "assets exceed"):
                prepare.extract_snapshot(self.archive, self.destination)

    def test_download_size_limit_rejects_and_removes_partial_archive(self):
        cache = self.root / "cache"
        with mock.patch.object(prepare, "MAX_TOTAL_BYTES", 4):
            with mock.patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(b"12345")):
                with self.assertRaisesRegex(ValueError, "archive exceeds"):
                    prepare.download(cache)
        self.assertEqual(list(cache.iterdir()), [])

    def test_bad_workbook_provenance_is_rejected(self):
        index = self.index_fixture()
        index["sources"] = [{"sha256": "0" * 64}]
        self.write_index(index)
        with self.assertRaisesRegex(ValueError, "verified DOL workbook"):
            prepare.validate_snapshot(self.destination)

    def test_missing_or_multiple_provenance_sources_are_rejected(self):
        for sources in ([], [{"sha256": prepare.WORKBOOK_SHA256}] * 2):
            with self.subTest(sources=len(sources)):
                index = self.index_fixture()
                index["sources"] = sources
                self.write_index(index)
                with self.assertRaisesRegex(ValueError, "verified DOL workbook"):
                    prepare.validate_snapshot(self.destination)

    def test_bad_index_schema_or_coverage_is_rejected(self):
        for field, value in (("records", 1), ("limited", True), ("visaClass", "H-1B1")):
            with self.subTest(field=field):
                index = self.index_fixture()
                index["scope"][field] = value
                self.write_index(index)
                with self.assertRaisesRegex(ValueError, "schema or published coverage"):
                    prepare.validate_snapshot(self.destination)
        index = self.index_fixture()
        index["columns"] = ["unexpected"]
        self.write_index(index)
        with self.assertRaisesRegex(ValueError, "schema or published coverage"):
            prepare.validate_snapshot(self.destination)


if __name__ == "__main__":
    unittest.main()
