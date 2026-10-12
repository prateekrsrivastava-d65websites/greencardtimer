import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'cheerio';
import { parseDate } from '../src/model.js';
import { processingFreshness, validateProcessingSnapshot } from '../src/processing.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PROCESSING_SOURCE_URL = 'https://flag.dol.gov/processingtimes';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const compact = value => value.replace(/\s+/g, ' ').trim();
const PROGRAMS = { PERM: 'perm', 'H-1B': 'h1b' };
const NOTES = [
  'Queue dates identify filing or submission months currently being reviewed, not a promised decision date. Older cases may still be pending.',
  'PERM averages describe completed applications in the stated reporting month. They are not an individual wait estimate or approval forecast.',
  'Reconsideration, redetermination and director-review months refer to appeal or review requests, not necessarily the original filing date.',
  'PWD remaining-request counts concern prevailing-wage requests, not pending PERM labor-certification applications. Withdrawn and voided requests are excluded; earlier counts may change.',
  'No individual case status is available in these public aggregate tables. History contains only snapshots actually observed by this site.',
];

export function parseProcessingMonth(value) {
  const text = compact(value);
  if (/^(?:--|N\/A)$/i.test(text)) return null;
  const match = text.match(/^([A-Za-z]+) (\d{4})$/);
  const month = match ? MONTHS.findIndex(name => name.toLowerCase() === match[1].toLowerCase()) + 1 : 0;
  if (!month) throw new Error(`Unexpected processing month: ${value}`);
  return `${match[2]}-${String(month).padStart(2, '0')}`;
}

function sourceDate(value) {
  const matches = [...value.matchAll(/\(as of (\d{1,2})\/(\d{1,2})\/(\d{4})\)/gi)];
  if (matches.length !== 1) throw new Error('Missing or ambiguous published processing source date.');
  const [match] = matches;
  const iso = match ? `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}` : null;
  if (!parseDate(iso)) throw new Error('Missing or invalid published processing source date.');
  return iso;
}

function count(value, nullable = false) {
  if (nullable && /^(?:--|N\/A)$/i.test(value)) return null;
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value)) throw new Error(`Unexpected processing count: ${value}`);
  const number = Number(value.replaceAll(',', ''));
  if (!Number.isSafeInteger(number)) throw new Error('Processing count exceeds the safe integer range.');
  return number;
}

