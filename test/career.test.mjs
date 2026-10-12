import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { searchCareer, summarizeEmployer, benchmarkOffer, searchSponsors, autocompleteEmployers, careerRowsToCsv, loadCareerRows, decodeCareerIndex, buildEmployerProfile, employerProfilePath, employerIdFromPath, employerSalaryPath, employerIdFromSearch, selectStaticEmployers, STATIC_EMPLOYER_LIMIT } from '../src/career.js';

const rows = [
  { id: 'a', employer: 'Example Inc.', title: 'Software Engineer', soc: '15-1252', state: 'CA', city: 'Sunnyvale', wage: 100000, prevailingWage: 90000, date: '2026-01-01', fullTime: true, petitionType: 'New employment' },
  { id: 'b', employer: 'Example Inc.', title: 'Software Engineer', soc: '15-1252', state: 'CA', city: 'Sunnyvale', wage: 200000, prevailingWage: 120000, date: '2026-02-01', fullTime: true, petitionType: 'Continuation' },
  { id: 'c', employer: 'Example Inc.', title: 'Analyst', soc: '15-2051', state: 'NY', city: 'New York', wage: 300000, prevailingWage: 130000, date: '2026-03-01', fullTime: false, petitionType: 'New employment' },
];

test('filters apply before pagination and statistics, without mutating source rows', () => {
  const result = searchCareer('engineer', { state: 'CA', minWage: 100000, page: 2, pageSize: 1 }, { rows });
  assert.equal(result.total, 2);
  assert.equal(result.rows[0].id, 'a');
  assert.equal(result.summary.median, 150000);
  assert.equal(result.matchingRows.length, 2);
  assert.equal(rows[0].id, 'a');
  assert.equal(searchCareer('', { fullTime: true, from: '2026-02-01' }, { rows }).total, 1);
});

test('offer benchmark handles ties, all matching records, and invalid or empty inputs', () => {
  const benchmark = benchmarkOffer(200000, rows);
  assert.equal(benchmark.percentile, 50);
  assert.equal(benchmark.median, 200000);
  assert.equal(benchmark.prevailingMedian, 120000);
  assert.equal(benchmarkOffer(150000, []).percentile, null);
  assert.throws(() => benchmarkOffer(NaN, rows), /positive/);
  assert.equal(summarizeEmployer('example inc.', { rows }).filings, 3);
});

test('employer index filters and autocomplete use distinct summaries', () => {
  const dataset = { employers: [
    { id: '1', name: 'EXAMPLE INC.', filings: 3, states: ['CA'], industry: 'Information', score: 80, median: 200000, lastFiled: '2026-01-01' },
    { id: '2', name: 'ANOTHER EXAMPLE', filings: 5, states: ['NY'], industry: 'Finance', score: 60, median: 150000, lastFiled: '2026-02-01' },
  ] };
  assert.equal(autocompleteEmployers('example', dataset)[0].id, '1');
  assert.equal(searchSponsors('', { state: 'CA', minScore: 70 }, dataset).total, 1);
  assert.equal(searchSponsors('', { sort: 'wage' }, dataset).rows[0].id, '1');
});

test('compact employer index decodes without changing the public browser API', () => {
  const decoded = decodeCareerIndex({ employerColumns: ['id', 'name', 'filings'], employerRows: [['a', 'EXAMPLE', 2]] });
  assert.deepEqual(decoded.employers, [{ id: 'a', name: 'EXAMPLE', filings: 2 }]);
  assert.equal(decodeCareerIndex(decoded), decoded);
});

test('shard loader decodes published columns and returns provenance', async () => {
  const id = 'abcdef0123456789';
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const data = url.endsWith('career-index.json')
      ? { employers: [{ id, name: 'EXAMPLE' }], scope: { records: 1 }, sources: [{ url: 'https://www.dol.gov/' }], shardPrefixLength: 2 }
      : { columns: ['id', 'wage'], employers: { [id]: { name: 'EXAMPLE', rows: [['case', 100000]] } } };
    return { ok: true, json: async () => data };
  };
  const result = await loadCareerRows(id, fetcher, '/test-data');
  assert.deepEqual(result.rows, [{ id: 'case', wage: 100000, employer: 'EXAMPLE' }]);
  assert.equal(result.scope.records, 1);
  assert.equal(calls[1], '/test-data/career/ab.json');
});

