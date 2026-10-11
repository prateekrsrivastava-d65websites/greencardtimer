# Green Card Timer

An original, free public-data tool. No accounts, paywalls, payment processor, application analytics, or backend database. Priority-date calculations and salary searches run in the browser; preferences stay in local storage.

## Run

Requires Node 22+ and Python 3. Python uses only its standard library.

```sh
npm ci
npm run prepare:career
npm run dev
```

`npm test` checks cutoff rules, trend calculations, data parsing, salary search, and build metadata. `npm run build` builds the UI using existing data. `npm run build:data` downloads and verifies the pinned public salary snapshot, runs the tests, then builds everything into `dist/`. `npm run preview` previews that output. Direct DOL ingestion is a maintainer update command, not a production build dependency.

## Deploy

Push this directory as the repository root. Connect the repository through [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/); this path does not require a deployment token in GitHub Actions.

- Build command: `npm run build:data`
- Output directory: `dist`
- Production branch: `main`
- Build image: v3, with `NODE_VERSION=22.16.0` and `PYTHON_VERSION=3.13.3`
- Set `SITE_URL` to the final HTTPS origin, such as your actual custom domain, to enable canonical links, `robots.txt`, and `sitemap.xml`. Without it, none of those domain-specific files or tags are generated.

The [current build image includes Python](https://developers.cloudflare.com/pages/configuration/build-image/). Attach the custom domain through the Cloudflare dashboard after the first successful deployment. This is a static app: no KV, D1, R2, Worker, paid API, or secrets are needed for serving it. Free-tier limits still apply; a domain registration is separate.

CI tests and builds the small tracked source. Large salary outputs are deliberately ignored by Git. Production prepares them from the [public FY2026 Q3 snapshot release](https://github.com/prateekrsrivastava-d65websites/greencardtimer/releases/tag/dol-fy2026-q3), not by downloading the 252 MB DOL workbook on every deployment. The approximately 14 MB `career-fy2026-q3.tar.gz` archive has pinned SHA-256 `441175780e4353549243b96feaa94c6f2aeb6be5500011a78b2022d02f65f724`. `scripts/prepare-career.py` pins its download URL and hash, verifies the bytes and dataset coverage, and safely extracts only the expected data. Local verified extraction took 0.94 seconds; hosted download performance remains to be measured. A failed download, hash check, extraction, or test fails the build and leaves the last successful deployment intact. No paid storage service or private download token is needed.

The full FY2026 Q3 snapshot contains 391,764 certified H-1B cases, 53,787 employers, a 4.65 MB index, and 256 shards totaling 75 MB, each below 3 MB. Its index retains the official workbook URL, byte count, SHA-256, release scope, and exclusions. The canonical source is the [DOL FY2026 Q3 LCA workbook](https://www.dol.gov//media/LCA_Disclosure_Data_FY2026_Q3.xlsx), with source SHA-256 `f8ca8448a528671f784d3692923775a13741c99caec2816b2fe30c8885bd28b3`. The release is a transport copy of derived public data, not a replacement source or a competitor dataset.

## Data & Updates

- Visa bulletins: [official Department of State monthly tables](https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html), with 25 sourced months from October 2024 through October 2026 in `public/data/bulletins.json`. `C` and `U` are preserved. A dated cutoff requires a priority date strictly earlier than the cutoff.
- Filing chart: verify [USCIS's monthly chart choice](https://www.uscis.gov/visabulletininfo) before any I-485 filing. The app marks the choice unknown instead of assuming Dates for Filing is permitted. A current cutoff does not mean an application will be approved.
- Salary disclosures: [DOL OFLC performance data](https://www.dol.gov/agencies/eta/foreign-labor/performance). The configured quarter is cumulative, not an entire historical database. Included records are certified H-1B LCAs with annualized wages from $5,000 through $1,000,000; both full-time and part-time filings are included. Duplicate case numbers, other statuses/classes, and missing or unsupported wage units are excluded. These wages are disclosed offers, not evidence of visa issuance, individual earnings, or green-card sponsorship.
- Scenarios: source code and `public/data/model.json` describe rolling six-month historical cutoff rates. These are illustrative pace scenarios, not queue estimates, probability intervals, or guaranteed dates. No inaccessible USCIS inventory is invented.

The bulletin workflow supports manual dispatch. Its schedule is deliberately disabled because the first GitHub fetch returned HTTP 403; there is no useful reason to run a known-blocked job every day. Successful fetches must validate both employment tables, every tracked cell, and contiguous history before tests/build and a commit of changed bulletin/model files. Unchanged source tables do not create timestamp-only commits. Plan on a reviewed monthly manual commit until a real runner fetch succeeds. The app warns when its latest verified bulletin is older than the current month.

Direct access to DOS and USCIS returned HTTP 403 during local verification; DOL returned HTTP 403 in the first Cloudflare build. This is why production uses the verified GitHub salary snapshot. Fetch errors and unexpected table formats fail closed without replacing tracked bulletin data. For the monthly manual update, review the official bulletin, update the structured JSON with its source URL and verification date, then run:

```sh
npm run refresh:bulletins -- --offline
npm test
npm run build
```

Review and commit both data files. Never substitute an empty response or an invented queue.

For a new DOL quarter, verify the official disclosure URL, update the ingester's configured source, and run `npm run ingest:dol -- --refresh` locally, or on a GitHub runner if DOL permits access from that runner. Do not combine cumulative quarters from the same fiscal year. The stdlib ingester streams the workbook; a full cached run measured 96 seconds and about 550 MiB peak RAM locally. Review the output manifest and tests, create a new public GitHub Release containing the derived index and shards, then pin its asset URL and SHA-256 in the prepare script and commit that change. Preserve the upstream workbook provenance. `.cache/dol` only avoids repeated downloads when that local directory survives.

## Build Details

The postbuild step creates useful initial route HTML and distinct metadata for the estimator, visa bulletin, salary data, methodology, and privacy pages. Latest sourced tables and essential rules remain readable before JavaScript loads; the client then replaces the main content with the interactive tool. It uses Lucide's icon data for the favicon. Security headers apply to every static response; JSON refreshes after five minutes, and only exact content-hashed build assets receive one-year immutable caching. No third-party scripts or runtime data services are required.

Future advertising anchors are between content sections and hidden while empty. No ad scripts are loaded. Enable advertising only after updating privacy/consent controls, security policy and fixed responsive placement dimensions. AdSense approval is not assumed.
