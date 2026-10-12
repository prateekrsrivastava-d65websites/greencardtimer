import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { buildModelData, monthIndex, parseDate } from '../src/model.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX_URL = 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html';
const OFFICIAL_HOSTS = ['travel.state.gov', 'adoption.state.gov', 'adoptions.state.gov'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CATEGORY_METADATA = [
  { id: 'EB1', label: 'EB-1', group: 'employment' },
  { id: 'EB2', label: 'EB-2', group: 'employment' },
  { id: 'EB3', label: 'EB-3', group: 'employment' },
  { id: 'EB3OW', label: 'EB-3 Other Workers', group: 'employment' },
  { id: 'EB5', label: 'EB-5 Unreserved', group: 'employment' },
  { id: 'F1', label: 'F1', group: 'family', description: 'Unmarried sons and daughters of U.S. citizens' },
  { id: 'F2A', label: 'F2A', group: 'family', description: 'Spouses and children of permanent residents' },
  { id: 'F2B', label: 'F2B', group: 'family', description: 'Unmarried sons and daughters (21 or older) of permanent residents' },
  { id: 'F3', label: 'F3', group: 'family', description: 'Married sons and daughters of U.S. citizens' },
  { id: 'F4', label: 'F4', group: 'family', description: 'Brothers and sisters of adult U.S. citizens' },
];
const CATEGORIES = CATEGORY_METADATA.map(category => category.id);
const GROUP_CATEGORIES = Object.fromEntries(['employment', 'family'].map(group => [group, CATEGORY_METADATA.filter(category => category.group === group).map(category => category.id)]));
const COUNTRIES = ['India', 'China', 'Mexico', 'Philippines', 'ROW'];
const compact = value => value.replace(/\s+/g, ' ').trim();

export function parseDOSDate(value) {
  const text = compact(value).toUpperCase().replace(/\s/g, '').replace(/\*/g, '');
  if (text === 'C' || text === 'U') return text;
  const match = text.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!match) throw new Error(`Unexpected DOS date token: ${value}`);
  const month = MONTHS.findIndex(name => name.slice(0, 3).toUpperCase() === match[2]) + 1;
  const year = Number(match[3]) < 50 ? 2000 + Number(match[3]) : 1900 + Number(match[3]);
  const date = `${year}-${String(month).padStart(2, '0')}-${match[1]}`;
  if (!parseDate(date)) throw new Error(`Invalid DOS calendar date: ${value}`);
  return date;
}

function categoryFor(value) {
  if (/^F(?:1|2A|2B|3|4)$/i.test(value)) return value.toUpperCase();
  if (/^1st\b/i.test(value)) return 'EB1';
  if (/^2nd\b/i.test(value)) return 'EB2';
  if (/^3rd\b/i.test(value)) return 'EB3';
  if (/^\*?Other Workers\b/i.test(value)) return 'EB3OW';
  if (/^5th\s+Unreserved\b/i.test(value)) return 'EB5';
  return null;
}

function countryFor(value) {
  if (/^All Chargeability Areas/i.test(value)) return 'ROW';
  if (/^CHINA\b/i.test(value)) return 'China';
  return COUNTRIES.find(country => value.toLowerCase() === country.toLowerCase()) ?? null;
}

export function validateBulletin(bulletin) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(bulletin.month)) throw new Error('Bulletin has no valid month.');
  for (const chart of ['finalAction', 'filing']) {
    for (const category of CATEGORIES) {
      for (const country of COUNTRIES) {
        const value = bulletin.charts?.[chart]?.[category]?.[country];
        if (value !== 'C' && value !== 'U' && !parseDate(value)) throw new Error(`Missing or invalid ${chart}/${category}/${country} in ${bulletin.month}.`);
      }
    }
  }
  return bulletin;
}

export function samePublishedBulletin(previous, next) {
  return Boolean(previous && previous.month === next.month && previous.sourceUrl === next.sourceUrl
    && previous.publishedAt === next.publishedAt
    && ['finalAction', 'filing'].every(chart => CATEGORIES.every(category => COUNTRIES.every(country =>
      previous.charts?.[chart]?.[category]?.[country] === next.charts?.[chart]?.[category]?.[country]))));
}

