import { parseDate } from './model.js';

const indexCache = new Map();
const shardCache = new Map();
const normalize = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
const validWages = (rows) => rows.map((row) => Number(row.wage)).filter((wage) => Number.isFinite(wage) && wage > 0).sort((a, b) => a - b);
const rowsOf = (dataset) => Array.isArray(dataset) ? dataset : dataset?.rows ?? [];
export const STATIC_EMPLOYER_LIMIT = 500;

export function employerProfilePath(employer) {
  if (!/^[a-f0-9]{16}$/.test(String(employer?.id)) || !String(employer?.name ?? '').trim()) return null;
  const slug = String(employer.name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || 'employer';
  return `/employers/${slug}--${employer.id}/`;
}

export function employerIdFromPath(pathname) {
  return /^\/employers\/[a-z0-9]+(?:-[a-z0-9]+)*--([a-f0-9]{16})\/?$/.exec(String(pathname))?.[1] ?? null;
}

export function employerSalaryPath(id) {
  return /^[a-f0-9]{16}$/.test(String(id)) ? `/salary-data/?employer=${id}` : null;
}

export function employerIdFromSearch(search) {
  const params = new URLSearchParams(search);
  const ids = params.getAll('employer');
  return ids.length === 1 && employerSalaryPath(ids[0]) ? ids[0] : null;
}

export function selectStaticEmployers(dataset, limit = STATIC_EMPLOYER_LIMIT) {
  const requested = Number(limit);
  const count = Number.isFinite(requested) ? Math.max(0, Math.min(STATIC_EMPLOYER_LIMIT, Math.floor(requested))) : STATIC_EMPLOYER_LIMIT;
  return [...(dataset?.employers ?? [])].filter(employer => employerProfilePath(employer) && employer.filings > 0)
    .sort((a, b) => b.filings - a.filings || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, count);
}

function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const weight = index - lower;
  return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * weight;
}

