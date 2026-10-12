import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { buildCommunitySummary, buildSearchContribution, communityWindow, validContribution } from '../src/community.js';
import { INSERT_CONTRIBUTION_SQL, onRequest } from '../functions/api/community.js';

const migration = await readFile(new URL('../migrations/0001-community.sql', import.meta.url), 'utf8');
const origin = 'https://greencardtimer.pages.dev';
const sample = { country: 'India', category: 'EB2', priorityPeriod: '2015-2019' };
const today = () => new Date().toISOString().slice(0, 10);

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let parameters = {};
      return {
        // Node 22.16 treats numbered placeholders as named, unlike later releases.
        bind(...values) { parameters = Object.fromEntries(values.map((value, index) => [`?${index + 1}`, value])); return this; },
        async run() { return { success: true, meta: { changes: Number(statement.run(parameters).changes) } }; },
        async all() { return { success: true, results: statement.all(parameters) }; },
      };
    },
  };
}

function add(db, day, contribution = sample) {
  return db.prepare(INSERT_CONTRIBUTION_SQL).bind(
    day, contribution.country, contribution.category, contribution.priorityPeriod,
    `$.countries.${contribution.country}`, `$.categories.${contribution.category}`, `$.priorityPeriods."${contribution.priorityPeriod}"`,
  ).run();
}

