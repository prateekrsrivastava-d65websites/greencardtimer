import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModelData } from '../src/model.js';
import { discoverBulletins, fetchOfficialHTML, refresh } from '../scripts/refresh-bulletins.mjs';

const template = JSON.parse(await readFile(new URL('../public/data/model.json', import.meta.url), 'utf8'));
const metadata = JSON.parse(await readFile(new URL('../public/data/bulletins.json', import.meta.url), 'utf8'));
const categories = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5'];
const countries = ['ROW', 'China', 'India', 'Mexico', 'Philippines'];
const labels = { EB1: '1st', EB2: '2nd', EB3: '3rd', EB3OW: 'Other Workers', EB5: '5th Unreserved' };
const now = new Date('2030-10-15T13:17:00Z');

function monthsEnding(month, length = 25) {
  const date = new Date(`${month}-01T00:00:00Z`);
  return Array.from({ length }, () => {
    const result = date.toISOString().slice(0, 7);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return result;
  });
}

function bulletin(month) {
  const date = new Date(`${month}-01T00:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
  const year = date.getUTCFullYear();
  const fiscalYear = year + (date.getUTCMonth() >= 9 ? 1 : 0);
  return { month, label: `${name} ${year}`, sourceUrl: `https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/${fiscalYear}/visa-bulletin-for-${name.toLowerCase()}-${year}.html`,
    publishedAt: null, verifiedAt: '2030-10-02', uscisEmploymentChart: null, uscisSourceUrl: 'https://www.uscis.gov/visabulletininfo',
    charts: Object.fromEntries(['finalAction', 'filing'].map(chart => [chart, Object.fromEntries(categories.map(category => [category, Object.fromEntries(countries.map(country => [country, '2001-01-01']))]))])) };
}

function htmlFor(value) {
  const token = date => date === '2001-01-01' ? '01JAN01' : date === '2001-02-01' ? '01FEB01' : date;
  const tables = ['finalAction', 'filing'].map(chart => `<p>${chart === 'finalAction' ? 'A. FINAL ACTION DATES FOR EMPLOYMENT-BASED PREFERENCE CASES' : 'B. DATES FOR FILING OF EMPLOYMENT-BASED VISA APPLICATIONS'}</p><table><tr><th>Employment-based</th><th>All Chargeability Areas Except Those Listed</th><th>CHINA-mainland born</th><th>INDIA</th><th>MEXICO</th><th>PHILIPPINES</th></tr>${categories.map(category => `<tr><td>${labels[category]}</td>${countries.map(country => `<td>${token(value.charts[chart][category][country])}</td>`).join('')}</tr>`).join('')}</table>`).join('');
  return `<html><body><h1>Visa Bulletin For ${value.label}</h1>${tables}</body></html>`;
}

function source(values, { malformedMonth, missingIndexMonth } = {}) {
  const calls = [];
  const pages = new Map(values.map(value => [new URL(value.sourceUrl).pathname, value.month === malformedMonth ? '<html>Changed format</html>' : htmlFor(value)]));
  const index = values.filter(value => value.month !== missingIndexMonth).map(value => `<a href="${value.sourceUrl}">${value.label}</a>`).join('');
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.hostname === 'travel.state.gov') return new Response('Forbidden', { status: 403 });
    const html = parsed.pathname.endsWith('/visa-bulletin.html') ? index : pages.get(parsed.pathname);
    return new Response(html ?? 'Not found', { status: html ? 200 : 404, headers: { 'content-type': 'text/html' } });
  } };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'greencardtimer-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = monthsEnding('2030-10').map(bulletin);
  const data = { ...metadata, generatedAt: '2030-10-02', latestMonth: values[0].month, bulletins: values };
  delete data.refresh;
  await mkdir(join(root, 'public/data'), { recursive: true });
  const bulletinPath = join(root, 'public/data/bulletins.json');
  const modelPath = join(root, 'public/data/model.json');
  await writeFile(bulletinPath, `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(modelPath, `${JSON.stringify(buildModelData(data, template), null, 2)}\n`);
  return { root, values, bulletinPath, modelPath };
}

test('official fallback uses normal HTTPS, fixed hosts and explicit provenance', async () => {
  const mock = source([bulletin('2030-10')]);
  const result = await fetchOfficialHTML(bulletin('2030-10').sourceUrl, mock.fetchImpl);
  assert.equal(new URL(result.retrievedFrom).hostname, 'adoption.state.gov');
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].options.redirect, 'error');
  assert.match(mock.calls[0].options.headers['User-Agent'], /GreenCardTimer/);
  for (const invalid of ['https://example.com/bulletin', 'http://travel.state.gov/bulletin', 'https://user:pass@travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html']) {
    await assert.rejects(fetchOfficialHTML(invalid, mock.fetchImpl), /official State Department/);
  }
  const links = discoverBulletins(`<a href="${bulletin('2030-10').sourceUrl.replace('travel.state.gov', 'adoptions.state.gov')}">Official</a><a href="${bulletin('2030-11').sourceUrl.replace('travel.state.gov', 'evil.state.gov')}">Other</a>`);
  assert.deepEqual(links, [{ month: '2030-10', url: bulletin('2030-10').sourceUrl }]);
});

