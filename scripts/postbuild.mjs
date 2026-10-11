import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { Hourglass } from 'lucide';
import { formatDate } from '../src/model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ROUTES = [
  { path: '/', title: 'Green Card Timer | Free Priority Date Tools', description: 'Check employment-based visa bulletin cutoffs, explore transparent priority-date trend scenarios, and compare public H-1B salary disclosures. Free, without an account.' },
  { path: '/visa-bulletin/', title: 'Employment-Based Visa Bulletin | Green Card Timer', description: 'Explore official employment-based final action and filing dates, historical movement, and country-by-category visa bulletin cutoffs.' },
  { path: '/salary-data/', title: 'H-1B Salary Data & Sponsors | Green Card Timer', description: 'Search official Department of Labor H-1B disclosures by employer, location, and salary. Compare disclosed offers and download matching records.' },
  { path: '/methodology/', title: 'Sources & Methodology | Green Card Timer', description: 'Read the official data sources, cutoff rules, historical trend method, and limitations behind Green Card Timer. No guaranteed approval dates.' },
  { path: '/privacy/', title: 'Privacy | Green Card Timer', description: 'Learn how Green Card Timer handles local browser preferences and public-data searches without accounts, paywalls, or application analytics.' },
];

export function siteOrigin(value) {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SITE_URL must be an http(s) origin without a path, credentials, query, or fragment.');
  }
  return url.origin;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function iconMarkup([tag, attributes, children = []]) {
  const props = Object.entries(attributes).map(([key, value]) => `${key}="${xml(value)}"`).join(' ');
  return `<${tag} ${props}>${children.map(iconMarkup).join('')}</${tag}>`;
}

export function faviconMarkup() {
  const [tag, attributes, children] = Hourglass;
  return `${iconMarkup([tag, { ...attributes, width: 32, height: 32, stroke: '#16765c' }, children])}\n`;
}

function sourceLink(url, label) {
  return `<a href="${xml(url)}" target="_blank" rel="noopener noreferrer">${xml(label)}</a>`;
}

