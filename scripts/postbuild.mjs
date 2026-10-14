import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { Hourglass } from 'lucide';
import { formatDate, parseDate } from '../src/model.js';
import { formatProcessingMonth } from '../src/processing.js';
import { buildEmployerProfile, decodeCareerIndex, employerProfilePath, employerSalaryPath, selectStaticEmployers } from '../src/career.js';
import { ROUTES, employerRoute, routeMetadata, structuredData, serializeStructuredData } from '../src/seo.js';
import { searchContext } from '../src/search-context.js';

export { ROUTES, employerRoute };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function coverageScope(careerData) {
  const scope = careerData?.scope;
  return typeof scope?.label === 'string' && scope.label.trim()
    && Number.isSafeInteger(scope.records) && scope.records > 0
    && Number.isSafeInteger(scope.employers) && scope.employers > 0 && scope.employers <= scope.records
    ? scope : null;
}

export function governmentCoverage({ bulletinData, careerData } = {}) {
  const scope = coverageScope(careerData);
  if (!scope) return '';
  const verifiedMonths = new Set((Array.isArray(bulletinData?.bulletins) ? bulletinData.bulletins : [])
    .filter(bulletin => /^\d{4}-(?:0[1-9]|1[0-2])$/.test(bulletin?.month) && parseDate(bulletin.verifiedAt))
    .map(bulletin => bulletin.month));
  const metric = (label, value, url) => `<div><dt>${xml(label)}</dt><dd><a href="${url}">${count(value)}</a></dd></div>`;
  return `<section id="government-coverage" class="government-coverage" aria-label="Official public data coverage"><p class="coverage-release">Official public data / ${xml(scope.label.trim().replaceAll('_', ' '))}</p><dl class="coverage-metrics">${metric('Disclosed employers', scope.employers, '/employers/')}${metric('Certified H-1B LCA records', scope.records, '/salary-data/')}${verifiedMonths.size ? metric('Verified visa bulletins', verifiedMonths.size, '/visa-bulletin/') : ''}</dl><p class="coverage-note">DOL certified H-1B LCA records, not site visitor counts, unique workers or open jobs. ${sourceLink('https://www.dol.gov/agencies/eta/foreign-labor/performance', 'Official DOL disclosure data')}.</p></section>`;
}

export function featuredEmployers(careerData) {
  const scope = coverageScope(careerData);
  if (!scope) return '';
  let employers;
  try {
    const decoded = decodeCareerIndex(careerData);
    if (!Array.isArray(decoded.employers)) return '';
    employers = selectStaticEmployers({ employers: decoded.employers.filter(employer =>
      typeof employer?.name === 'string' && employer.name.trim() && Number.isSafeInteger(employer.filings) && employer.filings > 0) }, 5);
  } catch { return ''; }
  if (!employers.length) return '';
  return `<section id="employer-discovery" class="employer-discovery" aria-labelledby="employer-discovery-heading"><div class="section-heading"><div><h2 id="employer-discovery-heading">H-1B employer filing profiles</h2><p>${xml(scope.label.trim().replaceAll('_', ' '))} / highest certified filing counts</p></div></div><ul class="employer-discovery-links">${employers.map(employer => `<li><a href="${xml(employerProfilePath(employer))}"><span>${xml(employer.name)}</span><small>${count(employer.filings)} certified filings</small></a></li>`).join('')}</ul><p class="chart-caption">Public DOL filing records, not current job openings or green-card sponsorship guarantees. <a href="/employers/">All H-1B employer filing profiles</a>.</p></section>`;
}

