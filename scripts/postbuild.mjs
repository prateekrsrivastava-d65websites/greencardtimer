import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { Hourglass } from 'lucide';
import { formatDate } from '../src/model.js';
import { formatProcessingMonth } from '../src/processing.js';
import { buildEmployerProfile, decodeCareerIndex, employerProfilePath, employerSalaryPath, selectStaticEmployers } from '../src/career.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ROUTES = [
  { path: '/', title: 'Green Card Timer | Free Priority Date Tools', description: 'Check employment-based and family-sponsored visa bulletin cutoffs, explore transparent priority-date history, and compare public H-1B salary disclosures. Free, without an account.' },
  { path: '/visa-bulletin/', title: 'Employment & Family Visa Bulletin | Green Card Timer', description: 'Explore official employment-based and family-sponsored final action and filing dates, historical movement, and country-by-category visa bulletin cutoffs.' },
  { path: '/family-green-card/', title: 'Family-Based Green Card Tracker | Green Card Timer', description: 'Check family preference priority dates for F1, F2A, F2B, F3 and F4. Compare official final action and filing cutoffs and monthly history without an account.' },
  { path: '/salary-data/', title: 'H-1B Salary Data & Sponsors | Green Card Timer', description: 'Search official Department of Labor H-1B disclosures by employer, location, and salary. Compare disclosed offers and download matching records.' },
  { path: '/employers/', title: 'H-1B Employer Filing Profiles | Green Card Timer', description: 'Explore employer H-1B filing profiles from official Department of Labor disclosures. Compare certified LCA counts, disclosed wages, job titles and primary worksites.' },
  { path: '/methodology/', title: 'Sources & Methodology | Green Card Timer', description: 'Read the official data sources, cutoff rules, historical trend method, and limitations behind Green Card Timer. No guaranteed approval dates.' },
  { path: '/privacy/', title: 'Privacy | Green Card Timer', description: 'Local profiles, optional aggregated community counts, and hosting disclosures. No accounts, paywalls or third-party tracking.' },
  { path: '/processing-times/', title: 'PERM & PWD Processing Times | Green Card Timer', description: 'Compare your filing month with official DOL PERM and prevailing-wage processing months. Weekly-checked source data, without a signup or approval predictions.' },
  { path: '/community/', title: 'Community Search Trends | Green Card Timer', description: 'Optional aggregated country, visa preference and broad priority-date search trends. Small groups hidden, no exact dates or visitor identifiers.' },
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