function bulletinTable(data, bulletin, chart) {
  const countries = data.countries;
  const headings = countries.map(country => `<th scope="col">${xml(country.label)}</th>`).join('');
  const rows = data.categories.map(category => `<tr><th scope="row">${xml(category.label)}</th>${countries.map(country => `<td>${xml(formatDate(bulletin.charts[chart][category.id][country.id]))}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th scope="col">Category</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function initialContent(route, { bulletinData, careerData } = {}) {
  const latest = bulletinData?.bulletins.find(bulletin => bulletin.month === bulletinData.latestMonth);
  const dos = latest?.sourceUrl || 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html';
  const uscis = 'https://www.uscis.gov/visabulletininfo';
  const dol = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
  let title;
  let body;
  if (route.path === '/visa-bulletin/') {
    title = 'Employment-Based Visa Bulletin';
    body = latest ? `<h2>${xml(latest.label)} Final Action Dates</h2>${bulletinTable(bulletinData, latest, 'finalAction')}<h2>${xml(latest.label)} Dates for Filing</h2>${bulletinTable(bulletinData, latest, 'filing')}` : '<p>The latest verified bulletin tables are temporarily unavailable.</p>';
    body += `<p>Current (C) means no cutoff; Unavailable (U) means no visas authorized. A priority date must be strictly earlier than a dated cutoff. These tables cover EB-1, EB-2, EB-3, other workers, and EB-5 unreserved.</p><p>${sourceLink(dos, 'Official State Department bulletin')}. ${sourceLink(uscis, 'Verify the chart USCIS permits for I-485')} before filing. A cutoff does not predict approval.</p>`;
  } else if (route.path === '/salary-data/') {
    title = 'H-1B Salary Data';
    const scope = careerData?.scope;
    body = scope ? `<h2>${xml(scope.label.replaceAll('_', ' '))} Public Disclosures</h2><p>${Number(scope.records).toLocaleString('en-US')} certified H-1B cases across ${Number(scope.employers).toLocaleString('en-US')} employers. Decision dates: ${xml(formatDate(scope.decisionFrom))} through ${xml(formatDate(scope.decisionTo))}.</p>` : '<p>Employer wage disclosures are published by the Department of Labor.</p>';
    body += `<p>Records are certified H-1B LCAs with annualized wages from $5,000 through $1,000,000. Both full-time and part-time filings are included. Duplicate cases, other statuses and classes, and missing or unsupported wage units are excluded. This is a cumulative quarterly disclosure, not an entire historical database or a list of live job openings.</p><p>Disclosed wages are offers, not verified individual earnings. Certification does not establish visa issuance or green-card sponsorship. ${sourceLink(dol, 'Official DOL disclosure data')}.</p>`;
  } else if (route.path === '/methodology/') {
    title = 'Sources & Methodology';
    body = `<h2>Official cutoff rules</h2><p>For a dated cutoff, the priority date must be strictly earlier, not equal. Current and Unavailable remain distinct states. The ${sourceLink(dos, 'State Department Visa Bulletin')} provides separate Final Action and Dates for Filing charts. ${sourceLink(uscis, 'USCIS selects the permitted I-485 chart each month')}; an unverified chart choice is marked unknown.</p><h2>Historical pace scenarios</h2><p>The tool measures net cutoff movement in complete six-month windows, retaining stalls and retrogression. Windows containing Current, Unavailable, or missing months are excluded. The 25th, 50th, and 75th percentile historical rates illustrate slower, typical, and faster movement; they are not probability bounds.</p><p>Scenarios require at least twelve months of history, three positive windows, a dated latest cutoff, and positive overall net movement. Nonpositive rates have no finite date, and no date is displayed beyond ten years. No inaccessible USCIS inventory or queue is invented. Cutoff eligibility, permission to file, agency processing, and individual approval are different questions.</p><h2>Salary scope</h2><p>${sourceLink(dol, 'DOL OFLC disclosures')} cover certified H-1B cases in the configured cumulative quarter. Both full-time and part-time filings are included. Annualization uses 2,080 hours, 52 weeks, 26 biweekly periods, or 12 months. Annualized wages outside $5,000-$1,000,000, unsupported units, other classes/statuses, and duplicate case numbers are excluded. One case can cover multiple workers or worksites; the primary disclosed worksite is used.</p><h2>Verification</h2><p>Every snapshot carries its official source and verification date. Failed downloads or changed table formats preserve the last verified data. Future demand, supply, policy, and agency decisions can diverge completely from historical movement. This independent educational tool is not a government service or legal advisor.</p>`;
  } else if (route.path === '/privacy/') {
    title = 'Privacy';
    body = '<h2>Local profiles</h2><p>Priority-date selections are processed in your browser. Saved profiles use local storage on this device; there is no account or application profile database. Shared profile links contain their fields, so recipients and hosting infrastructure may receive those details when a link is opened.</p><h2>Public data and hosting</h2><p>The browser downloads public bulletin and employer data. Hosting providers receive ordinary requests and may keep security and operational logs, including IP addresses. Official external links have their own policies.</p><h2>No third-party tracking</h2><p>This version includes no advertising scripts, third-party analytics, payment processing, or account cookies. CSV exports and printing happen locally in your browser.</p><p>Last updated: October 11, 2026.</p>';
  } else {
    title = 'Green Card Timer';
    body = '<p>Free employment-based priority-date checks and public salary disclosures. No account required.</p>';
    if (latest) {
      body += `<h2>${xml(latest.label)} India EB-2</h2><div class="table-wrap"><table><thead><tr><th scope="col">Final Action Date</th><th scope="col">Dates for Filing</th></tr></thead><tbody><tr><td>${xml(formatDate(latest.charts.finalAction.EB2.India))}</td><td>${xml(formatDate(latest.charts.filing.EB2.India))}</td></tr></tbody></table></div><p>A priority date must be strictly earlier than the cutoff. Final action availability does not establish individual approval. ${sourceLink(uscis, 'Check USCIS chart selection')} before filing I-485.</p><p>${sourceLink(dos, `${latest.label} official bulletin`)}.</p>`;
    }
    body += '<p><a href="/visa-bulletin/">Employment-based visa bulletin tables</a> | <a href="/salary-data/">H-1B salary disclosures</a> | <a href="/methodology/">Sources and limitations</a></p>';
  }
  return `<div class="page-heading"><div><h1>${xml(title)}</h1></div></div><article class="reading">${body}</article>`;
}

export function routeHTML(html, route, origin = null, data = {}) {
  const $ = load(html);
  $('title').text(route.title);
  function meta(attribute, name, content) {
    $(`meta[${attribute}="${name}"]`).remove();
    $('head').append($('<meta>').attr({ [attribute]: name, content }));
  }
  meta('name', 'description', route.description);
  meta('property', 'og:title', route.title);
  meta('property', 'og:description', route.description);
  meta('property', 'og:type', 'website');
  meta('property', 'og:site_name', 'Green Card Timer');
  meta('name', 'twitter:card', 'summary');
  meta('name', 'twitter:title', route.title);
  meta('name', 'twitter:description', route.description);
  $('link[rel="canonical"], meta[property="og:url"]').remove();
  if (origin) {
    const url = new URL(route.path, origin).href;
    $('head').append($('<link>').attr({ rel: 'canonical', href: url }));
    meta('property', 'og:url', url);
  }
  $('#main').html(initialContent(route, data));
  $('.nav a').each((_, element) => {
    const active = $(element).attr('href') === route.path;
    $(element).toggleClass('active', active);
    if (active) $(element).attr('aria-current', 'page');
    else $(element).removeAttr('aria-current');
  });
  return $.html();
}

export function assetCacheRules(filenames) {
  return filenames.filter(name => /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|avif|svg)$/.test(name))
    .sort().map(name => `/assets/${name}\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n');
}

export async function postbuild({ root = ROOT, siteURL = process.env.SITE_URL, faviconOnly = false } = {}) {
  const favicon = faviconMarkup();
  await mkdir(resolve(root, 'public'), { recursive: true });
  await writeFile(resolve(root, 'public/favicon.svg'), favicon);
  if (faviconOnly) return { favicon: true };
  const origin = siteOrigin(siteURL);
  const dist = resolve(root, 'dist');
  const html = await readFile(resolve(dist, 'index.html'), 'utf8');
  const bulletinData = JSON.parse(await readFile(resolve(dist, 'data/bulletins.json'), 'utf8'));
  let careerData;
  try { careerData = JSON.parse(await readFile(resolve(dist, 'data/career-index.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const route of ROUTES) {
    const directory = resolve(dist, `.${route.path}`);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'index.html'), routeHTML(html, route, origin, { bulletinData, careerData }));
  }
  await writeFile(resolve(dist, 'favicon.svg'), favicon);
  const headers = await readFile(resolve(root, 'public/_headers'), 'utf8');
  const assets = await readdir(resolve(dist, 'assets'));
  await writeFile(resolve(dist, '_headers'), `${headers.trim()}\n\n${assetCacheRules(assets)}`);
  if (origin) {
    await writeFile(resolve(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    const entries = ROUTES.map(route => `  <url><loc>${xml(new URL(route.path, origin).href)}</loc></url>`).join('\n');
    await writeFile(resolve(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`);
  } else {
    await rm(resolve(dist, 'robots.txt'), { force: true });
    await rm(resolve(dist, 'sitemap.xml'), { force: true });
  }
  return { routes: ROUTES.length, sitemap: Boolean(origin) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await postbuild({ faviconOnly: process.argv.includes('--favicon-only') }))); }
  catch (error) { console.error(`Postbuild failed: ${error.message}`); process.exitCode = 1; }
}
