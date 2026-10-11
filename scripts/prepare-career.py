#!/usr/bin/env python3
"""Install the checksum-pinned, derived public DOL snapshot for static builds."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import urllib.request

ARCHIVE_URL = "https://github.com/prateekrsrivastava-d65websites/greencardtimer/releases/download/dol-fy2026-q3/career-fy2026-q3.tar.gz"
ARCHIVE_SHA256 = "441175780e4353549243b96feaa94c6f2aeb6be5500011a78b2022d02f65f724"
WORKBOOK_SHA256 = "f8ca8448a528671f784d3692923775a13741c99caec2816b2fe30c8885bd28b3"
EXPECTED_RECORDS = 391764
EXPECTED_EMPLOYERS = 53787
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
COLUMNS = ["id", "title", "soc", "city", "state", "wage", "wageTo",
           "prevailingWage", "wageLevel", "date", "decisionDate", "beginDate",
           "fullTime", "petitionType", "status"]
EMPLOYER_COLUMNS = ["id", "name", "filings", "median", "mean", "states", "lastFiled"]
INDEX_PATH = "public/data/career-index.json"
SHARD_PATHS = {f"public/data/career/{i:02x}.json" for i in range(256)}
DIRECTORY_PATHS = {"public", "public/data", "public/data/career"}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(path):
    if sha256(path) != ARCHIVE_SHA256:
        raise ValueError("Career snapshot checksum does not match the pinned release")


def download(cache_dir):
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / "career-fy2026-q3.tar.gz"
    if destination.exists() and sha256(destination) == ARCHIVE_SHA256:
        return destination
    request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "GreenCardTimer public-data build/1.0"})
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
            if digest.hexdigest() != ARCHIVE_SHA256:
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


def validate_snapshot(directory):
    index = json.loads((directory / "career-index.json").read_text(encoding="utf-8"))
    scope = index.get("scope", {})
    if (index.get("version") != 2 or index.get("columns") != COLUMNS
            or index.get("employerColumns") != EMPLOYER_COLUMNS
            or index.get("shardPrefixLength") != 2
            or scope.get("records") != EXPECTED_RECORDS
            or scope.get("employers") != EXPECTED_EMPLOYERS
            or scope.get("limited") is not False
            or scope.get("visaClass") != "H-1B"
            or scope.get("statuses") != ["Certified"]):
        raise ValueError("Career index schema or published coverage is unexpected")
    sources = index.get("sources", [])
    if len(sources) != 1 or sources[0].get("sha256") != WORKBOOK_SHA256:
        raise ValueError("Career snapshot does not identify the verified DOL workbook")
    summaries = {}
    for values in index.get("employerRows", []):
        if not isinstance(values, list) or len(values) != len(EMPLOYER_COLUMNS):
            raise ValueError("Invalid employer index row")
        employer_id, name, filings = values[:3]
        if (not isinstance(employer_id, str) or not re.fullmatch(r"[a-f0-9]{16}", employer_id)
                or employer_id in summaries or not isinstance(name, str)
                or not isinstance(filings, int) or filings <= 0):
            raise ValueError("Invalid employer identity or filing count")
        summaries[employer_id] = (name, filings)
    if len(summaries) != EXPECTED_EMPLOYERS:
        raise ValueError("Career employer index count does not match its scope")
    seen = set()
    record_count = 0
    for prefix in range(256):
        shard_prefix = f"{prefix:02x}"
        shard = json.loads((directory / "career" / f"{shard_prefix}.json").read_text(encoding="utf-8"))
        if shard.get("columns") != COLUMNS or not isinstance(shard.get("employers"), dict):
            raise ValueError(f"Invalid career shard schema: {shard_prefix}")
        for employer_id, employer in shard["employers"].items():
            if employer_id not in summaries or not employer_id.startswith(shard_prefix) or employer_id in seen:
                raise ValueError("Unexpected employer identity in career shard")
            rows = employer.get("rows")
            if (employer.get("name") != summaries[employer_id][0]
                    or not isinstance(rows, list) or len(rows) != summaries[employer_id][1]
                    or any(not isinstance(row, list) or len(row) != len(COLUMNS) for row in rows)):
                raise ValueError("Career shard rows do not match the employer index")
            seen.add(employer_id)
            record_count += len(rows)
    if seen != set(summaries) or record_count != EXPECTED_RECORDS:
        raise ValueError("Career shard coverage does not match the published scope")


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
    parser.add_argument("--cache-dir", type=Path, default=Path(".cache/career"))
    parser.add_argument("--output-dir", type=Path, default=Path("public/data"))
    args = parser.parse_args()
    archive = args.archive or download(args.cache_dir)
    verify_archive(archive)
    args.output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="career-install-", dir=args.output_dir.parent) as temporary:
        staging = Path(temporary) / "snapshot"
        staging.mkdir()
        total_bytes = extract_snapshot(archive, staging)
        validate_snapshot(staging)
        install_snapshot(staging, args.output_dir)
    print(json.dumps({"records": EXPECTED_RECORDS, "employers": EXPECTED_EMPLOYERS,
                      "shards": 256, "assetBytes": total_bytes, "archiveSha256": ARCHIVE_SHA256,
                      "workbookSha256": WORKBOOK_SHA256}))


if __name__ == "__main__":
    main()
