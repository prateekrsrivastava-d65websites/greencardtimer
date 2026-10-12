import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { compareProcessingMonth, formatProcessingMonth, processingFreshness, validateProcessingSnapshot } from '../src/processing.js';
import { fetchProcessingHTML, parseProcessingHTML, parseProcessingMonth, PROCESSING_SOURCE_URL, refreshProcessing } from '../scripts/refresh-processing.mjs';

// Frozen official FLAG table values observed October 12, 2026; unrelated program tables are omitted.
const officialHTML = `<html><body>
<p><strong>Prevailing Wage Determination Processing Times</strong> <em>(as of 9/30/2026)</em></p>
<table><thead><tr><th>Processing Queue</th><th>OEWS Receipt Date<sup>i</sup></th><th>Non-OEWS Receipt Date<sup>i</sup></th></tr></thead><tbody>
<tr><td>CW-1</td><td>August 2026</td><td>--</td></tr><tr><td>H-1B</td><td>June 2026</td><td>June 2026</td></tr>
<tr><td>H-2B</td><td>August 2026</td><td>--</td></tr><tr><td>PERM</td><td>June 2026</td><td>June 2026</td></tr>
<tr><td>Redeterminations</td><td colspan="2"><p>H-1B: August 2026</p><p>PERM: July 2026</p></td></tr>
<tr><td>Center Director Reviews</td><td colspan="2"><p>CW-1: September 2026</p><p>H-1B: July 2026</p><p>H-2B: June 2026</p><p>PERM: July 2026</p></td></tr></tbody></table>
<table><thead><tr><th colspan="2">H-1B</th></tr><tr><th>Receipt Month<sup>ii</sup></th><th>Remaining Requests<sup>ii</sup></th></tr></thead><tbody>
<tr><td>April 2026</td><td>3</td></tr><tr><td>May 2026</td><td>1</td></tr><tr><td>June 2026</td><td>74</td></tr>
<tr><td>July 2026</td><td>248</td></tr><tr><td>August 2026</td><td>183</td></tr><tr><td>September 2026</td><td>201</td></tr></tbody></table>
<table><thead><tr><th colspan="2">PERM</th></tr><tr><th>Receipt Month<sup>ii</sup></th><th>Remaining Requests<sup>ii</sup></th></tr></thead><tbody>
<tr><td>April 2026</td><td>8</td></tr><tr><td>May 2026</td><td>36</td></tr><tr><td>June 2026</td><td>3,532</td></tr>
<tr><td>July 2026</td><td>15,959</td></tr><tr><td>August 2026</td><td>14,980</td></tr><tr><td>September 2026</td><td>14,519</td></tr></tbody></table>
<table><caption><strong>PERM Processing Times</strong>&nbsp;<em>(as of 10/05/2026)</em></caption><thead><tr><th>Processing Queue</th><th>Priority Date</th></tr></thead><tbody>
<tr><td>Analyst Review</td><td>December 2025</td></tr><tr><td>Audit Review</td><td>December 2025</td></tr>
<tr><td>Reconsideration Request to the CO</td><td>May 2026</td></tr></tbody></table>
<table><caption><strong>Average Number of Days to Process PERM Applications</strong></caption><thead><tr><th>Determinations</th><th>Month</th><th>Calendar Days</th></tr></thead><tbody>
<tr><td>Analyst Review</td><td>August 2026</td><td>336</td></tr><tr><td>Audit Review</td><td>August 2026</td><td>N/A</td></tr></tbody></table>
</body></html>`;

const now = new Date('2026-10-12T13:17:00Z');
const htmlResponse = html => new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'greencardtimer-processing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'public/data/processing.json');
  await refreshProcessing({ root, fetchImpl: async () => htmlResponse(officialHTML), now });
  return { root, path };
}

test('month comparison describes the queue without estimating a decision date', () => {
  assert.deepEqual(compareProcessingMonth('2025-11', '2025-12'), { position: 'before', monthDifference: -1 });
  assert.deepEqual(compareProcessingMonth('2025-12', '2025-12'), { position: 'same', monthDifference: 0 });
  assert.deepEqual(compareProcessingMonth('2026-01', '2025-12'), { position: 'after', monthDifference: 1 });
  assert.deepEqual(compareProcessingMonth('2025-13', '2025-12'), { position: 'unknown', monthDifference: null });
  assert.deepEqual(compareProcessingMonth('2025-12', null), { position: 'unknown', monthDifference: null });
  assert.equal(formatProcessingMonth('2025-12'), 'December 2025');
  assert.equal(formatProcessingMonth(null), 'Not published');
  assert.equal(parseProcessingMonth('June 2026'), '2026-06');
  assert.equal(parseProcessingMonth('N/A'), null);
  assert.equal(parseProcessingMonth('--'), null);
  assert.throws(() => parseProcessingMonth('June 2026 July 2026'), /Unexpected processing month/);
});