function wageStats(rows) {
  const wages = validWages(rows);
  if (!wages.length) return { count: 0, mean: null, median: null, min: null, max: null, p25: null, p75: null };
  return {
    count: wages.length,
    mean: wages.reduce((sum, value) => sum + value, 0) / wages.length,
    median: quantile(wages, 0.5), min: wages[0], max: wages.at(-1),
    p25: quantile(wages, 0.25), p75: quantile(wages, 0.75),
  };
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Career data could not be loaded (${response.status}).`);
  return response.json();
}

export function decodeCareerIndex(index) {
  if (index.employers) return index;
  if (!Array.isArray(index.employerColumns) || !Array.isArray(index.employerRows)) throw new Error('Unsupported career data index.');
  return {
    ...index,
    employers: index.employerRows.map((values) => Object.fromEntries(index.employerColumns.map((column, i) => [column, values[i]]))),
  };
}

export async function loadCareerIndex(fetchImpl = globalThis.fetch, baseUrl = '/data') {
  const key = `${baseUrl}/career-index.json`;
  if (!indexCache.has(key)) {
    const pending = getJson(key, fetchImpl).then(decodeCareerIndex).catch((error) => { indexCache.delete(key); throw error; });
    indexCache.set(key, pending);
  }
  return indexCache.get(key);
}

export async function loadCareerRows(employerId, fetchImpl = globalThis.fetch, baseUrl = '/data') {
  if (!/^[a-f0-9]{16}$/.test(String(employerId))) throw new Error('Select an employer from the published index.');
  const index = await loadCareerIndex(fetchImpl, baseUrl);
  const summary = index.employers.find((employer) => employer.id === employerId);
  if (!summary) throw new Error('This employer is outside the published dataset.');
  const prefix = employerId.slice(0, index.shardPrefixLength ?? 2);
  const key = `${baseUrl}/career/${prefix}.json`;
  if (!shardCache.has(key)) {
    const pending = getJson(key, fetchImpl).catch((error) => { shardCache.delete(key); throw error; });
    shardCache.set(key, pending);
  }
  const shard = await shardCache.get(key);
  const employer = shard.employers?.[employerId];
  if (!employer) throw new Error('The employer records are missing from this data release.');
  const rows = employer.rows.map((values) => ({
    ...Object.fromEntries(shard.columns.map((column, i) => [column, values[i]])),
    employer: employer.name,
  }));
  return { rows, employer: summary, scope: index.scope, sources: index.sources, generatedAt: index.generatedAt };
}

export function autocompleteEmployers(query, dataset, limit = 10) {
  const text = normalize(query);
  if (!text) return [];
  return (dataset?.employers ?? []).filter((employer) => normalize(employer.name).includes(text))
    .sort((a, b) => Number(normalize(b.name).startsWith(text)) - Number(normalize(a.name).startsWith(text)) || b.filings - a.filings)
    .slice(0, Math.max(1, Math.min(50, limit)));
}

export function searchSponsors(query = '', filters = {}, dataset = {}) {
  const text = normalize(query);
  const employers = (dataset.employers ?? []).filter((employer) => {
    return (!text || normalize(employer.name).includes(text))
      && (!filters.state || filters.state === 'All' || employer.states.includes(filters.state))
      && (!filters.industry || filters.industry === 'All' || employer.industry === filters.industry)
      && (!filters.minScore || employer.score >= Number(filters.minScore));
  });
  const sorters = {
    wage: (a, b) => b.median - a.median,
    score: (a, b) => b.score - a.score || b.filings - a.filings,
    name: (a, b) => a.name.localeCompare(b.name),
    recent: (a, b) => b.lastFiled.localeCompare(a.lastFiled) || b.filings - a.filings,
  };
  employers.sort(sorters[filters.sort] ?? ((a, b) => b.filings - a.filings));
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(employers.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number(filters.page) || 1));
  return { rows: employers.slice((page - 1) * pageSize, page * pageSize), total: employers.length, page, pageSize, pages };
}

export function searchCareer(query = '', filters = {}, dataset = {}) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  const minimum = Number(filters.minWage ?? filters.wageMin) || 0;
  const maximum = Number(filters.maxWage ?? filters.wageMax) || Infinity;
  const dateFrom = filters.from ?? filters.dateFrom ?? filters.filedFrom;
  const dateTo = filters.to ?? filters.dateTo ?? filters.filedTo;
  const matchingRows = rowsOf(dataset).filter((row) => {
    const searchable = normalize(`${row.employer} ${row.title} ${row.city} ${row.state} ${row.soc} ${row.id}`);
    return tokens.every((token) => searchable.includes(token))
      && (!filters.title || normalize(row.title).includes(normalize(filters.title)))
      && (!filters.employer || normalize(row.employer).includes(normalize(filters.employer)))
      && (!filters.state || filters.state === 'All' || row.state === filters.state)
      && (!filters.city || normalize(row.city).includes(normalize(filters.city)))
      && (!filters.soc || normalize(row.soc).includes(normalize(filters.soc)))
      && Number(row.wage) >= minimum && Number(row.wage) <= maximum
      && (!dateFrom || row.date >= dateFrom) && (!dateTo || row.date <= dateTo)
      && (!filters.petitionType || filters.petitionType === 'All' || row.petitionType.includes(filters.petitionType))
      && (filters.fullTime !== true || row.fullTime === true);
  });
  const sorters = {
    'wage-desc': (a, b) => b.wage - a.wage,
    'wage-asc': (a, b) => a.wage - b.wage,
    'date-asc': (a, b) => a.date.localeCompare(b.date),
    title: (a, b) => a.title.localeCompare(b.title),
    city: (a, b) => a.city.localeCompare(b.city),
  };
  matchingRows.sort(sorters[filters.sort] ?? ((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)));
  const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || 25));
  const pages = Math.max(1, Math.ceil(matchingRows.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number(filters.page) || 1));
  return {
    rows: matchingRows.slice((page - 1) * pageSize, page * pageSize), matchingRows,
    total: matchingRows.length, page, pageSize, pages, summary: wageStats(matchingRows),
  };
}

export function summarizeEmployer(name, dataset = {}) {
  const target = normalize(name);
  const summary = dataset.employers?.find((employer) => normalize(employer.name) === target || employer.id === name);
  if (summary) return summary;
  if (dataset.employer && (normalize(dataset.employer.name) === target || dataset.employer.id === name)) return dataset.employer;
  const rows = rowsOf(dataset).filter((row) => normalize(row.employer) === target);
  if (!rows.length) return null;
  const titles = new Map();
  for (const row of rows) titles.set(row.title, (titles.get(row.title) ?? 0) + 1);
  return {
    name: rows[0].employer, filings: rows.length, ...wageStats(rows),
    states: [...new Set(rows.map((row) => row.state).filter(Boolean))],
    topTitles: [...titles].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([title]) => title),
    lastFiled: rows.map((row) => row.date).sort().at(-1),
  };
}

function groupedWages(rows, fields, limit = Infinity) {
  const groups = new Map();
  for (const row of rows) {
    const labels = fields.map(field => String(row[field] ?? '').trim().replace(/\s+/g, ' '));
    if (labels.some(label => !label)) continue;
    const key = JSON.stringify(labels);
    if (!groups.has(key)) groups.set(key, { labels, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.labels.join(' ').localeCompare(b.labels.join(' ')))
    .slice(0, limit).map(group => ({
      ...Object.fromEntries(fields.map((field, i) => [field, group.labels[i]])),
      filings: group.rows.length, wages: wageStats(group.rows),
    }));
}

export function buildEmployerProfile(dataset = {}) {
  const employer = dataset.employer;
  const path = employerProfilePath(employer);
  if (!path) return null;
  const rows = rowsOf(dataset).filter(row => row.status === 'Certified'
    && normalize(row.employer ?? employer.name) === normalize(employer.name));
  const filedDates = rows.map(row => row.date).filter(value => parseDate(value)).sort();
  const decisionDates = rows.map(row => row.decisionDate).filter(value => parseDate(value)).sort();
  const months = new Map();
  for (const date of filedDates) months.set(date.slice(0, 7), (months.get(date.slice(0, 7)) ?? 0) + 1);
  const fullTime = rows.filter(row => row.fullTime === true).length;
  const partTime = rows.filter(row => row.fullTime === false).length;
  return {
    id: employer.id, name: employer.name, path, filings: rows.length, wages: wageStats(rows),
    firstFiled: filedDates[0] ?? null, lastFiled: filedDates.at(-1) ?? null, lastDecision: decisionDates.at(-1) ?? null,
    fullTimeCounts: { fullTime, partTime, unknown: rows.length - fullTime - partTime },
    topTitles: groupedWages(rows, ['title'], 10), worksiteStates: groupedWages(rows, ['state']),
    topWorksites: groupedWages(rows, ['city', 'state'], 10),
    filingMonths: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, filings]) => ({ month, filings })),
    scope: dataset.scope, sources: dataset.sources ?? [], generatedAt: dataset.generatedAt,
  };
}

export function benchmarkOffer(salary, matchingRows) {
  const offer = Number(salary);
  const rows = rowsOf(matchingRows);
  const wages = validWages(rows);
  if (!Number.isFinite(offer) || offer <= 0) throw new Error('Enter a positive annual base salary.');
  if (!wages.length) return { count: 0, percentile: null, median: null, mean: null };
  const below = wages.filter((wage) => wage < offer).length;
  const equal = wages.filter((wage) => wage === offer).length;
  const stats = wageStats(rows);
  const prevailing = rows.map((row) => Number(row.prevailingWage)).filter((wage) => Number.isFinite(wage) && wage > 0).sort((a, b) => a - b);
  return {
    ...stats, salary: offer, percentile: Math.round((below + equal / 2) / wages.length * 1000) / 10,
    premiumToMedian: (offer / stats.median - 1) * 100,
    prevailingMedian: quantile(prevailing, 0.5), smallSample: wages.length < 10,
    percentileMethod: 'Share of comparable filed wages below the offer, plus half of wages equal to it.',
  };
}

export function careerRowsToCsv(rows) {
  const columns = ['employer', 'title', 'soc', 'city', 'state', 'wage', 'prevailingWage', 'wageLevel', 'date', 'id'];
  const escape = (value) => {
    let text = String(value ?? '');
    // Prevent spreadsheet applications interpreting public employer/title text as formulas.
    if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((key) => escape(row[key])).join(','))].join('\r\n');
}
