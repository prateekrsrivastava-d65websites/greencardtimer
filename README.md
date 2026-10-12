# Green Card Timer

An original, free public-data tool for employment and family priority dates, PERM/PWD processing times, employer profiles and H-1B salary disclosures. No accounts, paywalls or payment processor. Government-data calculations and searches run in the browser; optional community totals use one small Cloudflare Pages Function and D1 daily counters. Priority dates can be typed as `MM-DD-YYYY`; structured data and shared profile dates use ISO `YYYY-MM-DD`.

## Run

Requires Node 22+ and Python 3. Python uses only its standard library.

```sh
npm ci
npm run prepare:career
npm run dev
```

`npm test` checks cutoff rules, trend calculations, official data parsing, salary search, employer profiles, community privacy and API behavior, and build metadata. `npm run build` builds the UI using existing data. `npm run build:data` downloads and verifies the pinned public salary snapshot, runs the tests, then builds everything into `dist/`. `npm run preview` previews that output. Vite's dev and preview servers serve the government-data tools; the optional community API requires the Cloudflare Pages runtime and a `COMMUNITY_DB` binding. Direct DOL ingestion runs only when the scheduled updater discovers a new disclosure release, not on every production build.

## Deploy

Push this directory as the repository root. Connect the repository through [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/); this path does not require a deployment token in GitHub Actions.

- Build command: `npm run build:data`
- Output directory: `dist`
- Production branch: `main`
- Build image: v3, with `NODE_VERSION=22.16.0` and `PYTHON_VERSION=3.13.3`
- Set `SITE_URL` to the final HTTPS origin, such as your actual custom domain, to enable canonical links, `robots.txt`, and `sitemap.xml`. Without it, none of those domain-specific files or tags are generated.

