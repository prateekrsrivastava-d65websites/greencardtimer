import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { assetCacheRules, employerRoute, faviconMarkup, initialContent, postbuild, ROUTES, routeHTML, siteOrigin } from '../scripts/postbuild.mjs';
import { samePublishedBulletin } from '../scripts/refresh-bulletins.mjs';
import { formatDate } from '../src/model.js';
import { buildEmployerProfile, employerProfilePath, employerSalaryPath } from '../src/career.js';

const bulletinData = JSON.parse(readFileSync(new URL('../public/data/bulletins.json', import.meta.url), 'utf8'));

test('processing route publishes sourced queue and prevailing wage tables without forecasts', () => {
  const processingData = JSON.parse(readFileSync(new URL('../public/data/processing.json', import.meta.url),'utf8'));
  const route = ROUTES.find(r => r.path === '/processing-times/');
  const $ = load(initialContent(route,{processingData}));
  assert.equal($('table').length,3);
  assert.equal($('table').first().find('tbody tr').length,7);
  assert.match($.text(),/not pending PERM labor-certification cases/);
  assert.match($.text(),/not a live case lookup/);
  assert.match($.text(),new RegExp(String(processingData.current.perm.averages.analystReview.days)));
  assert.equal($('a').first().attr('href'),'https://flag.dol.gov/processingtimes');
});

test('community and privacy static pages disclose optional aggregation without fabricated counts', () => {
  const community = load(initialContent(ROUTES.find(r=>r.path==='/community/')));
  const privacy = load(initialContent(ROUTES.find(r=>r.path==='/privacy/')));
  for (const text of [community.text(),privacy.text()]) {
    assert.match(text,/unchecked/);
    assert.match(text,/100 contributions/);
    assert.match(text,/groups below 20/);
    assert.match(text,/five-year date range/);
  }
  assert.equal(community('table').length,0);
  assert.match(privacy.text(),/inactive rollups may remain longer/);
  assert.match(privacy.text(),/Global Privacy Control/);
});
const employer = { id: 'abcdef0123456789', name: 'EXAMPLE & SONS <script>bad</script>', filings: 2, median: 150000 };
const employerRows = [
  { id: 'case-1', title: 'Software Engineer', city: 'Sunnyvale', state: 'CA', wage: 100000, date: '2026-01-01', decisionDate: '2026-01-08', fullTime: true, status: 'Certified' },
  { id: 'case-2', title: '<img src=x onerror=bad()>', city: 'New York', state: 'NY', wage: 200000, date: '2026-02-01', decisionDate: '2026-02-08', fullTime: false, status: 'Certified' },
];
const careerFixture = {
  employers: [employer], scope: { label: 'FY2026_Q3', records: 2, employers: 1 },
  sources: [{ url: 'https://www.dol.gov/official-disclosure.xlsx' }], generatedAt: '2026-10-11T00:00:00Z', shardPrefixLength: 2,
};

test('route metadata uses configured real origin only', () => {
  const html = '<!doctype html><html><head><title>Old</title><meta name="description" content="Old"><link rel="canonical" href="https://old.example/"></head><body><script type="module" src="/assets/app-abc12345.js"></script></body></html>';
  const route = ROUTES.find(item => item.path === '/visa-bulletin/');
  const $ = load(routeHTML(html, route, 'https://timer.example'));
  assert.equal($('title').text(), route.title);
  assert.equal($('meta[name="description"]').length, 1);
  assert.equal($('link[rel="canonical"]').attr('href'), 'https://timer.example/visa-bulletin/');
  assert.equal($('script').attr('src'), '/assets/app-abc12345.js');
  const withoutOrigin = load(routeHTML(html, route));
  assert.equal(withoutOrigin('link[rel="canonical"], meta[property="og:url"]').length, 0);
});