test('successful weekly checks are idempotent and do not advance data verification', async t => {
  const fixture = await setup(t);
  const mock = source(fixture.values);
  const first = await refresh({ ...fixture, fetchImpl: mock.fetchImpl, now });
  assert.equal(first.changed, true);
  const before = await readFile(fixture.bulletinPath, 'utf8');
  const data = JSON.parse(before);
  assert.equal(data.generatedAt, '2030-10-02');
  assert.equal(data.bulletins[0].verifiedAt, '2030-10-02');
  assert.equal(data.refresh.checkedAt, '2030-10-15');
  const second = await refresh({ ...fixture, fetchImpl: mock.fetchImpl, now: new Date('2030-10-22T13:17:00Z') });
  assert.equal(second.changed, false);
  assert.equal(await readFile(fixture.bulletinPath, 'utf8'), before);
});

test('a misleading HTTP 200 or stale index tries the healthy official fallback', async t => {
  for (const failure of ['challenge', 'stale-index', 'malformed-table']) {
    const fixture = await setup(t);
    const mock = source(fixture.values);
    const fetchImpl = (url, options) => {
      if (new URL(url).hostname !== 'travel.state.gov') return mock.fetchImpl(url, options);
      let html = '<html>Just a moment</html>';
      if (failure === 'stale-index') html = fixture.values.slice(1).map(value => `<a href="${value.sourceUrl}">Older</a>`).join('');
      if (failure === 'malformed-table' && url.endsWith('/visa-bulletin.html')) html = fixture.values.map(value => `<a href="${value.sourceUrl}">Bulletin</a>`).join('');
      return Promise.resolve(new Response(html, { headers: { 'content-type': 'text/html' } }));
    };
    await refresh({ ...fixture, fetchImpl, now });
    const data = JSON.parse(await readFile(fixture.bulletinPath, 'utf8'));
    assert.equal(data.latestMonth, '2030-10');
    assert.equal(new URL(data.refresh.latestRetrievedFrom).hostname, 'adoption.state.gov');
  }
});

test('a new monthly bulletin rolls history and also checks the current edition for corrections', async t => {
  const fixture = await setup(t);
  const current = structuredClone(fixture.values[0]);
  current.charts.finalAction.EB2.India = '2001-02-01';
  const mock = source([bulletin('2030-11'), current, ...fixture.values.slice(1)]);
  await refresh({ ...fixture, fetchImpl: mock.fetchImpl, now });
  const data = JSON.parse(await readFile(fixture.bulletinPath, 'utf8'));
  assert.equal(data.latestMonth, '2030-11');
  assert.equal(data.bulletins.length, 25);
  assert.equal(data.bulletins.at(-1).month, '2028-11');
  assert.equal(data.bulletins[1].charts.finalAction.EB2.India, '2001-02-01');
  assert.equal(data.generatedAt, '2030-10-15');
  const model = JSON.parse(await readFile(fixture.modelPath, 'utf8'));
  assert.equal(model.bulletinMonth, '2030-11');
  assert.deepEqual(model.series, buildModelData(data, model).series);
});

test('a genuine monthly successful-check record changes without changing cutoff dates', async t => {
  const fixture = await setup(t);
  const mock = source([bulletin('2030-11'), ...fixture.values]);
  await refresh({ ...fixture, fetchImpl: mock.fetchImpl, now });
  const result = await refresh({ ...fixture, fetchImpl: mock.fetchImpl, now: new Date('2030-11-05T13:17:00Z') });
  const data = JSON.parse(await readFile(fixture.bulletinPath, 'utf8'));
  assert.equal(result.changed, true);
  assert.equal(data.refresh.checkedAt, '2030-11-05');
  assert.equal(data.generatedAt, '2030-10-15');
});

test('fetch failures, malformed tables, gaps and stale or unexpected months preserve both files', async t => {
  for (const failure of ['network', 'table', 'gap', 'stale', 'future', 'rollback', 'truncated']) {
    const fixture = await setup(t);
    const before = await readFile(fixture.bulletinPath, 'utf8');
    const modelBefore = await readFile(fixture.modelPath, 'utf8');
    const values = failure === 'future' ? monthsEnding('2030-12').map(bulletin) : failure === 'rollback' ? fixture.values.slice(1) : failure === 'truncated' ? fixture.values.slice(0, 13) : fixture.values;
    const mock = source(values, { malformedMonth: failure === 'table' ? '2030-10' : null, missingIndexMonth: failure === 'gap' ? '2030-05' : null });
    const fetchImpl = failure === 'network' ? async () => { throw new Error('Network unavailable'); } : mock.fetchImpl;
    await assert.rejects(refresh({ ...fixture, fetchImpl, now: failure === 'stale' ? new Date('2030-11-05T13:17:00Z') : now }));
    assert.equal(await readFile(fixture.bulletinPath, 'utf8'), before, failure);
    assert.equal(await readFile(fixture.modelPath, 'utf8'), modelBefore, failure);
  }
});