function profileTable(label, headings, rows) {
  return `<h2>${xml(label)}</h2><div class="table-wrap"><table aria-label="${xml(label)}"><thead><tr>${headings.map(heading => `<th scope="col">${xml(heading)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((value, i) => i === 0 ? `<th scope="row">${xml(value)}</th>` : `<td>${xml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
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

export function initialContent(route, { bulletinData, careerData, employerProfile, processingData, publishedMarkup } = {}) {
  const latest = bulletinData?.bulletins.find(bulletin => bulletin.month === bulletinData.latestMonth);
  const dos = latest?.sourceUrl || 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html';
  const uscis = 'https://www.uscis.gov/visabulletininfo';
  const dol = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
  let title;
  let body;
  if (route.path === '/visa-bulletin/') {
    title = latest ? `${latest.label} Visa Bulletin` : 'Employment & Family Visa Bulletin';
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
    body = `<h2>Official cutoff rules</h2><p>For a dated cutoff, the priority date must be strictly earlier, not equal. Current and Unavailable remain distinct states. The ${sourceLink(dos, 'State Department Visa Bulletin')} provides separate employment and family Final Action and Dates for Filing tables. ${sourceLink(uscis, 'USCIS selects the permitted I-485 charts each month')} separately for employment and family cases; an unverified chart choice is marked unknown. Family preference categories do not include the immediate relatives of U.S. citizens. A cutoff does not predict an interview appointment or individual approval.</p><h2>Published Cutoff History</h2><p>Employment and family trackers compare the entered priority date with the actual published cutoff for the selected country, category, chart and month. Current (C) means no cutoff; Unavailable (U) means no visas authorized. A date gap measures the distance between two dates, not a remaining wait time.</p><p>History shows past cutoff movement, including stalls and retrogression. Complete six-month measurements describe historical net movement only; windows containing Current, Unavailable or missing months are excluded. We do not predict a green-card approval date or a remaining wait time. No queue position, inventory, spillover or future visa supply is inferred. Cutoff eligibility, permission to file, agency processing and individual approval are different questions.</p><h2>Salary scope</h2><p>${sourceLink(dol, 'DOL OFLC disclosures')} cover certified H-1B cases in the configured cumulative quarter. Both full-time and part-time filings are included. Annualization uses 2,080 hours, 52 weeks, 26 biweekly periods, or 12 months. Annualized wages outside $5,000-$1,000,000, unsupported units, other classes/statuses, and duplicate case numbers are excluded. One case can cover multiple workers or worksites; the primary disclosed worksite is used.</p><h2>Verification</h2><p>Every snapshot carries its official source and actual verification date. Failed downloads or changed table formats preserve the last verified data; a routine update check does not make unchanged data newly verified. Future demand, supply, policy and agency decisions can diverge completely from historical movement. This independent educational tool is not a government service or legal advisor.</p>`;
    body += '<h2>Community Search Trends</h2><p>Valid submitted employment and family priority-date checks automatically add a country group, visa preference category and priority-date range to daily search counters. Dates are grouped into five-year bands, plus before 2000 and 2030 or later. Repeat submissions count again. Browsing, typing, saved-profile loading and chart changes do not submit a search. Charts show separate marginal distributions, not combinations, unique people or a representative applicant survey. They cover the last 30 UTC calendar days, including today, and show exact counts from the first search. <a href="/privacy/">Data practices and retention details</a>.</p>';
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
    body = '<p>Submitted priority-date checks are counted automatically, including repeat submissions. Public charts cover the last 30 UTC calendar days, including today, and show exact counts from the first search. These are search counts, not unique visitors, government queue data or a representative applicant survey.</p><p>The browser sends country of chargeability, visa preference category, and a priority-date range. Dates are grouped into five-year bands, plus before 2000 and 2030 or later. Exact dates, names, receipt numbers, visitor identifiers, and free-text searches are not stored in the counters. Browsing, typing, loading or saving profiles, chart changes, employer searches and PERM dates are not part of this tracker.</p><p>There is no opt-in, per-tab limit, duplicate filtering or browser-signal exclusion. The interactive page loads current totals. Accepted submissions update the submitter\'s charts from the counter response; totals for other visitors can be cached for up to one minute. <a href="/#community-trends">Community trends on the home page</a>. <a href="/privacy/">Data practices</a>.</p>';
  } else if (route.path === '/privacy/') {
    title = 'Privacy';
    body = '<h2>Recorded searches</h2><p>Submitted employment and family priority-date checks are automatically recorded and displayed as public community totals. The browser sends country of chargeability, visa preference category and a priority-date range to our Cloudflare counter. Dates are grouped into five-year bands, plus before 2000 and 2030 or later. Repeat submissions count again.</p><p>There is no opt-in, per-tab limit, duplicate filtering or browser-signal exclusion. Public charts cover the last 30 UTC calendar days, including today, and show exact counts from the first search. Accepted submissions update the submitter\'s charts from the counter response; totals for other visitors can be cached for up to one minute.</p><p>The database stores separate daily counts for country, category and date range. It does not store exact dates, raw submissions, combinations, names, receipt numbers, visitor IDs, IP addresses or browser identifiers. Browsing, typing, loading or saving profiles, chart changes, employer searches and PERM dates are not recorded by this counter. Counts are search activity, not unique people or a representative applicant survey.</p><h2>Storage and availability</h2><p>Daily rollups older than 90 days are pruned when a new day receives a search; inactive rollups may remain longer. A 10,000-search daily cap bounds database work on the free tier. If a resource limit or outage prevents recording, the calculator still works.</p><h2>Local profiles</h2><p>Priority-date calculations run in your browser. Saved profiles use local storage on this device; there is no account or application profile database. Shared profile links contain their fields, so recipients and hosting infrastructure may receive those details when a link is opened.</p><h2>Public data and hosting</h2><p>The browser downloads public bulletin and employer data. Hosting providers receive ordinary requests and may keep security and operational logs, including IP addresses. These platform logs are separate from the search counters. Official external links have their own policies.</p><h2>No third-party tracking</h2><p>This version includes no advertising scripts, third-party analytics, payment processing, or account cookies. CSV exports and printing happen locally in your browser.</p><p>Last updated: October 11, 2026.</p>';
  } else {
    title = 'Green Card Priority Date Tracker';
    body = '<p>Free employment-based and family preference priority-date checks against published Visa Bulletin cutoffs, plus public salary disclosures. No account required. Past cutoff movement is not a prediction of remaining wait time or a green-card approval date.</p>';
    if (latest) {
      body += `<h2>${xml(latest.label)} India EB-2</h2><div class="table-wrap"><table><thead><tr><th scope="col">Final Action Date</th><th scope="col">Dates for Filing</th></tr></thead><tbody><tr><td>${xml(formatDate(latest.charts.finalAction.EB2.India))}</td><td>${xml(formatDate(latest.charts.filing.EB2.India))}</td></tr></tbody></table></div><p>A priority date must be strictly earlier than the cutoff. Final action availability does not establish individual approval. ${sourceLink(uscis, 'Check USCIS chart selection')} before filing I-485.</p><p>${sourceLink(dos, `${latest.label} official bulletin`)}.</p>`;
    }
    body += '<p><a href="/salary-data/">H-1B salary disclosures</a> | <a href="/employers/">Employer filing profiles</a> | <a href="/methodology/">Sources and limitations</a></p>';
    body += '<section id="community-trends" aria-labelledby="community-trends-heading"><h2 id="community-trends-heading">Community Search Trends</h2><p>Country groups, visa preferences and priority-date ranges from submitted checks. Live charts load when JavaScript is available; no live counts are embedded in this page.</p><p>Valid priority-date checks are counted automatically, including repeat submissions. Charts cover the last 30 UTC calendar days, including today, and show exact counts from the first search. These are search counts, not unique people or government queue data.</p><p><a href="/community/">Community trends</a> | <a href="/privacy/">Data practices</a></p></section>';
  }
  const home = route.path === '/';
  const coverage = home ? publishedMarkup?.coverage ?? governmentCoverage({ bulletinData, careerData }) : '';
  const discovery = home ? publishedMarkup?.employers ?? featuredEmployers(careerData) : '';
  return `<div class="page-heading"><div><h1>${xml(title)}</h1></div></div>${coverage}<article class="reading">${body}</article>${discovery}${searchContext(route.path)}`;
}

export function routeHTML(html, route, origin = null, data = {}) {
  const $ = load(html);
  route = routeMetadata(route.path, data);
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
  $('#page-schema').remove();
  const graph = structuredData(route, origin, data);
  if (graph) $('head').append(`<script id="page-schema" type="application/ld+json">${serializeStructuredData(graph)}</script>`);
  const publishedMarkup = data.publishedMarkup ?? { coverage: governmentCoverage(data), employers: featuredEmployers(data.careerData) };
  $('#main').attr('data-published-route', route.path).html(initialContent(route, { ...data, publishedMarkup }));
  $('#published-government-coverage, #published-employer-discovery').remove();
  $('body').append(`<template id="published-government-coverage">${publishedMarkup.coverage}</template><template id="published-employer-discovery">${publishedMarkup.employers}</template>`);
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
  const data = { bulletinData, careerData, processingData,
    publishedMarkup: { coverage: governmentCoverage({ bulletinData, careerData }), employers: featuredEmployers(careerData) },
  };
  for (const route of ROUTES) {
    const directory = resolve(dist, `.${route.path}`);
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'index.html'), routeHTML(html, route, origin, data));
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
        await writeFile(resolve(directory, 'index.html'), routeHTML(html, route, origin, { ...data, employerProfile }));
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