export function parseProcessingHTML(html) {
  const $ = load(html);
  const text = element => {
    const copy = $(element).clone();
    copy.find('sup').remove();
    copy.find('br').replaceWith(' ');
    copy.find('p,div').append(' ');
    return compact(copy.text());
  };
  const tables = $('table').map((_, table) => ({ element: table, rows: $(table).find('tr').map((__, row) => [$(row).children('td,th').map((___, cell) => text(cell)).get()]).get() })).get();
  const tableFor = (headers, title = null) => {
    const matches = tables.filter(table => (!title || table.rows[0]?.[0] === title)
      && table.rows.some(row => row.length === headers.length && headers.every(header => row.filter(cell => cell === header).length === 1)));
    if (matches.length !== 1) throw new Error(`Expected one ${title ?? headers.join('/')} table; found ${matches.length}.`);
    const table = matches[0];
    const header = table.rows.find(row => row.length === headers.length && headers.every(value => row.includes(value)));
    return { ...table, columns: Object.fromEntries(header.map((value, index) => [value, index])) };
  };
  const rowFor = (table, column, label) => {
    const matches = table.rows.filter(row => row[table.columns[column]] === label);
    if (matches.length !== 1) throw new Error(`Missing or duplicate ${label} processing row.`);
    return matches[0];
  };
  const headingFor = (table, title) => {
    const caption = compact($(table.element).children('caption').text());
    const heading = caption.startsWith(title) ? caption : $(table.element).prevAll('p,h2,h3,h4').map((_, element) => text(element)).get().find(value => value.startsWith(title));
    if (!heading) throw new Error(`Missing ${title} source heading.`);
    return heading;
  };
  const dateFor = (table, title) => sourceDate(headingFor(table, title));
  const permTable = tableFor(['Processing Queue', 'Priority Date']);
  const averageTable = tableFor(['Determinations', 'Month', 'Calendar Days']);
  const pwdTable = tableFor(['Processing Queue', 'OEWS Receipt Date', 'Non-OEWS Receipt Date']);
  headingFor(averageTable, 'Average Number of Days to Process PERM Applications');
  const namedMonths = row => {
    const value = row[pwdTable.columns['Processing Queue'] === 0 ? 1 : 0];
    const parts = value.split(/(?=(?:CW-1|H-1B|H-2B|PERM)\s*:)/).map(compact).filter(Boolean);
    const result = {};
    for (const part of parts) {
      const match = part.match(/^(CW-1|H-1B|H-2B|PERM):\s*(.+)$/);
      if (!match) throw new Error(`Unexpected PWD review month: ${part}`);
      const program = PROGRAMS[match[1]];
      if (!program) continue;
      if (Object.hasOwn(result, program)) throw new Error(`Duplicate PWD ${program} review month.`);
      result[program] = parseProcessingMonth(match[2]);
    }
    if (!Object.values(PROGRAMS).every(program => Object.hasOwn(result, program))) throw new Error('Missing PERM or H-1B PWD review month.');
    return { perm: result.perm, h1b: result.h1b };
  };
  const remainingRequests = {};
  for (const [label, program] of Object.entries(PROGRAMS)) {
    const table = tableFor(['Receipt Month', 'Remaining Requests'], label);
    const index = tables.findIndex(candidate => candidate.element === table.element);
    if (index <= tables.findIndex(candidate => candidate.element === pwdTable.element) || index >= tables.findIndex(candidate => candidate.element === permTable.element)) throw new Error('A remaining-request table is outside the published PWD section.');
    const dataRows = table.rows.filter(row => !(row.length === 1 && row[0] === label)
      && !(row.length === 2 && row[table.columns['Receipt Month']] === 'Receipt Month' && row[table.columns['Remaining Requests']] === 'Remaining Requests'));
    remainingRequests[program] = dataRows.map(row => {
      if (row.length !== 2) throw new Error(`Unexpected PWD ${program} remaining-request row shape.`);
      const month = parseProcessingMonth(row[table.columns['Receipt Month']]);
      if (month === null) throw new Error('A PWD receipt month was not published.');
      return { month, count: count(row[table.columns['Remaining Requests']]) };
    }).sort((a, b) => a.month.localeCompare(b.month));
  }
  const permQueues = {};
  for (const [label, id] of [['Analyst Review', 'analystReview'], ['Audit Review', 'auditReview'], ['Reconsideration Request to the CO', 'reconsideration']]) {
    permQueues[id] = parseProcessingMonth(rowFor(permTable, 'Processing Queue', label)[permTable.columns['Priority Date']]);
  }
  const averages = {};
  for (const [label, id] of [['Analyst Review', 'analystReview'], ['Audit Review', 'auditReview']]) {
    const row = rowFor(averageTable, 'Determinations', label);
    averages[id] = { month: parseProcessingMonth(row[averageTable.columns.Month]), days: count(row[averageTable.columns['Calendar Days']], true) };
  }
  const pwdQueues = {};
  for (const [label, id] of Object.entries(PROGRAMS)) {
    const row = rowFor(pwdTable, 'Processing Queue', label);
    pwdQueues[id] = { oews: parseProcessingMonth(row[pwdTable.columns['OEWS Receipt Date']]), nonOews: parseProcessingMonth(row[pwdTable.columns['Non-OEWS Receipt Date']]) };
  }
  return validateProcessingSnapshot({
    perm: { asOf: dateFor(permTable, 'PERM Processing Times'), queues: permQueues, averages },
    pwd: { asOf: dateFor(pwdTable, 'Prevailing Wage Determination Processing Times'), queues: pwdQueues,
      redeterminations: namedMonths(rowFor(pwdTable, 'Processing Queue', 'Redeterminations')),
      directorReviews: namedMonths(rowFor(pwdTable, 'Processing Queue', 'Center Director Reviews')), remainingRequests },
  });
}

