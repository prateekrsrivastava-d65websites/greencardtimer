import './style.css';
import { createIcons, Hourglass, Clock3, CalendarDays, BriefcaseBusiness, BookOpen, Unlock, ArrowUpRight, ArrowRight, ArrowLeft, Bookmark, Trash2, ShieldCheck, CircleCheck, CircleAlert, Share2, Printer, TrendingUp, Search, Download, ChevronLeft, ChevronRight, LockKeyhole, Info, Globe, RefreshCw, UsersRound } from 'lucide';
import { evaluateProfile, formatDate, parseDate, compareCutoffs, parseInputDate, formatInputDate, categoryGroup as getCategoryGroup } from './model.js';
import { loadCareerIndex, loadCareerRows, autocompleteEmployers, searchSponsors, searchCareer, benchmarkOffer, careerRowsToCsv, employerProfilePath, employerIdFromPath, employerSalaryPath, employerIdFromSearch, buildEmployerProfile } from './career.js';
import { compareProcessingMonth, formatProcessingMonth, processingFreshness } from './processing.js';
import { createCommunityRecorder } from './community-client.js';
import { validCommunitySummary } from './community.js';
import { communityDonut } from './community-chart.js';

const icons = { Hourglass, Clock3, CalendarDays, BriefcaseBusiness, BookOpen, Unlock, ArrowUpRight, ArrowRight, ArrowLeft, Bookmark, Trash2, ShieldCheck, CircleCheck, CircleAlert, Share2, Printer, TrendingUp, Search, Download, ChevronLeft, ChevronRight, LockKeyhole, Info, Globe, RefreshCw, UsersRound };
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
  '/family-green-card/': ['Family green card tracker', 'Family preference cutoffs, your priority date, and actual monthly movement.'],
  '/visa-bulletin/': ['Visa bulletin', 'Employment and family preference cutoffs and month-to-month movement.'],
  '/salary-data/': ['H-1B salary data', 'Certified employer filings. Reported wages, without a paywall.'],
  '/employers/': ['Employer sponsorship profiles', 'Public H-1B filing activity, roles, locations, and reported wages.'],
  '/processing-times/': ['PERM & prevailing wage tracker', 'Published Department of Labor processing months and request volumes.'],
  '/community/': ['Community searches', 'An aggregated view of submitted priority-date checks.'],
  '/methodology/': ['Sources & methodology', 'Public records. Visible assumptions. No promises about approval.'],
  '/privacy/': ['Privacy', 'No account, no payment. Clear data practices.'],
};
let bulletins, model, careerIndex, careerDataset, careerQuery = '', careerFilters = { page: 1, sort: 'date-desc' };
let careerToken = 0, chartWindow = 12, bulletinMonth, bulletinCountry = 'India', bulletinGroup = 'employment', toastTimer;
let offerSalary = '', offerCompared = false;
let processingData, processingDate = '', processingQueue = 'perm-analystReview';
let employerQuery = '', employerState = '', employerSort = 'filings', employerPage = 1;
let communityRequest, communityData, communityExpires = 0;
let historyChartObserver;
const recordCommunitySearch = createCommunityRecorder();
let profile = { country: 'India', category: 'EB2', priorityDate: '2015-01-01', chart: 'finalAction', filingPath: 'aos' };
const timelineProfiles = { employment: { ...profile }, family: { ...profile, category: 'F2A', priorityDate: '2024-01-01' } };
const stored = () => { try { const value = JSON.parse(localStorage.getItem('gct.profiles') || '[]'); return Array.isArray(value) ? value.filter(p => bulletins.countries.some(c => c.id === p.country) && bulletins.categories.some(c => c.id === p.category) && parseDate(p.priorityDate) && ['filing', 'finalAction'].includes(p.chart) && ['aos', 'consular'].includes(p.filingPath)).slice(0, 8) : []; } catch { return []; } };
const profileKey = p => `${p.country}:${p.category}:${p.priorityDate}:${p.chart}:${p.filingPath}`;
const countryLabel = id => bulletins.countries.find(c => c.id === id)?.label || id;
const categoryLabel = id => bulletins.categories.find(c => c.id === id)?.label || id;
const categoryGroup = id => getCategoryGroup(id, bulletins);
const profileRoute = p => categoryGroup(p.category) === 'family' ? '/family-green-card/' : '/';
const timelineRoute = () => path() === '/family-green-card/' ? '/family-green-card/' : '/';
const timelinePath = () => ['/', '/family-green-card/'].includes(path());
const routeCategories = () => bulletins.categories.filter(c => categoryGroup(c.id) === (timelineRoute() === '/family-green-card/' ? 'family' : 'employment'));
const path = () => location.pathname === '/index.html' ? '/' : location.pathname.replace(/\/*$/, '/');
function finishRender() {
  if (bulletins && bulletins.latestMonth < new Date().toISOString().slice(0, 7) && !document.querySelector('#freshness-notice')) {
    main.insertAdjacentHTML('afterbegin', `<div id="freshness-notice" class="inline-notice" role="status" style="margin:0 0 22px">${icon('info')}<span>The latest verified bulletin here is ${esc(month(bulletins.latestMonth))}. A newer month has not been verified. ${sourceLink(bulletins.sourceUrl, 'Check the official bulletin')}.</span></div>`);
  }
  createIcons({ icons });
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.href = new URL(path(), location.origin).href;
  document.querySelector('meta[property="og:url"]')?.setAttribute('content', new URL(path(),location.origin).href);
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
  document.querySelectorAll('.nav a').forEach(a => { const active = a.getAttribute('href') === path() || a.getAttribute('href') === '/employers/' && path().startsWith('/employers/'); a.classList.toggle('active', active); active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
}
function toast(text) { document.querySelector('.toast')?.remove(); clearTimeout(toastTimer); const element = document.createElement('div'); element.className = 'toast'; element.setAttribute('role', 'status'); element.textContent = text; document.body.append(element); toastTimer = setTimeout(() => element.remove(), 3500); }
function heading(route, edition = '') { const [title, description] = headings[route]; document.title = `${title} | Green Card Timer`; return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div>${edition ? `<div class="edition"><span class="edition-dot"></span>${esc(edition)}</div>` : ''}</div>`; }
function metric(label, value, detail = '', color = '') { return `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value ${color}">${esc(value)}</div><div class="metric-sub">${esc(detail)}</div></div>`; }
function movement(previous, current) { const change = compareCutoffs(previous, current); if (change.type === 'unchanged') return '<span class="movement muted">No change</span>'; if (change.months !== null) return `<span class="movement ${change.months > 0 ? 'positive' : 'negative'}">${change.months > 0 ? '+' : ''}${change.months.toFixed(1)} months</span>`; return `<span class="movement muted">${esc({ current: 'Now Current', retrogressed: 'Retrogressed', unavailable: 'Unavailable', available: 'Reopened', unknown: 'Not comparable' }[change.type])}</span>`; }
function readProfile() {
  const form = document.querySelector('#profile-form');
  if (!form) return true;
  const field = form.querySelector('#priority-date');
  const priorityDate = parseInputDate(field.value.trim());
  const error = form.querySelector('#priority-date-error');
  const message = priorityDate ? '' : 'Enter a valid calendar date in MM-DD-YYYY format.';
  field.setCustomValidity(message);
  field.setAttribute('aria-invalid', String(!priorityDate));
  error.hidden = Boolean(priorityDate);
  error.textContent = message;
  if (!form.reportValidity()) return false;
  const values = Object.fromEntries(new FormData(form));
  profile = { ...profile, country: values.country, category: values.category, filingPath: values.filingPath, priorityDate };
  timelineProfiles[categoryGroup(profile.category)] = { ...profile };
  return true;
}
function profilePanel() {
  const isSaved = stored().some(p => profileKey(p) === profileKey(profile));
  return `<section class="profile-panel" aria-labelledby="profile-title"><div class="panel-top"><h2 id="profile-title">Your priority date</h2>${button('bookmark', isSaved ? 'Remove saved profile' : 'Save profile on this device', 'save', `aria-pressed="${isSaved}"`)}</div>
  <form id="profile-form" class="profile-form" novalidate><div class="field"><label for="country">Country of chargeability</label><select id="country" name="country">${bulletins.countries.map(c => option(c.id, c.label, profile.country)).join('')}</select></div><div class="field"><label for="category">Preference category</label><select id="category" name="category">${routeCategories().map(c => option(c.id, c.label, profile.category)).join('')}</select></div>
  <div class="field full"><label for="priority-date" class="date-label">Priority date <span class="date-format">MM-DD-YYYY</span></label><input type="text" id="priority-date" name="priorityDate" required placeholder="MM-DD-YYYY" inputmode="text" autocomplete="off" spellcheck="false" aria-describedby="priority-date-error priority-date-hint" value="${esc(formatInputDate(profile.priorityDate) || '')}"><p id="priority-date-error" class="field-error" role="alert" hidden></p><p id="priority-date-hint" class="field-hint">Country is usually based on birth, not citizenship.</p></div>
  <div class="field full"><span class="field-label" id="chart-label">Bulletin chart</span><div class="segment" role="group" aria-labelledby="chart-label">${[['finalAction', 'Final action'], ['filing', 'Dates for filing']].map(([id, label]) => `<button type="button" data-chart="${id}" aria-pressed="${profile.chart === id}" class="${profile.chart === id ? 'active' : ''}">${label}</button>`).join('')}</div></div>
  <div class="field full"><label for="filing-path">Processing path</label><select name="filingPath" id="filing-path">${option('aos', 'Adjustment of status (U.S.)', profile.filingPath)}${option('consular', 'Consular processing', profile.filingPath)}</select></div><p class="community-notice">Submitted checks are recorded and displayed as public search totals. <a href="/privacy/">Data practices</a>.</p><button type="submit" class="primary">${timelineRoute() === '/family-green-card/' ? 'Check my priority date' : 'Check my timeline'} ${icon('arrow-right')}</button></form><div class="local-note">${icon('shield-check')}<span>Saved profiles stay in this browser.</span></div></section>
  ${stored().length ? `<section class="saved-profiles"><h3>Saved on this device</h3>${stored().map((p, i) => `<div class="saved-row"><button type="button" class="saved-load" data-load-profile="${i}">${esc(countryLabel(p.country))} ${esc(categoryLabel(p.category))}<br><span class="muted">${formatDate(p.priorityDate)}</span></button>${button('trash-2', 'Remove saved profile', 'remove-profile', `data-profile="${i}"`)}</div>`).join('')}</section>` : ''}
  <p class="source-note">${sourceLink(bulletins.sourceUrl, 'U.S. Department of State')}<br>Verified ${formatDate(bulletins.generatedAt)}<br><a href="/methodology/">Sources & limitations</a></p>`;
}
function historyChart(points, width = 720) {
  const selected = points.slice(-chartWindow - 1);
  const dated = selected.filter(p => parseDate(p.cutoff));
  if (!dated.length) return '<div class="empty-estimate">This period has no dated cutoffs. Current and Unavailable are shown in the history table below.</div>';
  const dateNumber = value => new Date(`${value}T00:00:00Z`).getTime();
  const pd = dateNumber(profile.priorityDate), values = [...dated.map(p => dateNumber(p.cutoff)), pd];
  let min = Math.min(...values), max = Math.max(...values); const padding = Math.max((max - min) * .13, 90 * 86400000); min -= padding; max += padding;
  const svgWidth = Math.max(240, Math.min(720, Number(width) || 720));
  const left = 58, right = svgWidth - 12;
  const x = i => left + i / Math.max(1, selected.length - 1) * (right - left);
  const y = v => 175 - (v - min) / (max - min) * 147;
  let line = '', connected = false;
  selected.forEach((p, i) => { if (!parseDate(p.cutoff)) { connected = false; return; } line += `${connected ? 'L' : 'M'}${x(i).toFixed(1)},${y(dateNumber(p.cutoff)).toFixed(1)} `; connected = true; });
  const ticks = [0, 1, 2, 3].map(i => { const value = min + (max - min) * i / 3; const yy = y(value); return `<line class="gridline" x1="${left}" x2="${right}" y1="${yy}" y2="${yy}"/><text x="${left - 10}" y="${yy + 4}" text-anchor="end">${new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(value))}</text>`; }).join('');
  const tickCount = svgWidth < 340 ? 3 : 4;
  const tickIndices = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.floor((selected.length - 1) * i / (tickCount - 1))))];
  return `<div class="chart"><svg viewBox="0 0 ${svgWidth} 215" role="img" aria-label="${esc(categoryLabel(profile.category))} ${esc(countryLabel(profile.country))} cutoff history and your priority date"><title>Actual published cutoffs, ${esc(month(selected[0].month))} to ${esc(month(selected.at(-1).month))}</title>${ticks}<line class="priority-line" x1="${left}" x2="${right}" y1="${y(pd)}" y2="${y(pd)}"/><path class="line" d="${line}"/>${selected.map((p, i) => parseDate(p.cutoff) ? `<circle class="dot" cx="${x(i)}" cy="${y(dateNumber(p.cutoff))}" r="3.5"><title>${esc(month(p.month))}: ${formatDate(p.cutoff)}</title></circle>` : '').join('')}${tickIndices.map((i, index) => `<text x="${x(i)}" y="203" text-anchor="${index === tickIndices.length - 1 ? 'end' : 'middle'}">${esc(month(selected[i].month))}</text>`).join('')}</svg></div><div class="chart-legend"><span><span class="legend-key"></span>Published cutoff</span><span><span class="legend-key priority"></span>Your priority date</span></div>`;
}
function stopHistoryChartObserver() {
  historyChartObserver?.disconnect();
  historyChartObserver = null;
}
function observeHistoryChart(points) {
  const chart = main.querySelector('.chart');
  if (!chart) return;
  let previousWidth;
  const resize = width => {
    const nextWidth = Math.round(Math.max(240, Math.min(720, width)));
    if (nextWidth === previousWidth) return;
    previousWidth = nextWidth;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = historyChart(points, nextWidth);
    chart.replaceChildren(wrapper.querySelector('svg'));
  };
  resize(chart.getBoundingClientRect().width);
  historyChartObserver = new ResizeObserver(entries => resize(entries[0].contentRect.width));
  historyChartObserver.observe(chart);
}
function renderTimeline() {
  stopHistoryChartObserver();
  timelineProfiles[categoryGroup(profile.category)] = { ...profile };
  const family = timelineRoute() === '/family-green-card/';
  const result = evaluateProfile(profile, bulletins, model);
  const status = { waiting: ['clock-3', 'wait', 'Your priority date has not met the cutoff', 'The cutoff must move past your priority date.'], current: ['circle-check', '', 'Your priority date meets this cutoff', 'Visa availability alone does not mean your case will be approved.'], unavailable: ['circle-alert', 'unknown', 'This category is unavailable', 'No visas are authorized in this category for this bulletin.'], unknown: ['circle-alert', 'unknown', 'Cutoff not verified', 'Check the official source before making a decision.'] }[result.status];
  if (!status) { main.innerHTML = '<div class="error-box">Enter a valid priority date.</div>'; finishRender(); return; }
  const latest = result.bulletin;
  const typical = result.scenarios?.find(s => s.id === 'typical');
  const lastChange = result.trend.lastMovement;
  const movementValue = lastChange.type === 'unchanged' ? 'No change' : lastChange.months !== null ? `${lastChange.months > 0 ? '+' : ''}${lastChange.months.toFixed(1)} months` : { current: 'Now Current', retrogressed: 'Retrogressed', unavailable: 'Unavailable', available: 'Reopened', unknown: 'Not comparable' }[lastChange.type];
  const thirdMetric = family ? metric('Monthly movement', movementValue, 'Compared with the previous bulletin', lastChange.months > 0 ? 'green' : lastChange.type === 'retrogressed' ? 'coral' : '') : metric('Typical pace scenario', typical?.date ? month(typical.date) : result.current ? 'Cutoff met' : 'Not modeled', 'Illustrative, not an approval date', typical?.date ? 'green' : '');
  main.innerHTML = `${heading(timelineRoute(), `${latest.label} bulletin`)}<div class="workspace"><aside>${profilePanel()}</aside><section class="results"><div class="result-overview"><div class="result-topline"><h2>${esc(countryLabel(profile.country))} / ${esc(categoryLabel(profile.category))}</h2><div class="action-icons">${button('share-2', 'Copy a link to this profile', 'share')}${button('printer', 'Print or save as PDF', 'print')}</div></div>${family ? `<p class="category-description">${esc(bulletins.categories.find(c => c.id === profile.category)?.description || '')}</p>` : ''}<div class="status-line"><span class="status-icon ${status[1]}">${icon(status[0])}</span><div><strong>${status[2]}</strong><span class="muted">${status[3]}</span></div></div><div class="metrics">${metric(profile.chart === 'finalAction' ? 'Final action cutoff' : 'Filing cutoff', formatDate(result.cutoff), latest.label, result.current ? 'green' : '')}${metric('Priority-date gap', result.monthsBehind == null ? '\u2014' : `${result.monthsBehind.toFixed(1)} months`, 'Date distance, not a waiting time', result.status === 'waiting' ? 'coral' : '')}${thirdMetric}</div>
  ${profile.filingPath === 'aos' && !result.chartChoiceKnown ? `<div class="inline-notice">${icon('info')}<span>USCIS ${family ? 'family ' : ''}chart selection is not verified here. ${sourceLink('https://www.uscis.gov/visabulletininfo', 'Check the monthly chart')} before filing I-485.</span></div>` : `<p class="chart-caption">${profile.filingPath === 'consular' ? 'Dates for Filing concern document submission when instructed by the National Visa Center. They do not authorize approval.' : 'Check all USCIS eligibility requirements before filing.'}</p>`}${family && profile.category === 'F2A' ? `<p class="chart-caption">F2A per-country exemptions and allocation limits also apply. ${sourceLink(latest.sourceUrl, 'Check this bulletin\u0027s F2A notes')}.</p>` : ''}</div>
  <div class="section-heading"><div><h2>Cutoff movement</h2><p>${profile.chart === 'finalAction' ? 'Final action dates' : 'Dates for filing'} / actual published history</p></div><div class="segment" role="group" aria-label="History range">${[6, 12, 24].map(n => `<button data-window="${n}" aria-pressed="${chartWindow === n}" class="${chartWindow === n ? 'active' : ''}">${n}m</button>`).join('')}</div></div>${historyChart(result.trend.points)}<p class="chart-caption">${result.trend.advancedMonths} advancing months, ${result.trend.unchangedMonths} unchanged, ${result.trend.retrogressedMonths} retrogressions in the verified history. Gaps mark Current or Unavailable.</p>
  ${family ? `<section class="family-scope"><h2>Family preference categories</h2><dl>${routeCategories().map(c => `<div><dt>${esc(c.label)}</dt><dd>${esc(c.description || '')}</dd></div>`).join('')}</dl><p class="chart-caption">Immediate relatives of U.S. citizens are not covered by these preference cutoffs. Age-out rules, category changes and individual eligibility are not calculated here. Published cutoffs do not predict your approval date.</p></section>` : `<section class="scenario-band"><div class="section-heading" style="margin-top:0"><h2>Illustrative cutoff scenarios</h2></div>${result.scenarios ? `<div class="scenario-grid">${result.scenarios.map(s => `<div class="scenario ${s.id === 'typical' ? 'base' : ''}"><div class="scenario-label">${icon('trending-up')}${esc(s.label.replace(' historical', ''))}</div><div class="scenario-date">${s.date ? month(s.date) : s.beyondHorizon ? 'Beyond 10 years' : 'No positive pace'}</div><p class="scenario-detail">${s.months && !s.beyondHorizon ? `${s.months} calendar months` : esc(s.reason)}</p></div>`).join('')}</div>` : `<div class="empty-estimate">${esc(result.forecastReason)}</div>`}<p class="chart-caption">${result.scenarios ? esc(result.forecastReason) : 'There is no reliable individual approval date in the public cutoff data.'}</p><a class="method-link" href="/methodology/">How these scenarios work ${icon('arrow-up-right')}</a></section>`}${adSpace(family ? 'family-between-sections' : 'timeline-between-sections')}
  <details class="details"><summary>Recent published cutoffs</summary><div class="table-wrap history-table"><table><thead><tr><th>Bulletin</th><th>Cutoff</th><th>Movement</th></tr></thead><tbody>${result.trend.points.slice(-12).reverse().map(p => { const previous = result.trend.points.find((q, i, all) => all[i + 1]?.month === p.month); return `<tr><td>${sourceLink(p.sourceUrl, month(p.month))}</td><td class="table-date">${formatDate(p.cutoff)}</td><td>${previous ? movement(previous.cutoff, p.cutoff) : '\u2014'}</td></tr>`; }).join('')}</tbody></table></div></details></section></div>${family ? '' : homeCommunity()}`;
  finishRender();
  observeHistoryChart(result.trend.points);
  if (!family) void loadCommunitySection();
}
function renderBulletin() {
  bulletinMonth ||= bulletins.latestMonth;
  const selected = bulletins.bulletins.find(b => b.month === bulletinMonth);
  const previous = bulletins.bulletins[bulletins.bulletins.indexOf(selected) + 1];
  main.innerHTML = `${heading('/visa-bulletin/', `Verified ${formatDate(selected.verifiedAt || bulletins.generatedAt)}`)}<div class="filters"><div class="segment" role="group" aria-label="Preference group">${[['employment', 'Employment'], ['family', 'Family']].map(([id, label]) => `<button type="button" data-bulletin-group="${id}" aria-pressed="${bulletinGroup === id}" class="${bulletinGroup === id ? 'active' : ''}">${label}</button>`).join('')}</div><div class="field"><label for="bulletin-month">Bulletin month</label><select id="bulletin-month">${bulletins.bulletins.map(b => option(b.month, b.label, bulletinMonth)).join('')}</select></div><div class="field"><label for="bulletin-country">Country of chargeability</label><select id="bulletin-country">${bulletins.countries.map(c => option(c.id, c.label, bulletinCountry)).join('')}</select></div></div><div class="table-wrap"><table><thead><tr><th>Category</th><th>Final action</th><th>Monthly movement</th><th>Dates for filing</th><th>Monthly movement</th></tr></thead><tbody>${bulletins.categories.filter(c => (c.group || 'employment') === bulletinGroup).map(c => `<tr><td><strong>${esc(c.label)}</strong></td>${['finalAction', 'filing'].map(chart => `<td class="table-date">${formatDate(selected.charts[chart][c.id][bulletinCountry])}</td><td>${previous ? movement(previous.charts[chart][c.id][bulletinCountry], selected.charts[chart][c.id][bulletinCountry]) : '\u2014'}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="data-scope">${sourceLink(selected.sourceUrl, `${selected.label} official bulletin`)}<br>Current: no cutoff. Unavailable: no visas authorized. A priority date must be earlier than the published date, not equal to it.</p><div class="inline-notice">${icon('info')}<span>The filing chart is not automatically the chart USCIS permits for I-485. ${sourceLink(selected.uscisSourceUrl || 'https://www.uscis.gov/visabulletininfo', 'Check USCIS chart selection')}.</span></div>${adSpace('bulletin-after-table')}<section class="reading"><h2>What the two dates mean</h2><p>Final Action Dates indicate visa availability for a case that is otherwise ready for final action. Dates for Filing concern an earlier stage of submitting documents or an application, subject to the applicable agency's instructions. Neither chart predicts an individual approval.</p><p>These tables cover EB-1, EB-2, EB-3, other workers, EB-5 unreserved and family preferences F1, F2A, F2B, F3 and F4. Other employment preferences, reserved EB-5 categories and immediate relatives of U.S. citizens are not included.</p></section>`;
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
  const requested = employerIdFromSearch(location.search);
  if (requested && careerIndex.employers.some(e => e.id === requested) && careerDataset?.employer.id !== requested) await selectEmployer(requested);
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
  try { const data = await loadCareerRows(id); if (token !== careerToken || path() !== '/salary-data/') return; careerDataset = data; careerFilters = { page: 1, sort: 'date-desc' }; history.replaceState({}, '', employerSalaryPath(id)); renderCareerReady(); }
  catch (error) { if (token === careerToken && path() === '/salary-data/') { careerDataset = null; renderCareerReady(); toast(error.message); } }
}
function histogram(rows, labelKey = 'label', valueKey = 'count') {
  const max = Math.max(1, ...rows.map(row => row[valueKey]));
  return rows.length ? `<div class="histogram">${rows.map(row => `<div class="histogram-row"><span>${esc(row[labelKey])}</span><div class="bar-track"><div class="bar" style="width:${row[valueKey] / max * 100}%"></div></div><strong>${number(row[valueKey])}</strong></div>`).join('')}</div>` : '<p class="chart-caption">No publishable counts yet.</p>';
}
async function renderEmployerDirectory() {
  const token = ++careerToken;
  main.innerHTML = `${heading('/employers/')}<div class="initial-loading" role="status">Loading employers...</div>`; finishRender();
  try { careerIndex ??= await loadCareerIndex(); if (path() === '/employers/' && token === careerToken) renderEmployerDirectoryReady(); }
  catch { if (path() === '/employers/') { main.innerHTML = `${heading('/employers/')}<div class="error-box">Employer data is temporarily unavailable.</div>`; finishRender(); } }
}
function renderEmployerDirectoryReady() {
  const focused = document.activeElement?.id;
  const selection = focused === 'profile-employer-search' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const result = searchSponsors(employerQuery, { state: employerState, sort: employerSort, page: employerPage, pageSize: 24 }, careerIndex);
  employerPage = result.page;
  const states = [...new Set(careerIndex.employers.flatMap(e => e.states))].sort();
  main.innerHTML = `${heading('/employers/', careerIndex.scope.label.replaceAll('_', ' '))}<div class="filters"><div class="field grow"><label for="profile-employer-search">Employer name</label><div class="input-wrap">${icon('search')}<input type="search" id="profile-employer-search" placeholder="Search employers" value="${esc(employerQuery)}"></div></div><div class="field"><label for="profile-employer-state">Worksite state</label><select id="profile-employer-state">${option('', 'All states', employerState)}${states.map(s => option(s, s, employerState)).join('')}</select></div><div class="field"><label for="profile-employer-sort">Sort</label><select id="profile-employer-sort">${[['filings', 'Most certified filings'], ['wage', 'Highest median wage'], ['name', 'Employer name'], ['recent', 'Most recently filed']].map(([id, text]) => option(id, text, employerSort)).join('')}</select></div></div><p class="data-scope">${number(careerIndex.scope.records)} certified H-1B records / ${number(careerIndex.employers.length)} employers. Not a list of open jobs or green-card sponsors.</p><div class="sponsor-list">${result.rows.map(e => `<article class="sponsor-item"><a class="employer-name" href="${esc(employerProfilePath(e))}">${esc(e.name)}</a><p>${number(e.filings)} certified filings<br>${money(e.median)} median annualized wage</p><span>${e.states.length} worksite states</span></article>`).join('')}</div>${result.rows.length ? pager(result, 'employers') : '<div class="empty-search">No employers match these filters.</div>'}<p class="data-scope">${sourceLink(careerIndex.sources[0].url, 'Official DOL disclosures')}<br>LCAs can cover multiple workers or repeated filings. Certification is not a visa approval, hiring commitment, or green-card sponsorship guarantee.</p>${adSpace('employer-directory-after-results')}`;
  finishRender();
  if (selection) { const input = document.querySelector('#profile-employer-search'); input.focus({preventScroll:true}); input.setSelectionRange(...selection); }
}
async function renderEmployerProfile() {
  const route = path(), id = employerIdFromPath(route), token = ++careerToken;
  main.innerHTML = '<div class="initial-loading" role="status">Loading public employer filings...</div>'; finishRender();
  try {
    const dataset = await loadCareerRows(id);
    if (token !== careerToken || path() !== route) return;
    careerIndex ??= await loadCareerIndex();
    const p = buildEmployerProfile(dataset);
    if (p.path !== route) history.replaceState({}, '', p.path);
    document.title = `${p.name} H-1B Sponsorship Profile | Green Card Timer`;
    main.innerHTML = `<div class="page-heading"><div><h1 class="employer-title">${esc(p.name)}</h1><p>H-1B sponsorship disclosures / ${esc(p.scope.label.replaceAll('_', ' '))}</p></div><a class="button-secondary" href="/employers/">${icon('arrow-left')}Employers</a></div>${careerSummary({...p.wages,filings:p.filings})}<div class="inline-notice">${icon('info')}<span>These are certified Labor Condition Applications, not unique employees, visa approvals, open jobs, or proof of green-card sponsorship.</span></div><div class="salary-extra"><section><h2>Most filed job titles</h2><div class="table-wrap"><table><thead><tr><th>Job title</th><th>Filings</th><th>Median wage</th></tr></thead><tbody>${p.topTitles.map(r => `<tr><td>${esc(r.title)}</td><td>${number(r.filings)}</td><td>${money(r.wages.median)}</td></tr>`).join('')}</tbody></table></div></section><section><h2>Primary worksite states</h2>${histogram(p.worksiteStates.map(r => ({label:r.state,count:r.filings})))}<p class="chart-caption">Reported primary worksite, not employer headquarters.</p></section></div><section class="content-band"><h2>Monthly filing activity</h2>${histogram(p.filingMonths.map(r => ({label:month(r.month),count:r.filings})))}<p class="chart-caption">Received dates of records certified in this release. This is not a complete month-by-month application census.</p></section><div class="salary-extra"><section><h2>Reported wage distribution</h2><dl class="facts">${[['25th percentile',money(p.wages.p25)],['Median',money(p.wages.median)],['75th percentile',money(p.wages.p75)],['Lowest / highest',`${money(p.wages.min)} / ${money(p.wages.max)}`]].map(([k,v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section><section><h2>Filing details</h2><dl class="facts">${[['Earliest received',formatDate(p.firstFiled)],['Latest received',formatDate(p.lastFiled)],['Latest decision',formatDate(p.lastDecision)],['Full-time / part-time',`${number(p.fullTimeCounts.fullTime)} / ${number(p.fullTimeCounts.partTime)}`]].map(([k,v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section></div><p><a href="${esc(employerSalaryPath(p.id))}">Explore this employer's salary records ${icon('arrow-right')}</a></p><p class="data-scope">${sourceLink(p.sources[0].url,'Official DOL disclosure source')}<br>Decision-date coverage ${formatDate(p.scope.decisionFrom)} to ${formatDate(p.scope.decisionTo)}. Annualized base wages exclude equity and bonuses. Legal employer names are not merged into corporate groups. <a href="/methodology/">Coverage and limitations</a>.</p>${adSpace('employer-profile-after-activity')}`;
    finishRender();
  } catch { if (token === careerToken) { main.innerHTML = '<div class="error-box">This employer profile is unavailable.</div><p><a href="/employers/">Browse published employers</a></p>'; finishRender(); } }
}
function processingOptions() {
  const c = processingData.current;
  return [
    {id:'perm-analystReview',label:'PERM analyst review',queue:c.perm.queues.analystReview,asOf:c.perm.asOf},
    {id:'perm-auditReview',label:'PERM audit review',queue:c.perm.queues.auditReview,asOf:c.perm.asOf},
    {id:'perm-reconsideration',label:'PERM reconsideration',queue:c.perm.queues.reconsideration,asOf:c.perm.asOf},
    ...['perm','h1b'].flatMap(program => ['oews','nonOews'].map(type => ({id:`pwd-${program}-${type}`,label:`${program === 'perm' ? 'PERM' : 'H-1B'} prevailing wage / ${type === 'oews' ? 'OEWS' : 'non-OEWS'}`,queue:c.pwd.queues[program][type],asOf:c.pwd.asOf}))),
  ];
}
async function renderProcessing() {
  const route = '/processing-times/';
  main.innerHTML = `${heading(route)}<div class="initial-loading" role="status">Loading published DOL processing times...</div>`; finishRender();
  try { if (!processingData) { const response = await fetch('/data/processing.json',{cache:'no-cache'}); if (!response.ok) throw new Error(); processingData = await response.json(); } if (path() === route) renderProcessingReady(); }
  catch { if (path() === route) { main.innerHTML = `${heading(route)}<div class="error-box">The last verified processing snapshot could not be loaded.</div><p>${sourceLink('https://flag.dol.gov/processingtimes','Official DOL processing times')}</p>`; finishRender(); } }
}
function renderProcessingReady() {
  const c = processingData.current, options = processingOptions();
  main.innerHTML = `${heading('/processing-times/',`Verified ${formatDate(processingData.verifiedAt)}`)}<form id="processing-form" class="filters" novalidate><div class="field grow"><label for="processing-queue">Review queue</label><select id="processing-queue">${options.map(r => option(r.id,r.label,processingQueue)).join('')}</select></div><div class="field"><label for="processing-date" class="date-label">Your filing date <span class="date-format">MM-DD-YYYY</span></label><input id="processing-date" type="text" placeholder="MM-DD-YYYY" value="${esc(processingDate)}" autocomplete="off" required aria-describedby="processing-date-error"><p id="processing-date-error" class="field-error" role="alert" hidden></p></div><button type="submit" class="primary">Compare filing month ${icon('arrow-right')}</button></form><div id="processing-comparison" aria-live="polite"></div><div class="stat-row">${metric('PERM analyst review',formatProcessingMonth(c.perm.queues.analystReview),`As of ${formatDate(c.perm.asOf)}`)}${metric('PERM audit review',formatProcessingMonth(c.perm.queues.auditReview),`As of ${formatDate(c.perm.asOf)}`)}${metric('Average analyst review',c.perm.averages.analystReview.days === null ? 'Not reported' : `${number(c.perm.averages.analystReview.days)} days`,`${formatProcessingMonth(c.perm.averages.analystReview.month)} determinations`)}${metric('Average audit review',c.perm.averages.auditReview.days === null ? 'Not reported' : `${number(c.perm.averages.auditReview.days)} days`,formatProcessingMonth(c.perm.averages.auditReview.month))}</div><div class="inline-notice">${icon('info')}<span>DOL's processing month is a published queue indicator, not a live case status. A date comparison or historical average cannot predict your decision date.</span></div><section class="content-band"><h2>Published processing months</h2><div class="table-wrap"><table><thead><tr><th>Queue</th><th>Processing month</th><th>Source as of</th></tr></thead><tbody>${options.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(formatProcessingMonth(r.queue))}</td><td>${formatDate(r.asOf)}</td></tr>`).join('')}${['perm','h1b'].flatMap(program => [['redeterminations','Redetermination'],['directorReviews','Director review']].map(([key,label]) => `<tr><td>${program === 'perm' ? 'PERM' : 'H-1B'} prevailing wage / ${label}</td><td>${esc(formatProcessingMonth(c.pwd[key][program]))}</td><td>${formatDate(c.pwd.asOf)}</td></tr>`)).join('')}</tbody></table></div></section><div class="salary-extra">${['perm','h1b'].map(program => `<section><h2>${program === 'perm' ? 'PERM' : 'H-1B'} prevailing-wage requests remaining</h2>${histogram(c.pwd.remainingRequests[program].map(r => ({label:formatProcessingMonth(r.month),count:r.count})))}<p class="chart-caption">PWD requests remaining as of ${formatDate(c.pwd.asOf)}. These are not pending PERM labor-certification cases.</p></section>`).join('')}</div><section class="content-band"><h2>Recorded snapshots</h2><div class="table-wrap"><table><thead><tr><th>Observed</th><th>PERM source date</th><th>Analyst review</th><th>Audit review</th></tr></thead><tbody>${processingData.history.slice().reverse().map(r => `<tr><td>${formatDate(r.observedAt)}</td><td>${formatDate(r.perm.asOf)}</td><td>${esc(formatProcessingMonth(r.perm.queues.analystReview))}</td><td>${esc(formatProcessingMonth(r.perm.queues.auditReview))}</td></tr>`).join('')}</tbody></table></div><p class="chart-caption">History begins with our first verified snapshot. Older observations are not reconstructed.</p></section><p class="data-scope">${sourceLink(processingData.sourceUrl,'Official DOL processing times')}<br>Source dates are separate from our verification date. Weekly checks preserve the last verified snapshot if the source changes format or cannot be downloaded. OEWS is DOL's Occupational Employment and Wage Statistics wage source.</p>${adSpace('processing-after-queues')}`;
  finishRender();
  if (processingFreshness(processingData,new Date().toISOString().slice(0,10)).stale) {
    main.insertAdjacentHTML('afterbegin', '<div class="inline-notice">The published DOL source dates are more than two months old. Check the official source before relying on this snapshot.</div>');
  }
}
function compareProcessingDate() {
  const input = document.querySelector('#processing-date'), error = document.querySelector('#processing-date-error');
  const date = parseInputDate(input.value.trim());
  const message = date ? '' : 'Enter a valid calendar date in MM-DD-YYYY format.';
  input.setCustomValidity(message); input.setAttribute('aria-invalid',String(!date)); error.hidden = Boolean(date); error.textContent = message;
  if (!document.querySelector('#processing-form').reportValidity()) return;
  processingDate = formatInputDate(date); processingQueue = document.querySelector('#processing-queue').value;
  const selected = processingOptions().find(r => r.id === processingQueue), result = compareProcessingMonth(date.slice(0,7), selected.queue);
  const position = {before:'earlier than',same:'the same as',after:'later than'}[result.position];
  document.querySelector('#processing-comparison').innerHTML = `<div class="inline-notice">${icon('info')}<span>${position ? `Your filing month (${esc(formatProcessingMonth(date.slice(0,7)))}) is ${position} the published ${esc(selected.label)} processing month (${esc(formatProcessingMonth(selected.queue))}).` : 'DOL did not report a processing month for this queue.'} This does not establish whether your case is under review or when it will finish.</span></div>`;
  createIcons({icons});
}
function communityContainer() {
  return '<div id="community-totals" class="community-totals" aria-live="polite"><p class="chart-caption" role="status">Loading community totals...</p></div>';
}
function homeCommunity() {
  return `<section id="community-trends" class="content-band home-community" aria-labelledby="community-trends-heading"><div class="section-heading"><div><h2 id="community-trends-heading">Community Search Trends</h2><p>Recorded searches / last 30 UTC days, including today</p></div><a class="method-link" href="/community/">About these counts ${icon('arrow-up-right')}</a></div>${communityContainer()}<p class="chart-caption">Includes repeat searches. These are search counts, not unique people or government queue data. <a href="/privacy/">Data practices</a>.</p></section>${adSpace('home-after-community')}`;
}
function communitySummary(data) {
  return `<div class="community-summary"><strong>${number(data.total)}</strong><span>recorded ${data.total === 1 ? 'search' : 'searches'}</span><small>${formatDate(data.window.from)} to ${formatDate(data.window.through)} / UTC</small></div>${data.total ? `<div class="community-charts">${[['Country of chargeability','countries'],['Visa preference category','categories'],['Priority-date range','priorityPeriods']].map(([title,dimension]) => `<section aria-labelledby="community-${dimension}-title"><h3 id="community-${dimension}-title">${title}</h3>${communityDonut(data[dimension], { title, total: data.total, dimension })}</section>`).join('')}</div>` : '<div class="community-empty"><h3>No recorded searches in this period</h3></div>'}`;
}
function rememberCommunitySummary(data) {
  if (!validCommunitySummary(data)) return false;
  // A slower response must not replace totals from a newer submitted search.
  if (communityData && (data.window.through < communityData.window.through
    || data.window.through === communityData.window.through && data.total < communityData.total)) return false;
  communityData = data;
  return true;
}
function publishCommunitySummary(data) {
  if (!rememberCommunitySummary(data)) return;
  communityRequest = Promise.resolve(communityData);
  communityExpires = Math.min(Date.now() + 60_000, new Date().setUTCHours(24, 0, 0, 0));
  const target = document.querySelector('#community-totals');
  if (target) { target.innerHTML = communitySummary(communityData); createIcons({ icons }); }
}
async function loadCommunitySection() {
  const target = document.querySelector('#community-totals');
  if (!target) return;
  if (!communityRequest || Date.now() >= communityExpires) {
    communityExpires = Math.min(Date.now() + 60_000, new Date().setUTCHours(24, 0, 0, 0));
    communityRequest = (async () => {
      const response = await fetch('/api/community', { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Community totals unavailable');
      const data = await response.json();
      if (!validCommunitySummary(data)) throw new Error('Invalid community totals');
      return data;
    })();
  }
  const request = communityRequest;
  try {
    const data = await request;
    if (communityRequest !== request) return;
    rememberCommunitySummary(data);
    if (target.isConnected) target.innerHTML = communitySummary(communityData);
  } catch {
    if (communityRequest !== request) return;
    communityRequest = null;
    if (target.isConnected) target.innerHTML = `<div class="inline-notice">${icon('info')}<span>Community totals are temporarily unavailable. Your calculator still works normally.</span></div>`;
  }
  if (target.isConnected) createIcons({ icons });
}
function renderCommunity() {
  main.innerHTML = `${heading('/community/', 'Last 30 UTC days, including today')}${communityContainer()}<section class="reading content-band"><h2>What is counted</h2><p>Submitted employment and family priority-date checks are automatically recorded and displayed as public totals by country of chargeability, visa preference category and priority-date range. Dates are grouped into five-year bands, plus before 2000 and 2030 or later. Repeat searches count again.</p><p>Charts include today and show exact counts from the first search, with no opt-in, browser-signal exclusion, minimum sample, hidden small groups or rounding. Counts measure search activity, not unique people or a representative applicant survey.</p><p>Browsing, typing, loading or saving profiles, chart changes, employer searches and PERM dates are not part of this tracker. <a href="/privacy/">Data practices</a>.</p></section>${adSpace('community-after-charts')}`;
  finishRender();
  void loadCommunitySection();
}
function renderSources() {
  main.innerHTML = `${heading('/methodology/')}<article class="reading"><h2>What the timeline actually measures</h2><p>The calculator compares your priority date with a published Department of State cutoff. Your date must be strictly earlier than a dated cutoff. Current means no cutoff applies; Unavailable means no visas are authorized in that category for the bulletin.</p><p>Country of chargeability is generally based on place of birth. Exceptions, cross-chargeability, petition eligibility and individual case issues are outside this calculator.</p><h2>Historical pace, not an approval prediction</h2><p>For an employment-based waiting date, we examine complete six-month windows in the verified history. Each window's net movement includes retrogression. We use the 25th, 50th and 75th percentiles of that movement to illustrate slower, typical and faster future cutoff paths.</p><p>Scenarios appear only with at least 12 months of history, three positive six-month windows, and positive overall net movement. Nonpositive pace produces no date. Projections beyond 10 years are not dated. The gap includes one extra day because equality with the cutoff is not enough.</p><p>Family tracking shows actual cutoffs and historical movement without dated projections. The employment scenarios are mathematical illustrations, not probabilities or forecasts of visa supply. They do not model pending applicants, dependents, spillover, policy changes or USCIS processing. A cutoff can stop or move backward. A current date does not mean a green card has been approved.</p><h2>Filing and approval are different</h2><p>Final Action Dates concern visa availability. Dates for Filing concern an earlier submission stage. For adjustment of status, USCIS chooses which chart can be used each month. Family and employment chart selections are independent. Neither has been independently verified in this dataset, so the app does not tell you that you can file I-485.</p><h2>Source register</h2><div class="source-list"><div class="source-item"><h3>Visa bulletin</h3><div><p>${bulletins.bulletins.length} monthly snapshots, ${month(bulletins.bulletins.at(-1).month)} through ${month(bulletins.latestMonth)}. Verified ${formatDate(bulletins.generatedAt)}. Five employment preferences, five family preferences and five chargeability groups.</p>${sourceLink(bulletins.sourceUrl, 'Department of State archive')}</div></div><div class="source-item"><h3>Monthly filing chart</h3><div><p>Not verified here. Always check the official selection before filing.</p>${sourceLink('https://www.uscis.gov/visabulletininfo', 'USCIS filing chart selection')}</div></div><div class="source-item"><h3>Employer wage records</h3><div><p>Certified H-1B Labor Condition Applications from the latest verified cumulative DOL disclosure. The salary and employer pages show the published quarter and actual coverage. Wage intervals are annualized (hourly x 2,080; weekly x 52; biweekly x 26; monthly x 12). Only valid, positive wage records are included.</p>${sourceLink('https://www.dol.gov/agencies/eta/foreign-labor/performance', 'DOL disclosure data')}</div></div></div><h2>Salary data limitations</h2><p>These are employer filings, not pay stubs, job listings, or unique employees. Repeated filings can concern one worker. Reported base wage excludes bonuses, benefits and equity. A filing does not prove an employer is hiring today. Offer percentiles are comparisons with the selected filings, not a population estimate.</p><p>Median state wages can reflect different roles and seniority. Filter by title and worksite before comparing an offer. Small samples and inconsistent job titles can distort results. Withdrawn and non-certified records are excluded.</p><h2>Freshness and corrections</h2><p>Published data carries a source and verification date. Automated updates validate table structure and dates before replacing a snapshot. If an agency blocks a download or changes its format, the last verified data stays available; we do not silently fill gaps with guesses.</p><p>Green Card Timer is an independent educational tool, not a government service or legal advisor. Confirm consequential decisions with official agencies or a qualified professional.</p></article>${adSpace('sources-after-content')}`;
  finishRender();
}
function renderPrivacy() {
  main.innerHTML = `${heading('/privacy/')}<article class="reading"><h2>Recorded searches</h2><p>Submitted employment and family priority-date checks are automatically recorded and displayed as public community totals. The browser sends country of chargeability, visa preference category and a priority-date range to our Cloudflare counter. Dates are grouped into five-year bands, plus before 2000 and 2030 or later. Repeated submissions count again.</p><p>There is no opt-in, per-tab contribution limit, duplicate filtering or browser-signal exclusion. Charts cover the last 30 UTC calendar days, including today, and show exact counts from the first search. New submissions update the submitter's charts immediately when the counter response is available; totals for other visitors can be cached for up to one minute.</p><p>The database stores separate daily counts for country, category and date range. It does not store exact dates, raw submissions, combinations, names, receipt numbers, visitor IDs, IP addresses or browser identifiers. Browsing, typing, loading or saving profiles, chart changes, employer searches and PERM dates are not recorded by this counter. Counts are search activity, not unique people or a representative applicant survey.</p><h2>Storage and availability</h2><p>Daily rollups older than 90 days are pruned when a new day receives a search; inactive rollups may remain longer. A 10,000-search daily cap bounds database work on the free tier. If a resource limit or outage prevents recording, the calculator still works.</p><h2>Profiles</h2><p>Priority-date calculations run in your browser. Saved profiles use this browser's local storage and do not sync across devices. There is no account or application profile database.</p><p>The share button creates a URL containing the profile fields. Share it only with people you want to see those details. The site removes those fields from the address bar after reading them; hosting providers can still receive a shared URL when it is opened.</p><button class="button-secondary" data-action="clear-storage">${icon('trash-2')}Clear saved profiles</button><h2>Public data and hosting</h2><p>The browser downloads public bulletin and employer data. Hosting infrastructure receives ordinary web requests and may keep security and operational logs, including IP addresses. These platform logs are separate from the search counters. External official-source links are separate websites with their own policies.</p><h2>Cookies and advertising</h2><p>There are no advertising scripts, third-party analytics scripts or account cookies in this version. Advertising may be added later; this policy and any required consent controls will be updated before it is enabled.</p><h2>Local downloads</h2><p>CSV exports and printing are generated in your browser. No document is uploaded to create a download.</p><p>Last updated: October 11, 2026.</p></article>`;
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
  stopHistoryChartObserver();
  careerToken += 1;
  const route = path();
  if (timelinePath()) { timelineProfiles[categoryGroup(profile.category)] = { ...profile }; profile = { ...timelineProfiles[route === '/family-green-card/' ? 'family' : 'employment'] }; renderTimeline(); } else if (route === '/visa-bulletin/') renderBulletin(); else if (route === '/salary-data/') renderCareer(); else if (route === '/employers/') renderEmployerDirectory(); else if (route.startsWith('/employers/')) renderEmployerProfile(); else if (route === '/processing-times/') renderProcessing(); else if (route === '/community/') renderCommunity(); else if (route === '/methodology/') { renderSources(); appendWageScope(); main.querySelector('.reading').insertAdjacentHTML('beforeend','<h2>PERM and prevailing wages</h2><p>Official DOL processing months and average review durations are weekly-checked snapshots, not a live case lookup or remaining-wait forecast. PWD request counts are prevailing-wage requests, not pending labor certifications. Employer profiles summarize the same certified H-1B disclosure release used by salary search. Certification is not visa approval or proof of green-card sponsorship.</p><p><a href="https://flag.dol.gov/processingtimes" target="_blank" rel="noopener noreferrer">Official DOL processing times</a>. Community counts are aggregated submitted checks, not government data; see <a href="/privacy/">privacy and aggregation rules</a>.</p>'); } else if (route === '/privacy/') renderPrivacy(); else { main.innerHTML = '<div class="page-heading"><div><h1>Page not found</h1><p><a href="/">Return to the priority date calculator</a></p></div></div>'; finishRender(); }
}
document.addEventListener('click', async event => {
  const a = event.target.closest('a');
  if (a && a.origin === location.origin && !a.hash && !a.target && !a.hasAttribute('download') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); history.pushState({}, '', a.pathname + a.search); renderRoute(); window.scrollTo(0, 0); return; }
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.chart && readProfile()) { profile.chart = target.dataset.chart; renderTimeline(); }
  if (target.dataset.window && readProfile()) { chartWindow = Number(target.dataset.window); renderTimeline(); }
  if (target.dataset.loadProfile) { profile = { ...stored()[Number(target.dataset.loadProfile)] }; timelineProfiles[categoryGroup(profile.category)] = { ...profile }; if (path() !== profileRoute(profile)) history.pushState({}, '', profileRoute(profile)); renderTimeline(); }
  if (target.dataset.bulletinGroup) { bulletinGroup = target.dataset.bulletinGroup; renderBulletin(); }
  if (target.dataset.employer) { selectEmployer(target.dataset.employer); return; }
  const action = target.dataset.action;
  if (action === 'save' && readProfile()) { const list = stored(), index = list.findIndex(p => profileKey(p) === profileKey(profile)); index === -1 ? list.unshift({ ...profile }) : list.splice(index, 1); try { localStorage.setItem('gct.profiles', JSON.stringify(list.slice(0, 8))); renderTimeline(); toast(index === -1 ? 'Saved on this device' : 'Profile removed'); } catch { toast('This browser does not allow profile storage.'); } }
  if (action === 'remove-profile') { const list = stored(); list.splice(Number(target.dataset.profile), 1); try { localStorage.setItem('gct.profiles', JSON.stringify(list)); renderTimeline(); } catch { toast('Storage is unavailable.'); } }
  if (action === 'share' && readProfile()) { const url = new URL(profileRoute(profile), location.origin); Object.entries(profile).forEach(([k, v]) => url.searchParams.set(k, v)); try { await navigator.clipboard.writeText(url.href); toast('Profile link copied'); } catch { toast('Clipboard unavailable. Use Print to export this profile.'); } }
  if (action === 'print') window.print();
  if (action === 'clear-storage') { try { localStorage.removeItem('gct.profiles'); toast('Saved profiles cleared'); } catch { toast('Storage is unavailable.'); } }
  if (action === 'clear-employer') { ++careerToken; careerDataset = null; careerQuery = ''; careerFilters.page = 1; history.replaceState({}, '', '/salary-data/'); renderCareerReady(); }
  if (action === 'career-next' || action === 'career-previous') { careerFilters.page += action.endsWith('next') ? 1 : -1; renderCareerReady(); document.querySelector('#career-content').scrollIntoView({ block: 'start', behavior: 'auto' }); }
  if (action === 'employers-next' || action === 'employers-previous') { employerPage += action.endsWith('next') ? 1 : -1; renderEmployerDirectoryReady(); }
  if (action === 'csv') { const result = searchCareer('', careerFilters, careerDataset); const url = URL.createObjectURL(new Blob([careerRowsToCsv(result.matchingRows)], { type: 'text/csv;charset=utf-8;' })); const link = document.createElement('a'); link.href = url; link.download = `h1b-wages-${careerIndex.scope.label}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
});
document.addEventListener('submit', event => {
  if (event.target.id === 'profile-form') {
    event.preventDefault();
    if (readProfile()) {
      void recordCommunitySearch({ ...profile }).then(response => { if (response?.summary) publishCommunitySummary(response.summary); });
      renderTimeline();
    }
  }
  if (event.target.id === 'processing-form') { event.preventDefault(); compareProcessingDate(); }
  if (event.target.id === 'offer-form') { event.preventDefault(); offerSalary = document.querySelector('#offer-salary').value; offerCompared = true; renderOffer(); }
});
document.addEventListener('change', event => {
  const { id, value } = event.target;
  if (id === 'profile-employer-state' || id === 'profile-employer-sort') { if (id.endsWith('state')) employerState = value; else employerSort = value; employerPage = 1; renderEmployerDirectoryReady(); }
  if (id === 'processing-queue') { processingQueue = value; document.querySelector('#processing-comparison').innerHTML = ''; }
  if (id === 'bulletin-month') { bulletinMonth = value; renderBulletin(); }
  if (id === 'bulletin-country') { bulletinCountry = value; renderBulletin(); }
  if (careerDataset && (id === 'state-filter' || id === 'salary-sort')) { careerFilters[id === 'state-filter' ? 'state' : 'sort'] = value; careerFilters.page = 1; renderCareerReady(); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'processing-date') { processingDate = event.target.value; event.target.setCustomValidity(''); event.target.removeAttribute('aria-invalid'); document.querySelector('#processing-date-error').hidden = true; document.querySelector('#processing-comparison').innerHTML = ''; return; }
  if (event.target.id === 'profile-employer-search') { employerQuery = event.target.value; employerPage = 1; renderEmployerDirectoryReady(); return; }
  if (event.target.id === 'priority-date') { event.target.setCustomValidity(''); event.target.removeAttribute('aria-invalid'); document.querySelector('#priority-date-error').hidden = true; return; }
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
async function boot() {
  finishRender();
  try {
    [bulletins, model] = await Promise.all(['/data/bulletins.json', '/data/model.json'].map(async url => { const response = await fetch(url, { cache: 'no-cache' }); if (!response.ok) throw new Error('Published data is unavailable.'); return response.json(); }));
    const params = new URLSearchParams(location.search);
    if (params.size) {
      const fields = [...params].filter(([key]) => Object.keys(profile).includes(key));
      const candidate = { ...(path() === '/family-green-card/' ? timelineProfiles.family : profile), ...Object.fromEntries(fields) };
      const accepted = fields.length > 0 && bulletins.countries.some(c => c.id === candidate.country)
        && bulletins.categories.some(c => c.id === candidate.category) && parseDate(candidate.priorityDate)
        && ['filing', 'finalAction'].includes(candidate.chart) && ['aos', 'consular'].includes(candidate.filingPath);
      if (accepted) { profile = candidate; timelineProfiles[categoryGroup(profile.category)] = { ...profile }; }
      const salaryId = path() === '/salary-data/' ? employerIdFromSearch(location.search) : null;
      history.replaceState({}, '', salaryId ? employerSalaryPath(salaryId) : accepted && timelinePath() ? profileRoute(profile) : location.pathname);
    }
    renderRoute();
  } catch { main.innerHTML = '<div class="error-box" role="alert">The verified data could not be loaded. Please try again later or consult the <a href="https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html" target="_blank" rel="noopener noreferrer">official Visa Bulletin</a>.</div>'; }
}
boot();
