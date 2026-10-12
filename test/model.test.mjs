import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { buildModelData, cutoffStatus, compareCutoffs, deriveSeries, evaluateProfile, monthIndex, parseDate } from '../src/model.js';
import { discoverBulletins, parseBulletinHTML, parseDOSDate, validateBulletin } from '../scripts/refresh-bulletins.mjs';
import { bulletinData, modelData } from './fixtures/model-bulletins.mjs';

const productionBulletinData = JSON.parse(await readFile(new URL('../public/data/bulletins.json', import.meta.url), 'utf8'));
const productionModelData = JSON.parse(await readFile(new URL('../public/data/model.json', import.meta.url), 'utf8'));
const profile = { country: 'India', category: 'EB2', priorityDate: '2015-01-01', chart: 'finalAction', filingPath: 'aos' };

test('a priority date must be strictly earlier than the dated cutoff', () => {
  assert.equal(cutoffStatus('2013-11-01', '2013-11-01').current, false);
  assert.equal(cutoffStatus('2013-10-31', '2013-11-01').current, true);
  assert.equal(cutoffStatus('2013-11-02', '2013-11-01').current, false);
});

test('Current and Unavailable remain distinct states', () => {
  assert.deepEqual(cutoffStatus('2025-01-01', 'C'), { status: 'current', current: true });
  assert.deepEqual(cutoffStatus('2010-01-01', 'U'), { status: 'unavailable', current: false });
  assert.equal(evaluateProfile({ ...profile, bulletinMonth: '2026-09' }, bulletinData, modelData).scenarios, null);
});

test('invalid calendar dates cannot be silently normalized', () => {
  assert.equal(parseDate('2025-02-29'), null);
  assert.equal(parseDate('2024-02-29').toISOString().slice(0, 10), '2024-02-29');
  assert.throws(() => parseDOSDate('31FEB26'), /Invalid DOS/);
});

test('USCIS chart choice unknown does not imply permission to file I-485', () => {
  const result = evaluateProfile({ ...profile, priorityDate: '2014-01-01', chart: 'filing' }, bulletinData, modelData);
  assert.equal(result.current, true);
  assert.equal(result.approvalEligible, false);
  assert.equal(result.canFile, null);
  assert.equal(result.chartChoiceKnown, false);
  const known = structuredClone(bulletinData);
  known.bulletins[0].uscisEmploymentChart = 'finalAction';
  assert.equal(evaluateProfile({ ...profile, priorityDate: '2014-01-01', chart: 'filing' }, known, modelData).canFile, false);
  known.bulletins[0].uscisEmploymentChart = 'filing';
  assert.equal(evaluateProfile({ ...profile, priorityDate: '2014-01-01', chart: 'filing' }, known, modelData).canFile, true);
});

test('unsupported categories and unavailable methodology yield no forecasts', () => {
  assert.equal(evaluateProfile({ ...profile, category: 'EB4' }, bulletinData, modelData).status, 'unknown');
  const result = evaluateProfile(profile, bulletinData, {});
  assert.equal(result.scenarios, null);
  assert.match(result.forecastReason, /No supported/);
});

test('retrogression is retained and C/U are excluded from numeric window rates', () => {
  assert.equal(compareCutoffs('2024-09-01', '2024-05-15').type, 'retrogressed');
  assert.equal(compareCutoffs('C', '2025-01-01').type, 'retrogressed');
  const trend = deriveSeries(bulletinData, 'India', 'EB2', 'finalAction');
  assert.ok(trend.retrogressedMonths > 0);
  assert.equal(trend.unavailableMonths, 3);
  assert.ok(trend.completeWindows < bulletinData.bulletins.length - modelData.methodology.parameters.rollingWindowMonths);
  assert.ok(trend.positiveWindows >= 3);
});

test('illustrative scenarios are labeled and never stand in for approval dates', () => {
  const result = evaluateProfile(profile, bulletinData, modelData);
  assert.equal(result.forecastKind, 'illustrative-trend');
  assert.equal(result.approvalEligible, false);
  assert.equal(result.scenarios.length, 3);
  assert.ok(result.scenarios[0].months <= result.scenarios[1].months);
  assert.ok(result.scenarios[1].months <= result.scenarios[2].months);
  assert.match(result.forecastReason, /not predicted approval dates/);
  const remote = evaluateProfile({ ...profile, priorityDate: '2040-01-01' }, bulletinData, modelData);
  assert.ok(remote.scenarios.every(scenario => scenario.beyondHorizon && scenario.date === null));
});

