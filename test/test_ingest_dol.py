from contextlib import redirect_stdout
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import warnings
import xml.etree.ElementTree as ET
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ingest-dol.py"
SPEC = importlib.util.spec_from_file_location("ingest_dol", SCRIPT)
ingest = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ingest)
SOURCE_URL = "https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q3.xlsx"


def column_name(index):
    name = ""
    while index:
        index, digit = divmod(index - 1, 26)
        name = chr(65 + digit) + name
    return name


def raw_row(case="I-200-26001-000001", **changes):
    row = {field: "" for field in ingest.FIELDS}
    row.update({"CASE_NUMBER": case, "CASE_STATUS": "Certified", "VISA_CLASS": "H-1B",
                "EMPLOYER_NAME": "Example Employer", "JOB_TITLE": "Engineer",
                "SOC_CODE": "15-1252", "FULL_TIME_POSITION": "Y",
                "RECEIVED_DATE": "10/01/2025", "DECISION_DATE": "10/08/2025",
                "BEGIN_DATE": "04/01/2026", "WAGE_RATE_OF_PAY_FROM": "120000",
                "WAGE_UNIT_OF_PAY": "Year", "PREVAILING_WAGE": "105000",
                "PW_UNIT_OF_PAY": "Year", "PW_WAGE_LEVEL": "II",
                "WORKSITE_CITY": "Seattle", "WORKSITE_STATE": "WA",
                "NAICS_CODE": "541511", "NEW_EMPLOYMENT": "1"})
    row.update(changes)
    return row


def write_xlsx(path, rows=None, headers=None, duplicate_entry=False, omit_workbook=False):
    headers = list(sorted(ingest.FIELDS)) if headers is None else headers
    sheet = ET.Element(ingest.NS + "worksheet")
    data = ET.SubElement(sheet, ingest.NS + "sheetData")
    values = [headers] + [[row.get(header, "") for header in headers] for row in (rows or [])]
    for row_number, row_values in enumerate(values, 1):
        row_element = ET.SubElement(data, ingest.NS + "row", r=str(row_number))
        for column, value in enumerate(row_values, 1):
            cell = ET.SubElement(row_element, ingest.NS + "c",
                                 r=f"{column_name(column)}{row_number}", t="inlineStr")
            inline = ET.SubElement(cell, ingest.NS + "is")
            ET.SubElement(inline, ingest.NS + "t").text = str(value)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        if not omit_workbook:
            archive.writestr("xl/workbook.xml", f'<workbook xmlns="{ingest.NS[1:-1]}"/>')
        archive.writestr("xl/worksheets/sheet1.xml", ET.tostring(sheet, encoding="utf-8"))
        if duplicate_entry:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr("xl/workbook.xml", "duplicate")
    return path


class DownloadResponse(io.BytesIO):
    def __init__(self, body, declared_length=None, url=SOURCE_URL):
        super().__init__(body)
        self.url = url
        self.headers = Message()
        if declared_length is not None:
            self.headers["Content-Length"] = str(declared_length)

    def geturl(self):
        return self.url


class IngestDOLTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workbook = self.root / "source.xlsx"
        self.cache = self.root / "cache"

    def test_all_required_columns_are_read(self):
        expected = raw_row()
        write_xlsx(self.workbook, [expected])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(list(ingest.disclosure_rows(self.workbook)), [expected])

    def test_missing_critical_column_fails_instead_of_dropping_every_record(self):
        for missing in ("WAGE_UNIT_OF_PAY", "DECISION_DATE", "WORKSITE_STATE", "CHANGE_EMPLOYER"):
            with self.subTest(missing=missing):
                headers = sorted(ingest.FIELDS - {missing})
                write_xlsx(self.workbook, [raw_row()], headers=headers)
                with self.assertRaisesRegex(ValueError, f"missing.*{missing}"):
                    list(ingest.disclosure_rows(self.workbook))

    def test_duplicate_critical_header_is_rejected(self):
        write_xlsx(self.workbook, [raw_row()], headers=sorted(ingest.FIELDS) + ["CASE_NUMBER"])
        with self.assertRaisesRegex(ValueError, "duplicate header"):
            list(ingest.disclosure_rows(self.workbook))

    def test_no_disclosure_header_is_rejected(self):
        write_xlsx(self.workbook, headers=["A different DOL workbook"])
        with self.assertRaisesRegex(ValueError, "no disclosure header"):
            list(ingest.disclosure_rows(self.workbook))

    def test_duplicate_zip_entries_are_rejected(self):
        write_xlsx(self.workbook, [raw_row()], duplicate_entry=True)
        with self.assertRaisesRegex(ValueError, "duplicate ZIP"):
            list(ingest.disclosure_rows(self.workbook))

    def test_zip_entry_count_limit_is_checked_before_xml(self):
        write_xlsx(self.workbook, [raw_row()])
        with mock.patch.object(ingest, "MAX_ZIP_ENTRIES", 2):
            with self.assertRaisesRegex(ValueError, "ZIP entry limit"):
                list(ingest.disclosure_rows(self.workbook))

    def test_uncompressed_size_limit_is_checked_before_xml(self):
        write_xlsx(self.workbook, [raw_row()])
        with mock.patch.object(ingest, "MAX_XLSX_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "uncompressed size limit"):
                list(ingest.disclosure_rows(self.workbook))

    def test_generic_zip_is_not_accepted_as_xlsx(self):
        write_xlsx(self.workbook, [raw_row()], omit_workbook=True)
        with self.assertRaisesRegex(ValueError, "valid XLSX"):
            ingest.validate_workbook(self.workbook)

    def test_source_row_limit_includes_rows_without_case_numbers(self):
        write_xlsx(self.workbook, [raw_row(), raw_row(case=""), raw_row(case="")])
        with mock.patch.object(ingest, "MAX_SOURCE_ROWS", 2), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "source row limit"):
                list(ingest.disclosure_rows(self.workbook))

    def test_normalization_preserves_certified_h1b_filter_and_compact_schema(self):
        result = ingest.normalize(raw_row(EMPLOYER_NAME="  Example   Employer "))
        self.assertEqual(result[0], "EXAMPLE EMPLOYER")
        self.assertEqual(result[1][5], 120000)
        self.assertEqual(result[1][9:13], ["2025-10-01", "2025-10-08", "2026-04-01", True])
        self.assertEqual(result[1][13:], ["New employment", "Certified"])
        self.assertEqual(len(result[1]), len(ingest.COLUMNS))
        for changes in ({"CASE_STATUS": "Denied"}, {"VISA_CLASS": "E-3"},
                        {"WAGE_UNIT_OF_PAY": "Unknown"}, {"WAGE_RATE_OF_PAY_FROM": "nan"},
                        {"WAGE_RATE_OF_PAY_FROM": "1"}, {"EMPLOYER_NAME": ""}):
            with self.subTest(changes=changes):
                self.assertIsNone(ingest.normalize(raw_row(**changes)))

    def test_annualization_and_excel_dates_are_unchanged(self):
        self.assertEqual(ingest.annual_wage("$50.00", "Hour"), 104000)
        self.assertEqual(ingest.annual_wage("2,000", "Bi-Weekly"), 52000)
        self.assertEqual(ingest.iso_date("45931"), "2025-10-01")

    def test_unknown_full_time_flag_is_not_mislabeled_as_part_time(self):
        self.assertFalse(ingest.normalize(raw_row(FULL_TIME_POSITION="N"))[1][12])
        for flag in ("", "Unknown", "X", None):
            with self.subTest(flag=flag), self.assertRaisesRegex(ValueError, "FULL_TIME_POSITION"):
                ingest.normalize(raw_row(FULL_TIME_POSITION=flag))
        self.assertIsNone(ingest.normalize(raw_row(CASE_STATUS="Denied", FULL_TIME_POSITION="")))

    def test_default_source_follows_manifest_not_a_hardcoded_quarter(self):
        manifest = self.root / "release.json"
        manifest.write_text(json.dumps({"source": {"url": "https://www.dol.gov//media/LCA_Disclosure_Data_FY2027_Q1.xlsx"}}))
        self.assertEqual(ingest.default_source(manifest),
                         "https://www.dol.gov/media/LCA_Disclosure_Data_FY2027_Q1.xlsx")

    def test_complete_cli_emits_every_shard_with_current_filter_and_deduplication(self):
        rows = [raw_row(), raw_row(case="I-200-26002-000002", CASE_STATUS="Denied"),
                raw_row(case="I-200-26003-000003", VISA_CLASS="E-3"),
                raw_row(case="I-200-26004-000004", WAGE_RATE_OF_PAY_FROM="1"),
                raw_row(DECISION_DATE="10/09/2025", WAGE_RATE_OF_PAY_FROM="130000")]
        write_xlsx(self.workbook, rows)
        output = self.root / "public" / "data"
        arguments = [str(SCRIPT), "--source", SOURCE_URL, "--archive-dir", str(self.cache),
                     "--output-dir", str(output)]
        with mock.patch.object(ingest, "download", return_value=self.workbook), \
                mock.patch("sys.argv", arguments), redirect_stdout(io.StringIO()):
            ingest.main()
        index = json.loads((output / "career-index.json").read_text())
        self.assertEqual(index["scope"]["records"], 1)
        self.assertEqual(index["scope"]["employers"], 1)
        self.assertEqual(index["scope"]["sourceRows"], 5)
        shards = sorted((output / "career").glob("*.json"))
        self.assertEqual(len(shards), 256)
        self.assertEqual([path.stem for path in shards], [f"{value:02x}" for value in range(256)])
        employers = {key: value for path in shards
                     for key, value in json.loads(path.read_text())["employers"].items()}
        self.assertEqual(len(employers), 1)
        self.assertEqual(next(iter(employers.values()))["rows"][0][5], 130000)

    def test_complete_valid_download_is_promoted_only_after_validation(self):
        body = write_xlsx(self.workbook, [raw_row()]).read_bytes()
        response = DownloadResponse(body, len(body))
        with mock.patch.object(ingest.dol_source, "open_dol_url", return_value=response) as fetch:
            result = ingest.download(SOURCE_URL, self.cache)
        self.assertEqual(result.read_bytes(), body)
        self.assertFalse((self.cache / "LCA_Disclosure_Data_FY2026_Q3.part").exists())
        self.assertEqual(fetch.call_args.kwargs["timeout"], 180)

    def test_existing_valid_cache_does_not_download(self):
        self.cache.mkdir()
        cached = write_xlsx(self.cache / "LCA_Disclosure_Data_FY2026_Q3.xlsx", [raw_row()])
        with mock.patch.object(ingest.dol_source, "open_dol_url", side_effect=AssertionError("no request")):
            self.assertEqual(ingest.download(SOURCE_URL, self.cache), cached)

    def test_oversized_declared_download_is_rejected_without_reading(self):
        response = DownloadResponse(b"not read", ingest.MAX_DOWNLOAD_BYTES + 1)
        with mock.patch.object(ingest.dol_source, "open_dol_url", return_value=response), \
                mock.patch.object(response, "read1", side_effect=AssertionError("must not read")):
            with self.assertRaisesRegex(ValueError, "download size limit"):
                ingest.download(SOURCE_URL, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_streamed_size_limit_removes_partial_download(self):
        with mock.patch.object(ingest, "MAX_DOWNLOAD_BYTES", 10), \
                mock.patch.object(ingest.dol_source, "open_dol_url", return_value=DownloadResponse(b"x" * 11)):
            with self.assertRaisesRegex(ValueError, "download size limit"):
                ingest.download(SOURCE_URL, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_invalid_workbook_does_not_replace_the_last_valid_cache(self):
        self.cache.mkdir()
        cached = write_xlsx(self.cache / "LCA_Disclosure_Data_FY2026_Q3.xlsx", [raw_row()])
        previous = cached.read_bytes()
        with mock.patch.object(ingest.dol_source, "open_dol_url", return_value=DownloadResponse(b"not an XLSX")):
            with self.assertRaisesRegex(ValueError, "valid XLSX"):
                ingest.download(SOURCE_URL, self.cache, refresh=True)
        self.assertEqual(cached.read_bytes(), previous)
        self.assertFalse(cached.with_suffix(".part").exists())

    def test_truncated_download_is_rejected_even_if_zip_would_parse(self):
        body = write_xlsx(self.workbook, [raw_row()]).read_bytes()
        with mock.patch.object(ingest.dol_source, "open_dol_url",
                               return_value=DownloadResponse(body, len(body) + 1)):
            with self.assertRaisesRegex(ValueError, "truncated"):
                ingest.download(SOURCE_URL, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_elapsed_deadline_removes_partial_download(self):
        response = DownloadResponse(b"no time left")
        with mock.patch.object(ingest.dol_source, "open_dol_url", return_value=response), \
                mock.patch.object(ingest.time, "monotonic", side_effect=[0, 181]):
            with self.assertRaisesRegex(TimeoutError, "time limit"):
                ingest.download(SOURCE_URL, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_source_and_redirect_must_stay_on_official_https_file(self):
        for url in (SOURCE_URL.replace("https:", "http:"), SOURCE_URL.replace("www.dol.gov", "evil.example")):
            with self.subTest(url=url), self.assertRaises(ValueError):
                ingest.download(url, self.cache)
        response = DownloadResponse(b"wrong file", url=SOURCE_URL.replace("Q3", "Q2"))
        with mock.patch.object(ingest.dol_source, "open_dol_url", return_value=response):
            with self.assertRaisesRegex(ValueError, "different source"):
                ingest.download(SOURCE_URL, self.cache)


if __name__ == "__main__":
    unittest.main()