The [current build image includes Python](https://developers.cloudflare.com/pages/configuration/build-image/). Attach the custom domain through the Cloudflare dashboard after the first successful deployment. Government tools remain static and bypass Functions. Only `/api/community` invokes a Function with the `COMMUNITY_DB` D1 binding. No KV, R2, paid API or GitHub deployment secret is needed. Free-tier limits still apply; a domain registration is separate.

CI tests and builds the small tracked source. Large salary outputs and raw DOL workbooks are deliberately ignored by Git. Production prepares the index and shards from a [public GitHub Release asset](https://github.com/prateekrsrivastava-d65websites/greencardtimer/releases), not by downloading and processing the large DOL workbook on every deployment. `data/career-release.json` pins the verified archive URL, SHA-256, source provenance and expected coverage. `scripts/prepare-career.py` verifies the downloaded bytes and dataset coverage and safely extracts only the expected files. A failed download, hash check, extraction, or test fails the build and leaves the last successful deployment intact. No paid storage service or private download token is needed.

Each snapshot contains a compact employer index and 256 fixed-prefix shards. The index retains the official workbook URL, byte count, SHA-256, release scope and exclusions; record and employer totals come from the actual release rather than hardcoded application values. The canonical source remains the [DOL OFLC disclosure register](https://www.dol.gov/agencies/eta/foreign-labor/performance). GitHub Releases are transport copies of derived public data, not replacement sources or competitor datasets.

## Data & Updates

- Visa bulletins: [official Department of State monthly tables](https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html), with a rolling 25-month history in `public/data/bulletins.json`. Each month has four tables and 100 tracked cells: employment and family Final Action Dates and Dates for Filing, five categories per group, and five chargeability columns. `C` and `U` are preserved. A dated cutoff requires a priority date strictly earlier than the cutoff.
- Family tracker: `/family-green-card/` covers F1, F2A, F2B, F3 and F4, with relationship descriptions, current cutoffs and monthly history. These are family preference categories, not the immediate-relative categories for U.S. citizens' spouses, unmarried children under 21, or parents. F1 is not the F-1 student visa. Numerical availability does not predict approval, an interview date, or National Visa Center instructions.
- Filing charts: verify [USCIS's separate monthly employment and family chart choices](https://www.uscis.gov/visabulletininfo) before any I-485 filing. `uscisEmploymentChart` and `uscisFamilyChart` are independent and remain unknown unless separately verified; the app never applies the employment selection to family cases or assumes Dates for Filing is permitted. A current cutoff does not mean an application will be approved.
- Salary disclosures: [DOL OFLC performance data](https://www.dol.gov/agencies/eta/foreign-labor/performance), automatically checked for new quarterly releases. The published quarter is cumulative, not an entire historical database. Included records are certified H-1B LCAs with annualized wages from $5,000 through $1,000,000; both full-time and part-time filings are included. Duplicate case numbers, other statuses/classes, and missing or unsupported wage units are excluded. These wages are disclosed offers, not evidence of visa issuance, individual earnings, or green-card sponsorship.
- Employment scenarios: source code and `public/data/model.json` describe rolling six-month historical cutoff rates. These are illustrative pace scenarios, not queue estimates, probability intervals, or guaranteed dates. Family categories retain cutoff history and movement without dated projections. No inaccessible USCIS inventory is invented.

The same bulletin workflow checks employment and family tables every Tuesday at 13:17 UTC and supports manual dispatch. It tries the canonical DOS host, then its openly published [adoption.state.gov](https://adoption.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html) and [adoptions.state.gov](https://adoptions.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html) publication hosts using ordinary HTTPS, without cookies, browser impersonation, proxies or challenge solving. These are State Department publications, not third-party data. Canonical source links and actual retrieval URLs are preserved. The current and recent editions are rechecked for corrections even when the upcoming bulletin already exists. All four employment/family tables, all 100 tracked cells and contiguous 25-month history must pass validation, tests and a build before any commit. A source or schema failure preserves both groups' last verified tables and both independent USCIS chart selections. Cloudflare's existing Git integration deploys committed changes without another token or service; family data comes from the same DOS pages, with no additional service or credentials.

[Standard GitHub-hosted runners are free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions); this workflow uses `ubuntu-latest`, not a paid larger runner. The existing Tuesday 13:17 UTC workflow checks bulletins, processing times and quarterly employer disclosures together: approximately 4-5 runs per month, bounded to 15 minutes per run. Unchanged published files create no commit. One genuine successful-check record per calendar month keeps repository activity below the [60-day scheduled-workflow inactivity limit](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), without changing the data verification date. Schedules can be delayed or dropped by GitHub, so this is a weekly check, not a guaranteed publication-time SLA. Each updater preserves its own last good data on failure; independently valid updates can still publish before the job reports the source failure. The Actions summary lists updater outcomes and retained source provenance. GitHub notification delivery follows the account's notification settings. The app warns when its latest bulletin is older than the current month.

Canonical DOS and USCIS downloads returned HTTP 403 during initial verification; the public DOS alternate hosts allow normal HTTP downloads. DOL returned HTTP 403 in the first Cloudflare build, so salary data uses the verified GitHub release snapshot prepared by the GitHub updater. No routine monthly or quarterly source-file edits are required. To check all sources now:

```sh
gh workflow run refresh-bulletins.yml
```

For exceptional source corrections, review the official bulletin and update the structured JSON with its source and verification date. Rebuild without a network fetch using:

```sh
npm run refresh:bulletins -- --offline
npm test
npm run build
```

Review and commit both data files. Never substitute an empty response or an invented queue.

`npm run refresh:employers` discovers quarterly LCA workbook links on the official disclosure register. After establishing a source baseline against the pinned workbook checksum, unchanged weekly releases need only the small HTML check and an HTTP `HEAD` metadata check when the source supports it. The updater records source validators in `data/career-source-check.json`; changes to `ETag` or `Last-Modified` trigger a checksum comparison so same-URL corrections can be detected without downloading the workbook every week. An unchanged downloaded checksum skips ingestion even if the server's metadata changed.

When a newer quarter, changed published URL or changed workbook checksum appears, the updater downloads the official workbook with bounded size and time, streams it with Python's standard library, and builds a complete candidate in a temporary directory. Schema, provenance, fiscal decision-date coverage and dataset completeness must validate before a content-addressed public GitHub Release asset is published and the manifest can change. The workflow tests and builds the result before committing it; Cloudflare's existing Git integration then deploys it. The runner's built-in `GITHUB_TOKEN` has the existing `contents: write` permission; no personal access token or additional secret is required.

Quarterly files are cumulative within a fiscal year, so the updater replaces the previous snapshot rather than combining overlapping quarters. A new fiscal year's Q1 can legitimately contain fewer records than the previous year's Q4; the published coverage follows the source. Existing releases stay available, and any discovery, download, schema or publication failure leaves the last verified manifest and live deployment in place. If DOL supplies no usable HTTP validators, the updater falls back to downloading and checking the checksum. `npm run refresh:employers -- --recheck` explicitly verifies the current workbook without publishing; add `--publish` to publish a validated correction. Source format changes or persistent blocked downloads can still require a code repair, reported as a failed workflow instead of publishing guessed data. Raw workbooks are neither committed nor uploaded as Actions artifacts.

## Additional Tools

`/processing-times/` reads `public/data/processing.json`, obtained with ordinary HTTPS from [official DOL FLAG processing times](https://flag.dol.gov/processingtimes). `npm run refresh:processing` validates both PERM and PWD tables, actual source dates, nullable entries and pending PWD counts before replacement. The existing weekly GitHub workflow checks this alongside bulletins. Failed sources preserve last good data; independent valid updates can still publish, then the job reports the failed source. History starts at the first observed snapshot, not fabricated earlier data. DOL queue months and averages do not predict a case decision.

`/employers/` reuses the existing LCA index and shards. All published employers have browser-rendered profiles; the largest 500 by certified filing count also get factual static HTML and sitemap entries. This avoids generating a file for every employer or adding a search backend. Corporate entities are not silently merged. Profiles show disclosed activity, not visa approvals or guaranteed green-card sponsorship. The quarterly salary and employer snapshot is automatically upgraded only after source and dataset validation; each deployment remains pinned to one verified release.

`/community/` publishes optional contribution histograms. Sharing starts unchecked, is disabled by DNT/GPC and never happens on initial rendering, chart toggles, saving, or browsing. The on-device helper sends only three enumerated fields: chargeability group, category and five-year priority-date range. The API rejects extra fields, query filters, oversized bodies and cross-origin requests. There are no exact dates, visitor identifiers, IP/user-agent fields, raw submissions or joint distributions in D1. The browser suppresses identical buckets within the tab and caps itself at 10 contributions; this is not robust bot detection or a unique-person measure.

Initialize `migrations/0001-community.sql` in the `greencardtimer-community` database, and bind it as `COMMUNITY_DB` in Pages production settings. The schema atomically updates one JSON rollup per UTC day with a 10,000-contribution daily cap. Public summaries cover the last 30 completed days, require 100 contributions, suppress bins under 20, round counts down to tens and show only a 100-wide total range. Today cannot alter today's published chart. These measures reduce disclosure risk, not establish formal anonymity. Rollups beyond 90 days are pruned upon the first contribution of a new day; idle records may remain longer. Platform operational logs are separate. No paid plan was enabled.

Functions are restricted by `public/_routes.json` so ordinary pages and data assets keep static hosting behavior. Free-tier exhaustion disables only optional counters; government tools keep working. There is no third-party analytics or advertising script. No synthetic events are inserted into production.

## Build Details

The postbuild step creates useful initial HTML and distinct metadata for nine base routes: the estimator, visa bulletin, family tracker, salary data, employer directory, PERM/PWD tracker, community, methodology and privacy pages. It also creates 500 employer profile pages from the full pinned release, for 509 routes in the production sitemap when `SITE_URL` is configured. All other employers remain available through browser-rendered profiles without generating tens of thousands of files.

`/visa-bulletin/` includes all four latest employment/family tables; `/family-green-card/` includes both family tables and category descriptions. The processing and employer pages include their sourced facts and essential limitations in the initial HTML. These remain readable without JavaScript; the client then replaces the main content with the interactive tool. The static community page explains its privacy rules but does not fabricate live totals.

The build uses Lucide's icon data for the favicon. Security headers apply to every static response; JSON has a five-minute cache lifetime, and only exact content-hashed build assets receive one-year immutable caching. Government-data tools require no runtime data service. The sole runtime exception is the optional `/api/community` Pages Function with D1 aggregate counters; all other routes bypass Functions. No third-party scripts are loaded.

Future advertising anchors are between content sections and hidden while empty. No ad scripts are loaded. Enable advertising only after updating privacy/consent controls, security policy and fixed responsive placement dimensions. AdSense approval is not assumed.