test('production bulletins retain twenty-five contiguous months and fifty complete tracked cells', () => {
  assert.equal(productionBulletinData.bulletins.length, 25);
  assert.equal(productionBulletinData.bulletins[0].month, productionBulletinData.latestMonth);
  const latestIndex = monthIndex(productionBulletinData.latestMonth);
  assert.notEqual(latestIndex, null);
  assert.equal(productionBulletinData.countries.length, 5);
  assert.equal(productionBulletinData.categories.length, 5);
  assert.equal(new Set(productionBulletinData.countries.map(country => country.id)).size, 5);
  assert.equal(new Set(productionBulletinData.categories.map(category => category.id)).size, 5);
  for (const [offset, bulletin] of productionBulletinData.bulletins.entries()) {
    assert.equal(monthIndex(bulletin.month), latestIndex - offset);
    assert.equal(new URL(bulletin.sourceUrl).protocol, 'https:');
    assert.equal(new URL(bulletin.sourceUrl).hostname, 'travel.state.gov');
    assert.deepEqual(Object.keys(bulletin.charts).sort(), ['filing', 'finalAction']);
    assert.equal(Object.values(bulletin.charts).flatMap(chart => Object.values(chart).flatMap(Object.values)).length, 50);
    validateBulletin(bulletin);
  }
});

test('production model summaries match the current published bulletin history', () => {
  assert.deepEqual(buildModelData(productionBulletinData, productionModelData), productionModelData);
});

function officialShapedHTML() {
  const latest = bulletinData.bulletins[0];
  const columns = ['ROW', 'China', 'India', 'Mexico', 'Philippines'];
  const labels = { EB1: '1st', EB2: '2nd', EB3: '3rd', EB3OW: 'Other Workers', EB5: '5th Unreserved (including C5, T5, I5, R5)' };
  const token = value => value === 'C' || value === 'U' ? value : `${value.slice(8, 10)}${new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(parseDate(value)).toUpperCase()}${value.slice(2, 4)}`;
  const tables = ['finalAction', 'filing'].map(chart => `<p>${chart === 'finalAction' ? 'A. FINAL ACTION DATES FOR EMPLOYMENT-BASED PREFERENCE CASES' : 'B. DATES FOR FILING OF EMPLOYMENT-BASED VISA APPLICATIONS'}</p><table><tr><th>Employment-based</th><th>All Chargeability Areas Except Those Listed</th><th>CHINA-mainland born</th><th>INDIA</th><th>MEXICO</th><th>PHILIPPINES</th></tr>${Object.entries(labels).map(([category, label]) => `<tr><td>${label}</td>${columns.map(country => `<td>${token(latest.charts[chart][category][country])}</td>`).join('')}</tr>`).join('')}</table>`).join('');
  return `<html><body><h1>Visa Bulletin For ${latest.label}</h1>${tables}<p>CA/VO: September 4, 2026</p></body></html>`;
}

test('structured HTML parser maps DOS column order and fails closed on malformed tables', () => {
  const html = officialShapedHTML();
  const parsed = parseBulletinHTML(html, bulletinData.bulletins[0].sourceUrl, '2026-10-11');
  assert.deepEqual(parsed.charts, bulletinData.bulletins[0].charts);
  assert.equal(parsed.publishedAt, '2026-09-04');
  assert.equal(parsed.uscisEmploymentChart, null);
  assert.throws(() => parseBulletinHTML(html.replace('01NOV13', 'not-a-date'), parsed.sourceUrl), /Unexpected DOS/);
  assert.throws(() => parseBulletinHTML(html.replaceAll('Other Workers', 'Missing row'), parsed.sourceUrl), /missing a tracked category/);
  assert.throws(() => parseBulletinHTML(html, 'https://example.com/bulletin'), /official State Department/);
  assert.throws(() => parseBulletinHTML(html.replace('FINAL ACTION DATES FOR EMPLOYMENT-BASED PREFERENCE CASES', 'Changed heading'), parsed.sourceUrl), /no recognized chart heading/);
  const $ = load(html);
  const firstSection = $('p').first().add($('table').first()).remove();
  $('body').append(firstSection);
  assert.deepEqual(parseBulletinHTML($.html(), parsed.sourceUrl).charts, parsed.charts);
});

test('link discovery follows official links rather than guessed URLs', () => {
  const valid = bulletinData.bulletins[0].sourceUrl;
  const older = bulletinData.bulletins[1].sourceUrl;
  const links = discoverBulletins(`<a href="${older}">September</a><a href="${valid}">October</a><a href="${valid.replace('travel.state.gov', 'example.com')}">Other</a><a href="/contact">Contact</a>`);
  assert.deepEqual(links.map(link => link.month), ['2026-10', '2026-09']);
});