function context(db, { method = 'GET', body, headers = {}, path = '/api/community' } = {}) {
  return {
    request: new Request(`${origin}${path}`, {
      method,
      headers: method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers } : headers,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    env: db ? { COMMUNITY_DB: db } : {},
  };
}

function row(day, counts) {
  const counters = { countries: {}, categories: {}, priorityPeriods: {} };
  let total = 0;
  for (const [contribution, count] of counts) {
    total += count;
    for (const [dimension, id] of [['countries', contribution.country], ['categories', contribution.category], ['priorityPeriods', contribution.priorityPeriod]]) counters[dimension][id] = (counters[dimension][id] ?? 0) + count;
  }
  return { day, total, counters: JSON.stringify(counters) };
}

test('community contributions bucket valid dates locally and send only three coarse fields', () => {
  for (const [priorityDate, priorityPeriod] of [
    ['1999-12-31', 'before2000'], ['2000-01-01', '2000-2004'], ['2004-12-31', '2000-2004'], ['2005-01-01', '2005-2009'],
    ['2010-01-01', '2010-2014'], ['2019-12-31', '2015-2019'], ['2024-02-29', '2020-2024'], ['2029-12-31', '2025-2029'], ['2030-01-01', '2030plus'],
  ]) {
    assert.deepEqual(buildSearchContribution({ ...sample, priorityDate, chart: 'filing', filingPath: 'aos' }), { country: 'India', category: 'EB2', priorityPeriod });
  }
  for (const profile of [null, {}, { ...sample, priorityDate: '2025-02-29' }, { ...sample, priorityDate: '02-29-2024' }, { ...sample, country: 'Unknown', priorityDate: '2024-02-29' }, { ...sample, category: 'F5', priorityDate: '2024-02-29' }]) assert.equal(buildSearchContribution(profile), null);
});

test('the server rejects exact dates, identifiers, unrecognized bins and extra fields', () => {
  assert.equal(validContribution(sample), true);
  assert.equal(validContribution({ ...sample, category: 'F2A', country: 'ROW', priorityPeriod: 'before2000' }), true);
  for (const value of [null, [], 'India', {}, { ...sample, priorityDate: '2015-01-01' }, { ...sample, ip: '127.0.0.1' }, { ...sample, country: 'US' }, { ...sample, category: 'H1B' }, { ...sample, priorityPeriod: '2015-01-01' }, { ...sample, priorityPeriod: 2015 }]) assert.equal(validContribution(value), false);
});

test('the public window is exactly thirty completed UTC days including across year boundaries', () => {
  assert.deepEqual(communityWindow('2026-01-01T23:59:59Z'), { from: '2025-12-02', through: '2025-12-31', days: 30 });
  assert.deepEqual(communityWindow('2026-01-02T00:00:00Z'), { from: '2025-12-03', through: '2026-01-01', days: 30 });
});

test('small samples publish no exact totals or partial histograms', () => {
  const summary = buildCommunitySummary([row('2026-01-01', [[sample, 99]])], '2026-01-02T12:00:00Z');
  assert.deepEqual(summary, { status: 'collecting', window: { from: '2025-12-03', through: '2026-01-01', days: 30 }, totalRange: null, countries: [], categories: [], priorityPeriods: [] });
  assert.equal(JSON.stringify(summary).includes('99'), false);
});

test('public histograms suppress bins below twenty, round down to ten, and publish a broad total range', () => {
  const summary = buildCommunitySummary([row('2026-01-01', [
    [sample, 61], [{ country: 'China', category: 'F1', priorityPeriod: '2000-2004' }, 20], [{ country: 'Mexico', category: 'F4', priorityPeriod: 'before2000' }, 19],
  ])], '2026-01-02T12:00:00Z');
  assert.equal(summary.status, 'ready');
  assert.equal(summary.totalRange, '100-199');
  assert.deepEqual(summary.countries, [{ id: 'India', label: 'India', count: 60 }, { id: 'China', label: 'China', count: 20 }]);
  assert.deepEqual(summary.categories, [{ id: 'EB2', label: 'EB2', count: 60 }, { id: 'F1', label: 'F1', count: 20 }]);
  assert.deepEqual(summary.priorityPeriods, [{ id: '2000-2004', label: '2000-2004', count: 20 }, { id: '2015-2019', label: '2015-2019', count: 60 }]);
  assert.deepEqual(Object.keys(summary).sort(), ['categories', 'countries', 'priorityPeriods', 'status', 'totalRange', 'window']);
});

test('today and out-of-window rollups cannot change the completed-day summary', () => {
  const completed = row('2026-01-01', [[sample, 100]]);
  const before = buildCommunitySummary([completed], '2026-01-02T00:00:01Z');
  const after = buildCommunitySummary([completed, row('2026-01-02', [[sample, 1000]]), row('2025-12-02', [[sample, 1000]])], '2026-01-02T23:59:59Z');
  assert.deepEqual(after, before);
});

test('corrupt or inconsistent rollups fail closed rather than publishing invented statistics', () => {
  const good = row('2026-01-01', [[sample, 100]]);
  for (const bad of [
    { ...good, total: 101 }, { ...good, total: 10001 }, { ...good, counters: '{' }, { ...good, day: '2026-02-30' },
    { ...good, counters: JSON.stringify({ countries: { India: 100, Unknown: 0 }, categories: { EB2: 100 }, priorityPeriods: { '2015-2019': 100 } }) },
  ]) assert.throws(() => buildCommunitySummary([bad], '2026-01-02T12:00:00Z'));
  assert.throws(() => buildCommunitySummary([good, good], '2026-01-02T12:00:00Z'));
});

test('SQLite atomic upserts keep one daily row with marginal counters and no identifiers', async t => {
  const db = database(t);
  await add(db, '2026-01-01');
  await add(db, '2026-01-01', { country: 'Mexico', category: 'F2B', priorityPeriod: '2000-2004' });
  await add(db, '2026-01-01');
  const rows = db.sqlite.prepare('SELECT * FROM community_daily').all();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ['day', 'total', 'counters']);
  assert.equal(rows[0].total, 3);
  assert.deepEqual(JSON.parse(rows[0].counters), { countries: { India: 2, Mexico: 1 }, categories: { EB2: 2, F2B: 1 }, priorityPeriods: { '2015-2019': 2, '2000-2004': 1 } });
});

test('SQLite rolls back no counters when the daily contribution cap is reached', async t => {
  const db = database(t);
  const full = row('2026-01-01', [[sample, 10000]]);
  db.sqlite.prepare('INSERT INTO community_daily(day,total,counters) VALUES (?,?,?)').run(full.day, full.total, full.counters);
  assert.equal((await add(db, full.day, { ...sample, country: 'Mexico' })).meta.changes, 0);
  const after = db.sqlite.prepare('SELECT * FROM community_daily').get();
  assert.equal(after.total, 10000);
  assert.deepEqual(JSON.parse(after.counters), JSON.parse(full.counters));
});

test('first new daily insertion prunes old aggregate rows to a ninety-day active retention window', async t => {
  const db = database(t);
  await add(db, '2026-01-01');
  await add(db, '2026-01-02');
  await add(db, '2026-04-01');
  assert.deepEqual(db.sqlite.prepare('SELECT day FROM community_daily ORDER BY day').all().map(item => item.day), ['2026-01-02', '2026-04-01']);
});