export async function fetchProcessingHTML(fetchImpl = fetch) {
  const response = await fetchImpl(PROCESSING_SOURCE_URL, { headers: { 'User-Agent': 'GreenCardTimer-public-data-refresh/1.0 (https://greencardtimer.com/)', Accept: 'text/html' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Official processing source returned HTTP ${response.status}.`);
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Official processing source did not return HTML.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let html = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2_000_000) { await reader.cancel(); throw new Error('Official processing HTML exceeded the size limit.'); }
    html += decoder.decode(value, { stream: true });
  }
  return html + decoder.decode();
}

export async function refreshProcessing({ root = ROOT, fetchImpl = fetch, now = new Date() } = {}) {
  const path = resolve(root, 'public/data/processing.json');
  let saved = null;
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved) {
    if (saved.schemaVersion !== 1 || saved.sourceUrl !== PROCESSING_SOURCE_URL || !parseDate(saved.generatedAt) || !parseDate(saved.verifiedAt) || !parseDate(saved.refresh?.checkedAt)) throw new Error('Existing processing metadata is invalid; preserving the last good data.');
    validateProcessingSnapshot(saved.current);
    if (!Array.isArray(saved.history) || !saved.history.length) throw new Error('Existing processing history is missing; preserving the last good data.');
    let previousObservation = null;
    for (const snapshot of saved.history) {
      validateProcessingSnapshot(snapshot);
      if (!parseDate(snapshot.observedAt) || (previousObservation && snapshot.observedAt < previousObservation) || ['perm', 'pwd'].some(section => snapshot[section].asOf > snapshot.observedAt)) throw new Error('Existing processing observation dates are invalid; preserving the last good data.');
      previousObservation = snapshot.observedAt;
    }
    if (!isDeepStrictEqual(saved.current, { perm: saved.history.at(-1).perm, pwd: saved.history.at(-1).pwd })) throw new Error('Existing processing history disagrees with the current snapshot.');
  }
  const today = now.toISOString().slice(0, 10);
  const current = parseProcessingHTML(await fetchProcessingHTML(fetchImpl));
  const freshness = processingFreshness(current, today);
  if (freshness.stale) throw new Error('The processing source dates are stale or future-dated; preserving the last good data.');
  for (const section of ['perm', 'pwd']) if (saved && current[section].asOf < saved.current[section].asOf) throw new Error('The processing source would roll back a published date; preserving the last good data.');
  const contentChanged = !saved || !isDeepStrictEqual(saved.current, current);
  const history = contentChanged ? [...(saved?.history ?? []), { observedAt: today, ...current }].slice(-120) : saved.history;
  const reuseCheck = !contentChanged && saved?.refresh?.checkedAt?.slice(0, 7) === today.slice(0, 7);
  const data = { schemaVersion: 1, sourceUrl: PROCESSING_SOURCE_URL,
    generatedAt: contentChanged ? today : saved.generatedAt, verifiedAt: contentChanged ? today : saved.verifiedAt,
    refresh: reuseCheck ? saved.refresh : { checkedAt: today },
    updateSchedule: 'DOL publishes PERM and PWD processing updates at the end of the first work week of each month.',
    notes: NOTES, current, history };
  const changed = !isDeepStrictEqual(saved, data);
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }
  return { changed, contentChanged, snapshots: history.length, permAsOf: current.perm.asOf, pwdAsOf: current.pwd.asOf, checkedAt: data.refresh.checkedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await refreshProcessing())); }
  catch (error) { console.error(`Processing refresh failed: ${error.message}`); process.exitCode = 1; }
}
