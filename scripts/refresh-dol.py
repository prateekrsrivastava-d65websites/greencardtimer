#!/usr/bin/env python3
"""Refresh the verified quarterly LCA release without a database or pip packages."""

import argparse
from datetime import date
import gzip
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "prateekrsrivastava-d65websites/greencardtimer"
CHECK_PATH = ROOT / "data/career-source-check.json"
MIN_RECORDS = 10000
MIN_EMPLOYERS = 100


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "scripts" / f"{name}.py")
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


source = module("dol-source")
prepare = module("prepare-career")
ingest = module("ingest-dol")


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, indent=2, ensure_ascii=True)
            stream.write("\n")
            stream.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def probe(url):
    try:
        response = source.open_dol_url(url, method="HEAD", timeout=30)
    except urllib.error.HTTPError as error:
        if error.code not in {405, 501}:
            raise
        error.close()
        return {"etag": None, "lastModified": None, "bytes": None}
    with response:
        if source.canonical_dol_url(response.geturl()) != source.canonical_dol_url(url):
            raise ValueError("DOL metadata redirected to a different workbook")
        length = response.headers.get("Content-Length")
        if length is not None and (not length.isdigit() or not 0 < int(length) <= ingest.MAX_DOWNLOAD_BYTES):
            raise ValueError("DOL workbook Content-Length is invalid or exceeds the size limit")
        # Validators are change signals, never evidence that a workbook is valid.
        return {"etag": response.headers.get("ETag"),
                "lastModified": response.headers.get("Last-Modified"),
                "bytes": int(length) if length is not None else None}


def unchanged(candidate, pinned, check, validators):
    if (candidate["fiscalYear"], candidate["quarter"]) != (pinned["fiscalYear"], pinned["quarter"]):
        return False
    if (check.get("sourceSha256") != pinned["source"]["sha256"]
            or check.get("url") != candidate["url"] or check.get("validators") != validators):
        return False
    return bool(validators["etag"] or validators["lastModified"])


def validate_coverage(index, candidate, pinned):
    scope = index["scope"]
    if scope["records"] < MIN_RECORDS or scope["employers"] < MIN_EMPLOYERS:
        raise ValueError("DOL candidate is unexpectedly small; last verified snapshot retained")
    if not scope["records"] <= scope["sourceRows"] <= 2000000:
        raise ValueError("DOL source row coverage is invalid")
    # Cumulative quarters can have redeterminations, but not lose most of their cases.
    # A new fiscal year's Q1 is a different cohort and must not inherit this floor.
    if (candidate["fiscalYear"] == pinned["fiscalYear"]
            and scope["records"] < pinned["records"] * 0.9):
        raise ValueError("DOL cumulative coverage fell by more than 10%; last verified snapshot retained")
    year, quarter = candidate["fiscalYear"], candidate["quarter"]
    first = date(year - 1, 10, 1)
    end = [date(year - 1, 12, 31), date(year, 3, 31), date(year, 6, 30), date(year, 9, 30)][quarter - 1]
    dates = [date.fromisoformat(scope[key]) for key in ("decisionFrom", "decisionTo")]
    if not first <= dates[0] <= dates[1] <= end:
        raise ValueError("DOL determinations fall outside the linked fiscal quarter")
    if (end - dates[1]).days > 31:
        raise ValueError("DOL candidate does not cover the latest quarter")


def pack_snapshot(directory, archive):
    total = 0
    with archive.open("wb") as output, gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as bundle:
            for name in sorted(prepare.SHARD_PATHS | {prepare.INDEX_PATH}):
                path = directory / Path(name).relative_to("public/data")
                info = bundle.gettarinfo(str(path), arcname=name)
                if not info.isfile() or info.size > prepare.MAX_FILE_BYTES:
                    raise ValueError("DOL candidate contains an oversized or nonregular asset")
                total += info.size
                if total > prepare.MAX_TOTAL_BYTES:
                    raise ValueError("DOL candidate exceeds the static snapshot size limit")
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                with path.open("rb") as stream:
                    bundle.addfile(info, stream)
    return prepare.sha256(archive)