test('POST accepts same-origin opt-in coarse data without recording headers or exact dates', async t => {
  const db = database(t);
  const response = await onRequest(context(db, { method: 'POST', body: sample, headers: { 'User-Agent': 'not retained', 'CF-Connecting-IP': '192.0.2.10', 'Content-Type': 'application/json; charset=utf-8' } }));
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { accepted: true });
  const stored = db.sqlite.prepare('SELECT * FROM community_daily').get();
  assert.equal(stored.day, today());
  assert.equal(stored.total, 1);
  assert.equal(JSON.stringify(stored).includes('192.0.2.10'), false);
  assert.equal(JSON.stringify(stored).includes('not retained'), false);
});

test('cross-origin posts and unsupported methods never touch storage', async () => {
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    const response = await onRequest(context(null, { method: 'POST', body: sample, headers }));
    assert.equal(response.status, 403);
  }
  for (const method of ['DELETE', 'OPTIONS', 'PUT', 'HEAD']) {
    const response = await onRequest(context(null, { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, POST');
  }
});

test('all query parameters, incorrect media types and private or malformed payloads are rejected', async () => {
  for (const method of ['GET', 'POST']) assert.equal((await onRequest(context(null, { method, path: '/api/community?country=India', ...(method === 'POST' ? { body: sample } : {}) }))).status, 400);
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=iso-8859-1']) assert.equal((await onRequest(context(null, { method: 'POST', body: sample, headers: { 'Content-Type': contentType } }))).status, 415);
  for (const body of ['{', 'null', JSON.stringify({ ...sample, priorityDate: '2015-01-01' }), JSON.stringify({ ...sample, priorityPeriod: '2015-01-01' }), ' '.repeat(513), `${JSON.stringify(sample)}${' '.repeat(513)}`]) assert.equal((await onRequest(context(null, { method: 'POST', body }))).status, 400);
});

test('streamed bodies are bounded independently of a claimed content length', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(300))); controller.enqueue(new TextEncoder().encode(' '.repeat(300))); controller.close(); } });
  const request = new Request(`${origin}/api/community`, { method: 'POST', body: stream, duplex: 'half', headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '100' } });
  assert.equal((await onRequest({ request, env: {} })).status, 400);
  assert.equal((await onRequest(context(null, { method: 'POST', body: sample, headers: { 'Content-Length': '513' } }))).status, 400);
});

test('GET only reads completed-day aggregate rows, is public-cacheable, and does not track views', async t => {
  const db = database(t);
  const window = communityWindow();
  const completed = row(window.through, [[sample, 100]]);
  db.sqlite.prepare('INSERT INTO community_daily(day,total,counters) VALUES (?,?,?)').run(completed.day, completed.total, completed.counters);
  await add(db, today());
  const before = JSON.stringify(db.sqlite.prepare('SELECT * FROM community_daily ORDER BY day').all());
  const response = await onRequest(context(db));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
  const result = await response.json();
  assert.equal(result.totalRange, '100-199');
  assert.deepEqual(result.countries, [{ id: 'India', label: 'India', count: 100 }]);
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM community_daily ORDER BY day').all()), before);
});

test('capacity responses do not leak raw counts and storage failures reveal no internal details', async t => {
  const db = database(t);
  const full = row(today(), [[sample, 10000]]);
  db.sqlite.prepare('INSERT INTO community_daily(day,total,counters) VALUES (?,?,?)').run(full.day, full.total, full.counters);
  const capped = await onRequest(context(db, { method: 'POST', body: sample }));
  assert.equal(capped.status, 202);
  assert.deepEqual(await capped.json(), { accepted: false });
  const broken = { prepare() { throw new Error('private database account id'); } };
  for (const requestContext of [context(null), context(broken), context(broken, { method: 'POST', body: sample })]) {
    const response = await onRequest(requestContext);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Community summary temporarily unavailable.' });
  }
});

test('only the community API invokes Pages Functions; all static routes bypass it', async () => {
  const routes = JSON.parse(await readFile(new URL('../public/_routes.json', import.meta.url), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/api/community'], exclude: [] });
});