function bulletinTable(data, bulletin, chart, group) {
  const countries = data.countries;
  const headings = countries.map(country => `<th scope="col">${xml(country.label)}</th>`).join('');
  const categories = data.categories.filter(category => (category.group ?? 'employment') === group);
  const rows = categories.map(category => `<tr><th scope="row">${xml(category.label)}</th>${countries.map(country => `<td>${xml(formatDate(bulletin.charts[chart][category.id][country.id]))}</td>`).join('')}</tr>`).join('');
  const label = `${group === 'family' ? 'Family-Sponsored' : 'Employment-Based'} ${chart === 'finalAction' ? 'Final Action Dates' : 'Dates for Filing'}`;
  return `<div class="table-wrap"><table aria-label="${xml(label)}"><thead><tr><th scope="col">Category</th>${headings}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function bulletinCharts(data, bulletin, group) {
  const label = group === 'family' ? 'Family-Sponsored' : 'Employment-Based';
  return `<h2>${xml(bulletin.label)} ${label} Final Action Dates</h2>${bulletinTable(data, bulletin, 'finalAction', group)}<h2>${xml(bulletin.label)} ${label} Dates for Filing</h2>${bulletinTable(data, bulletin, 'filing', group)}`;
}

function chartChoice(value) {
  return value === 'finalAction' ? 'Final Action Dates' : value === 'filing' ? 'Dates for Filing' : 'Unknown; not independently verified';
}

function currency(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value) : 'Not available';
}

function count(value) {
  return Number(value).toLocaleString('en-US');
}

function profileTable(label, headings, rows) {
  return `<h2>${xml(label)}</h2><div class="table-wrap"><table aria-label="${xml(label)}"><thead><tr>${headings.map(heading => `<th scope="col">${xml(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((value, i) => i === 0 ? `<th scope="row">${xml(value)}</th>` : `<td>${xml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function employerRoute(profile) {
  return {
    path: profile.path,
    title: `${profile.name} H-1B Filings & Salaries | Green Card Timer`,
    description: `${profile.name}: ${count(profile.filings)} certified H-1B LCA filings in ${String(profile.scope?.label ?? 'the published DOL release').replaceAll('_', ' ')}. Explore disclosed annualized wages, job titles and primary worksites.`,
  };
}

function employerContent(profile) {
  const wages = profile.wages;
  const disclosure = profile.sources[0]?.url || 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
  const dates = `${formatDate(profile.firstFiled)} through ${formatDate(profile.lastFiled)}`;
  let body = `<p>${count(profile.filings)} certified H-1B LCA filings in ${xml(String(profile.scope?.label ?? 'the published DOL release').replaceAll('_', ' '))}. Received dates: ${xml(dates)}. Latest disclosed decision: ${xml(formatDate(profile.lastDecision))}.</p>`;
  body += profileTable('Disclosed Annualized Base Wages', ['Measure', 'Amount'], [
    ['Median', currency(wages.median)], ['25th percentile', currency(wages.p25)], ['75th percentile', currency(wages.p75)],
    ['Lowest disclosed wage', currency(wages.min)], ['Highest disclosed wage', currency(wages.max)],
  ]);
  body += `<p>${count(profile.fullTimeCounts.fullTime)} full-time and ${count(profile.fullTimeCounts.partTime)} part-time filings${profile.fullTimeCounts.unknown ? `; ${count(profile.fullTimeCounts.unknown)} with an unspecified schedule` : ''}. Wages are annualized disclosed base rates, not total compensation or actual individual earnings.</p>`;
  const wageHeadings = ['Certified filings', 'Median annualized wage', '25th percentile', '75th percentile'];
  const wageCells = group => [count(group.filings), currency(group.wages.median), currency(group.wages.p25), currency(group.wages.p75)];
  body += profileTable('Most Disclosed Job Titles', ['Job title', ...wageHeadings], profile.topTitles.map(group => [group.title, ...wageCells(group)]));
  body += profileTable('Primary Worksite States', ['State', ...wageHeadings], profile.worksiteStates.map(group => [group.state, ...wageCells(group)]));
  body += profileTable('Most Disclosed Primary Worksites', ['City / state', ...wageHeadings], profile.topWorksites.map(group => [`${group.city}, ${group.state}`, ...wageCells(group)]));
  body += profileTable('Certified Filings by Received Month', ['Received month', 'Certified filings'], profile.filingMonths.map(group => [group.month, count(group.filings)]));
  body += `<h2>Source & Coverage</h2><p>${sourceLink(disclosure, 'Official DOL LCA disclosure')}. ${sourceLink('https://www.dol.gov/agencies/eta/foreign-labor/performance', 'DOL disclosure release register')}. Snapshot prepared ${xml(formatDate(String(profile.generatedAt ?? '').slice(0, 10)))}.</p><p>This is a cumulative quarterly release of certified H-1B LCAs, not a complete employer history. Non-certified filings and other visa classes are excluded, so an approval rate cannot be calculated. One case may concern multiple workers or worksites; these counts are cases, not hires, employees or visas issued. Only the primary disclosed worksite is shown. Small groups and different roles can distort wage comparisons.</p><p>Names follow the disclosed business names; separately named subsidiaries are not combined. LCA certification does not establish a USCIS approval, current job opening or green-card sponsorship. No employer reliability score or sponsorship guarantee is inferred.</p><p><a href="/employers/">All employer filing profiles</a> | <a href="${xml(employerSalaryPath(profile.id))}">Search individual H-1B wage records</a> | <a href="/methodology/">Sources and limitations</a></p>`;
  return body;
}

export function initialContent(route, { bulletinData, careerData, employerProfile, processingData } = {}) {
  const latest = bulletinData?.bulletins.find(bulletin => bulletin.month === bulletinData.latestMonth);
  const dos = latest?.sourceUrl || 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html';
  const uscis = 'https://www.uscis.gov/visabulletininfo';
  const dol = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
  let title;
  let body;
  if (route.path === '/visa-bulletin/') {
    title = 'Employment & Family Visa Bulletin';
    body = latest ? `${bulletinCharts(bulletinData, latest, 'employment')}${bulletinCharts(bulletinData, latest, 'family')}` : '<p>The latest verified bulletin tables are temporarily unavailable.</p>';
    body += `<p>Current (C) means no cutoff; Unavailable (U) means no visas authorized. A priority date must be strictly earlier than a dated cutoff. Employment tables cover EB-1, EB-2, EB-3, other workers, and EB-5 unreserved. Family tables cover F1, F2A, F2B, F3 and F4.</p><p>USCIS selects the employment and family I-485 charts separately each month. An unverified choice remains unknown. ${sourceLink(dos, 'Official State Department bulletin')}. ${sourceLink(uscis, 'Verify the applicable USCIS chart')} before filing. A cutoff does not predict approval.</p>`;
  } else if (route.path === '/family-green-card/') {
    title = 'Family-Based Green Card Tracker';
    body = latest ? bulletinCharts(bulletinData, latest, 'family') : '<p>The latest verified family bulletin tables are temporarily unavailable.</p>';
    if (bulletinData) {
      const categories = bulletinData.categories.filter(category => category.group === 'family');
      body += `<h2>Family Preference Categories</h2><dl>${categories.map(category => `<dt>${xml(category.label)}</dt><dd>${xml(category.description)}</dd>`).join('')}</dl>`;
    }
    body += `<p>Family preference visas have annual and per-country numerical limits. These are not the immediate-relative categories for spouses, unmarried children under 21, or parents of adult U.S. citizens. F1 here is a family preference, not an F-1 student visa.</p><p>A priority date must be strictly earlier than a dated cutoff. Official category and chargeability footnotes, including F2A per-country exemptions and allocation limits, also apply. Current (C) means no cutoff; Unavailable (U) means no visas authorized. Visa-number availability does not establish an approval or interview date.</p><p>USCIS family I-485 chart choice: ${xml(chartChoice(latest?.uscisFamilyChart))}. The employment chart choice does not determine the family chart choice. For consular processing, follow National Visa Center instructions; meeting a filing cutoff alone is not an invitation or appointment.</p><p>${sourceLink(dos, 'Official State Department bulletin')}. ${sourceLink(uscis, 'Verify the family chart USCIS permits for I-485')} before filing. <a href="/methodology/">Sources and limitations</a>.</p>`;
  } else if (route.path === '/salary-data/') {
    title = 'H-1B Salary Data';
    const scope = careerData?.scope;
    body = scope ? `<h2>${xml(scope.label.replaceAll('_', ' '))} Public Disclosures</h2><p>${Number(scope.records).toLocaleString('en-US')} certified H-1B cases across ${Number(scope.employers).toLocaleString('en-US')} employers. Decision dates: ${xml(formatDate(scope.decisionFrom))} through ${xml(formatDate(scope.decisionTo))}.</p>` : '<p>Employer wage disclosures are published by the Department of Labor.</p>';
    body += `<p>Records are certified H-1B LCAs with annualized wages from $5,000 through $1,000,000. Both full-time and part-time filings are included. Duplicate cases, other statuses and classes, and missing or unsupported wage units are excluded. This is a cumulative quarterly disclosure, not an entire historical database or a list of live job openings.</p><p>Disclosed wages are offers, not verified individual earnings. Certification does not establish visa issuance or green-card sponsorship. ${sourceLink(dol, 'Official DOL disclosure data')}.</p>`;
    body += '<p><a href="/employers/">Employer H-1B filing profiles</a></p>';
  } else if (route.path === '/employers/') {
    title = 'H-1B Employer Filing Profiles';
    const employers = careerData ? selectStaticEmployers(decodeCareerIndex(careerData)) : [];
    body = careerData?.scope ? `<p>${count(careerData.scope.employers)} disclosed employers and ${count(careerData.scope.records)} certified H-1B LCA cases in ${xml(careerData.scope.label.replaceAll('_', ' '))}.</p>` : '<p>Employer filing profiles are derived from official Department of Labor H-1B LCA disclosures.</p>';
    if (employers.length) {
      body += '<h2>Employers by Certified Filing Count</h2><div class="table-wrap"><table aria-label="Employer certified H-1B filings"><thead><tr><th scope="col">Disclosed employer</th><th scope="col">Certified filings</th><th scope="col">Median annualized wage</th></tr></thead><tbody>';
      body += employers.map(employer => `<tr><th scope="row"><a href="${xml(employerProfilePath(employer))}">${xml(employer.name)}</a></th><td>${count(employer.filings)}</td><td>${xml(currency(employer.median))}</td></tr>`).join('');
      body += '</tbody></table></div>';
    }
    body += `<p>These are certified LCA cases, not hires or individual employees. This cumulative quarterly release is not a complete employer history. Certification does not prove current hiring, USCIS visa approval or green-card sponsorship. Separately named businesses are not combined, and no approval rate or reliability score is inferred. ${sourceLink(dol, 'Official DOL disclosure data')}.</p>`;
  } else if (route.path.startsWith('/employers/') && employerProfile) {
    title = `${employerProfile.name} H-1B Filing Profile`;
    body = employerContent(employerProfile);
  } else if (route.path === '/methodology/') {
    title = 'Sources & Methodology';
    body = `<h2>Official cutoff rules</h2><p>For a dated cutoff, the priority date must be strictly earlier, not equal. Current and Unavailable remain distinct states. The ${sourceLink(dos, 'State Department Visa Bulletin')} provides separate employment and family Final Action and Dates for Filing tables. ${sourceLink(uscis, 'USCIS selects the permitted I-485 charts each month')} separately for employment and family cases; an unverified chart choice is marked unknown. Family preference categories do not include the immediate relatives of U.S. citizens. A cutoff does not predict an interview appointment or individual approval.</p><h2>Employment Historical Pace Scenarios</h2><p>Employment scenarios measure net cutoff movement in complete six-month windows, retaining stalls and retrogression. Windows containing Current, Unavailable, or missing months are excluded. The 25th, 50th, and 75th percentile historical rates illustrate slower, typical, and faster movement; they are not probability bounds.</p><p>Scenarios require at least twelve months of history, three positive windows, a dated latest cutoff, and positive overall net movement. Nonpositive rates have no finite date, and no date is displayed beyond ten years. Family tracking shows current cutoffs and historical movement without dated projections. No inaccessible USCIS inventory or queue is invented. Cutoff eligibility, permission to file, agency processing, and individual approval are different questions.</p><h2>Salary scope</h2><p>${sourceLink(dol, 'DOL OFLC disclosures')} cover certified H-1B cases in the configured cumulative quarter. Both full-time and part-time filings are included. Annualization uses 2,080 hours, 52 weeks, 26 biweekly periods, or 12 months. Annualized wages outside $5,000-$1,000,000, unsupported units, other classes/statuses, and duplicate case numbers are excluded. One case can cover multiple workers or worksites; the primary disclosed worksite is used.</p><h2>Verification</h2><p>Every snapshot carries its official source and verification date. Failed downloads or changed table formats preserve the last verified data. Future demand, supply, policy, and agency decisions can diverge completely from historical movement. This independent educational tool is not a government service or legal advisor.</p>`;
  } else if (route.path === '/processing-times/') {
    title = 'PERM & Prevailing Wage Processing Times';
    const c = processingData?.current;
    if (c) {
      const rows = [
        ...[['analystReview','PERM analyst review'],['auditReview','PERM audit review'],['reconsideration','PERM reconsideration']].map(([key,label]) => [label,c.perm.queues[key],c.perm.asOf]),
        ...['perm','h1b'].flatMap(program => ['oews','nonOews'].map(key => [`${program.toUpperCase()} prevailing wage / ${key === 'oews' ? 'OEWS' : 'non-OEWS'}`,c.pwd.queues[program][key],c.pwd.asOf])),
      ];
      body = `<h2>Published Processing Months</h2><div class="table-wrap"><table><thead><tr><th>Queue</th><th>Processing month</th><th>Source as of</th></tr></thead><tbody>${rows.map(([label,value,date]) => `<tr><th scope="row">${xml(label)}</th><td>${xml(formatProcessingMonth(value))}</td><td>${xml(formatDate(date))}</td></tr>`).join('')}</tbody></table></div><h2>Average PERM Review Duration</h2><p>Analyst review: ${c.perm.averages.analystReview.days === null ? 'Not published' : `${c.perm.averages.analystReview.days} days`} for ${xml(formatProcessingMonth(c.perm.averages.analystReview.month))} determinations. Audit review: ${c.perm.averages.auditReview.days === null ? 'Not published' : `${c.perm.averages.auditReview.days} days`}.</p>`;
      body += ['perm','h1b'].map(program => `<h2>${program.toUpperCase()} Prevailing-Wage Requests Remaining</h2><div class="table-wrap"><table><thead><tr><th>Received month</th><th>Requests remaining</th></tr></thead><tbody>${c.pwd.remainingRequests[program].map(r => `<tr><th scope="row">${xml(formatProcessingMonth(r.month))}</th><td>${r.count.toLocaleString('en-US')}</td></tr>`).join('')}</tbody></table></div>`).join('');
      body += `<p>Verified ${xml(formatDate(processingData.verifiedAt))}. History begins at the first verified snapshot.</p>`;
    } else body = '<p>Published processing tables are temporarily unavailable here.</p>';
    body += `<p>A processing month is a queue indicator, not a live case lookup or remaining-wait estimate. An average duration does not predict your decision date. PWD request counts are prevailing-wage requests, not pending PERM labor-certification cases. OEWS refers to Occupational Employment and Wage Statistics.</p><p>${sourceLink('https://flag.dol.gov/processingtimes','Official DOL processing times')}. Weekly checks validate the source before replacing data; failed checks preserve the last verified snapshot.</p>`;
  } else if (route.path === '/community/') {
    title = 'Community Search Trends';
    body = '<p>Optional aggregated priority-date checks, not unique visitors, government queue data or a representative applicant survey. Public charts cover 30 completed UTC days. They appear only after 100 contributions, hide groups below 20, and round counts down to tens.</p><p>Sharing begins unchecked. Only country of chargeability, visa preference category, and a five-year date range are submitted when a visitor explicitly contributes a check. Exact dates, names, receipt numbers, visitor identifiers, and free-text searches are not stored in the counters.</p><p>There are no fabricated launch charts. The interactive page loads current aggregate totals; today\'s contributions are excluded until the next UTC day. <a href="/privacy/">Privacy and aggregation details</a>.</p>';
  } else if (route.path === '/privacy/') {
    title = 'Privacy';
    body = '<h2>Local profiles</h2><p>Priority-date selections are processed in your browser. Saved profiles use local storage on this device; there is no account or application profile database. Shared profile links contain their fields, so recipients and hosting infrastructure may receive those details when a link is opened.</p><h2>Optional community totals</h2><p>Sharing starts unchecked and is disabled by Do Not Track or Global Privacy Control. Only an explicit contributed check submits a chargeability group, visa category and five-year date range to our Cloudflare counter. The counter does not store exact dates, names, receipt numbers, IP addresses, browser identifiers, individual submissions or combinations.</p><p>The choice lasts in this tab until unchecked or reloaded. Public charts cover 30 completed UTC days, require 100 contributions, hide groups below 20 and round counts down to tens. Separate daily rollups older than 90 days are pruned when a new day receives a contribution; inactive rollups may remain longer. This is not a unique-person count, representative survey or formal anonymity guarantee. Employer searches and PERM dates are not collected.</p><h2>Public data and hosting</h2><p>The browser downloads public bulletin and employer data. Hosting providers receive ordinary requests and may keep security and operational logs, including IP addresses. Official external links have their own policies.</p><h2>No third-party tracking</h2><p>This version includes no advertising scripts, third-party analytics, payment processing, or account cookies. CSV exports and printing happen locally in your browser.</p><p>Last updated: October 12, 2026.</p>';
  } else {
    title = 'Green Card Timer';
    body = '<p>Free employment-based and family preference priority-date checks and public salary disclosures. No account required.</p>';
    if (latest) {
      body += `<h2>${xml(latest.label)} India EB-2</h2><div class="table-wrap"><table><thead><tr><th scope="col">Final Action Date</th><th scope="col">Dates for Filing</th></tr></thead><tbody><tr><td>${xml(formatDate(latest.charts.finalAction.EB2.India))}</td><td>${xml(formatDate(latest.charts.filing.EB2.India))}</td></tr></tbody></table></div><p>A priority date must be strictly earlier than the cutoff. Final action availability does not establish individual approval. ${sourceLink(uscis, 'Check USCIS chart selection')} before filing I-485.</p><p>${sourceLink(dos, `${latest.label} official bulletin`)}.</p>`;
    }
    body += '<p><a href="/visa-bulletin/">Employment and family visa bulletin tables</a> | <a href="/family-green-card/">Family-based green card tracker</a> | <a href="/salary-data/">H-1B salary disclosures</a> | <a href="/employers/">Employer filing profiles</a> | <a href="/methodology/">Sources and limitations</a></p>';
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
  let processingData;
  try { processingData = JSON.parse(await readFile(resolve(dist,'data/processing.json'),'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const route of ROUTES) {
    const directory = resolve(dist, `.${route.path}`);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'index.html'), routeHTML(html, route, origin, { bulletinData, careerData, processingData }));
  }
  const employerRoutes = [];
  if (careerData) {
    const index = decodeCareerIndex(careerData);
    const byShard = new Map();
    for (const employer of selectStaticEmployers(index)) {
      const prefix = employer.id.slice(0, index.shardPrefixLength ?? 2);
      if (!byShard.has(prefix)) byShard.set(prefix, []);
      byShard.get(prefix).push(employer);
    }
    // Read each selected shard once, and retain only the small profile summaries.
    for (const [prefix, employers] of byShard) {
      const shard = JSON.parse(await readFile(resolve(dist, `data/career/${prefix}.json`), 'utf8'));
      for (const employer of employers) {
        const published = shard.employers?.[employer.id];
        if (!published || published.name !== employer.name || published.rows.length !== employer.filings) {
          throw new Error(`Employer shard does not match its published index: ${employer.id}`);
        }
        const rows = published.rows.map(values => ({ ...Object.fromEntries(shard.columns.map((column, i) => [column, values[i]])), employer: employer.name }));
        const employerProfile = buildEmployerProfile({ employer, rows, scope: index.scope, sources: index.sources, generatedAt: index.generatedAt });
        if (employerProfile.filings !== employer.filings) throw new Error(`Employer profile is missing certified records: ${employer.id}`);
        const route = employerRoute(employerProfile);
        const directory = resolve(dist, `.${route.path}`);
        await mkdir(directory, { recursive: true });
        await writeFile(resolve(directory, 'index.html'), routeHTML(html, route, origin, { employerProfile }));
        employerRoutes.push(route);
      }
    }
  }
  await writeFile(resolve(dist, 'favicon.svg'), favicon);
  const headers = await readFile(resolve(root, 'public/_headers'), 'utf8');
  const assets = await readdir(resolve(dist, 'assets'));
  await writeFile(resolve(dist, '_headers'), `${headers.trim()}\n\n${assetCacheRules(assets)}`);
  if (origin) {
    await writeFile(resolve(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    const entries = [...ROUTES, ...employerRoutes].map(route => `  <url><loc>${xml(new URL(route.path, origin).href)}</loc></url>`).join('\n');
    await writeFile(resolve(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`);
  } else {
    await rm(resolve(dist, 'robots.txt'), { force: true });
    await rm(resolve(dist, 'sitemap.xml'), { force: true });
  }
  return { routes: ROUTES.length + employerRoutes.length, sitemap: Boolean(origin) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await postbuild({ faviconOnly: process.argv.includes('--favicon-only') }))); }
  catch (error) { console.error(`Postbuild failed: ${error.message}`); process.exitCode = 1; }
}