export function parseBulletinHTML(html, sourceUrl, verifiedAt = new Date().toISOString().slice(0, 10)) {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'travel.state.gov') throw new Error('Expected an official State Department bulletin URL.');
  const $ = load(html);
  const headings = $('h1,h2').map((_, element) => compact($(element).text())).get();
  const title = headings.find(text => /^Visa Bulletin For /i.test(text)) ?? compact($('title').text());
  const match = title.match(/Visa Bulletin For\s+(\w+)\s+(\d{4})/i);
  const monthNumber = match ? MONTHS.findIndex(name => name.toLowerCase() === match[1].toLowerCase()) + 1 : 0;
  if (!match || !monthNumber) throw new Error('The bulletin title format changed.');
  const month = `${match[2]}-${String(monthNumber).padStart(2, '0')}`;
  const tables = {};
  let activeSection = null;
  $('body').find('*').each((_, element) => {
    if (element.tagName !== 'table') {
      const heading = compact($(element).text()).toUpperCase();
      if (/^(?:[A-Z]\.\s*)?FINAL ACTION DATES FOR (?:FAMILY-SPONSORED|EMPLOYMENT-BASED) PREFERENCE CASES$/.test(heading)) activeSection = { group: heading.includes('FAMILY-SPONSORED') ? 'family' : 'employment', chart: 'finalAction' };
      if (/^(?:[A-Z]\.\s*)?DATES FOR FILING (?:OF )?(?:FAMILY-SPONSORED|EMPLOYMENT-BASED) VISA APPLICATIONS$/.test(heading)) activeSection = { group: heading.includes('FAMILY-SPONSORED') ? 'family' : 'employment', chart: 'filing' };
      return;
    }
    const rows = $(element).find('tr').map((__, row) => [$(row).children('td,th').map((___, cell) => compact($(cell).text())).get()]).get();
    const header = rows.find(row => row.some(cell => countryFor(cell) === 'India') && row.some(cell => countryFor(cell) === 'ROW'));
    if (!header) return;
    if (!COUNTRIES.every(country => header.filter(cell => countryFor(cell) === country).length === 1)) throw new Error('A preference table has missing or duplicate country columns.');
    const columns = Object.fromEntries(header.map((cell, index) => [countryFor(cell), index]).filter(([country]) => country));
    const chart = {};
    for (const row of rows) {
      const category = categoryFor(row[0] ?? '');
      if (!category) continue;
      if (chart[category]) throw new Error(`Duplicate ${category} row in a preference table.`);
      chart[category] = Object.fromEntries(COUNTRIES.map(country => {
        if (columns[country] === undefined || !row[columns[country]]) throw new Error(`The ${country} column format changed.`);
        return [country, parseDOSDate(row[columns[country]])];
      }));
    }
    if (!Object.keys(chart).length) return;
    if (!activeSection) throw new Error('A preference table has no recognized chart heading.');
    const { group, chart: chartName } = activeSection;
    if (!GROUP_CATEGORIES[group].every(category => chart[category]) || Object.keys(chart).some(category => !GROUP_CATEGORIES[group].includes(category))) throw new Error(`A ${group} table is missing a tracked category or has an unexpected category.`);
    const sectionKey = `${group}:${chartName}`;
    if (tables[sectionKey]) throw new Error(`Duplicate ${chartName} ${group} table.`);
    tables[sectionKey] = chart;
  });
  if (Object.keys(tables).length !== 4) throw new Error(`Expected four labeled family and employment tables; found ${Object.keys(tables).length}.`);
  const published = compact($('body').text()).match(/CA\/VO:\s*(\w+ \d{1,2}, \d{4})/i);
  return validateBulletin({
    month,
    label: `${MONTHS[monthNumber - 1]} ${match[2]}`,
    sourceUrl: url.href,
    publishedAt: published ? new Date(`${published[1]} UTC`).toISOString().slice(0, 10) : null,
    verifiedAt,
    uscisEmploymentChart: null,
    uscisFamilyChart: null,
    uscisSourceUrl: 'https://www.uscis.gov/visabulletininfo',
    charts: Object.fromEntries(['finalAction', 'filing'].map(chart => [chart, { ...tables[`employment:${chart}`], ...tables[`family:${chart}`] }])),
  });
}