test('site origin rejects placeholder paths and credentials', () => {
  assert.equal(siteOrigin(''), null);
  assert.equal(siteOrigin('https://timer.example/'), 'https://timer.example');
  for (const value of ['ftp://timer.example', 'https://timer.example/path', 'https://user:password@timer.example', 'https://timer.example/?query']) {
    assert.throws(() => siteOrigin(value));
  }
});

test('immutable caching is limited to hashed build assets', () => {
  const rules = assetCacheRules(['app-Abc_1234.js', 'app-Abc_1234.css', 'logo.svg', 'data.json']);
  assert.match(rules, /\/assets\/app-Abc_1234\.js/);
  assert.match(rules, /immutable/);
  assert.doesNotMatch(rules, /logo\.svg|data\.json|\/assets\/\*/);
});

test('favicon is generated from a valid Lucide icon tree', () => {
  const $ = load(faviconMarkup(), { xmlMode: true });
  assert.equal($('svg').attr('viewBox'), '0 0 24 24');
  assert.equal($('svg').attr('stroke'), '#16765c');
  assert.ok($('svg').children().length > 0);
});

test('initial bulletin HTML publishes four sourced employment and family tables with one hundred cells', () => {
  const route = ROUTES.find(item => item.path === '/visa-bulletin/');
  const $ = load(initialContent(route, { bulletinData }));
  assert.equal($('table').length, 4);
  assert.equal($('tbody tr').length, 20);
  assert.equal($('tbody td').length, 100);
  assert.deepEqual($('table').map((_, table) => $(table).attr('aria-label')).get(), [
    'Employment-Based Final Action Dates', 'Employment-Based Dates for Filing',
    'Family-Sponsored Final Action Dates', 'Family-Sponsored Dates for Filing',
  ]);
  const latest = bulletinData.bulletins.find(bulletin => bulletin.month === bulletinData.latestMonth);
  assert.ok($.text().includes(latest.label));
  assert.match($.text(), /strictly earlier/);
  assert.equal($('a').first().attr('href'), latest.sourceUrl);
});

test('family route publishes the current fifty-cell tables and category definitions without JavaScript', () => {
  const route = ROUTES.find(item => item.path === '/family-green-card/');
  const latest = bulletinData.bulletins.find(bulletin => bulletin.month === bulletinData.latestMonth);
  const $ = load(routeHTML('<html><head><title>Old</title></head><body><main id="main"></main></body></html>', route, 'https://timer.example', { bulletinData }));
  assert.equal($('title').text(), 'Family-Based Green Card Tracker | Green Card Timer');
  assert.equal($('h1').text(), 'Family-Based Green Card Tracker');
  assert.equal($('link[rel="canonical"]').attr('href'), 'https://timer.example/family-green-card/');
  assert.equal($('script').length, 0);
  assert.equal($('table').length, 2);
  assert.equal($('tbody tr').length, 10);
  assert.equal($('tbody td').length, 50);
  assert.ok($.text().includes(latest.label));
  const categories = bulletinData.categories.filter(item => item.group === 'family');
  const expectedCells = ['finalAction', 'filing'].flatMap(chart => categories.flatMap(category =>
    bulletinData.countries.map(country => formatDate(latest.charts[chart][category.id][country.id]))));
  assert.deepEqual($('tbody td').map((_, cell) => $(cell).text()).get(), expectedCells);
  for (const category of categories) {
    assert.equal(typeof category.description, 'string');
    assert.notEqual(category.description.trim(), '');
    assert.ok($('dt').toArray().some(element => $(element).text() === category.label));
    assert.ok($.text().includes(category.description));
  }
  assert.match($.text(), /annual and per-country numerical limits/);
  assert.match($.text(), /not the immediate-relative categories/);
  assert.match($.text(), /does not establish an approval or interview date/);
  assert.equal($('a').first().attr('href'), latest.sourceUrl);
  assert.equal(load(initialContent(ROUTES[0], { bulletinData }))('a[href="/family-green-card/"]').length, 1);
});

