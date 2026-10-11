import './style.css';
import { createIcons, Hourglass, Clock3, CalendarDays, BriefcaseBusiness, BookOpen, Unlock, ArrowUpRight, ArrowRight, ArrowLeft, Bookmark, Trash2, ShieldCheck, CircleCheck, CircleAlert, Share2, Printer, TrendingUp, Search, Download, ChevronLeft, ChevronRight, LockKeyhole, Info, Globe, RefreshCw } from 'lucide';
import { evaluateProfile, formatDate, parseDate, compareCutoffs } from './model.js';
import { loadCareerIndex, loadCareerRows, autocompleteEmployers, searchSponsors, searchCareer, benchmarkOffer, careerRowsToCsv } from './career.js';

const icons = { Hourglass, Clock3, CalendarDays, BriefcaseBusiness, BookOpen, Unlock, ArrowUpRight, ArrowRight, ArrowLeft, Bookmark, Trash2, ShieldCheck, CircleCheck, CircleAlert, Share2, Printer, TrendingUp, Search, Download, ChevronLeft, ChevronRight, LockKeyhole, Info, Globe, RefreshCw };
const main = document.querySelector('#main');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const button = (name, label, action, extra = '') => `<button type="button" class="icon-button" aria-label="${esc(label)}" data-action="${action}" ${extra}>${icon(name)}</button>`;
const number = value => Number(value).toLocaleString('en-US');
const money = value => value == null ? 'Not available' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const month = value => new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`));
const option = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
const sourceLink = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${icon('arrow-up-right')}</a>`;
const adSpace = name => `<aside class="future-ad-slot" data-ad-slot="${name}" aria-hidden="true"></aside>`;
const headings = {
  '/': ['Priority date timeline', 'Your priority date, the latest cutoff, and the movement behind it.'],
  '/visa-bulletin/': ['Visa bulletin', 'Employment-based cutoffs and month-to-month movement.'],
  '/salary-data/': ['H-1B salary data', 'Certified employer filings. Reported wages, without a paywall.'],
  '/methodology/': ['Sources & methodology', 'Public records. Visible assumptions. No promises about approval.'],
  '/privacy/': ['Privacy', 'No account, no payment, no tracking scripts.'],
};
let bulletins, model, careerIndex, careerDataset, careerQuery = '', careerFilters = { page: 1, sort: 'date-desc' };
let careerToken = 0, chartWindow = 12, bulletinMonth, bulletinCountry = 'India', toastTimer;
let offerSalary = '', offerCompared = false;
let profile = { country: 'India', category: 'EB2', priorityDate: '2015-01-01', chart: 'finalAction', filingPath: 'aos' };
const stored = () => { try { const value = JSON.parse(localStorage.getItem('gct.profiles') || '[]'); return Array.isArray(value) ? value.filter(p => bulletins.countries.some(c => c.id === p.country) && bulletins.categories.some(c => c.id === p.category) && parseDate(p.priorityDate) && ['filing', 'finalAction'].includes(p.chart) && ['aos', 'consular'].includes(p.filingPath)).slice(0, 8) : []; } catch { return []; } };
const profileKey = p => `${p.country}:${p.category}:${p.priorityDate}:${p.chart}:${p.filingPath}`;
const countryLabel = id => bulletins.countries.find(c => c.id === id)?.label || id;
const categoryLabel = id => bulletins.categories.find(c => c.id === id)?.label || id;
const path = () => location.pathname === '/index.html' ? '/' : location.pathname.replace(/\/*$/, '/');
function finishRender() {
  if (bulletins && bulletins.latestMonth < new Date().toISOString().slice(0, 7) && !document.querySelector('#freshness-notice')) {
    main.insertAdjacentHTML('afterbegin', `<div id="freshness-notice" class="inline-notice" role="status" style="margin:0 0 22px">${icon('info')}<span>The latest verified bulletin here is ${esc(month(bulletins.latestMonth))}. A newer month has not been verified. ${sourceLink(bulletins.sourceUrl, 'Check the official bulletin')}.</span></div>`);
  }
  createIcons({ icons });
  document.querySelectorAll('.nav a').forEach(a => { const active = a.getAttribute('href') === path(); a.classList.toggle('active', active); active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
}
function toast(text) { document.querySelector('.toast')?.remove(); clearTimeout(toastTimer); const element = document.createElement('div'); element.className = 'toast'; element.setAttribute('role', 'status'); element.textContent = text; document.body.append(element); toastTimer = setTimeout(() => element.remove(), 3500); }
function heading(route, edition = '') { const [title, description] = headings[route]; document.title = `${title} | Green Card Timer`; return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${edition ? `<div class="edition"><span class="edition-dot"></span>${esc(edition)}</div>` : ''}</div>`; }
function metric(label, value, detail = '', color = '') { return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value ${color}">${esc(value)}</div><div class="metric-sub">${esc(detail)}</div></div>`; }
function movement(previous, current) { const change = compareCutoffs(previous, current); if (change.type === 'unchanged') return '<span class="movement muted">No change</span>'; if (change.months !== null) return `<span class="movement ${change.months > 0 ? 'positive' : 'negative'}">${change.months > 0 ? '+' : ''}${change.months.toFixed(1)} months</span>`; return `<span class="movement muted">${esc({ current: 'Now Current', retrogressed: 'Retrogressed', unavailable: 'Unavailable', available: 'Reopened', unknown: 'Not comparable' }[change.type])}</span>`; }
function readProfile() {
  const form = document.querySelector('#profile-form');
  if (!form) return true;
  if (!form.reportValidity()) return false;
  profile = { ...profile, ...Object.fromEntries(new FormData(form)) };
  return true;
}
function profilePanel() {
  const isSaved = stored().some(p => profileKey(p) === profileKey(profile));
  return `<section class="profile-panel" aria-labelledby="profile-title"><div class="panel-top"><h2 id="profile-title">Your priority date</h2>${button('bookmark', isSaved ? 'Remove saved profile' : 'Save profile on this device', 'save', `aria-pressed="${isSaved}"`)}</div>
  <form id="profile-form" class="profile-form"><div class="field"><label for="country">Country of chargeability</label><select id="country" name="country">${bulletins.countries.map(c => option(c.id, c.label, profile.country)).join('')}</select></div><div class="field"><label for="category">Preference category</label><select id="category" name="category">${bulletins.categories.map(c => option(c.id, c.label, profile.category)).join('')}</select></div>
  <div class="field full"><label for="priority-date">Priority date</label><input type="date" id="priority-date" name="priorityDate" required min="1900-01-01" max="${new Date().toISOString().slice(0, 10)}" value="${esc(profile.priorityDate)}"><p class="field-hint">Country is usually based on birth, not citizenship.</p></div>
  <div class="field full"><span class="field-label" id="chart-label">Bulletin chart</span><div class="segment" role="group" aria-labelledby="chart-label">${[['finalAction', 'Final action'], ['filing', 'Dates for filing']].map(([id, label]) => `<button type="button" data-chart="${id}" aria-pressed="${profile.chart === id}" class="${profile.chart === id ? 'active' : ''}">${label}</button>`).join('')}</div></div>
  <div class="field full"><label for="filing-path">Processing path</label><select name="filingPath" id="filing-path">${option('aos', 'Adjustment of status (U.S.)', profile.filingPath)}${option('consular', 'Consular processing', profile.filingPath)}</select></div><button type="submit" class="primary">Check my timeline ${icon('arrow-right')}</button></form><div class="local-note">${icon('shield-check')}<span>Saved profiles stay in this browser.</span></div></section>
  ${stored().length ? `<section class="saved-profiles"><h3>Saved on this device</h3>${stored().map((p, i) => `<div class="saved-row"><button type="button" class="saved-load" data-load-profile="${i}">${esc(countryLabel(p.country))} ${esc(categoryLabel(p.category))}<br><span class="muted">${formatDate(p.priorityDate)}</span></button>${button('trash-2', 'Remove saved profile', 'remove-profile', `data-profile="${i}"`)}</div>`).join('')}</section>` : ''}
  <p class="source-note">${sourceLink(bulletins.sourceUrl, 'U.S. Department of State')}<br>Verified ${formatDate(bulletins.generatedAt)}<br><a href="/methodology/">Sources & limitations</a></p>`;
}
function historyChart(points) {
  const selected = points.slice(-chartWindow - 1);
  const dated = selected.filter(p => parseDate(p.cutoff));
  if (!dated.length) return '<div class="empty-estimate">This period has no dated cutoffs. Current and Unavailable are shown in the history table below.</div>';
  const dateNumber = value => new Date(`${value}T00:00:00Z`).getTime();
  const pd = dateNumber(profile.priorityDate), values = [...dated.map(p => dateNumber(p.cutoff)), pd];
  let min = Math.min(...values), max = Math.max(...values); const padding = Math.max((max - min) * .13, 90 * 86400000); min -= padding; max += padding;
  const svgWidth = Math.min(720, window.innerWidth <= 760 ? window.innerWidth - 40 : 720);
  const left = 58, right = svgWidth - 12;
  const x = i => left + i / Math.max(1, selected.length - 1) * (right - left);
  const y = v => 175 - (v - min) / (max - min) * 147;
  let line = '', connected = false;
  selected.forEach((p, i) => { if (!parseDate(p.cutoff)) { connected = false; return; } line += `${connected ? 'L' : 'M'}${x(i).toFixed(1)},${y(dateNumber(p.cutoff)).toFixed(1)} `; connected = true; });
  const ticks = [0, 1, 2, 3].map(i => { const value = min + (max - min) * i / 3; const yy = y(value); return `<line class="gridline" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}"/><text x="${left - 10}" y="${yy + 4}" text-anchor="end">${new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(value))}</text>`; }).join('');
  const tickIndices = [...new Set([0, Math.floor((selected.length - 1) / 3), Math.floor((selected.length - 1) * 2 / 3), selected.length - 1])];
  return `<div class="chart"><svg viewBox="0 0 ${svgWidth} 215" role="img" aria-label="${esc(categoryLabel(profile.category))} ${esc(countryLabel(profile.country))} cutoff history and your priority date"><title>Actual published cutoffs, ${esc(month(selected[0].month))} to ${esc(month(selected.at(-1).month))}</title>${ticks}<line class="priority-line" x1="${left}" x2="${right}" y1="${y(pd)}" y2="${y(pd)}"/><path class="line" d="${line}"/>${selected.map((p, i) => parseDate(p.cutoff) ? `<circle class="dot" cx="${x(i)}" cy="${y(dateNumber(p.cutoff))}" r="3.5"><title>${esc(month(p.month))}: ${formatDate(p.cutoff)}</title></circle>` : '').join('')}${tickIndices.map((i, index) => `<text x="${x(i)}" y="203" text-anchor="${index === tickIndices.length - 1 ? 'end' : 'middle'}">${esc(month(selected[i].month))}</text>`).join('')}</svg></div><div class="chart-legend"><span><span class="legend-key"></span>Published cutoff</span><span><span class="legend-key priority"></span>Your priority date</span></div>`;
}
function renderTimeline() {
  const result = evaluateProfile(profile, bulletins, model);
  const status = { waiting: ['clock-3', 'wait', 'Your priority date has not met the cutoff', 'The cutoff must move past your priority date.'], current: ['circle-check', '', 'Your priority date meets this cutoff', 'Visa availability alone does not mean your case will be approved.'], unavailable: ['circle-alert', 'unknown', 'This category is unavailable', 'No visas are authorized in this category for this bulletin.'], unknown: ['circle-alert', 'unknown', 'Cutoff not verified', 'Check the official source before making a decision.'] }[result.status];
  if (!status) { main.innerHTML = '<div class="error-box">Enter a valid priority date.</div>'; finishRender(); return; }
  const latest = result.bulletin;
  const typical = result.scenarios?.find(s => s.id === 'typical');
  main.innerHTML = `${heading('/', `${latest.label} bulletin`)}<div class="workspace"><aside>${profilePanel()}</aside><section class="results"><div class="result-overview"><div class="result-topline"><h2>${esc(countryLabel(profile.country))} / ${esc(categoryLabel(profile.category))}</h2><div class="action-icons">${button('share-2', 'Copy a link to this profile', 'share')}${button('printer', 'Print or save as PDF', 'print')}</div></div><div class="status-line"><span class="status-icon ${status[1]}">${icon(status[0])}</span><div><strong>${status[2]}</strong><span class="muted">${status[3]}</span></div></div><div class="metrics">${metric(profile.chart === 'finalAction' ? 'Final action cutoff' : 'Filing cutoff', formatDate(result.cutoff), latest.label, result.current ? 'green' : '')}${metric('Priority-date gap', result.monthsBehind == null ? '\u2014' : `${result.monthsBehind.toFixed(1)} months`, 'Date distance, not a waiting time', result.status === 'waiting' ? 'coral' : '')}${metric('Typical pace scenario', typical?.date ? month(typical.date) : result.current ? 'Cutoff met' : 'Not modeled', 'Illustrative, not an approval date', typical?.date ? 'green' : '')}</div>
  ${profile.filingPath === 'aos' && !result.chartChoiceKnown ? `<div class="inline-notice">${icon('info')}<span>USCIS chart selection is not verified here. ${sourceLink('https://www.uscis.gov/visabulletininfo', 'Check the monthly chart')} before filing I-485.</span></div>` : `<p class="chart-caption">${profile.filingPath === 'consular' ? 'Dates for Filing concern document submission when instructed by the National Visa Center. They do not authorize approval.' : 'Check all USCIS eligibility requirements before filing.'}</p>`}</div>
  <div class="section-heading"><div><h2>Cutoff movement</h2><p>${profile.chart === 'finalAction' ? 'Final action dates' : 'Dates for filing'} / actual published history</p></div><div class="segment" role="group" aria-label="History range">${[6, 12, 24].map(n => `<button data-window="${n}" aria-pressed="${chartWindow === n}" class="${chartWindow === n ? 'active' : ''}">${n}m</button>`).join('')}</div></div>${historyChart(result.trend.points)}<p class="chart-caption">${result.trend.advancedMonths} advancing months, ${result.trend.unchangedMonths} unchanged, ${result.trend.retrogressedMonths} retrogressions in the verified history. Gaps mark Current or Unavailable.</p>
  <section class="scenario-band"><div class="section-heading" style="margin-top:0"><h2>Illustrative cutoff scenarios</h2></div>${result.scenarios ? `<div class="scenario-grid">${result.scenarios.map(s => `<div class="scenario ${s.id === 'typical' ? 'base' : ''}"><div class="scenario-label">${icon('trending-up')}${esc(s.label.replace(' historical', ''))}</div><div class="scenario-date">${s.date ? month(s.date) : s.beyondHorizon ? 'Beyond 10 years' : 'No positive pace'}</div><p class="scenario-detail">${s.months && !s.beyondHorizon ? `${s.months} calendar months` : esc(s.reason)}</p></div>`).join('')}</div>` : `<div class="empty-estimate">${esc(result.forecastReason)}</div>`}<p class="chart-caption">${result.scenarios ? esc(result.forecastReason) : 'There is no reliable individual approval date in the public cutoff data.'}</p><a class="method-link" href="/methodology/">How these scenarios work ${icon('arrow-up-right')}</a></section>${adSpace('timeline-between-sections')}
  <details class="details"><summary>Recent published cutoffs</summary><div class="table-wrap history-table"><table><thead><tr><th>Bulletin</th><th>Cutoff</th><th>Movement</th></tr></thead><tbody>${result.trend.points.slice(-12).reverse().map(p => { const previous = result.trend.points.find((q, i, all) => all[i + 1]?.month === p.month); return `<tr><td>${sourceLink(p.sourceUrl, month(p.month))}</td><td class="table-date">${formatDate(p.cutoff)}</td><td>${previous ? movement(previous.cutoff, p.cutoff) : '\u2014'}</td></tr>`; }).join('')}</tbody></table></div></details></section></div>`;
  finishRender();
}
function renderBulletin() {
  bulletinMonth ||= bulletins.latestMonth;
  const selected = bulletins.bulletins.find(b => b.month === bulletinMonth);
  const previous = bulletins.bulletins[bulletins.bulletins.indexOf(selected) + 1];
  main.innerHTML = `${heading('/visa-bulletin/', `Verified ${formatDate(selected.verifiedAt || bulletins.generatedAt)}`)}<div class="filters"><div class="field"><label for="bulletin-month">Bulletin month</label><select id="bulletin-month">${bulletins.bulletins.map(b => option(b.month, b.label, bulletinMonth)).join('')}</select></div><div class="field"><label for="bulletin-country">Country of chargeability</label><select id="bulletin-country">${bulletins.countries.map(c => option(c.id, c.label, bulletinCountry)).join('')}</select></div></div><div class="table-wrap"><table><thead><tr><th>Category</th><th>Final action</th><th>Monthly movement</th><th>Dates for filing</th><th>Monthly movement</th></tr></thead><tbody>${bulletins.categories.map(c => `<tr><td><strong>${esc(c.label)}</strong></td>${['finalAction', 'filing'].map(chart => `<td class="table-date">${formatDate(selected.charts[chart][c.id][bulletinCountry])}</td><td>${previous ? movement(previous.charts[chart][c.id][bulletinCountry], selected.charts[chart][c.id][bulletinCountry]) : '\u2014'}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="data-scope">${sourceLink(selected.sourceUrl, `${selected.label} official bulletin`)}<br>Current: no cutoff. Unavailable: no visas authorized. A priority date must be earlier than the published date, not equal to it.</p><div class="inline-notice">${icon('info')}<span>The filing chart is not automatically the chart USCIS permits for I-485. ${sourceLink(selected.uscisSourceUrl || 'https://www.uscis.gov/visabulletininfo', 'Check USCIS chart selection')}.</span></div>${adSpace('bulletin-after-table')}<section class="reading"><h2>What the two dates mean</h2><p>Final Action Dates indicate visa availability for a case that is otherwise ready for final action. Dates for Filing concern an earlier stage of submitting documents or an application, subject to the applicable agency's instructions. Neither chart predicts an individual approval.</p><p>These tables cover EB-1, EB-2, EB-3, other workers and EB-5 unreserved. Other employment-based preferences and reserved EB-5 categories are not included.</p></section>`;
  finishRender();
}
async function renderCareer() {
  const token = ++careerToken;
  if (!careerIndex) {
    main.innerHTML = `${heading('/salary-data/')}<div class="initial-loading" role="status">Loading the employer index...</div>`; finishRender();
    try { careerIndex = await loadCareerIndex(); } catch { if (path() === '/salary-data/' && token === careerToken) { main.innerHTML = `${heading('/salary-data/')}<div class="error-box">Salary data is temporarily unavailable. The official source remains accessible.</div><p>${sourceLink('https://www.dol.gov/agencies/eta/foreign-labor/performance', 'DOL disclosure data')}</p>`; finishRender(); } return; }
  }
  if (path() !== '/salary-data/' || token !== careerToken) return;
  renderCareerReady();
}
function careerSummary(stats) {
  return `<div class="stat-row">${metric('Certified filings', number(stats.filings ?? stats.count), 'Not unique workers or open jobs')}${metric('Median reported wage', money(stats.median), 'Annualized base wage')}${metric('Mean reported wage', money(stats.mean), 'Excludes equity and bonuses')}${metric('Release', careerIndex.scope.label.replaceAll('_', ' '), 'DOL disclosure data')}</div>`;
}
function pager(result, mode) { return `<div class="pager"><span>${number(result.total)} results</span><div>${button('chevron-left', 'Previous page', `${mode}-previous`, result.page <= 1 ? 'disabled' : '')}<span>${result.page} / ${number(result.pages)}</span>${button('chevron-right', 'Next page', `${mode}-next`, result.page >= result.pages ? 'disabled' : '')}</div></div>`; }
function renderCareerReady() {
  const focused = document.activeElement?.id;
  const selection = focused === 'title-filter' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const result = careerDataset ? searchCareer('', careerFilters, careerDataset) : searchSponsors(careerQuery, { page: careerFilters.page, pageSize: 12 }, careerIndex);
  const states = careerDataset ? [...new Set(careerDataset.rows.map(r => r.state))].sort() : [];
  main.innerHTML = `${heading('/salary-data/', `${number(careerIndex.employers.length)} employers`)}<div class="filters"><div class="field employer-search"><label for="employer-search">Employer</label><div class="input-wrap">${icon('search')}<input id="employer-search" type="search" autocomplete="off" role="combobox" aria-controls="employer-options" aria-autocomplete="list" aria-expanded="false" placeholder="Search an employer" value="${esc(careerDataset?.employer.name || careerQuery)}"></div><div class="search-menu" id="employer-options" role="listbox" hidden></div></div>${careerDataset ? `<div class="field grow"><label for="title-filter">Job title</label><input id="title-filter" type="search" placeholder="All job titles" value="${esc(careerFilters.title || '')}"></div><div class="field"><label for="state-filter">Worksite state</label><select id="state-filter">${option('', 'All states', careerFilters.state || '')}${states.map(s => option(s, s, careerFilters.state)).join('')}</select></div>` : ''}</div><div id="career-content">
  ${careerDataset ? `${careerSummary(result.summary)}<div class="toolbar"><p>${esc(careerDataset.employer.name)}</p><div class="action-icons"><select id="salary-sort" aria-label="Sort salary records">${[['date-desc', 'Newest filed'], ['wage-desc', 'Highest wage'], ['wage-asc', 'Lowest wage'], ['title', 'Job title']].map(([v, l]) => option(v, l, careerFilters.sort)).join('')}</select>${button('download', 'Download filtered records as CSV', 'csv')}${button('arrow-left', 'Browse employers', 'clear-employer')}</div></div><div class="table-wrap"><table class="salary-table"><thead><tr><th>Job title</th><th>Worksite</th><th>Annual wage</th><th>Prevailing wage</th><th>Filed</th></tr></thead><tbody>${result.rows.map(r => `<tr><td class="title-col"><strong>${esc(r.title)}</strong><br><span class="muted">${esc(r.soc)} / ${esc(r.id)}</span></td><td class="city-col">${esc(r.city)}, ${esc(r.state)}</td><td>${money(r.wage)}</td><td>${money(r.prevailingWage)}</td><td class="table-date">${formatDate(r.date)}</td></tr>`).join('')}</tbody></table>${!result.rows.length ? '<div class="empty-search">No filings match these filters.</div>' : ''}</div>${pager(result, 'career')}<div class="salary-extra"><section><h2>Compare an annual base offer</h2><form id="offer-form"><div class="field"><label for="offer-salary">Annual base salary (USD)</label><input id="offer-salary" type="number" min="1" max="10000000" step="1" required placeholder="150000"></div><button type="submit" class="button-secondary">Compare ${icon('arrow-right')}</button></form><div id="offer-result" aria-live="polite"></div><p class="chart-caption">Compared with all ${number(result.total)} filings matching your current filters. Records are filings, not a representative survey of employees.</p></section><section><h2>Median wage by worksite state</h2>${stateBars(result.matchingRows)}</section></div>` : `<div class="data-scope">${number(careerIndex.scope.publishedRows || careerIndex.employers.reduce((sum, e) => sum + e.filings, 0))} certified H-1B wage records / ${esc(careerIndex.scope.label.replaceAll('_', ' '))}</div><div class="sponsor-list">${result.rows.map(e => `<article class="sponsor-item"><button data-employer="${e.id}">${esc(e.name)}</button><p>${number(e.filings)} certified filings<br>${money(e.median)} median annual wage</p><span>${e.states.length} worksite states</span></article>`).join('')}</div>${result.rows.length ? pager(result, 'career') : '<div class="empty-search">No employers match this search.</div>'}`}</div><p class="data-scope">${sourceLink(careerIndex.sources[0].url, 'Official DOL source')}<br>Certified H-1B filings only. Annualized wage rates are not total compensation or proof of hiring. Release coverage: ${esc(careerIndex.scope.label.replaceAll('_', ' '))}. ${sourceLink('/methodology/', 'Coverage & limitations')}</p>${adSpace('salary-after-results')}`;
  finishRender();
  if (careerDataset) {
    document.querySelector('#offer-salary').value = offerSalary;
    if (offerCompared && Number(offerSalary) > 0) renderOffer();
    if (focused === 'title-filter') { const field = document.querySelector('#title-filter'); field.focus({ preventScroll: true }); if (selection) field.setSelectionRange(...selection); }
  }
}
function stateBars(rows) {
  const states = [...new Set(rows.map(r => r.state))].map(state => { const values = rows.filter(r => r.state === state).map(r => r.wage).sort((a, b) => a - b); const middle = (values.length - 1) / 2; return { state, count: values.length, median: (values[Math.floor(middle)] + values[Math.ceil(middle)]) / 2 }; }).sort((a, b) => b.count - a.count).slice(0, 6);
  const max = Math.max(...states.map(s => s.median));
  return states.length ? states.map(s => `<div class="bar-row"><span>${esc(s.state)} / ${number(s.count)}</span><div class="bar-track"><div class="bar" style="width:${s.median / max * 100}%"></div></div><span class="bar-value">${money(s.median)}</span></div>`).join('') : '<p class="chart-caption">No matching records.</p>';
}
async function selectEmployer(id) {
  const token = ++careerToken;
  careerDataset = null;
  offerCompared = false;
  document.querySelector('#employer-options').hidden = true;
  document.querySelector('#employer-search').setAttribute('aria-expanded', 'false');
  document.querySelector('#employer-search').value = careerIndex.employers.find(e => e.id === id)?.name || '';
  document.querySelectorAll('#title-filter, #state-filter').forEach(field => { field.disabled = true; });
  document.querySelector('#career-content').innerHTML = '<div class="initial-loading" role="status">Loading employer filings...</div>';
  try { const data = await loadCareerRows(id); if (token !== careerToken || path() !== '/salary-data/') return; careerDataset = data; careerFilters = { page: 1, sort: 'date-desc' }; renderCareerReady(); }
  catch (error) { if (token === careerToken && path() === '/salary-data/') { careerDataset = null; renderCareerReady(); toast(error.message); } }
}
function renderSources() {
  main.innerHTML = `${heading('/methodology/')}<article class="reading"><h2>What the timeline actually measures</h2><p>The calculator compares your priority date with a published Department of State cutoff. Your date must be strictly earlier than a dated cutoff. Current means no cutoff applies; Unavailable means no visas are authorized in that category for the bulletin.</p><p>Country of chargeability is generally based on place of birth. Exceptions, cross-chargeability, petition eligibility and individual case issues are outside this calculator.</p><h2>Historical pace, not an approval prediction</h2><p>For a waiting date, we examine complete six-month windows in the verified history. Each window's net movement includes retrogression. We use the 25th, 50th and 75th percentiles of that movement to illustrate slower, typical and faster future cutoff paths.</p><p>Scenarios appear only with at least 12 months of history, three positive six-month windows, and positive overall net movement. Nonpositive pace produces no date. Projections beyond 10 years are not dated. The gap includes one extra day because equality with the cutoff is not enough.</p><p>These are mathematical illustrations, not probabilities or forecasts of visa supply. They do not model pending applicants, dependents, spillover, policy changes or USCIS processing. A cutoff can stop or move backward. A current date does not mean a green card has been approved.</p><h2>Filing and approval are different</h2><p>Final Action Dates concern visa availability. Dates for Filing concern an earlier submission stage. For adjustment of status, USCIS chooses which chart can be used each month. That selection has not been independently verified in this dataset, so the app does not tell you that you can file I-485.</p><h2>Source register</h2><div class="source-list"><div class="source-item"><h3>Visa bulletin</h3><div><p>${bulletins.bulletins.length} monthly snapshots, ${month(bulletins.bulletins.at(-1).month)} through ${month(bulletins.latestMonth)}. Verified ${formatDate(bulletins.generatedAt)}. Five employment preferences and five chargeability groups.</p>${sourceLink(bulletins.sourceUrl, 'Department of State archive')}</div></div><div class="source-item"><h3>Monthly filing chart</h3><div><p>Not verified here. Always check the official selection before filing.</p>${sourceLink('https://www.uscis.gov/visabulletininfo', 'USCIS filing chart selection')}</div></div><div class="source-item"><h3>Employer wage records</h3><div><p>FY2026 Q3 certified H-1B Labor Condition Applications from the DOL disclosure release. Wage intervals are annualized (hourly x 2,080; weekly x 52; biweekly x 26; monthly x 12). Only valid, positive wage records are included.</p>${sourceLink('https://www.dol.gov/agencies/eta/foreign-labor/performance', 'DOL disclosure data')}</div></div></div><h2>Salary data limitations</h2><p>These are employer filings, not pay stubs, job listings, or unique employees. Repeated filings can concern one worker. Reported base wage excludes bonuses, benefits and equity. A filing does not prove an employer is hiring today. Offer percentiles are comparisons with the selected filings, not a population estimate.</p><p>Median state wages can reflect different roles and seniority. Filter by title and worksite before comparing an offer. Small samples and inconsistent job titles can distort results. Withdrawn and non-certified records are excluded.</p><h2>Freshness and corrections</h2><p>Published data carries a source and verification date. Automated updates validate table structure and dates before replacing a snapshot. If an agency blocks a download or changes its format, the last verified data stays available; we do not silently fill gaps with guesses.</p><p>Green Card Timer is an independent educational tool, not a government service or legal advisor. Confirm consequential decisions with official agencies or a qualified professional.</p></article>${adSpace('sources-after-content')}`;
  finishRender();
}
function renderPrivacy() {
  main.innerHTML = `${heading('/privacy/')}<article class="reading"><div class="privacy-graphic">${icon('lock-keyhole')}<div><strong>Your calculator runs in your browser.</strong><p>No account or profile database.</p></div></div><h2>Profiles</h2><p>Your priority date and selections are processed on your device. Saving a profile uses this browser's local storage. It is not uploaded to an application database and does not sync across devices.</p><p>The share button creates a URL containing the profile fields. Share it only with people you want to see those details. The site removes those fields from the address bar after reading them; hosting providers can still receive a shared URL when it is opened.</p><button class="button-secondary" data-action="clear-storage">${icon('trash-2')}Clear saved profiles</button><h2>Public data and hosting</h2><p>The browser downloads public bulletin and employer data. Hosting infrastructure receives ordinary web requests and may keep security and operational logs, including IP addresses. External official-source links are separate websites with their own policies.</p><h2>Cookies and advertising</h2><p>There are no advertising scripts, third-party analytics scripts or account cookies in this version. Advertising may be added later; this policy and any required consent controls will be updated before it is enabled.</p><h2>Local downloads</h2><p>CSV exports and printing are generated in your browser. No document is uploaded to create a download.</p><p>Last updated: October 11, 2026.</p></article>`;
  finishRender();
}
function appendWageScope() {
  main.querySelector('.source-list')?.insertAdjacentHTML('afterend', '<p>Published wage records exclude other visa classes, non-certified filings, missing or unrecognized wage units, and annualized wages outside $5,000-$1,000,000. Full-time and part-time filings are included. Each record uses the primary disclosed worksite.</p>');
}
function renderOffer() {
  const result = benchmarkOffer(offerSalary, searchCareer('', careerFilters, careerDataset).matchingRows);
  document.querySelector('#offer-result').innerHTML = result.count ? `<div class="benchmark-result"><strong>${result.percentile}%</strong><span>of filed wages below this offer<br>(ties count half)</span></div><p class="chart-caption">${result.smallSample ? 'Small sample: fewer than 10 filings. ' : ''}Median ${money(result.median)} / ${number(result.count)} comparable filings.</p>` : '<p class="chart-caption">No matching wages to compare.</p>';
}
function renderRoute() {
  careerToken += 1;
  const route = path();
  if (route === '/') renderTimeline(); else if (route === '/visa-bulletin/') renderBulletin(); else if (route === '/salary-data/') renderCareer(); else if (route === '/methodology/') { renderSources(); appendWageScope(); } else if (route === '/privacy/') renderPrivacy(); else { main.innerHTML = '<div class="page-heading"><div><h1>Page not found</h1><p><a href="/">Return to the priority date calculator</a></p></div></div>'; finishRender(); }
}
document.addEventListener('click', async event => {
  const a = event.target.closest('a');
  if (a && a.origin === location.origin && !a.hash && !a.target && !a.hasAttribute('download') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); history.pushState({}, '', a.pathname); renderRoute(); window.scrollTo(0, 0); return; }
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.chart && readProfile()) { profile.chart = target.dataset.chart; renderTimeline(); }
  if (target.dataset.window && readProfile()) { chartWindow = Number(target.dataset.window); renderTimeline(); }
  if (target.dataset.loadProfile) { profile = { ...stored()[Number(target.dataset.loadProfile)] }; renderTimeline(); }
  if (target.dataset.employer) { selectEmployer(target.dataset.employer); return; }
  const action = target.dataset.action;
  if (action === 'save' && readProfile()) { const list = stored(), index = list.findIndex(p => profileKey(p) === profileKey(profile)); index === -1 ? list.unshift({ ...profile }) : list.splice(index, 1); try { localStorage.setItem('gct.profiles', JSON.stringify(list.slice(0, 8))); renderTimeline(); toast(index === -1 ? 'Saved on this device' : 'Profile removed'); } catch { toast('This browser does not allow profile storage.'); } }
  if (action === 'remove-profile') { const list = stored(); list.splice(Number(target.dataset.profile), 1); try { localStorage.setItem('gct.profiles', JSON.stringify(list)); renderTimeline(); } catch { toast('Storage is unavailable.'); } }
  if (action === 'share' && readProfile()) { const url = new URL('/', location.origin); Object.entries(profile).forEach(([k, v]) => url.searchParams.set(k, v)); try { await navigator.clipboard.writeText(url.href); toast('Profile link copied'); } catch { toast('Clipboard unavailable. Use Print to export this profile.'); } }
  if (action === 'print') window.print();
  if (action === 'clear-storage') { try { localStorage.removeItem('gct.profiles'); toast('Saved profiles cleared'); } catch { toast('Storage is unavailable.'); } }
  if (action === 'clear-employer') { ++careerToken; careerDataset = null; careerQuery = ''; careerFilters.page = 1; renderCareerReady(); }
  if (action === 'career-next' || action === 'career-previous') { careerFilters.page += action.endsWith('next') ? 1 : -1; renderCareerReady(); document.querySelector('#career-content').scrollIntoView({ block: 'start', behavior: 'auto' }); }
  if (action === 'csv') { const result = searchCareer('', careerFilters, careerDataset); const url = URL.createObjectURL(new Blob([careerRowsToCsv(result.matchingRows)], { type: 'text/csv;charset=utf-8;' })); const link = document.createElement('a'); link.href = url; link.download = `h1b-wages-${careerIndex.scope.label}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'profile-form') { event.preventDefault(); if (readProfile()) renderTimeline(); }
  if (event.target.id === 'offer-form') { event.preventDefault(); offerSalary = document.querySelector('#offer-salary').value; offerCompared = true; renderOffer(); }
});
document.addEventListener('change', event => {
  const { id, value } = event.target;
  if (id === 'bulletin-month') { bulletinMonth = value; renderBulletin(); }
  if (id === 'bulletin-country') { bulletinCountry = value; renderBulletin(); }
  if (careerDataset && (id === 'state-filter' || id === 'salary-sort')) { careerFilters[id === 'state-filter' ? 'state' : 'sort'] = value; careerFilters.page = 1; renderCareerReady(); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'offer-salary') { offerSalary = event.target.value; offerCompared = false; document.querySelector('#offer-result').innerHTML = ''; return; }
  if (event.target.id === 'title-filter' && careerDataset) { careerFilters.title = event.target.value; careerFilters.page = 1; renderCareerReady(); return; }
  if (event.target.id !== 'employer-search' || !careerIndex) return;
  const query = event.target.value, menu = document.querySelector('#employer-options');
  const matches = autocompleteEmployers(query, careerIndex, 8);
  menu.hidden = !query.trim(); event.target.setAttribute('aria-expanded', String(!menu.hidden));
  menu.innerHTML = matches.length ? matches.map(e => `<button role="option" aria-selected="false" data-employer="${e.id}"><span>${esc(e.name)}</span><small>${number(e.filings)} filings</small></button>`).join('') : '<p>No employer found in this release.</p>';
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { const menu = document.querySelector('#employer-options'); if (menu) { menu.hidden = true; document.querySelector('#employer-search').setAttribute('aria-expanded', 'false'); document.querySelector('#employer-search').focus(); } }
  if (event.target.id === 'employer-search' && event.key === 'ArrowDown') { event.preventDefault(); document.querySelector('#employer-options button')?.focus(); }
  if (event.target.closest('#employer-options') && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); (event.key === 'ArrowDown' ? event.target.nextElementSibling : event.target.previousElementSibling)?.focus(); }
  if (event.target.id === 'employer-search' && event.key === 'Enter') { event.preventDefault(); const match = autocompleteEmployers(event.target.value, careerIndex, 1)[0]; if (match) selectEmployer(match.id); }
});
document.addEventListener('click', event => { const menu = document.querySelector('#employer-options'); if (menu && !event.target.closest('.employer-search')) { menu.hidden = true; document.querySelector('#employer-search')?.setAttribute('aria-expanded', 'false'); } });
window.addEventListener('popstate', renderRoute);
let chartResizeFrame, previousWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === previousWidth) return;
  previousWidth = window.innerWidth;
  cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => {
    const previousChart = document.querySelector('.chart');
    if (path() !== '/' || !previousChart || !bulletins) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = historyChart(evaluateProfile(profile, bulletins, model).trend.points);
    previousChart.replaceWith(wrapper.firstElementChild);
  });
});
async function boot() {
  finishRender();
  try {
    [bulletins, model] = await Promise.all(['/data/bulletins.json', '/data/model.json'].map(async url => { const response = await fetch(url); if (!response.ok) throw new Error('Published data is unavailable.'); return response.json(); }));
    const params = new URLSearchParams(location.search);
    if (params.size) { const candidate = { ...profile, ...Object.fromEntries([...params].filter(([key]) => Object.keys(profile).includes(key))) }; if (bulletins.countries.some(c => c.id === candidate.country) && bulletins.categories.some(c => c.id === candidate.category) && parseDate(candidate.priorityDate) && ['filing', 'finalAction'].includes(candidate.chart) && ['aos', 'consular'].includes(candidate.filingPath)) profile = candidate; history.replaceState({}, '', location.pathname); }
    renderRoute();
  } catch { main.innerHTML = '<div class="error-box" role="alert">The verified data could not be loaded. Please try again later or consult the <a href="https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html" target="_blank" rel="noopener noreferrer">official Visa Bulletin</a>.</div>'; }
}
boot();