export function discoverBulletins(html) {
  const $ = load(html);
  const links = new Map();
  $('a[href]').each((_, element) => {
    let url;
    try { url = new URL($(element).attr('href'), INDEX_URL); } catch { return; }
    if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.includes(url.hostname) || url.port || url.username || url.password) return;
    const match = url.pathname.match(/^\/content\/travel\/en\/legal\/visa-law0\/visa-bulletin\/\d{4}\/visa-bulletin-for-([a-z]+)-(\d{4})\.html$/);
    const month = match ? MONTHS.findIndex(name => name.toLowerCase() === match[1]) + 1 : 0;
    if (!month) return;
    links.set(`${match[2]}-${String(month).padStart(2, '0')}`, `https://travel.state.gov${url.pathname}`);
  });
  return [...links].map(([month, url]) => ({ month, url })).sort((a, b) => b.month.localeCompare(a.month));
}

export async function fetchOfficialHTML(sourceUrl, fetchImpl = fetch, validate = () => undefined) {
  const source = new URL(sourceUrl);
  if (source.protocol !== 'https:' || source.hostname !== 'travel.state.gov' || source.port || source.username || source.password
    || !/^\/content\/travel\/en\/legal\/visa-law0\/(?:visa-bulletin\.html|visa-bulletin\/\d{4}\/visa-bulletin-for-[a-z]+-\d{4}\.html)$/.test(source.pathname)) throw new Error('Expected an official State Department bulletin URL.');
  const errors = [];
  // These openly published State Department hosts serve the same canonical bulletin paths.
  for (const host of OFFICIAL_HOSTS) {
    const url = `https://${host}${source.pathname}`;
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': 'GreenCardTimer-public-data-refresh/1.0 (https://greencardtimer.com/)', Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('text/html')) throw new Error(`Expected HTML; received ${type}`);
      const html = await response.text();
      if (html.length > 2_000_000) throw new Error('Bulletin HTML exceeded the size limit');
      return { html, retrievedFrom: url, parsed: await validate(html) };
    } catch (error) { errors.push(`${url}: ${error.message}`); }
  }
  throw new Error(`All official publication hosts failed; preserving existing data. ${errors.join('; ')}`);
}

