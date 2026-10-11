import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { buildModelData, parseDate } from '../src/model.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INDEX_URL = 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CATEGORIES = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5'];
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
  const tables = [];
  $('table').each((_, element) => {
    const rows = $(element).find('tr').map((__, row) => [$(row).children('td,th').map((___, cell) => compact($(cell).text())).get()]).get();
    const header = rows.find(row => row.some(cell => countryFor(cell) === 'India') && row.some(cell => countryFor(cell) === 'ROW'));
    if (!header) return;
    const columns = Object.fromEntries(header.map((cell, index) => [countryFor(cell), index]).filter(([country]) => country));
    const chart = {};
    for (const row of rows) {
      const category = categoryFor(row[0] ?? '');
      if (!category) continue;
      if (chart[category]) throw new Error(`Duplicate ${category} row in an employment table.`);
      chart[category] = Object.fromEntries(COUNTRIES.map(country => {
        if (columns[country] === undefined || !row[columns[country]]) throw new Error(`The ${country} column format changed.`);
        return [country, parseDOSDate(row[columns[country]])];
      }));
    }
    if (!Object.keys(chart).length) return;
    if (!CATEGORIES.every(category => chart[category])) throw new Error('An employment table is missing a tracked category.');
    tables.push(chart);
  });
  if (tables.length !== 2) throw new Error(`Expected two employment tables; found ${tables.length}.`);
  const published = compact($('body').text()).match(/CA\/VO:\s*(\w+ \d{1,2}, \d{4})/i);
  return validateBulletin({
    month,
    label: `${MONTHS[monthNumber - 1]} ${match[2]}`,
    sourceUrl: url.href,
    publishedAt: published ? new Date(`${published[1]} UTC`).toISOString().slice(0, 10) : null,
    verifiedAt,
    uscisEmploymentChart: null,
    uscisSourceUrl: 'https://www.uscis.gov/visabulletininfo',
    charts: { finalAction: tables[0], filing: tables[1] },
  });
}

export function discoverBulletins(html) {
  const $ = load(html);
  const links = new Map();
  $('a[href]').each((_, element) => {
    let url;
    try { url = new URL($(element).attr('href'), INDEX_URL); } catch { return; }
    if (url.protocol !== 'https:' || url.hostname !== 'travel.state.gov') return;
    const match = url.pathname.match(/\/visa-bulletin\/\d{4}\/visa-bulletin-for-([a-z]+)-(\d{4})\.html$/);
    const month = match ? MONTHS.findIndex(name => name.toLowerCase() === match[1]) + 1 : 0;
    if (!month) return;
    links.set(`${match[2]}-${String(month).padStart(2, '0')}`, url.href);
  });
  return [...links].map(([month, url]) => ({ month, url })).sort((a, b) => b.month.localeCompare(a.month));
}

async function fetchHTML(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'GreenCardTimer-public-data-refresh/1.0', Accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}: ${url}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) throw new Error(`Expected HTML from ${url}; received ${type}.`);
  return response.text();
}

async function atomicJSON(path, data) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export async function refresh({ offline = false, maxMonths = 25 } = {}) {
  const bulletinPath = resolve(ROOT, 'public/data/bulletins.json');
  const modelPath = resolve(ROOT, 'public/data/model.json');
  const saved = JSON.parse(await readFile(bulletinPath, 'utf8'));
  const template = JSON.parse(await readFile(modelPath, 'utf8'));
  let data = saved;
  if (!offline) {
    const links = discoverBulletins(await fetchHTML(INDEX_URL)).slice(0, maxMonths);
    if (links.length < 13) throw new Error('Fewer than thirteen bulletin links were discovered; preserving the existing dataset.');
    const bulletins = [];
    for (const link of links) {
      const old = saved.bulletins.find(bulletin => bulletin.month === link.month);
      if (old && link.month < saved.latestMonth) { bulletins.push(validateBulletin(old)); continue; }
      const bulletin = parseBulletinHTML(await fetchHTML(link.url), link.url);
      if (bulletin.month !== link.month) throw new Error(`Index and bulletin disagree for ${link.month}.`);
      bulletins.push(samePublishedBulletin(old, bulletin) ? validateBulletin(old) : bulletin);
    }
    if (bulletins[0].month < saved.latestMonth) throw new Error('Source would roll back the latest month; preserving the existing dataset.');
    for (let i = 1; i < bulletins.length; i += 1) {
      const previousMonth = new Date(`${bulletins[i - 1].month}-01T00:00:00Z`);
      previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
      if (bulletins[i].month !== previousMonth.toISOString().slice(0, 7)) throw new Error('A monthly bulletin is missing from the discovered history.');
    }
    const changed = saved.latestMonth !== bulletins[0].month || JSON.stringify(saved.bulletins) !== JSON.stringify(bulletins);
    if (changed) {
      data = { ...saved, generatedAt: new Date().toISOString().slice(0, 10), latestMonth: bulletins[0].month, verificationMethod: 'Official DOS HTML tables parsed with Cheerio; all tracked cells and contiguous monthly history validated.', bulletins };
      template.sourceAccess.automation = 'The latest refresh fetched official DOS HTML successfully. Fetch and parser errors stop the task without changing the published data.';
    }
  }
  data.bulletins.forEach(validateBulletin);
  const model = buildModelData(data, template);
  await atomicJSON(bulletinPath, data);
  await atomicJSON(modelPath, model);
  return { months: data.bulletins.length, latestMonth: data.latestMonth, offline };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await refresh({ offline: process.argv.includes('--offline') }))); }
  catch (error) { console.error(`Bulletin refresh failed: ${error.message}`); process.exitCode = 1; }
}