test('official processing markup separates PERM queues, completion averages and PWD request counts', () => {
  const current = parseProcessingHTML(officialHTML);
  assert.deepEqual(current.perm, { asOf: '2026-10-05', queues: { analystReview: '2025-12', auditReview: '2025-12', reconsideration: '2026-05' }, averages: { analystReview: { month: '2026-08', days: 336 }, auditReview: { month: '2026-08', days: null } } });
  assert.equal(current.pwd.asOf, '2026-09-30');
  assert.deepEqual(current.pwd.queues, { perm: { oews: '2026-06', nonOews: '2026-06' }, h1b: { oews: '2026-06', nonOews: '2026-06' } });
  assert.deepEqual(current.pwd.redeterminations, { perm: '2026-07', h1b: '2026-08' });
  assert.deepEqual(current.pwd.directorReviews, { perm: '2026-07', h1b: '2026-07' });
  assert.deepEqual(current.pwd.remainingRequests.perm, [{ month: '2026-04', count: 8 }, { month: '2026-05', count: 36 }, { month: '2026-06', count: 3532 }, { month: '2026-07', count: 15959 }, { month: '2026-08', count: 14980 }, { month: '2026-09', count: 14519 }]);
  assert.equal(current.pwd.remainingRequests.h1b[2].count, 74);
  assert.deepEqual(processingFreshness(current, '2026-10-12'), { permDays: 7, pwdDays: 12, stale: false });
  assert.equal(processingFreshness(current, '2027-01-01').stale, true);
  assert.equal(processingFreshness(current, '2026-09-01').stale, true);
});

test('parser uses header labels and normalizes source row order without data churn', () => {
  const $ = load(officialHTML);
  const pwd = $('table').first();
  pwd.find('tr').filter((_, row) => $(row).children().length === 3).each((_, row) => {
    const cells = $(row).children();
    const second = cells.eq(1).remove();
    $(row).append(second);
  });
  $('table').eq(2).find('tbody').append($('table').eq(2).find('tbody tr').get().reverse());
  assert.deepEqual(parseProcessingHTML($.html()), parseProcessingHTML(officialHTML));
  assert.deepEqual(parseProcessingHTML(officialHTML + '<table><tr><td>CW-1 typo</td><td>98.5.4%</td></tr></table>'), parseProcessingHTML(officialHTML));
});

test('parser rejects changed headers, duplicate rows, ambiguous dates and malformed source values', () => {
  for (const bad of [
    officialHTML.replace('Non-OEWS Receipt Date', 'Unrecognized wage header'),
    officialHTML.replace('<td>Analyst Review</td><td>December 2025</td>', '<td>Analyst Review</td><td>December 2025 January 2026</td>'),
    officialHTML.replace('(as of 10/05/2026)', '(as of 02/30/2026)'),
    officialHTML.replace('(as of 10/05/2026)', '(as of 10/05/2026) (as of 10/06/2026)'),
    officialHTML.replace('<td>3,532</td>', '<td>3,53</td>'),
    officialHTML.replace('<td>3,532</td>', '<td>-4</td>'),
    officialHTML.replace('<td>3,532</td>', '<td>N/A</td>'),
    officialHTML.replace('<td>3,532</td>', '<td>3,532</td><td>unexpected third cell</td>'),
    officialHTML.replace('PERM Processing Times</strong>', 'Unrecognized PERM heading</strong>'),
    officialHTML.replace('Average Number of Days to Process PERM Applications', 'Unrecognized average heading'),
    officialHTML.replace('<tr><td>April 2026</td><td>8</td></tr>', '<tr><td>April 2026</td><td>8</td></tr><tr><td>April 2026</td><td>1</td></tr>'),
    officialHTML.replace('<tr><td>Analyst Review</td><td>December 2025</td></tr>', ''),
    officialHTML.replace('<tr><td>Analyst Review</td><td>December 2025</td></tr>', '<tr><td>Analyst Review</td><td>December 2025</td></tr><tr><td>Analyst Review</td><td>December 2025</td></tr>'),
  ]) assert.throws(() => parseProcessingHTML(bad));
  const future = parseProcessingHTML(officialHTML);
  future.perm.queues.analystReview = '2026-11';
  assert.throws(() => validateProcessingSnapshot(future), /future/);
  const $ = load(officialHTML);
  const requests = $('table').eq(2).remove();
  $('body').append(requests);
  assert.throws(() => parseProcessingHTML($.html()), /outside the published PWD section/);
});

test('official fetch uses a fixed public URL, rejects redirects and caps response size', async () => {
  const calls = [];
  const result = await fetchProcessingHTML(async (url, options) => { calls.push({ url, options }); return htmlResponse(officialHTML); });
  assert.equal(result, officialHTML);
  assert.equal(calls[0].url, PROCESSING_SOURCE_URL);
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.headers['User-Agent'], /GreenCardTimer/);
  await assert.rejects(fetchProcessingHTML(async () => new Response('Forbidden', { status: 403 })), /HTTP 403/);
  await assert.rejects(fetchProcessingHTML(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })), /did not return HTML/);
  await assert.rejects(fetchProcessingHTML(async () => htmlResponse('x'.repeat(2_000_001))), /size limit/);
});

