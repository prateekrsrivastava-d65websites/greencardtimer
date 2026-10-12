import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("refresh_dol", ROOT / "scripts/refresh-dol.py")
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


def fixture(directory, candidate, source_hash="a" * 64, source_bytes=8):
    year, quarter = candidate["fiscalYear"], candidate["quarter"]
    end = [f"{year-1}-12-31", f"{year}-03-31", f"{year}-06-30", f"{year}-09-30"][quarter-1]
    name = "EXAMPLE INC."
    employer_id = hashlib.sha256(name.encode()).hexdigest()[:16]
    row = ["I-200-26001-123456", "Engineer", "15-1252", "Austin", "TX", 100000,
           None, 90000, "II", end, end, f"{year}-12-01", True, "New employment", "Certified"]
    descriptor = {"url": candidate["url"], "filename": candidate["filename"],
                  "sha256": source_hash, "bytes": source_bytes}
    index = {"version": 2, "generatedAt": "2026-10-11T12:00:00Z", "sources": [descriptor],
             "sourcePage": refresh.source.SOURCE_PAGE, "columns": refresh.prepare.COLUMNS,
             "employerColumns": refresh.prepare.EMPLOYER_COLUMNS, "shardPrefixLength": 2,
             "employerRows": [[employer_id, name, 1, 100000, 100000, ["TX"], end]],
             "scope": {"label": f"FY{year}_Q{quarter}", "records": 1, "employers": 1,
                       "sourceRows": 1, "limited": False, "visaClass": "H-1B", "statuses": ["Certified"],
                       "decisionFrom": end, "decisionTo": end, "filedFrom": end, "filedTo": end}}
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "career").mkdir()
    refresh.atomic_json(directory / "career-index.json", index)
    for prefix in range(256):
        refresh.atomic_json(directory / "career" / f"{prefix:02x}.json",
                            {"columns": refresh.prepare.COLUMNS,
                             "employers": {employer_id: {"name": name, "rows": [row]}}
                             if employer_id.startswith(f"{prefix:02x}") else {}})
    return index


class RefreshDOLTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pinned = {"version": 1, "fiscalYear": 2026, "quarter": 3,
                       "sourcePage": refresh.source.SOURCE_PAGE,
                       "source": {"url": "https://www.dol.gov//media/LCA_Disclosure_Data_FY2026_Q3.xlsx",
                                  "filename": "LCA_Disclosure_Data_FY2026_Q3.xlsx", "sha256": "a" * 64, "bytes": 8},
                       "archive": {"url": "https://github.com/" + refresh.REPOSITORY + "/releases/download/fixture/career.tar.gz",
                                   "sha256": "b" * 64}, "records": 400000, "employers": 54000}
        self.candidate = {"fiscalYear": 2026, "quarter": 4,
                          "url": "https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q4.xlsx",
                          "filename": "LCA_Disclosure_Data_FY2026_Q4.xlsx"}
        self.validators = {"etag": '"verified"', "lastModified": "Wed, 07 Oct 2026 12:00:00 GMT", "bytes": 8}
        self.manifest = self.root / "data/career-release.json"
        self.check = self.root / "data/career-source-check.json"
        refresh.atomic_json(self.manifest, self.pinned)
        self.before = self.manifest.read_bytes()

    def setup_run(self, candidate=None, same_hash=False):
        candidate = candidate or self.candidate
        stack = self.enterContext
        stack(patch.object(refresh, "ROOT", self.root))
        stack(patch.object(refresh, "CHECK_PATH", self.check))
        stack(patch.object(refresh.prepare, "DEFAULT_MANIFEST", self.manifest))
        stack(patch.object(refresh.prepare, "load_manifest", return_value=self.pinned))
        stack(patch.object(refresh.source, "fetch_page", return_value="<html></html>"))
        stack(patch.object(refresh.source, "discover_latest", return_value=candidate))
        stack(patch.object(refresh, "probe", return_value=self.validators))
        stack(patch.object(refresh, "MIN_RECORDS", 1))
        stack(patch.object(refresh, "MIN_EMPLOYERS", 1))
        self.pinned["records"] = 1
        self.pinned["employers"] = 1

        def download(url, directory, refresh=True):
            file = directory / candidate["filename"]
            file.write_bytes(b"workbook")
            return file

        self.download = stack(patch.object(refresh.ingest, "download", side_effect=download))
        sha = self.pinned["source"]["sha256"] if same_hash else hashlib.sha256(b"workbook").hexdigest()
        stack(patch.object(refresh.ingest, "file_hash", return_value=sha))

        def run(command, **kwargs):
            data = Path(command[command.index("--output-dir") + 1])
            fixture(data, candidate, sha)
            return subprocess.CompletedProcess(command, 0)

        self.ingestion = stack(patch.object(refresh.subprocess, "run", side_effect=run))
        self.build = stack(patch.object(refresh, "build_candidate"))
        self.publish = stack(patch.object(refresh, "publish"))

    def test_unchanged_check_does_not_download_or_mutate(self):
        candidate = {"fiscalYear": 2026, "quarter": 3,
                     "url": refresh.source.canonical_dol_url(self.pinned["source"]["url"]),
                     "filename": self.pinned["source"]["filename"]}
        self.setup_run(candidate)
        refresh.atomic_json(self.check, {"url": candidate["url"], "sourceSha256": self.pinned["source"]["sha256"],
                                        "validators": self.validators})
        self.assertEqual(refresh.refresh(True)["status"], "unchanged")
        self.download.assert_not_called()
        self.publish.assert_not_called()
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_new_quarter_builds_and_publishes_before_pin_changes(self):
        self.setup_run()
        def verify_old_pin(archive, manifest):
            self.assertEqual(self.manifest.read_bytes(), self.before)
            refresh.prepare.verify_archive(archive, manifest)
        self.publish.side_effect = verify_old_pin
        self.assertEqual(refresh.refresh(True)["status"], "updated")
        result = json.loads(self.manifest.read_text())
        self.assertEqual(result["quarter"], 4)
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(b"workbook").hexdigest())
        self.build.assert_called_once()
        self.publish.assert_called_once()

    def test_dry_run_never_publishes_or_changes_pin(self):
        self.setup_run()
        self.assertIn("dry run", refresh.refresh()["status"])
        self.publish.assert_not_called()
        self.assertFalse(self.check.exists())
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_download_failure_preserves_old_pin(self):
        self.setup_run()
        self.download.side_effect = RuntimeError("upstream unavailable")
        with self.assertRaises(RuntimeError):
            refresh.refresh(True)
        self.assertEqual(self.manifest.read_bytes(), self.before)
        self.publish.assert_not_called()

    def test_build_failure_preserves_old_pin(self):
        self.setup_run()
        self.build.side_effect = RuntimeError("candidate build failed")
        with self.assertRaises(RuntimeError):
            refresh.refresh(True)
        self.publish.assert_not_called()
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_publish_failure_preserves_old_pin(self):
        self.setup_run()
        self.publish.side_effect = RuntimeError("asset unavailable")
        with self.assertRaises(RuntimeError):
            refresh.refresh(True)
        self.assertEqual(self.manifest.read_bytes(), self.before)
        self.assertFalse(self.check.exists())

    def test_same_source_baseline_verifies_checksum_without_reingestion(self):
        candidate = {"fiscalYear": 2026, "quarter": 3,
                     "url": refresh.source.canonical_dol_url(self.pinned["source"]["url"]),
                     "filename": self.pinned["source"]["filename"]}
        self.setup_run(candidate, same_hash=True)
        self.assertIn("checksum verified", refresh.refresh(True)["status"])
        self.ingestion.assert_not_called()
        self.assertEqual(json.loads(self.check.read_text())["sourceSha256"], self.pinned["source"]["sha256"])
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_same_quarter_changed_validator_needs_download(self):
        candidate = {"fiscalYear": 2026, "quarter": 3, "url": self.pinned["source"]["url"]}
        check = {"url": candidate["url"], "sourceSha256": self.pinned["source"]["sha256"],
                 "validators": {**self.validators, "etag": "older"}}
        self.assertFalse(refresh.unchanged(candidate, self.pinned, check, self.validators))

    def test_missing_validators_cannot_hide_same_size_corrections(self):
        candidate = {"fiscalYear": 2026, "quarter": 3, "url": self.pinned["source"]["url"]}
        validators = {"etag": None, "lastModified": None, "bytes": 8}
        check = {"url": candidate["url"], "sourceSha256": self.pinned["source"]["sha256"], "validators": validators}
        self.assertFalse(refresh.unchanged(candidate, self.pinned, check, validators))

    def test_moved_source_does_not_repeat_downloads_after_hash_verification(self):
        candidate = {"fiscalYear": 2026, "quarter": 3,
                     "url": "https://www.dol.gov/another/LCA_Disclosure_Data_FY2026_Q3.xlsx"}
        check = {"url": candidate["url"], "sourceSha256": self.pinned["source"]["sha256"], "validators": self.validators}
        self.assertTrue(refresh.unchanged(candidate, self.pinned, check, self.validators))

    def test_next_fiscal_year_candidate_passes_entire_validation_path(self):
        candidate = {"fiscalYear": 2027, "quarter": 1,
                     "url": "https://www.dol.gov/media/LCA_Disclosure_Data_FY2027_Q1.xlsx",
                     "filename": "LCA_Disclosure_Data_FY2027_Q1.xlsx"}
        self.setup_run(candidate)
        self.assertEqual(refresh.refresh(True)["status"], "updated")
        self.assertEqual(json.loads(self.manifest.read_text())["fiscalYear"], 2027)

    def test_changing_source_during_download_preserves_pin(self):
        self.setup_run()
        refresh.probe.side_effect = [self.validators, {**self.validators, "etag": "changed"}]
        with self.assertRaisesRegex(ValueError, "changed during"):
            refresh.refresh(True)
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_cumulative_loss_fails_but_new_fiscal_year_can_be_smaller(self):
        index = {"scope": {"records": 10000, "employers": 100, "sourceRows": 11000,
                            "decisionFrom": "2026-10-01", "decisionTo": "2026-12-31"}}
        with self.assertRaisesRegex(ValueError, "fell"):
            refresh.validate_coverage(index, {"fiscalYear": 2026, "quarter": 4}, self.pinned)
        refresh.validate_coverage(index, {"fiscalYear": 2027, "quarter": 1}, self.pinned)

    def test_date_in_wrong_quarter_or_partial_quarter_fails(self):
        index = {"scope": {"records": 400000, "employers": 54000, "sourceRows": 450000,
                            "decisionFrom": "2025-10-01", "decisionTo": "2026-06-30"}}
        with self.assertRaisesRegex(ValueError, "latest quarter"):
            refresh.validate_coverage(index, self.candidate, self.pinned)
        index["scope"]["decisionTo"] = "2026-10-01"
        with self.assertRaisesRegex(ValueError, "outside"):
            refresh.validate_coverage(index, self.candidate, self.pinned)

    def test_archive_round_trip_and_determinism(self):
        directory = self.root / "snapshot"
        fixture(directory, self.candidate)
        first, second = self.root / "first.tar.gz", self.root / "second.tar.gz"
        self.assertEqual(refresh.pack_snapshot(directory, first), refresh.pack_snapshot(directory, second))
        extracted = self.root / "extracted"
        extracted.mkdir()
        refresh.prepare.extract_snapshot(first, extracted)
        self.assertEqual((extracted / "career-index.json").read_bytes(), (directory / "career-index.json").read_bytes())

    def test_head_not_supported_still_allows_quarter_detection(self):
        with patch.object(refresh.source, "open_dol_url", side_effect=urllib.error.HTTPError("url", 405, "method", {}, None)):
            self.assertEqual(refresh.probe("https://www.dol.gov/"), {"etag": None, "lastModified": None, "bytes": None})

    def test_publication_recovers_uncertain_upload_only_after_exact_download_verification(self):
        archive = self.root / "upload.tar.gz"
        archive.write_bytes(b"verified release bytes")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.pinned["archive"] = {"url": "https://github.com/" + refresh.REPOSITORY +
                                 "/releases/download/immutable-fixture/career.tar.gz", "sha256": digest}
        with patch.object(refresh.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as command:
            with patch.object(refresh.prepare, "download", return_value=archive.with_name("career.tar.gz")):
                refresh.publish(archive, self.pinned)
            arguments = command.call_args.args[0]
            self.assertIn("--latest=false", arguments)
            self.assertNotIn("--clobber", arguments)
            self.assertEqual(arguments[3], "immutable-fixture")

    def test_unverified_public_asset_cannot_be_promoted(self):
        archive = self.root / "upload.tar.gz"
        archive.write_bytes(b"release bytes")
        with patch.object(refresh.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            with patch.object(refresh.prepare, "download", return_value=archive.with_name("career-fy2026-q3.tar.gz")):
                with self.assertRaisesRegex(RuntimeError, "old pin retained"):
                    refresh.publish(archive, self.pinned)

    def test_isolated_build_keeps_live_data_and_private_files_out(self):
        source_root = self.root / "repo"
        (source_root / "node_modules").mkdir(parents=True)
        refresh.atomic_json(source_root / "public/data/career-index.json", {"live": True})
        (source_root / "public/data/career").mkdir()
        (source_root / ".env").write_text("private test value")
        directory = self.root / "candidate"
        fixture(directory, self.candidate)
        workspace = self.root / "build"
        with patch.object(refresh, "ROOT", source_root):
            with patch.object(refresh.subprocess, "run") as command:
                refresh.build_candidate(directory, self.pinned, workspace)
        self.assertEqual(command.call_count, 2)
        self.assertFalse((workspace / ".env").exists())
        self.assertTrue((workspace / "node_modules").is_symlink())
        self.assertEqual(json.loads((source_root / "public/data/career-index.json").read_text()), {"live": True})
        self.assertEqual(len(list((workspace / "public/data/career").glob("*.json"))), 256)


if __name__ == "__main__":
    unittest.main()
