import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { searchCareer, summarizeEmployer, benchmarkOffer, searchSponsors, autocompleteEmployers, careerRowsToCsv, loadCareerRows, decodeCareerIndex } from '../src/career.js';

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