test('CSV escapes commas, quotation marks and formula prefixes', () => {
  const csv = careerRowsToCsv([{ employer: '=VALUE("x")', title: 'Role, senior' }]);
  assert.match(csv, /"'=VALUE\(""x""\)"/);
  assert.match(csv, /"Role, senior"/);
});

test('employer profile paths are safe, readable and collision-resistant', () => {
  const employer = { id: 'abcdef0123456789', name: 'EXAMPLE, INC. / R&D' };
  const path = employerProfilePath(employer);
  assert.equal(path, '/employers/example-inc-r-d--abcdef0123456789/');
  assert.equal(employerIdFromPath(path), employer.id);
  assert.equal(employerIdFromPath(path.slice(0, -1)), employer.id);
  assert.notEqual(employerProfilePath({ ...employer, id: '1234567890abcdef' }), path);
  assert.match(employerProfilePath({ ...employer, name: '\u00c9xample LLC' }), /^\/employers\/example-llc--/);
  assert.match(employerProfilePath({ ...employer, name: '\u4f01\u4e1a' }), /^\/employers\/employer--/);
  assert.ok(employerProfilePath({ ...employer, name: 'a'.repeat(200) }).split('--')[0].length <= '/employers/'.length + 80);
  assert.equal(employerProfilePath({ ...employer, id: '../../escape' }), null);
  assert.equal(employerProfilePath({ ...employer, name: '' }), null);
  for (const invalid of ['/employers/', '/employers/../example--abcdef0123456789/', `${path}?id=other`, '/employers/x--ABCDEF0123456789/', '/salary-data/']) {
    assert.equal(employerIdFromPath(invalid), null);
  }
});

test('salary links preserve a validated employer selection across new tabs and reloads', () => {
  const id = 'abcdef0123456789';
  assert.equal(employerSalaryPath(id), `/salary-data/?employer=${id}`);
  assert.equal(employerIdFromSearch(new URL(employerSalaryPath(id), 'https://timer.example').search), id);
  for (const invalid of ['', '?employer=../escape', '?employer=ABCDEF0123456789', `?employer=${id}&employer=${id}`]) {
    assert.equal(employerIdFromSearch(invalid), null);
  }
  assert.equal(employerSalaryPath('invalid'), null);
});

test('static employer selection ranks disclosed volume without scores and respects its page cap', () => {
  const employers = Array.from({ length: 600 }, (_, i) => ({ id: i.toString(16).padStart(16, '0'), name: `Employer ${i}`, filings: i + 1, score: 1000 - i }));
  const dataset = { employers };
  assert.equal(selectStaticEmployers(dataset, 10000).length, STATIC_EMPLOYER_LIMIT);
  assert.equal(selectStaticEmployers(dataset)[0].filings, 600);
  assert.equal(selectStaticEmployers(dataset, 0).length, 0);
  assert.equal(selectStaticEmployers(dataset, 2.9).length, 2);
  assert.equal(employers[0].filings, 1);
  const ties = { employers: [{ ...employers[0], name: 'Z', filings: 2 }, { ...employers[1], name: 'A', filings: 2 }] };
  assert.equal(selectStaticEmployers(ties)[0].name, 'A');
});