async function atomicJSON(path, data) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export async function refresh({ offline = false, maxMonths = 25, root = ROOT, fetchImpl = fetch, now = new Date() } = {}) {
  const bulletinPath = resolve(root, 'public/data/bulletins.json');
  const modelPath = resolve(root, 'public/data/model.json');
  const saved = JSON.parse(await readFile(bulletinPath, 'utf8'));
  const template = JSON.parse(await readFile(modelPath, 'utf8'));
  let data = saved;
  if (!offline) {
    const today = now.toISOString().slice(0, 10);
    const index = await fetchOfficialHTML(INDEX_URL, fetchImpl, html => {
      const links = discoverBulletins(html).slice(0, maxMonths);
      if (links.length < maxMonths) throw new Error(`Fewer than ${maxMonths} bulletin links were discovered; preserving the existing dataset.`);
      if (links[0].month < saved.latestMonth) throw new Error('Source would roll back the latest month; preserving the existing dataset.');
      if (links[0].month < today.slice(0, 7)) throw new Error('The published bulletin is older than the current month; preserving the existing dataset.');
      if (monthIndex(links[0].month) > monthIndex(today.slice(0, 7)) + 1) throw new Error('Source contains an unexpectedly future bulletin month.');
      for (let i = 1; i < links.length; i += 1) {
        if (monthIndex(links[i].month) !== monthIndex(links[i - 1].month) - 1) throw new Error('A monthly bulletin is missing from the discovered history.');
      }
      return links;
    });
    const links = index.parsed;
    const bulletins = [];
    let contentChanged = saved.latestMonth !== links[0].month;
    for (const link of links) {
      const old = saved.bulletins.find(bulletin => bulletin.month === link.month);
      const oldComplete = old && ['finalAction', 'filing'].every(chart => CATEGORIES.every(category => COUNTRIES.every(country => old.charts?.[chart]?.[category]?.[country] !== undefined)));
      if (oldComplete && monthIndex(link.month) < Math.min(monthIndex(saved.latestMonth), monthIndex(today.slice(0, 7))) - 1) { bulletins.push(validateBulletin(old)); continue; }
      const page = await fetchOfficialHTML(link.url, fetchImpl, html => {
        const bulletin = parseBulletinHTML(html, link.url, today);
        if (bulletin.month !== link.month) throw new Error(`Index and bulletin disagree for ${link.month}.`);
        return bulletin;
      });
      const bulletin = page.parsed;
      const unchanged = samePublishedBulletin(old, bulletin);
      contentChanged ||= !unchanged;
      bulletins.push({ ...(unchanged ? validateBulletin(old) : bulletin), retrievedFrom: page.retrievedFrom });
    }
    if (bulletins[0].month < saved.latestMonth) throw new Error('Source would roll back the latest month; preserving the existing dataset.');
    for (let i = 1; i < bulletins.length; i += 1) {
      const previousMonth = new Date(`${bulletins[i - 1].month}-01T00:00:00Z`);
      previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
      if (bulletins[i].month !== previousMonth.toISOString().slice(0, 7)) throw new Error('A monthly bulletin is missing from the discovered history.');
    }
    const check = { checkedAt: today, latestMonth: bulletins[0].month, indexRetrievedFrom: index.retrievedFrom, latestRetrievedFrom: bulletins[0].retrievedFrom };
    const previousCheck = saved.refresh;
    // One genuine successful-check record per month keeps the public repository's schedule active.
    const reuseCheck = !contentChanged && previousCheck?.checkedAt?.slice(0, 7) === today.slice(0, 7)
      && ['latestMonth', 'indexRetrievedFrom', 'latestRetrievedFrom'].every(key => previousCheck[key] === check[key]);
    data = { ...saved, generatedAt: contentChanged ? today : saved.generatedAt, latestMonth: bulletins[0].month, categories: CATEGORY_METADATA,
      verificationMethod: 'Four official DOS family and employment HTML tables identified by chart heading and parsed with Cheerio; all 100 tracked cells and contiguous monthly history validated.',
      bulletins, refresh: reuseCheck ? previousCheck : check };
    template.sourceAccess.automation = 'GitHub Actions checks weekly. Official DOS HTML is fetched from travel.state.gov or its openly published adoption.state.gov/adoptions.state.gov hosts. Canonical sources and actual retrieval URLs are retained. All tracked cells and contiguous history are validated; errors preserve the published data. A monthly successful-check record does not change the data verification date.';
  }
  data.bulletins.forEach(validateBulletin);
  template.methodology.familyCategories = 'Family-sponsored preference categories show sourced cutoff history only; no dated scenarios or approval forecasts are generated.';
  template.sourceAccess.bulletins = 'Twenty-five contiguous official DOS bulletins include both Final Action Dates and Dates for Filing for five employment and five family preference categories across five chargeability areas. Canonical source and actual retrieval URLs are retained.';
  const model = buildModelData(data, template);
  await atomicJSON(bulletinPath, data);
  await atomicJSON(modelPath, model);
  return { months: data.bulletins.length, latestMonth: data.latestMonth, offline, changed: JSON.stringify(data) !== JSON.stringify(saved), refresh: data.refresh };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await refresh({ offline: process.argv.includes('--offline') }))); }
  catch (error) { console.error(`Bulletin refresh failed: ${error.message}`); process.exitCode = 1; }
}
