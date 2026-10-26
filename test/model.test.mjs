import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { buildModelData, cutoffStatus, compareCutoffs, deriveSeries, evaluateProfile, formatInputDate, monthIndex, parseDate, parseInputDate } from '../src/model.js';
import { discoverBulletins, parseBulletinHTML, parseDOSDate, validateBulletin } from '../scripts/refresh-bulletins.mjs';
import { bulletinData, modelData, officialOctoberFamilyRows } from './fixtures/model-bulletins.mjs';

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

test('typed priority dates require MM-DD-YYYY and validate the real calendar only', () => {
  for (const [input, expected] of [['02-29-2024', '2024-02-29'], ['02-29-2000', '2000-02-29'], ['12-31-2099', '2099-12-31'], ['01-01-1900', '1900-01-01']]) {
    assert.equal(parseInputDate(input), expected);
    assert.equal(formatInputDate(expected), input);
  }
  for (const input of ['02-29-2025', '02-29-1900', '02-30-2024', '04-31-2024', '13-01-2024', '00-01-2024', '01-00-2024', '2024-02-29', '02/29/2024', '2-29-2024', '02-9-2024', ' 02-29-2024 ', '', null]) assert.equal(parseInputDate(input), null, input);
  for (const input of ['2025-02-29', '02-29-2024', 'C', 'U', null]) assert.equal(formatInputDate(input), null, input);
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

test('family filing permission uses its own USCIS chart, never the employment decision', () => {
  const data = structuredClone(bulletinData);
  const family = { ...profile, category: 'F1', priorityDate: '2020-12-01', chart: 'filing' };
  data.bulletins[0].uscisEmploymentChart = 'filing';
  const unknown = evaluateProfile(family, data, modelData);
  assert.equal(unknown.current, true);
  assert.equal(unknown.approvalEligible, false);
  assert.equal(unknown.canFile, null);
  assert.equal(unknown.chartChoiceKnown, false);
  assert.equal(unknown.filingChart, null);
  data.bulletins[0].uscisFamilyChart = 'finalAction';
  const finalAction = evaluateProfile(family, data, modelData);
  assert.equal(finalAction.canFile, false);
  assert.equal(finalAction.filingChart, 'finalAction');
  assert.equal(evaluateProfile({ ...family, filingPath: 'consular' }, data, modelData).canFile, true);
  data.bulletins[0].uscisFamilyChart = 'filing';
  data.bulletins[0].uscisEmploymentChart = 'finalAction';
  assert.equal(evaluateProfile(family, data, modelData).canFile, true);
  assert.equal(evaluateProfile({ ...profile, priorityDate: '2014-01-01', chart: 'filing' }, data, modelData).canFile, false);
  delete data.categories.find(category => category.id === 'F1').group;
  assert.equal(evaluateProfile(family, data, modelData).categoryGroup, 'family');
  assert.equal(evaluateProfile(family, data, modelData).filingChart, 'filing');
});

test('family preferences retain historical movement but never generate dated scenarios', () => {
  const data = structuredClone(bulletinData);
  for (const bulletin of data.bulletins) bulletin.charts.finalAction.F1.India = bulletin.charts.finalAction.EB2.India;
  const result = evaluateProfile({ ...profile, category: 'F1' }, data, modelData);
  assert.equal(result.status, 'waiting');
  assert.ok(result.trend.positiveWindows >= 3);
  assert.equal(result.forecastKind, 'history-only');
  assert.equal(result.scenarios, null);
  assert.match(result.forecastReason, /history only/);
  assert.equal(evaluateProfile({ ...profile, category: 'F1', priorityDate: '2010-01-01' }, data, modelData).scenarios, null);
  assert.equal(evaluateProfile({ ...profile, category: 'F1', country: 'ROW' }, data, modelData).status, 'current');
  assert.equal(evaluateProfile({ ...profile, category: 'F1', country: 'Philippines' }, data, modelData).status, 'unavailable');
  const cutoff = data.bulletins[0].charts.finalAction.F1.India;
  assert.equal(evaluateProfile({ ...profile, category: 'F1', priorityDate: cutoff }, data, modelData).current, false);
  assert.equal(evaluateProfile({ ...profile, category: 'F1', priorityDate: '2013-10-31' }, data, modelData).current, true);
});

test('unsupported categories and unavailable methodology retain history-only scope', () => {
  assert.equal(evaluateProfile({ ...profile, category: 'EB4' }, bulletinData, modelData).status, 'unknown');
  const result = evaluateProfile(profile, bulletinData, {});
  assert.equal(result.scenarios, null);
  assert.equal(result.forecastKind, 'history-only');
  assert.match(result.forecastReason, /do not predict individual approval dates/);
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

test('legacy scenario configuration cannot re-enable employment or family forecasts', () => {
  const result = evaluateProfile(profile, bulletinData, modelData);
  assert.equal(result.forecastKind, 'history-only');
  assert.equal(result.approvalEligible, false);
  assert.ok(result.trend.positiveWindows >= 3);
  assert.ok(result.trend.netMovementMonths > 0);
  assert.equal(result.scenarios, null);
  assert.match(result.forecastReason, /Published Visa Bulletins/);
  assert.match(result.forecastReason, /do not predict individual approval dates/);
  const legacy = { methodology: { kind: 'historical-cutoff-scenarios', parameters: { rollingWindowMonths: 6, minimumHistoryMonths: 0, minimumPositiveWindows: 0, maximumHorizonMonths: 10_000 } } };
  for (const country of bulletinData.countries) {
    for (const category of bulletinData.categories) {
      for (const chart of ['finalAction', 'filing']) {
        const remote = evaluateProfile({ ...profile, country: country.id, category: category.id, chart, priorityDate: '2040-01-01' }, bulletinData, legacy);
        assert.equal(remote.scenarios, null, `${country.id}:${category.id}:${chart}`);
        assert.equal(remote.forecastKind, 'history-only');
      }
    }
  }
});

test('April 2026 India EB-1 dates show actual cutoffs and history, never a calendar forecast', () => {
  const data = structuredClone(bulletinData);
  // Freeze the official October 2024-October 2026 India EB-1 regression history.
  const finalAction = [
    '2022-02-01', '2022-02-01', '2022-02-01', '2022-02-01', '2022-02-01', '2022-02-01',
    '2022-02-15', '2022-02-15', '2022-02-15', '2022-02-15', '2022-02-15', '2022-02-15',
    '2022-02-15', '2022-02-15', '2022-03-15', '2023-02-01', '2023-02-01', '2023-03-01',
    '2023-04-01', '2023-04-01', '2022-12-15', '2022-10-15', '2022-10-15', '2022-10-15', '2023-02-01',
  ];
  const filing = [
    ...Array(12).fill('2022-04-15'), ...Array(3).fill('2023-04-15'), ...Array(2).fill('2023-08-01'),
    ...Array(7).fill('2023-12-01'), '2024-07-01',
  ];
  for (const [index, bulletin] of [...data.bulletins].reverse().entries()) {
    bulletin.charts.finalAction.EB1.India = finalAction[index];
    bulletin.charts.filing.EB1.India = filing[index];
  }
  for (const chart of ['finalAction', 'filing']) {
    for (const day of ['01', '15', '30']) {
      const result = evaluateProfile({ ...profile, category: 'EB1', priorityDate: `2026-04-${day}`, chart }, data, modelData);
      assert.equal(result.status, 'waiting');
      assert.equal(result.current, false);
      assert.equal(result.finalActionCutoff, '2023-02-01');
      assert.equal(result.filingCutoff, '2024-07-01');
      assert.equal(result.cutoff, chart === 'finalAction' ? '2023-02-01' : '2024-07-01');
      assert.equal(result.approvalEligible, false);
      assert.equal(result.canFile, null);
      assert.equal(result.chartChoiceKnown, false);
      assert.equal(result.scenarios, null);
      assert.equal(result.forecastKind, 'history-only');
      assert.equal(result.trend.points.length, 25);
      assert.equal(result.trend.monthsObserved, 24);
      assert.ok(result.monthsBehind > (chart === 'finalAction' ? 37 : 20));
      assert.ok(result.monthsBehind < (chart === 'finalAction' ? 39 : 22));
      assert.match(result.forecastReason, /do not predict individual approval dates/);
    }
    const cutoff = chart === 'finalAction' ? '2023-02-01' : '2024-07-01';
    const previousDay = chart === 'finalAction' ? '2023-01-31' : '2024-06-30';
    const equal = evaluateProfile({ ...profile, category: 'EB1', priorityDate: cutoff, chart }, data, modelData);
    assert.equal(equal.current, false);
    const earlier = evaluateProfile({ ...profile, category: 'EB1', priorityDate: previousDay, chart }, data, modelData);
    assert.equal(earlier.current, true);
    assert.equal(earlier.approvalEligible, chart === 'finalAction');
    assert.equal(earlier.scenarios, null);
    assert.equal(earlier.forecastKind, 'history-only');
    assert.match(earlier.forecastReason, /do not predict individual approval dates/);
  }
});

test('January 2026 India EB-1 compares correctly with the published October 2026 bulletin', () => {
  const result = evaluateProfile({ ...profile, category: 'EB1', priorityDate: '2026-01-01', chart: 'finalAction', bulletinMonth: '2026-10' }, productionBulletinData, modelData);
  assert.equal(result.status, 'waiting');
  assert.equal(result.finalActionCutoff, '2023-02-01');
  assert.equal(result.filingCutoff, '2024-07-01');
  assert.ok(result.monthsBehind > 34 && result.monthsBehind < 36);
  assert.equal(result.scenarios, null);
});

test('November 2026 India EB-1 retains separate sourced final-action and filing cutoffs', () => {
  const result = evaluateProfile({ ...profile, category: 'EB1', priorityDate: '2026-01-01', chart: 'finalAction', bulletinMonth: '2026-11' }, productionBulletinData, modelData);
  assert.equal(result.bulletin.sourceUrl, 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/2027/visa-bulletin-for-november-2026.html');
  assert.equal(result.finalActionCutoff, '2023-02-01');
  assert.equal(result.filingCutoff, '2024-07-01');
  assert.equal(result.status, 'waiting');
  assert.equal(result.canFile, null);
  assert.equal(result.scenarios, null);
});

test('production bulletins retain twenty-five contiguous months and one hundred complete tracked cells', () => {
  assert.equal(productionBulletinData.bulletins.length, 25);
  assert.equal(productionBulletinData.bulletins[0].month, productionBulletinData.latestMonth);
  const latestIndex = monthIndex(productionBulletinData.latestMonth);
  assert.notEqual(latestIndex, null);
  assert.equal(productionBulletinData.countries.length, 5);
  assert.equal(productionBulletinData.categories.length, 10);
  assert.equal(new Set(productionBulletinData.countries.map(country => country.id)).size, 5);
  assert.equal(new Set(productionBulletinData.categories.map(category => category.id)).size, 10);
  assert.equal(productionBulletinData.categories.filter(category => category.group === 'family').length, 5);
  assert.equal(productionBulletinData.categories.filter(category => category.group === 'employment').length, 5);
  for (const [offset, bulletin] of productionBulletinData.bulletins.entries()) {
    assert.equal(monthIndex(bulletin.month), latestIndex - offset);
    assert.equal(new URL(bulletin.sourceUrl).protocol, 'https:');
    assert.equal(new URL(bulletin.sourceUrl).hostname, 'travel.state.gov');
    assert.deepEqual(Object.keys(bulletin.charts).sort(), ['filing', 'finalAction']);
    assert.equal(Object.values(bulletin.charts).flatMap(chart => Object.values(chart).flatMap(Object.values)).length, 100);
    assert.ok(Object.hasOwn(bulletin, 'uscisFamilyChart'));
    validateBulletin(bulletin);
  }
});

test('production model summaries match the current published bulletin history', () => {
  assert.deepEqual(buildModelData(productionBulletinData, productionModelData), productionModelData);
});

function officialShapedHTML() {
  const latest = bulletinData.bulletins[0];
  const columns = ['ROW', 'China', 'India', 'Mexico', 'Philippines'];
  const labels = { EB1: '1st', EB2: '2nd', EB3: '3rd', EB3OW: 'Other Workers', EB5: '5th Unreserved (including C5, T5, I5, R5)', F1: 'F1', F2A: 'F2A', F2B: 'F2B', F3: 'F3', F4: 'F4' };
  const token = value => value === 'C' || value === 'U' ? value : `${value.slice(8, 10)}${new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(parseDate(value)).toUpperCase()}${value.slice(2, 4)}`;
  const tables = ['employment', 'family'].flatMap(group => ['finalAction', 'filing'].map(chart => {
    const groupLabel = group === 'family' ? 'FAMILY-SPONSORED' : 'EMPLOYMENT-BASED';
    const heading = chart === 'finalAction' ? `FINAL ACTION DATES FOR ${groupLabel} PREFERENCE CASES` : `DATES FOR FILING ${group === 'family' ? '' : 'OF '}${groupLabel} VISA APPLICATIONS`;
    return `<p>${chart === 'finalAction' ? 'A' : 'B'}. ${heading}</p><table><tr><th>${group}</th><th>All Chargeability Areas Except Those Listed</th><th>CHINA-mainland born</th><th>INDIA</th><th>MEXICO</th><th>PHILIPPINES</th></tr>${bulletinData.categories.filter(category => category.group === group).map(({ id: category }) => `<tr><td>${labels[category]}</td>${columns.map(country => `<td>${token(latest.charts[chart][category][country])}</td>`).join('')}</tr>`).join('')}</table>`;
  })).join('');
  return `<html><body><h1>Visa Bulletin For ${latest.label}</h1>${tables}<p>CA/VO: September 4, 2026</p></body></html>`;
}

test('structured HTML parser maps DOS column order and fails closed on malformed tables', () => {
  const html = officialShapedHTML();
  const parsed = parseBulletinHTML(html, bulletinData.bulletins[0].sourceUrl, '2026-10-11');
  assert.deepEqual(parsed.charts, bulletinData.bulletins[0].charts);
  assert.equal(parsed.publishedAt, '2026-09-04');
  assert.equal(parsed.uscisEmploymentChart, null);
  assert.equal(parsed.uscisFamilyChart, null);
  assert.throws(() => parseBulletinHTML(html.replace('01NOV13', 'not-a-date'), parsed.sourceUrl), /Unexpected DOS/);
  assert.throws(() => parseBulletinHTML(html.replaceAll('Other Workers', 'Missing row'), parsed.sourceUrl), /missing a tracked category/);
  assert.throws(() => parseBulletinHTML(html, 'https://example.com/bulletin'), /official State Department/);
  assert.throws(() => parseBulletinHTML(html.replace('FINAL ACTION DATES FOR EMPLOYMENT-BASED PREFERENCE CASES', 'Changed heading'), parsed.sourceUrl), /no recognized chart heading/);
  const $ = load(html);
  const firstSection = $('p').first().add($('table').first()).remove();
  $('body').append(firstSection);
  assert.deepEqual(parseBulletinHTML($.html(), parsed.sourceUrl).charts, parsed.charts);
  assert.deepEqual(parseBulletinHTML(html.replace('DATES FOR FILING FAMILY-SPONSORED', 'DATES FOR FILING OF FAMILY-SPONSORED'), parsed.sourceUrl).charts, parsed.charts);
  assert.throws(() => parseBulletinHTML(html.replaceAll('<td>F4</td>', '<td>Missing family row</td>'), parsed.sourceUrl), /missing a tracked category/);
  assert.throws(() => parseBulletinHTML(html.replace('FINAL ACTION DATES FOR FAMILY-SPONSORED PREFERENCE CASES', 'Changed family heading'), parsed.sourceUrl), /missing a tracked category|Duplicate/);
});

test('link discovery follows official links rather than guessed URLs', () => {
  const valid = bulletinData.bulletins[0].sourceUrl;
  const older = bulletinData.bulletins[1].sourceUrl;
  const links = discoverBulletins(`<a href="${older}">September</a><a href="${valid}">October</a><a href="${valid.replace('travel.state.gov', 'example.com')}">Other</a><a href="/contact">Contact</a>`);
  assert.deepEqual(links.map(link => link.month), ['2026-10', '2026-09']);
});

test('actual October family cells parse line breaks and ignore fragments outside the tables', () => {
  const $ = load(officialShapedHTML());
  const familyRows = $('tr').filter((_, row) => $(row).children('td').first().text() === 'F4');
  familyRows.eq(0).html(officialOctoberFamilyRows.finalAction);
  familyRows.eq(1).html(officialOctoberFamilyRows.filing);
  familyRows.eq(0).closest('table').after('<p>08JUN11 08JUN11 01NOV06 15MAR01 08FEB08</p>');
  const parsed = parseBulletinHTML($.html(), bulletinData.bulletins[0].sourceUrl);
  assert.deepEqual(parsed.charts.finalAction.F4, { India: '2006-12-15', China: '2011-10-22', Mexico: '2001-04-22', Philippines: '2008-05-15', ROW: '2011-10-22' });
  assert.deepEqual(parsed.charts.filing.F4, { India: '2007-02-01', China: '2011-11-01', Mexico: '2001-04-30', Philippines: '2009-03-22', ROW: '2011-11-01' });
  assert.throws(() => parseBulletinHTML($.html().replace('22APR01<br>', '22APR01<br>01MAY01'), parsed.sourceUrl), /Unexpected DOS date token/);
});