test('employer profile aggregates certified disclosed cases and carries coverage without approval claims', () => {
  const employer = { id: 'abcdef0123456789', name: 'Example Inc.', filings: 3, score: 99 };
  const data = {
    employer, rows: [
      ...rows.map(row => ({ ...row, status: 'Certified', decisionDate: '2026-04-01' })),
      { ...rows[0], status: 'Denied', date: '2025-01-01' },
      { ...rows[0], status: 'Certified', employer: 'Other LLC' },
    ],
    scope: { label: 'FY2026_Q3' }, sources: [{ url: 'https://www.dol.gov/official.xlsx' }], generatedAt: '2026-10-11T00:00:00Z',
  };
  const original = structuredClone(data);
  const profile = buildEmployerProfile(data);
  assert.equal(profile.path, employerProfilePath(employer));
  assert.equal(profile.filings, 3);
  assert.equal(profile.wages.median, 200000);
  assert.equal(profile.wages.p25, 150000);
  assert.equal(profile.wages.p75, 250000);
  assert.equal(profile.firstFiled, '2026-01-01');
  assert.equal(profile.lastFiled, '2026-03-01');
  assert.equal(profile.lastDecision, '2026-04-01');
  assert.deepEqual(profile.fullTimeCounts, { fullTime: 2, partTime: 1, unknown: 0 });
  assert.equal(profile.topTitles[0].title, 'Software Engineer');
  assert.equal(profile.topTitles[0].filings, 2);
  assert.equal(profile.topTitles[0].wages.median, 150000);
  assert.equal(profile.worksiteStates[0].state, 'CA');
  assert.equal(profile.topWorksites[0].city, 'Sunnyvale');
  assert.deepEqual(profile.filingMonths, [{ month: '2026-01', filings: 1 }, { month: '2026-02', filings: 1 }, { month: '2026-03', filings: 1 }]);
  assert.deepEqual(profile.scope, data.scope);
  assert.deepEqual(profile.sources, data.sources);
  assert.equal(profile.generatedAt, data.generatedAt);
  for (const field of ['score', 'approvalRate', 'reliabilityScore', 'greenCardSponsorship']) assert.equal(Object.hasOwn(profile, field), false);
  assert.deepEqual(data, original);
});

test('employer profiles preserve unknown schedule and missing dates without guessing', () => {
  const profile = buildEmployerProfile({
    employer: { id: 'abcdef0123456789', name: 'Example' },
    rows: [{ id: 'case', status: 'Certified', wage: 100000, date: '2026-02-30' }],
  });
  assert.equal(profile.filings, 1);
  assert.deepEqual(profile.fullTimeCounts, { fullTime: 0, partTime: 0, unknown: 1 });
  assert.equal(profile.firstFiled, null);
  assert.equal(profile.lastFiled, null);
  assert.equal(profile.lastDecision, null);
  assert.deepEqual(profile.filingMonths, []);
  assert.deepEqual(profile.topTitles, []);
  assert.deepEqual(profile.worksiteStates, []);
  assert.deepEqual(profile.topWorksites, []);
  assert.equal(buildEmployerProfile(), null);
});

const publishedIndex = new URL('../public/data/career-index.json', import.meta.url);
test('published records match source manifest and employer aggregates', { skip: !existsSync(publishedIndex) }, () => {
  const index = decodeCareerIndex(JSON.parse(readFileSync(publishedIndex, 'utf8')));
  assert.equal(index.scope.limited, false);
  assert.equal(index.scope.visaClass, 'H-1B');
  assert.ok(index.sources.every((source) => new URL(source.url).hostname.endsWith('dol.gov') && /^[a-f0-9]{64}$/.test(source.sha256)));
  const seen = new Set();
  const shardDirectory = new URL('../public/data/career/', import.meta.url);
  const counts = new Map();
  for (const filename of readdirSync(shardDirectory)) {
    const path = new URL(filename, shardDirectory);
    assert.ok(statSync(path).size < 25 * 1024 * 1024);
    const shard = JSON.parse(readFileSync(path, 'utf8'));
    const idIndex = shard.columns.indexOf('id');
    const wageIndex = shard.columns.indexOf('wage');
    const statusIndex = shard.columns.indexOf('status');
    for (const [employerId, employer] of Object.entries(shard.employers)) {
      counts.set(employerId, employer.rows.length);
      for (const row of employer.rows) {
        assert.ok(!seen.has(row[idIndex]), `Duplicate disclosed case ${row[idIndex]}`);
        seen.add(row[idIndex]);
        assert.ok(row[wageIndex] >= 5000 && row[wageIndex] <= 1000000);
        assert.equal(row[statusIndex], 'Certified');
      }
    }
  }
  assert.equal(seen.size, index.scope.records);
  assert.equal(counts.size, index.scope.employers);
  assert.ok(index.employers.every((employer) => counts.get(employer.id) === employer.filings));
});
