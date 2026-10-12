#!/usr/bin/env python3
"""Install the checksum-pinned, derived public DOL snapshot for static builds."""

import argparse
from datetime import date
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request
from urllib.parse import unquote, urlsplit

DEFAULT_MANIFEST = Path(__file__).resolve().parents[1] / "data" / "career-release.json"
SOURCE_PAGE = "https://www.dol.gov/agencies/eta/foreign-labor/performance"
RELEASE_PREFIX = "/prateekrsrivastava-d65websites/greencardtimer/releases/download/"
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_RECORDS = 5_000_000
MAX_EMPLOYERS = 1_000_000
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
COLUMNS = ["id", "title", "soc", "city", "state", "wage", "wageTo",
           "prevailingWage", "wageLevel", "date", "decisionDate", "beginDate",
           "fullTime", "petitionType", "status"]
EMPLOYER_COLUMNS = ["id", "name", "filings", "median", "mean", "states", "lastFiled"]
INDEX_PATH = "public/data/career-index.json"
SHARD_PATHS = {f"public/data/career/{i:02x}.json" for i in range(256)}
DIRECTORY_PATHS = {"public", "public/data", "public/data/career"}


def canonical_source_url(value):
    if not isinstance(value, str) or any(ord(char) < 32 for char in value):
        raise ValueError("DOL source URL must be a string")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.hostname not in {"dol.gov", "www.dol.gov"}
            or parsed.username is not None or parsed.password is not None
            or parsed.port is not None or parsed.query or parsed.fragment):
        raise ValueError("DOL source URL must identify an official HTTPS workbook")
    path = unquote(parsed.path)
    if any(segment in {".", ".."} for segment in path.split("/")):
        raise ValueError("Unsafe DOL source URL path")
    return "https://www.dol.gov/" + "/".join(segment for segment in path.split("/") if segment)


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1:
        raise ValueError("Unexpected career release manifest version")
    year, quarter = manifest.get("fiscalYear"), manifest.get("quarter")
    if type(year) is not int or not 2000 <= year <= 2100 or type(quarter) is not int or not 1 <= quarter <= 4:
        raise ValueError("Invalid fiscal year or quarter in career release manifest")
    if manifest.get("sourcePage") != SOURCE_PAGE:
        raise ValueError("Unexpected DOL source page in career release manifest")
    source, archive = manifest.get("source"), manifest.get("archive")
    if not isinstance(source, dict) or not isinstance(archive, dict):
        raise ValueError("Career release manifest must identify its source and archive")
    expected_filenames = {f"LCA_Disclosure_Data_FY{year}_Q{quarter}.xlsx"}
    if quarter == 4:
        expected_filenames.add(f"LCA_Disclosure_Data_FY{year}.xlsx")
    source_url = canonical_source_url(source.get("url"))
    if (not isinstance(source.get("filename"), str) or source["filename"] not in expected_filenames
            or source_url.rsplit("/", 1)[-1] != source["filename"]):
        raise ValueError("DOL source filename does not match the manifest fiscal quarter")
    for descriptor in (source, archive):
        if not isinstance(descriptor.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", descriptor["sha256"]):
            raise ValueError("Invalid SHA-256 in career release manifest")
    if type(source.get("bytes")) is not int or not 0 < source["bytes"] <= MAX_SOURCE_BYTES:
        raise ValueError("DOL source size exceeds the manifest limit")
    archive_url = archive.get("url")
    if not isinstance(archive_url, str) or any(ord(char) < 32 for char in archive_url):
        raise ValueError("Invalid career archive release URL")
    parsed = urlsplit(archive_url)
    if (parsed.scheme != "https" or parsed.netloc != "github.com" or parsed.query or parsed.fragment
            or not parsed.path.startswith(RELEASE_PREFIX)):
        raise ValueError("Career archive must be a release in the configured public repository")
    release_path = parsed.path.removeprefix(RELEASE_PREFIX)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz", release_path):
        raise ValueError("Invalid career archive release path")
    records, employers = manifest.get("records"), manifest.get("employers")
    if (type(records) is not int or not 0 < records <= MAX_RECORDS
            or type(employers) is not int or not 0 < employers <= min(records, MAX_EMPLOYERS)):
        raise ValueError("Invalid published coverage in career release manifest")
    return manifest


def load_manifest(path=DEFAULT_MANIFEST):
    return validate_manifest(json.loads(Path(path).read_text(encoding="utf-8")))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(path, manifest):
    if sha256(path) != manifest["archive"]["sha256"]:
        raise ValueError("Career snapshot checksum does not match the pinned release")


def download(cache_dir, manifest):
    cache_dir.mkdir(parents=True, exist_ok=True)
    expected_sha256 = manifest["archive"]["sha256"]
    destination = cache_dir / f"career-{expected_sha256}.tar.gz"
    if destination.exists() and sha256(destination) == expected_sha256:
        return destination
    request = urllib.request.Request(manifest["archive"]["url"], headers={"User-Agent": "GreenCardTimer public-data build/1.0"})
    with tempfile.NamedTemporaryFile(dir=cache_dir, suffix=".part", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            digest = hashlib.sha256()
            downloaded = 0
            with urllib.request.urlopen(request, timeout=180) as response:
                while chunk := response.read(1024 * 1024):
                    downloaded += len(chunk)
                    if downloaded > MAX_TOTAL_BYTES:
                        raise ValueError("Career release archive exceeds the size limit")
                    digest.update(chunk)
                    stream.write(chunk)
            stream.close()
            if digest.hexdigest() != expected_sha256:
                raise ValueError("Downloaded career snapshot checksum does not match the pinned release")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    return destination


def extract_snapshot(archive, destination):
    seen = set()
    total_bytes = 0
    # No tar extraction helpers: only known regular files are streamed to staging.
    with tarfile.open(archive, mode="r:gz") as bundle:
        for member in bundle:
            if member.isdir() and member.name.rstrip("/") in DIRECTORY_PATHS:
                continue
            if member.name not in SHARD_PATHS | {INDEX_PATH} or not member.isfile():
                raise ValueError(f"Unexpected or unsafe archive entry: {member.name}")
            if member.name in seen:
                raise ValueError(f"Duplicate archive entry: {member.name}")
            if member.size < 0 or member.size > MAX_FILE_BYTES:
                raise ValueError(f"Career asset exceeds size limit: {member.name}")
            seen.add(member.name)
            total_bytes += member.size
            if total_bytes > MAX_TOTAL_BYTES:
                raise ValueError("Extracted career assets exceed the size limit")
            relative = Path(member.name).relative_to("public/data")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            if target.stat().st_size != member.size:
                raise ValueError(f"Incomplete archive entry: {member.name}")
    if seen != SHARD_PATHS | {INDEX_PATH}:
        raise ValueError("Career snapshot is missing its index or one of the 256 shards")
    return total_bytes


def valid_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return False
    try:
        return 1990 <= date.fromisoformat(value).year <= 2150
    except ValueError:
        return False


def finite_number(value, minimum=0, maximum=100_000_000):
    return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum


def fiscal_date_range(manifest):
    year, quarter = manifest["fiscalYear"], manifest["quarter"]
    starts = f"{year - 1}-10-01"
    ends = [f"{year - 1}-12-31", f"{year}-03-31", f"{year}-06-30", f"{year}-09-30"]
    return starts, ends[quarter - 1]


def validate_snapshot(directory, manifest):
    validate_manifest(manifest)
    index = json.loads((directory / "career-index.json").read_text(encoding="utf-8"))
    if not isinstance(index, dict):
        raise ValueError("Career index must be an object")
    scope = index.get("scope", {})
    if (not isinstance(scope, dict) or index.get("version") != 2 or index.get("columns") != COLUMNS
            or index.get("employerColumns") != EMPLOYER_COLUMNS
            or index.get("shardPrefixLength") != 2
            or type(scope.get("records")) is not int or scope["records"] != manifest["records"]
            or type(scope.get("employers")) is not int or scope["employers"] != manifest["employers"]
            or scope.get("limited") is not False
            or scope.get("visaClass") != "H-1B"
            or scope.get("statuses") != ["Certified"]):
        raise ValueError("Career index schema or published coverage is unexpected")
    sources = index.get("sources", [])
    if (not isinstance(sources, list) or len(sources) != 1 or not isinstance(sources[0], dict)
            or sources[0].get("sha256") != manifest["source"]["sha256"]
            or sources[0].get("filename") != manifest["source"]["filename"]
            or type(sources[0].get("bytes")) is not int or sources[0]["bytes"] != manifest["source"]["bytes"]
            or canonical_source_url(sources[0].get("url")) != canonical_source_url(manifest["source"]["url"])
            or index.get("sourcePage") != manifest["sourcePage"]):
        raise ValueError("Career snapshot does not identify the verified DOL workbook")
    start, end = fiscal_date_range(manifest)
    if (not valid_date(scope.get("decisionFrom")) or not valid_date(scope.get("decisionTo"))
            or not start <= scope["decisionFrom"] <= scope["decisionTo"] <= end
            or not valid_date(scope.get("filedFrom")) or not valid_date(scope.get("filedTo"))
            or scope["filedFrom"] > scope["filedTo"]):
        raise ValueError("Career snapshot dates do not match its fiscal quarter")
    summaries = {}
    employer_rows = index.get("employerRows")
    if not isinstance(employer_rows, list):
        raise ValueError("Invalid employer index rows")
    for values in employer_rows:
        if not isinstance(values, list) or len(values) != len(EMPLOYER_COLUMNS):
            raise ValueError("Invalid employer index row")
        employer_id, name, filings = values[:3]
        if (not isinstance(employer_id, str) or not re.fullmatch(r"[a-f0-9]{16}", employer_id)
                or employer_id in summaries or not isinstance(name, str) or not name.strip()
                or len(name) > 1000 or hashlib.sha256(name.encode("utf-8")).hexdigest()[:16] != employer_id
                or type(filings) is not int or filings <= 0
                or not finite_number(values[3], 5000, 1_000_000)
                or not finite_number(values[4], 5000, 1_000_000)
                or not isinstance(values[5], list) or not values[5]
                or any(not isinstance(state, str) or not re.fullmatch(r"[A-Z]{2}", state) for state in values[5])
                or len(set(values[5])) != len(values[5]) or not valid_date(values[6])):
            raise ValueError("Invalid employer identity or filing count")
        summaries[employer_id] = (name, filings)
    if len(summaries) != manifest["employers"]:
        raise ValueError("Career employer index count does not match its scope")
    seen = set()
    seen_cases = set()
    record_count = 0
    filed_min = decision_min = "9999-12-31"
    filed_max = decision_max = "0000-01-01"
    for prefix in range(256):
        shard_prefix = f"{prefix:02x}"
        shard = json.loads((directory / "career" / f"{shard_prefix}.json").read_text(encoding="utf-8"))
        if not isinstance(shard, dict) or shard.get("columns") != COLUMNS or not isinstance(shard.get("employers"), dict):
            raise ValueError(f"Invalid career shard schema: {shard_prefix}")
        for employer_id, employer in shard["employers"].items():
            if employer_id not in summaries or not employer_id.startswith(shard_prefix) or employer_id in seen:
                raise ValueError("Unexpected employer identity in career shard")
            rows = employer.get("rows") if isinstance(employer, dict) else None
            if (not isinstance(employer, dict) or employer.get("name") != summaries[employer_id][0]
                    or not isinstance(rows, list) or len(rows) != summaries[employer_id][1]
                    or any(not isinstance(row, list) or len(row) != len(COLUMNS) for row in rows)):
                raise ValueError("Career shard rows do not match the employer index")
            for row in rows:
                if (not isinstance(row[0], str) or not re.fullmatch(r"I-\d{3}-\d{5}-\d{6}", row[0])
                        or row[0] in seen_cases
                        or any(not isinstance(row[column], str) or len(row[column]) > 2000 for column in (1, 2, 3, 4, 8, 13, 14))
                        or not re.fullmatch(r"[A-Z]{2}", row[4])
                        or not finite_number(row[5], 5000, 1_000_000)
                        or any(value is not None and not finite_number(value) for value in (row[6], row[7]))
                        or any(not valid_date(row[column]) for column in (9, 10, 11))
                        or not start <= row[10] <= end or row[9] > row[10]
                        or type(row[12]) is not bool or row[14] != "Certified"):
                    raise ValueError("Invalid normalized certified H-1B filing row")
                seen_cases.add(row[0])
                filed_min, filed_max = min(filed_min, row[9]), max(filed_max, row[9])
                decision_min, decision_max = min(decision_min, row[10]), max(decision_max, row[10])
            seen.add(employer_id)
            record_count += len(rows)
    if seen != set(summaries) or record_count != manifest["records"]:
        raise ValueError("Career shard coverage does not match the published scope")
    if (filed_min != scope["filedFrom"] or filed_max != scope["filedTo"]
            or decision_min != scope["decisionFrom"] or decision_max != scope["decisionTo"]):
        raise ValueError("Career row dates do not match the published scope")


def install_snapshot(staging, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    old_shards = output_dir / "career"
    backup = staging.parent / "previous-career"
    if old_shards.exists():
        old_shards.replace(backup)
    try:
        (staging / "career").replace(old_shards)
        (staging / "career-index.json").replace(output_dir / "career-index.json")
    except Exception:
        if old_shards.exists():
            shutil.rmtree(old_shards)
        if backup.exists():
            backup.replace(old_shards)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Verify and install a local release archive without network access")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/career"))
    parser.add_argument("--output-dir", type=Path, default=Path("public/data"))
    args = parser.parse_args()
    manifest = load_manifest(args.manifest)
    archive = args.archive or download(args.cache_dir, manifest)
    verify_archive(archive, manifest)
    args.output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="career-install-", dir=args.output_dir.parent) as temporary:
        staging = Path(temporary) / "snapshot"
        staging.mkdir()
        total_bytes = extract_snapshot(archive, staging)
        validate_snapshot(staging, manifest)
        install_snapshot(staging, args.output_dir)
    print(json.dumps({"records": manifest["records"], "employers": manifest["employers"],
                      "shards": 256, "assetBytes": total_bytes, "archiveSha256": manifest["archive"]["sha256"],
                      "workbookSha256": manifest["source"]["sha256"]}))


if __name__ == "__main__":
    main()