def build_candidate(directory, manifest, workspace):
    # Test the candidate in isolation; failed updates cannot replace local/live data.
    ignore = shutil.ignore_patterns(".git", ".cache", "node_modules", "dist", "__pycache__",
                                   "*.pyc", ".env*", ".dev.vars*", "career-index.json", "career")
    shutil.copytree(ROOT, workspace, ignore=ignore)
    (workspace / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    shutil.copytree(directory / "career", workspace / "public/data/career")
    shutil.copy2(directory / "career-index.json", workspace / "public/data/career-index.json")
    atomic_json(workspace / "data/career-release.json", manifest)
    subprocess.run(["npm", "test"], cwd=workspace, check=True, timeout=180)
    subprocess.run(["npm", "run", "build"], cwd=workspace, check=True, timeout=180)


def publish(archive, manifest):
    tag, filename = manifest["archive"]["url"].split("/releases/download/", 1)[1].split("/")
    # A content-addressed release is never overwritten or used as an unpinned latest link.
    asset = archive.with_name(filename)
    archive.replace(asset)
    notes = (f"Derived certified H-1B LCA data from {manifest['source']['url']}\n\n"
             f"Workbook SHA-256: {manifest['source']['sha256']}\n"
             f"Archive SHA-256: {manifest['archive']['sha256']}\n"
             f"{manifest['records']} cases; {manifest['employers']} employers. "
             "Cumulative fiscal-year disclosure, not visa approvals or live vacancies.")
    command = ["gh", "release", "create", tag, str(asset), "--repo", REPOSITORY,
               "--target", os.environ.get("GITHUB_SHA", "main"), "--latest=false",
               "--title", f"DOL FY{manifest['fiscalYear']} Q{manifest['quarter']} verified snapshot",
               "--notes", notes]
    result = subprocess.run(command, text=True, capture_output=True, timeout=180)
    # An uncertain upload may already have completed. Check exact bytes either way.
    try:
        with tempfile.TemporaryDirectory(prefix="release-verify-", dir=asset.parent) as temporary:
            downloaded = prepare.download(Path(temporary), manifest)
            prepare.verify_archive(downloaded, manifest)
    except Exception as error:
        raise RuntimeError("Public DOL release could not be downloaded and verified; old pin retained") from error
    if result.returncode:
        print("Release command returned an error, but the exact public asset was recovered and verified.", flush=True)


def report(status, manifest):
    result = {"status": status, "fiscalYear": manifest["fiscalYear"], "quarter": manifest["quarter"],
              "records": manifest["records"], "employers": manifest["employers"],
              "source": manifest["source"]["url"]}
    print(json.dumps(result), flush=True)
    if os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as stream:
            stream.write(f"status={status}\n")
    return result


def refresh(publish_release=False, recheck=False):
    pinned = prepare.load_manifest()
    candidate = source.discover_latest(source.fetch_page(), minimum_period=pinned)
    validators = probe(candidate["url"])
    check = json.loads(CHECK_PATH.read_text()) if CHECK_PATH.exists() else {}
    if not recheck and unchanged(candidate, pinned, check, validators):
        return report("unchanged", pinned)
    cache = ROOT / ".cache"
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dol-refresh-", dir=cache) as temporary:
        staging = Path(temporary)
        workbook = ingest.download(candidate["url"], staging, refresh=True)
        workbook_sha = ingest.file_hash(workbook)
        if validators["bytes"] is not None and workbook.stat().st_size != validators["bytes"]:
            raise ValueError("DOL workbook does not match its declared size")
        after = probe(candidate["url"])
        if after != validators:
            raise ValueError("DOL workbook changed during retrieval; old snapshot retained")
        verified_check = {"version": 1, "url": candidate["url"], "sourceSha256": workbook_sha,
                          "validators": validators}
        if (workbook_sha == pinned["source"]["sha256"]
                and (candidate["fiscalYear"], candidate["quarter"]) == (pinned["fiscalYear"], pinned["quarter"])):
            if publish_release:
                atomic_json(CHECK_PATH, verified_check)
            return report("unchanged; workbook checksum verified", pinned)
        data = staging / "snapshot"
        subprocess.run(["python3", str(ROOT / "scripts/ingest-dol.py"), "--source", candidate["url"],
                        "--archive-dir", str(staging), "--output-dir", str(data)],
                       cwd=ROOT, check=True, timeout=420)
        index = json.loads((data / "career-index.json").read_text())
        validate_coverage(index, candidate, pinned)
        archive = staging / "career.tar.gz"
        digest = pack_snapshot(data, archive)
        tag = f"dol-fy{candidate['fiscalYear']}-q{candidate['quarter']}-{digest[:20]}"
        filename = f"career-fy{candidate['fiscalYear']}-q{candidate['quarter']}-{digest[:20]}.tar.gz"
        manifest = {"version": 1, "fiscalYear": candidate["fiscalYear"], "quarter": candidate["quarter"],
                    "sourcePage": source.SOURCE_PAGE, "source": index["sources"][0],
                    "archive": {"url": f"https://github.com/{REPOSITORY}/releases/download/{tag}/{filename}",
                                "sha256": digest},
                    "records": index["scope"]["records"], "employers": index["scope"]["employers"]}
        prepare.validate_manifest(manifest)
        prepare.validate_snapshot(data, manifest)
        prepare.verify_archive(archive, manifest)
        with tempfile.TemporaryDirectory(prefix="extract-check-", dir=staging) as extracted:
            prepare.extract_snapshot(archive, Path(extracted))
            prepare.validate_snapshot(Path(extracted), manifest)
        build_candidate(data, manifest, staging / "build")
        if not publish_release:
            return report("candidate validated; dry run only", manifest)
        publish(archive, manifest)
        # Only the small pin changes. The workflow's preparer installs the verified release.
        atomic_json(CHECK_PATH, verified_check)
        atomic_json(prepare.DEFAULT_MANIFEST, manifest)
        return report("updated", manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true", help="Publish validated changes using the existing GitHub CLI credentials")
    parser.add_argument("--recheck", action="store_true", help="Verify the current workbook even if HTTP validators are unchanged")
    args = parser.parse_args()
    refresh(args.publish, args.recheck)


if __name__ == "__main__":
    main()
