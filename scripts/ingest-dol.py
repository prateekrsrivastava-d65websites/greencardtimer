#!/usr/bin/env python3
"""Build static career data from DOL LCA XLSX disclosures, using Python 3 stdlib.

No pip dependencies are required. Raw workbooks stay outside the public folder.
Quarterly disclosure files are cumulative: pass the latest quarter per fiscal year.
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import statistics
import sys
import time
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
MANIFEST_PATH = Path(__file__).resolve().parents[1] / "data" / "career-release.json"
SOURCE_PAGE = "https://www.dol.gov/agencies/eta/foreign-labor/performance"
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
MAX_DOWNLOAD_SECONDS = 180
MAX_XLSX_BYTES = 4 * 1024 * 1024 * 1024
MAX_ZIP_ENTRIES = 2000
MAX_SOURCE_ROWS = 2_000_000
COLUMNS = ["id", "title", "soc", "city", "state", "wage", "wageTo",
           "prevailingWage", "wageLevel", "date", "decisionDate", "beginDate",
           "fullTime", "petitionType", "status"]
EMPLOYER_COLUMNS = ["id", "name", "filings", "median", "mean", "states", "lastFiled"]
FIELDS = {"CASE_NUMBER", "CASE_STATUS", "VISA_CLASS", "EMPLOYER_NAME", "JOB_TITLE",
          "SOC_CODE", "FULL_TIME_POSITION", "RECEIVED_DATE", "DECISION_DATE",
          "BEGIN_DATE", "WAGE_RATE_OF_PAY_FROM", "WAGE_RATE_OF_PAY_TO",
          "WAGE_UNIT_OF_PAY", "PREVAILING_WAGE", "PW_UNIT_OF_PAY", "PW_WAGE_LEVEL",
          "WORKSITE_CITY", "WORKSITE_STATE", "NAICS_CODE", "NEW_EMPLOYMENT",
          "CONTINUED_EMPLOYMENT", "CHANGE_PREVIOUS_EMPLOYMENT",
          "NEW_CONCURRENT_EMPLOYMENT", "CHANGE_EMPLOYER", "AMENDED_PETITION"}
SECTORS = {"11": "Agriculture", "21": "Mining", "22": "Utilities",
           "23": "Construction", "31": "Manufacturing", "32": "Manufacturing",
           "33": "Manufacturing", "42": "Wholesale", "44": "Retail",
           "45": "Retail", "48": "Transportation", "49": "Transportation",
           "51": "Information", "52": "Finance", "53": "Real estate",
           "54": "Professional services", "55": "Management",
           "56": "Administrative services", "61": "Education",
           "62": "Healthcare", "71": "Arts and recreation",
           "72": "Hospitality", "81": "Other services", "92": "Public administration"}

_SOURCE_SPEC = importlib.util.spec_from_file_location(
    "dol_source", Path(__file__).with_name("dol-source.py")
)
dol_source = importlib.util.module_from_spec(_SOURCE_SPEC)
_SOURCE_SPEC.loader.exec_module(dol_source)


def default_source(manifest_path=MANIFEST_PATH):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or not isinstance(manifest.get("source"), dict):
        raise ValueError("DOL release manifest is missing source metadata")
    return dol_source.canonical_dol_url(manifest["source"].get("url"))


def validate_workbook(path, check_crc=False):
    if path.stat().st_size > MAX_DOWNLOAD_BYTES:
        raise ValueError("DOL workbook exceeds the download size limit")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if not entries or len(entries) > MAX_ZIP_ENTRIES:
                raise ValueError("DOL workbook exceeds the ZIP entry limit")
            if len(set(names)) != len(names):
                raise ValueError("DOL workbook contains duplicate ZIP entries")
            if any(entry.flag_bits & 1 for entry in entries):
                raise ValueError("Encrypted DOL workbooks are unsupported")
            if sum(entry.file_size for entry in entries) > MAX_XLSX_BYTES:
                raise ValueError("DOL workbook exceeds the uncompressed size limit")
            if (not {"[Content_Types].xml", "xl/workbook.xml"}.issubset(names)
                    or not any(re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name) for name in names)):
                raise ValueError("DOL response was not a valid XLSX workbook")
            if check_crc and archive.testzip() is not None:
                raise ValueError("DOL workbook contains corrupt ZIP data")
    except (zipfile.BadZipFile, EOFError) as error:
        raise ValueError("DOL response was not a valid XLSX workbook") from error


def numeric(value):
    try:
        number = float(str(value).replace(",", "").replace("$", ""))
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def annual_wage(value, unit):
    number = numeric(value)
    factor = {"year": 1, "annual": 1, "hour": 2080, "week": 52,
              "bi-weekly": 26, "biweekly": 26, "month": 12}.get(str(unit).lower())
    return round(number * factor, 2) if number is not None and factor else None


def iso_date(value):
    number = numeric(value)
    if number is not None and 30000 <= number <= 70000:
        return (datetime(1899, 12, 30) + timedelta(days=number)).date().isoformat()
    for pattern in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(str(value)[:10], pattern).date().isoformat()
        except ValueError:
            pass
    return ""


def column_number(reference):
    index = 0
    for char in reference:
        if not char.isalpha():
            break
        index = index * 26 + ord(char.upper()) - ord("A") + 1
    return index - 1


def shared_strings(archive):
    strings = []
    if "xl/sharedStrings.xml" not in archive.namelist():
        return strings
    with archive.open("xl/sharedStrings.xml") as stream:
        for _, element in ET.iterparse(stream, events=("end",)):
            if element.tag == NS + "si":
                strings.append("".join(t.text or "" for t in element.iter(NS + "t")))
                element.clear()
    return strings


def cell_value(cell, strings):
    if cell.get("t") == "inlineStr":
        return "".join(t.text or "" for t in cell.iter(NS + "t"))
    child = cell.find(NS + "v")
    value = child.text if child is not None else ""
    if cell.get("t") == "s" and value:
        return strings[int(value)]
    return value or ""


def disclosure_rows(path):
    validate_workbook(path)
    with zipfile.ZipFile(path) as archive:
        strings = shared_strings(archive)
        worksheet = next(name for name in archive.namelist()
                         if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name))
        with archive.open(worksheet) as stream:
            events = ET.iterparse(stream, events=("start", "end"))
            _, root = next(events)
            mapping = None
            source_rows = 0
            for event, element in events:
                if event != "end" or element.tag != NS + "row":
                    continue
                cells = list(element)
                if mapping is None:
                    header_cells = [(column_number(c.get("r", "")), cell_value(c, strings))
                                    for c in cells]
                    headers = dict(header_cells)
                    if "CASE_NUMBER" not in headers.values():
                        element.clear()
                        root.clear()
                        continue
                    if (len(headers) != len(header_cells)
                            or any(count > 1 for name, count in Counter(headers.values()).items()
                                   if name in FIELDS)):
                        raise ValueError("Unsupported DOL schema: duplicate header columns")
                    missing = FIELDS - set(headers.values())
                    if missing:
                        raise ValueError(f"Unsupported DOL schema: missing {sorted(missing)}")
                    mapping = {i: h for i, h in headers.items() if h in FIELDS}
                    print(f"Reading {path.name}: {len(headers)} columns", flush=True)
                else:
                    source_rows += 1
                    if source_rows > MAX_SOURCE_ROWS:
                        raise ValueError("DOL workbook exceeds the source row limit")
                    yield {mapping[i]: cell_value(c, strings) for c in cells
                           if (i := column_number(c.get("r", ""))) in mapping}
                element.clear()
                root.clear()
            if mapping is None:
                raise ValueError("Unsupported DOL schema: no disclosure header found")


def petition_type(raw):
    types = (("NEW_EMPLOYMENT", "New employment"),
             ("CHANGE_EMPLOYER", "Change of employer"),
             ("CONTINUED_EMPLOYMENT", "Continuation"),
             ("AMENDED_PETITION", "Amendment"),
             ("NEW_CONCURRENT_EMPLOYMENT", "Concurrent employment"),
             ("CHANGE_PREVIOUS_EMPLOYMENT", "Change in employment"))
    active = [label for field, label in types if (numeric(raw.get(field)) or 0) > 0]
    return " / ".join(active) or "Unspecified"


def normalize(raw):
    if raw.get("CASE_STATUS", "").casefold() != "certified" or raw.get("VISA_CLASS") != "H-1B":
        return None
    employer = " ".join(raw.get("EMPLOYER_NAME", "").upper().split())
    wage = annual_wage(raw.get("WAGE_RATE_OF_PAY_FROM"), raw.get("WAGE_UNIT_OF_PAY"))
    if not employer or not raw.get("CASE_NUMBER") or wage is None or not 5000 <= wage <= 1000000:
        return None
    if raw.get("FULL_TIME_POSITION") not in {"Y", "N"}:
        raise ValueError("Unsupported DOL data: FULL_TIME_POSITION must be Y or N")
    values = [raw["CASE_NUMBER"], raw.get("JOB_TITLE", ""), raw.get("SOC_CODE", ""),
              raw.get("WORKSITE_CITY", ""), raw.get("WORKSITE_STATE", ""), wage,
              annual_wage(raw.get("WAGE_RATE_OF_PAY_TO"), raw.get("WAGE_UNIT_OF_PAY")),
              annual_wage(raw.get("PREVAILING_WAGE"), raw.get("PW_UNIT_OF_PAY")),
              raw.get("PW_WAGE_LEVEL", ""), iso_date(raw.get("RECEIVED_DATE")),
              iso_date(raw.get("DECISION_DATE")), iso_date(raw.get("BEGIN_DATE")),
              raw["FULL_TIME_POSITION"] == "Y", petition_type(raw), "Certified"]
    return employer, values, str(raw.get("NAICS_CODE", ""))[:2]


def download(url, archive_dir, refresh=False):
    url = dol_source.canonical_dol_url(url)
    filename = urlsplit(url).path.rsplit("/", 1)[-1]
    if not filename.lower().endswith(".xlsx"):
        raise ValueError("Source URL must name an XLSX disclosure file")
    archive_dir = Path(archive_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    path = archive_dir / filename
    if not refresh and path.exists():
        try:
            validate_workbook(path)
            return path
        except ValueError:
            pass
    temporary = path.with_suffix(".part")
    deadline = time.monotonic() + MAX_DOWNLOAD_SECONDS
    try:
        with dol_source.open_dol_url(url, timeout=MAX_DOWNLOAD_SECONDS) as response:
            if dol_source.canonical_dol_url(response.geturl()) != url:
                raise ValueError("DOL workbook redirected to a different source file")
            length = response.headers.get("Content-Length")
            declared_bytes = None
            if length is not None:
                try:
                    declared_bytes = int(length)
                except ValueError as error:
                    raise ValueError("DOL workbook has an invalid Content-Length") from error
                if declared_bytes < 0 or declared_bytes > MAX_DOWNLOAD_BYTES:
                    raise ValueError("DOL workbook exceeds the download size limit")
            downloaded = 0
            with temporary.open("wb") as output:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("DOL workbook download exceeded its time limit")
                    # urllib's socket timeout is per read; reduce it to the
                    # remaining budget so a late read cannot restart the clock.
                    socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                    if socket is not None:
                        socket.settimeout(remaining)
                    chunk = getattr(response, "read1", response.read)(1024 * 1024)
                    if time.monotonic() > deadline:
                        raise TimeoutError("DOL workbook download exceeded its time limit")
                    if not chunk:
                        break
                    downloaded += len(chunk)
                    if downloaded > MAX_DOWNLOAD_BYTES:
                        raise ValueError("DOL workbook exceeds the download size limit")
                    output.write(chunk)
            if declared_bytes is not None and downloaded != declared_bytes:
                raise ValueError("DOL workbook download was truncated")
        validate_workbook(temporary, check_crc=True)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=True), encoding="utf-8")
    if path.stat().st_size > 25 * 1024 * 1024:
        raise ValueError(f"Static asset exceeds Cloudflare 25 MiB limit: {path}")


def main():
    started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", help="Official DOL XLSX URL; repeat for latest release of other fiscal years")
    parser.add_argument("--archive-dir", default="../../work/dol")
    parser.add_argument("--output-dir", default="public/data")
    parser.add_argument("--max-rows", type=int, help="Explicitly limited development sample; omitted for full source")
    parser.add_argument("--refresh", action="store_true", help="Re-download cached source files, including corrected releases")
    parser.add_argument("--rich-index", action="store_true", help="Include titles, industry and activity scores in the larger employer index")
    args = parser.parse_args()
    if args.max_rows is not None and not 1 <= args.max_rows <= MAX_SOURCE_ROWS:
        parser.error(f"--max-rows must be between 1 and {MAX_SOURCE_ROWS}")
    archive_dir = Path(args.archive_dir)
    output_dir = Path(args.output_dir)
    archive_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "career").mkdir(parents=True, exist_ok=True)
    records = {}
    latest_decisions = {}
    sources = []
    input_rows = 0
    source_rows = 0
    for url in args.source or [default_source()]:
        url = dol_source.canonical_dol_url(url)
        path = download(url, archive_dir, args.refresh)
        sources.append({"name": "DOL OFLC LCA public disclosure", "url": url,
                        "filename": path.name, "sha256": file_hash(path), "bytes": path.stat().st_size})
        for raw in disclosure_rows(path):
            source_rows += 1
            if source_rows > MAX_SOURCE_ROWS:
                raise ValueError("DOL ingestion exceeds the source row limit")
            if not raw.get("CASE_NUMBER"):
                continue
            input_rows += 1
            case_number = raw["CASE_NUMBER"]
            decision_date = iso_date(raw.get("DECISION_DATE"))
            previous_decision = latest_decisions.get(case_number)
            if previous_decision is not None and decision_date < previous_decision:
                continue
            latest_decisions[case_number] = decision_date
            item = normalize(raw)
            if item:
                records[case_number] = item
            else:
                records.pop(case_number, None)
            if input_rows % 50000 == 0:
                print(f"Read {input_rows:,} source rows; kept {len(records):,} certified wage records", flush=True)
            if args.max_rows and input_rows >= args.max_rows:
                break
    groups = defaultdict(list)
    sectors = defaultdict(Counter)
    for employer, values, sector in records.values():
        groups[employer].append(values)
        sectors[employer][sector] += 1
    shards = defaultdict(dict)
    summaries = []
    all_dates = []
    all_decisions = []
    for name, rows in groups.items():
        employer_id = hashlib.sha256(name.encode()).hexdigest()[:16]
        rows.sort(key=lambda row: (row[9], row[0]), reverse=True)
        wages = sorted(row[5] for row in rows)
        state_counts = Counter(row[4] for row in rows if row[4])
        titles = Counter(row[1] for row in rows if row[1])
        full_time = sum(row[12] for row in rows)
        all_dates.extend(row[9] for row in rows if row[9])
        all_decisions.extend(row[10] for row in rows if row[10])
        # Score describes activity only, with explicit bounds; it is not an approval probability.
        score = round(min(40, math.log10(len(rows) + 1) * 10) + min(25, len(titles) * 2.5)
                      + min(20, len(state_counts) * 4) + (15 * full_time / len(rows)))
        summaries.append({"id": employer_id, "name": name, "filings": len(rows),
                          "mean": round(statistics.mean(wages)), "median": round(statistics.median(wages)),
                          "min": min(wages), "max": max(wages), "states": list(state_counts),
                          "topTitles": [title for title, _ in titles.most_common(3)],
                          "score": score, "industry": SECTORS.get(sectors[name].most_common(1)[0][0], "Other"),
                          "lastFiled": rows[0][9], "fullTime": full_time})
        shards[employer_id[:2]][employer_id] = {"name": name, "rows": rows}
    summaries.sort(key=lambda item: (-item["filings"], item["name"]))
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    scope = {"label": ", ".join(source["filename"].replace("LCA_Disclosure_Data_", "").replace(".xlsx", "") for source in sources),
             "visaClass": "H-1B", "statuses": ["Certified"], "sourceRows": input_rows,
             "records": len(records), "employers": len(summaries), "limited": bool(args.max_rows),
             "filedFrom": min(all_dates) if all_dates else None,
             "filedTo": max(all_dates) if all_dates else None,
             "decisionFrom": min(all_decisions) if all_decisions else None,
             "decisionTo": max(all_decisions) if all_decisions else None,
             "exclusions": "Other visa classes, non-certified filings, missing/unrecognized wage units, and annualized wages outside $5,000-$1,000,000.",
             "note": "Quarterly disclosure reflects final determinations, not live job openings or USCIS H-1B approvals. One case may cover multiple workers or worksites; rows use the primary disclosed worksite.",
             "annualization": "Hourly x 2,080; weekly x 52; biweekly x 26; monthly x 12. Full-time and part-time filings are identified separately."}
    employer_columns = list(summaries[0]) if args.rich_index and summaries else EMPLOYER_COLUMNS
    index = {"version": 2, "generatedAt": now, "sources": sources, "sourcePage": SOURCE_PAGE,
             "scope": scope, "columns": COLUMNS, "shardPrefixLength": 2,
             "employerColumns": employer_columns,
             "employerRows": [[employer[column] for column in employer_columns] for employer in summaries]}
    if args.rich_index:
        index["scoreMethod"] = "Activity score: up to 40 points from log10(filings+1)*10, 25 from distinct titles*2.5, 20 from distinct states*4, and 15 from full-time filing share. Not a visa approval or sponsorship guarantee."
    prefixes = {f"{value:02x}" for value in range(256)}
    for prefix in sorted(prefixes):
        employers = shards.get(prefix, {})
        write_json(output_dir / "career" / f"{prefix}.json", {"columns": COLUMNS, "employers": employers})
    for path in (output_dir / "career").glob("*.json"):
        if path.stem not in prefixes:
            path.unlink()
    write_json(output_dir / "career-index.json", index)
    import resource
    peak_memory = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform != "darwin":
        peak_memory *= 1024
    print(json.dumps({"records": len(records), "employers": len(summaries), "shards": len(prefixes),
                      "indexBytes": (output_dir / "career-index.json").stat().st_size,
                      "totalBytes": sum(p.stat().st_size for p in (output_dir / "career").glob("*.json")),
                      "elapsedSeconds": round(time.monotonic() - started, 2), "peakResidentBytes": peak_memory,
                      "sources": sources}), flush=True)


if __name__ == "__main__":
    main()