test('bootstrap creates one sourced snapshot and unchanged weekly checks preserve exact bytes', async t => {
  const fixture = await setup(t);
  const before = await readFile(fixture.path, 'utf8');
  const data = JSON.parse(before);
  assert.equal(data.sourceUrl, PROCESSING_SOURCE_URL);
  assert.equal(data.verifiedAt, '2026-10-12');
  assert.equal(data.current.perm.asOf, '2026-10-05');
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].observedAt, '2026-10-12');
  const result = await refreshProcessing({ root: fixture.root, fetchImpl: async () => htmlResponse(officialHTML), now: new Date('2026-10-19T13:17:00Z') });
  assert.equal(result.changed, false);
  assert.equal(result.contentChanged, false);
  assert.equal(await readFile(fixture.path, 'utf8'), before);
});

test('monthly successful checks do not advance source verification dates or invent history', async t => {
  const fixture = await setup(t);
  const result = await refreshProcessing({ root: fixture.root, fetchImpl: async () => htmlResponse(officialHTML), now: new Date('2026-11-05T13:17:00Z') });
  assert.equal(result.changed, true);
  assert.equal(result.contentChanged, false);
  const data = JSON.parse(await readFile(fixture.path, 'utf8'));
  assert.equal(data.refresh.checkedAt, '2026-11-05');
  assert.equal(data.verifiedAt, '2026-10-12');
  assert.equal(data.generatedAt, '2026-10-12');
  assert.equal(data.history.length, 1);
});

test('new monthly readings and same-date corrections append only genuinely observed snapshots', async t => {
  for (const kind of ['month', 'correction']) {
    const fixture = await setup(t);
    const html = kind === 'month' ? officialHTML.replace('9/30/2026', '10/31/2026').replace('10/05/2026', '11/05/2026').replaceAll('December 2025', 'January 2026') : officialHTML.replace('3,532', '3,540');
    const date = kind === 'month' ? new Date('2026-11-06T13:17:00Z') : new Date('2026-10-19T13:17:00Z');
    const result = await refreshProcessing({ root: fixture.root, fetchImpl: async () => htmlResponse(html), now: date });
    assert.equal(result.contentChanged, true);
    assert.equal(result.snapshots, 2);
    const data = JSON.parse(await readFile(fixture.path, 'utf8'));
    assert.equal(data.history[0].pwd.remainingRequests.perm[2].count, 3532);
    assert.equal(data.history[1].observedAt, date.toISOString().slice(0, 10));
    if (kind === 'month') assert.equal(data.current.perm.queues.analystReview, '2026-01');
    else assert.equal(data.current.pwd.remainingRequests.perm[2].count, 3540);
  }
});

test('failed, malformed, stale, future and rolled-back sources preserve the last good file', async t => {
  const failures = [
    async () => { throw new Error('Network unavailable'); },
    async () => new Response('Forbidden', { status: 403 }),
    async () => htmlResponse('<html>Just a moment</html>'),
    async () => htmlResponse(officialHTML.replace('3,532', 'ambiguous')),
    async () => htmlResponse(officialHTML.replace('<td>3,532</td>', '<td>3,532</td><td>unexpected third cell</td>')),
    async () => htmlResponse(officialHTML.replace('10/05/2026', '10/31/2026')),
    async () => htmlResponse(officialHTML.replace('10/05/2026', '9/05/2026')),
    async () => htmlResponse(officialHTML.replaceAll('December 2025', 'December 2027')),
  ];
  const fixture = await setup(t);
  const before = await readFile(fixture.path, 'utf8');
  for (const fetchImpl of failures) {
    await assert.rejects(refreshProcessing({ root: fixture.root, fetchImpl, now }));
    assert.equal(await readFile(fixture.path, 'utf8'), before);
  }
  await assert.rejects(refreshProcessing({ root: fixture.root, fetchImpl: async () => htmlResponse(officialHTML), now: new Date('2027-01-01T00:00:00Z') }), /stale/);
  assert.equal(await readFile(fixture.path, 'utf8'), before);
  await writeFile(fixture.path, '{bad existing JSON');
  let fetched = false;
  await assert.rejects(refreshProcessing({ root: fixture.root, fetchImpl: async () => { fetched = true; return htmlResponse(officialHTML); }, now }));
  assert.equal(fetched, false);
  assert.equal(await readFile(fixture.path, 'utf8'), '{bad existing JSON');
});

test('a failed first fetch never publishes an empty processing dataset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'greencardtimer-processing-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(refreshProcessing({ root, fetchImpl: async () => htmlResponse('<html>Empty</html>'), now }));
  await assert.rejects(readFile(join(root, 'public/data/processing.json'), 'utf8'), { code: 'ENOENT' });
});

test('published processing data contain real source dates and a matching observed history', async () => {
  const data = JSON.parse(await readFile(new URL('../public/data/processing.json', import.meta.url), 'utf8'));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.sourceUrl, PROCESSING_SOURCE_URL);
  validateProcessingSnapshot(data.current);
  assert.ok(data.history.length >= 1);
  for (const snapshot of data.history) validateProcessingSnapshot(snapshot);
  assert.deepEqual({ perm: data.history.at(-1).perm, pwd: data.history.at(-1).pwd }, data.current);
});