test('family initial HTML never borrows the employment USCIS chart choice', () => {
  const route = ROUTES.find(item => item.path === '/family-green-card/');
  const data = structuredClone(bulletinData);
  const latest = data.bulletins.find(bulletin => bulletin.month === data.latestMonth);
  latest.uscisEmploymentChart = 'filing';
  latest.uscisFamilyChart = null;
  const choice = () => {
    const $ = load(initialContent(route, { bulletinData: data }));
    return $('p').map((_, element) => $(element).text()).get().find(text => text.startsWith('USCIS family I-485 chart choice:'));
  };
  assert.match(choice(), /Unknown; not independently verified/);
  latest.uscisFamilyChart = 'finalAction';
  assert.match(choice(), /^USCIS family I-485 chart choice: Final Action Dates\./);
});

test('postbuild writes the family route and includes it in the canonical sitemap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'greencardtimer-postbuild-'));
  try {
    await mkdir(join(root, 'public'), { recursive: true });
    await mkdir(join(root, 'dist/data'), { recursive: true });
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await writeFile(join(root, 'public/_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    await writeFile(join(root, 'dist/index.html'), '<html><head><title>Old</title></head><body><main id="main"></main></body></html>');
    await writeFile(join(root, 'dist/data/bulletins.json'), JSON.stringify(bulletinData));
    const result = await postbuild({ root, siteURL: 'https://timer.example' });
    assert.deepEqual(result, { routes: ROUTES.length, sitemap: true });
    const sitemap = load(await readFile(join(root, 'dist/sitemap.xml'), 'utf8'), { xmlMode: true });
    assert.equal(sitemap('url').length, ROUTES.length);
    assert.ok(sitemap('loc').toArray().some(element => sitemap(element).text() === 'https://timer.example/family-green-card/'));
    const family = load(await readFile(join(root, 'dist/family-green-card/index.html'), 'utf8'));
    assert.equal(family('title').text(), 'Family-Based Green Card Tracker | Green Card Timer');
    assert.equal(family('tbody td').length, 50);
    assert.equal(family('link[rel="canonical"]').attr('href'), 'https://timer.example/family-green-card/');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('initial salary HTML identifies full release scope without inventing absent counts', () => {
  const route = ROUTES.find(item => item.path === '/salary-data/');
  const data = { scope: { label: 'FY2026_Q3', records: 391764, employers: 53787, decisionFrom: '2025-10-01', decisionTo: '2026-06-30' } };
  const html = initialContent(route, { careerData: data });
  assert.match(html, /391,764/);
  assert.match(html, /53,787/);
  assert.match(html, /\$5,000 through \$1,000,000/);
  assert.match(html, /Both full-time and part-time filings are included/);
  assert.doesNotMatch(initialContent(route), /391,764|53,787|NaN/);
});

test('initial employer HTML contains sourced case and wage tables without JavaScript or injected markup', () => {
  const employerProfile = buildEmployerProfile({ ...careerFixture, employer, rows: employerRows });
  const route = employerRoute(employerProfile);
  const $ = load(routeHTML('<html><head><title>Old</title></head><body><main id="main"></main></body></html>', route, 'https://timer.example', { employerProfile }));
  assert.equal($('h1').text(), `${employer.name} H-1B Filing Profile`);
  assert.equal($('link[rel="canonical"]').attr('href'), `https://timer.example${employerProfile.path}`);
  assert.equal($('title').text(), `${employer.name} H-1B Filings & Salaries | Green Card Timer`);
  assert.equal($('script, img').length, 0);
  assert.equal($('table').length, 5);
  assert.match($.text(), /\$150,000/);
  assert.match($.text(), /1 full-time and 1 part-time filings/);
  assert.match($.text(), /2026-01/);
  assert.match($.text(), /2026-02/);
  assert.ok($.text().includes(employerRows[1].title));
  assert.match($.text(), /approval rate cannot be calculated/);
  assert.match($.text(), /counts are cases, not hires, employees or visas issued/);
  assert.match($.text(), /not a complete employer history/);
  assert.equal($('a').first().attr('href'), careerFixture.sources[0].url);
});

test('employer directory links published profiles and tolerates missing salary data', () => {
  const route = ROUTES.find(item => item.path === '/employers/');
  const $ = load(initialContent(route, { careerData: careerFixture }));
  assert.equal($('tbody tr').length, 1);
  assert.equal($('tbody a').attr('href'), employerProfilePath(employer));
  assert.equal($('script').length, 0);
  const missing = load(initialContent(route));
  assert.equal(missing('table').length, 0);
  assert.doesNotMatch(missing.text(), /NaN|undefined/);
});

test('postbuild generates selected employer profiles and includes the actual route count in the sitemap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'greencardtimer-employers-'));
  try {
    await mkdir(join(root, 'public'), { recursive: true });
    await mkdir(join(root, 'dist/data/career'), { recursive: true });
    await mkdir(join(root, 'dist/assets'), { recursive: true });
    await writeFile(join(root, 'public/_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
    await writeFile(join(root, 'dist/index.html'), '<html><head><title>Old</title></head><body><main id="main"></main></body></html>');
    await writeFile(join(root, 'dist/data/bulletins.json'), JSON.stringify(bulletinData));
    await writeFile(join(root, 'dist/data/career-index.json'), JSON.stringify(careerFixture));
    const columns = Object.keys(employerRows[0]);
    await writeFile(join(root, 'dist/data/career/ab.json'), JSON.stringify({ columns, employers: { [employer.id]: { name: employer.name, rows: employerRows.map(row => columns.map(column => row[column])) } } }));
    const result = await postbuild({ root, siteURL: 'https://timer.example' });
    assert.deepEqual(result, { routes: ROUTES.length + 1, sitemap: true });
    const sitemap = load(await readFile(join(root, 'dist/sitemap.xml'), 'utf8'), { xmlMode: true });
    assert.equal(sitemap('url').length, result.routes);
    const path = employerProfilePath(employer);
    assert.ok(sitemap('loc').toArray().some(element => sitemap(element).text() === `https://timer.example${path}`));
    const profile = load(await readFile(join(root, `dist${path}index.html`), 'utf8'));
    assert.equal(profile('tbody').length, 5);
    assert.equal(profile('link[rel="canonical"]').attr('href'), `https://timer.example${path}`);
    assert.equal(profile(`a[href="${employerSalaryPath(employer.id)}"]`).length, 1);
    const directory = load(await readFile(join(root, 'dist/employers/index.html'), 'utf8'));
    assert.equal(directory('tbody a').attr('href'), path);
    const broken = { columns, employers: { [employer.id]: { name: employer.name, rows: [] } } };
    await writeFile(join(root, 'dist/data/career/ab.json'), JSON.stringify(broken));
    await assert.rejects(postbuild({ root }), /Employer shard does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unchanged bulletin tables ignore key order and verification-only timestamps', () => {
  const published = bulletinData.bulletins[0];
  for (const cutoff of [published.charts.finalAction.EB2.India, 'C', 'U', '2013-12-01']) {
    const old = structuredClone(published);
    old.charts.finalAction.EB2.India = cutoff;
    const next = structuredClone(old);
    next.verifiedAt = old.verifiedAt === '2000-01-01' ? '2000-01-02' : '2000-01-01';
    next.charts.finalAction.EB2 = Object.fromEntries(Object.entries(next.charts.finalAction.EB2).reverse());
    assert.equal(samePublishedBulletin(old, next), true);
    next.charts.finalAction.EB2.India = cutoff === 'C' ? 'U' : 'C';
    assert.equal(samePublishedBulletin(old, next), false);
  }
});
