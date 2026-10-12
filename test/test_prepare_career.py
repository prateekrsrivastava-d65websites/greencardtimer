import copy
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
        self.manifest = {
            "version": 1, "fiscalYear": 2026, "quarter": 3,
            "sourcePage": prepare.SOURCE_PAGE,
            "source": {"url": "https://www.dol.gov//media/LCA_Disclosure_Data_FY2026_Q3.xlsx",
                       "filename": "LCA_Disclosure_Data_FY2026_Q3.xlsx",
                       "sha256": "a" * 64, "bytes": 8},
            "archive": {"url": "https://github.com" + prepare.RELEASE_PREFIX + "fixture/career-fixture.tar.gz",
                        "sha256": "b" * 64},
            "records": 2, "employers": 1,
        }
        self.employer_name = "EXAMPLE EMPLOYER LLC"
        self.employer_id = hashlib.sha256(self.employer_name.encode()).hexdigest()[:16]

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
            "sourcePage": self.manifest["sourcePage"],
            "scope": {"records": self.manifest["records"],
                      "employers": self.manifest["employers"], "limited": False,
                      "visaClass": "H-1B", "statuses": ["Certified"],
                      "filedFrom": "2026-06-01", "filedTo": "2026-06-02",
                      "decisionFrom": "2026-06-08", "decisionTo": "2026-06-09"},
            "sources": [copy.deepcopy(self.manifest["source"])],
            "employerRows": [[self.employer_id, self.employer_name, 2,
                              100000, 100000, ["CA"], "2026-06-02"]],
        }

    def filing_fixture(self, case=1):
        return [f"I-200-26152-00000{case}", "Software Engineer", "15-1252.00",
                "San Francisco", "CA", 100000, None, 90000, "II",
                f"2026-06-0{case}", f"2026-06-0{case + 7}", "2026-09-01",
                True, "New employment", "Certified"]

    def write_index(self, index):
        self.destination.mkdir(exist_ok=True)
        (self.destination / "career-index.json").write_text(json.dumps(index), encoding="utf-8")

    def write_snapshot(self, rows=None, index=None):
        self.write_index(index or self.index_fixture())
        shards = self.destination / "career"
        shards.mkdir(exist_ok=True)
        for prefix in range(256):
            employers = {}
            if f"{prefix:02x}" == self.employer_id[:2]:
                employers[self.employer_id] = {"name": self.employer_name,
                                               "rows": rows or [self.filing_fixture(1), self.filing_fixture(2)]}
            (shards / f"{prefix:02x}.json").write_text(
                json.dumps({"columns": prepare.COLUMNS, "employers": employers}), encoding="utf-8")

    def test_current_manifest_loads_and_relative_working_directory_is_not_required(self):
        manifest = prepare.load_manifest()
        self.assertIs(prepare.validate_manifest(manifest), manifest)
        self.assertGreater(manifest["records"], 0)
        self.assertGreater(manifest["source"]["bytes"], 0)
        self.assertTrue(prepare.DEFAULT_MANIFEST.is_absolute())

    def test_invalid_manifest_primitives_are_rejected(self):
        for key, value in (("version", True), ("fiscalYear", "2026"), ("quarter", 0),
                           ("quarter", True), ("records", 0), ("records", True),
                           ("records", prepare.MAX_RECORDS + 1), ("employers", 3),
                           ("sourcePage", "https://example.com")):
            with self.subTest(key=key, value=value):
                manifest = copy.deepcopy(self.manifest)
                manifest[key] = value
                with self.assertRaises(ValueError):
                    prepare.validate_manifest(manifest)

    def test_source_must_be_official_https_with_matching_fiscal_filename(self):
        for url in ("http://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q3.xlsx",
                    "https://www.dol.gov.example.com/media/LCA_Disclosure_Data_FY2026_Q3.xlsx",
                    "https://www.dol.gov:443/media/LCA_Disclosure_Data_FY2026_Q3.xlsx",
                    "https://user@www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q3.xlsx",
                    "https://www.dol.gov/media/LCA_Disclosure_Data_FY2025_Q3.xlsx",
                    "https://www.dol.gov/media/../LCA_Disclosure_Data_FY2026_Q3.xlsx",
                    "https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q3.xlsx?other=true"):
            with self.subTest(url=url):
                manifest = copy.deepcopy(self.manifest)
                manifest["source"]["url"] = url
                with self.assertRaises(ValueError):
                    prepare.validate_manifest(manifest)

    def test_annual_q4_source_and_normalized_double_slashes_are_supported(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["quarter"] = 4
        manifest["source"]["filename"] = "LCA_Disclosure_Data_FY2026.xlsx"
        manifest["source"]["url"] = "https://dol.gov//media/LCA_Disclosure_Data_FY2026.xlsx"
        self.assertIs(prepare.validate_manifest(manifest), manifest)
        self.assertEqual(prepare.canonical_source_url(manifest["source"]["url"]),
                         "https://www.dol.gov/media/LCA_Disclosure_Data_FY2026.xlsx")

    def test_future_fiscal_year_snapshot_validates_without_changing_test_fixtures(self):
        manifest = copy.deepcopy(self.manifest)
        manifest.update(fiscalYear=2027, quarter=1)
        manifest["source"].update(filename="LCA_Disclosure_Data_FY2027_Q1.xlsx",
                                  url="https://www.dol.gov/media/LCA_Disclosure_Data_FY2027_Q1.xlsx")
        index = self.index_fixture()
        index["sources"] = [copy.deepcopy(manifest["source"])]
        index["scope"].update(filedFrom="2026-10-01", filedTo="2026-10-02",
                               decisionFrom="2026-10-08", decisionTo="2026-10-09")
        rows = [self.filing_fixture(1), self.filing_fixture(2)]
        for row in rows:
            row[9], row[10], row[11] = row[9].replace("-06-", "-10-"), row[10].replace("-06-", "-10-"), "2027-03-01"
        index["employerRows"][0][6] = "2026-10-02"
        self.write_snapshot(rows=rows, index=index)
        prepare.validate_snapshot(self.destination, manifest)
        self.assertEqual(prepare.fiscal_date_range(manifest), ("2026-10-01", "2026-12-31"))

    def test_archive_must_be_pinned_to_configured_repository_and_safe_path(self):
        for url in ("http://github.com" + prepare.RELEASE_PREFIX + "tag/file.tar.gz",
                    "https://github.com/another/repo/releases/download/tag/file.tar.gz",
                    "https://github.com" + prepare.RELEASE_PREFIX + "../tag/file.tar.gz",
                    "https://github.com" + prepare.RELEASE_PREFIX + "tag/file.tar.gz?token=secret",
                    "https://github.com" + prepare.RELEASE_PREFIX + "tag/file.zip"):
            with self.subTest(url=url):
                manifest = copy.deepcopy(self.manifest)
                manifest["archive"]["url"] = url
                with self.assertRaises(ValueError):
                    prepare.validate_manifest(manifest)

    def test_manifest_checksums_and_source_size_are_validated(self):
        for key, value in (("sha256", "0" * 63), ("sha256", "A" * 64),
                           ("filename", []), ("url", None), ("bytes", -1),
                           ("bytes", True), ("bytes", prepare.MAX_SOURCE_BYTES + 1)):
            with self.subTest(key=key, value=value):
                manifest = copy.deepcopy(self.manifest)
                manifest["source"][key] = value
                with self.assertRaises(ValueError):
                    prepare.validate_manifest(manifest)

    def test_matching_checksum_is_accepted(self):
        self.archive.write_bytes(b"tiny checksum fixture")
        self.manifest["archive"]["sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        prepare.verify_archive(self.archive, self.manifest)

    def test_checksum_mismatch_is_rejected(self):
        self.archive.write_bytes(b"not the pinned release")
        with self.assertRaisesRegex(ValueError, "checksum"):
            prepare.verify_archive(self.archive, self.manifest)

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
        for name in ("../escape.json", "public/data/../escape.json", "public/data/career/../00.json"):
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
        cases = [[(prepare.INDEX_PATH, b"{}")], [(name, b"{}") for name in sorted(prepare.SHARD_PATHS)]]
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
        self.write_archive([(prepare.INDEX_PATH, b"{}"), ("public/data/career/00.json", b"{}")])
        with mock.patch.object(prepare, "MAX_TOTAL_BYTES", 3):
            with self.assertRaisesRegex(ValueError, "assets exceed"):
                prepare.extract_snapshot(self.archive, self.destination)

    def test_download_size_limit_rejects_and_removes_partial_archive(self):
        cache = self.root / "cache"
        with mock.patch.object(prepare, "MAX_TOTAL_BYTES", 4):
            with mock.patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(b"12345")):
                with self.assertRaisesRegex(ValueError, "archive exceeds"):
                    prepare.download(cache, self.manifest)
        self.assertEqual(list(cache.iterdir()), [])

    def test_download_cache_is_keyed_by_checksum_not_quarter(self):
        content = b"fixture archive"
        cache = self.root / "cache"
        self.manifest["archive"]["sha256"] = hashlib.sha256(content).hexdigest()
        with mock.patch.object(prepare.urllib.request, "urlopen", return_value=io.BytesIO(content)) as request:
            first = prepare.download(cache, self.manifest)
            second = prepare.download(cache, self.manifest)
        self.assertEqual(first, second)
        self.assertIn(self.manifest["archive"]["sha256"], first.name)
        request.assert_called_once()

    def test_valid_complete_snapshot_is_accepted(self):
        self.write_snapshot()
        prepare.validate_snapshot(self.destination, self.manifest)

    def test_bad_workbook_provenance_is_rejected(self):
        for key, value in (("sha256", "0" * 64), ("filename", "other.xlsx"), ("bytes", 1),
                           ("url", "https://www.dol.gov/media/other.xlsx")):
            with self.subTest(key=key):
                index = self.index_fixture()
                index["sources"][0][key] = value
                self.write_index(index)
                with self.assertRaisesRegex(ValueError, "verified DOL workbook"):
                    prepare.validate_snapshot(self.destination, self.manifest)

    def test_missing_or_multiple_provenance_sources_are_rejected(self):
        for sources in ([], [self.manifest["source"]] * 2):
            with self.subTest(sources=len(sources)):
                index = self.index_fixture()
                index["sources"] = sources
                self.write_index(index)
                with self.assertRaisesRegex(ValueError, "verified DOL workbook"):
                    prepare.validate_snapshot(self.destination, self.manifest)

    def test_bad_index_schema_or_coverage_is_rejected(self):
        for field, value in (("records", 1), ("limited", True), ("visaClass", "H-1B1")):
            with self.subTest(field=field):
                index = self.index_fixture()
                index["scope"][field] = value
                self.write_index(index)
                with self.assertRaisesRegex(ValueError, "schema or published coverage"):
                    prepare.validate_snapshot(self.destination, self.manifest)
        index = self.index_fixture()
        index["columns"] = ["unexpected"]
        self.write_index(index)
        with self.assertRaisesRegex(ValueError, "schema or published coverage"):
            prepare.validate_snapshot(self.destination, self.manifest)

    def test_invalid_normalized_filing_rows_are_rejected(self):
        for column, value in ((0, "arbitrary-id"), (4, "California"), (5, True), (5, 4999),
                              (5, float("nan")), (6, float("inf")), (9, "2026-02-30"),
                              (10, "2026-07-01"), (11, None), (12, "Y"), (14, "Denied")):
            with self.subTest(column=column, value=value):
                rows = [self.filing_fixture(1), self.filing_fixture(2)]
                rows[0][column] = value
                self.write_snapshot(rows=rows)
                with self.assertRaisesRegex(ValueError, "filing row"):
                    prepare.validate_snapshot(self.destination, self.manifest)

    def test_duplicate_case_numbers_are_rejected(self):
        rows = [self.filing_fixture(1), self.filing_fixture(2)]
        rows[1][0] = rows[0][0]
        self.write_snapshot(rows=rows)
        with self.assertRaisesRegex(ValueError, "filing row"):
            prepare.validate_snapshot(self.destination, self.manifest)

    def test_employer_hash_identity_and_stats_are_checked(self):
        for column, value in ((0, "0" * 16), (1, "OTHER EMPLOYER"), (2, True),
                              (3, 0), (4, float("inf")), (5, ["CA", "CA"]), (6, "bad-date")):
            with self.subTest(column=column):
                index = self.index_fixture()
                index["employerRows"][0][column] = value
                self.write_snapshot(index=index)
                with self.assertRaisesRegex(ValueError, "identity or filing count"):
                    prepare.validate_snapshot(self.destination, self.manifest)

    def test_scope_dates_must_match_actual_rows_and_fiscal_quarter(self):
        for field, value in (("decisionTo", "2026-07-01"), ("decisionTo", "2026-06-10"),
                             ("filedFrom", "2026-05-31"), ("decisionFrom", "2025-09-30")):
            with self.subTest(field=field):
                index = self.index_fixture()
                index["scope"][field] = value
                self.write_snapshot(index=index)
                with self.assertRaisesRegex(ValueError, "dates"):
                    prepare.validate_snapshot(self.destination, self.manifest)

    def test_install_failure_restores_last_good_shards_and_index(self):
        existing = self.root / "public-data"
        (existing / "career").mkdir(parents=True)
        (existing / "career" / "old.json").write_text("previous shards")
        (existing / "career-index.json").write_text("previous index")
        self.write_snapshot()
        (self.destination / "career-index.json").unlink()
        with self.assertRaises(FileNotFoundError):
            prepare.install_snapshot(self.destination, existing)
        self.assertEqual((existing / "career" / "old.json").read_text(), "previous shards")
        self.assertEqual((existing / "career-index.json").read_text(), "previous index")


if __name__ == "__main__":
    unittest.main()
