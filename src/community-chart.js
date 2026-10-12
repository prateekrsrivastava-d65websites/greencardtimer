import { COMMUNITY_COUNTRIES, COMMUNITY_CATEGORIES, COMMUNITY_PERIODS } from './community.js';

const PALETTE = ['#178568', '#3a74bf', '#d96355', '#b28527', '#8462ba', '#368996', '#bf5d83', '#667844', '#cc874b', '#63728a'];
const DIMENSIONS = new Map([
  ['countries', COMMUNITY_COUNTRIES],
  ['categories', COMMUNITY_CATEGORIES],
  ['priorityPeriods', COMMUNITY_PERIODS],
]);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = value => value.toLocaleString('en-US');
const unavailable = () => '<p class="community-donut-error" role="status">Chart data is unavailable.</p>';

function colorFor(id, known) {
  const ordinal = known?.findIndex(bin => bin.id === id) ?? -1;
  if (ordinal >= 0) return PALETTE[ordinal % PALETTE.length];
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function shareLabel(count, total) {
  const percentage = count / total * 100;
  return percentage < 0.1 ? '<0.1%' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(percentage)}%`;
}

export function communityDonut(rows, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return unavailable();
    const { title = 'Submitted searches', dimension = '', total: specifiedTotal } = options;
    if (!Array.isArray(rows) || typeof title !== 'string' || typeof dimension !== 'string') return unavailable();
    const known = DIMENSIONS.get(dimension);
    const seen = new Set();
    let total = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.id !== 'string' || !row.id || typeof row.label !== 'string' || !row.label
        || !Number.isSafeInteger(row.count) || row.count < 0 || seen.has(row.id)
        || known && !known.some(bin => bin.id === row.id)) return unavailable();
      seen.add(row.id);
      total += row.count;
      if (!Number.isSafeInteger(total)) return unavailable();
    }
    if (specifiedTotal !== undefined && (!Number.isSafeInteger(specifiedTotal) || specifiedTotal !== total)) return unavailable();
    const order = id => known?.findIndex(bin => bin.id === id) ?? -1;
    const sorted = rows.filter(row => row.count > 0).slice().sort((a, b) => b.count - a.count
      || order(a.id) - order(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let cumulative = 0;
    const segments = sorted.map(row => {
      const percentage = row.count / total * 100;
      const offset = -(cumulative / total * 100);
      cumulative += row.count;
      const details = `${row.label}: ${number(row.count)} ${row.count === 1 ? 'search' : 'searches'} (${shareLabel(row.count, total)})`;
      return `<circle class="community-donut-segment" data-bin="${escapeHTML(row.id)}" cx="110" cy="110" r="76" fill="none" stroke="${colorFor(row.id, known)}" stroke-width="26" stroke-linecap="butt" pathLength="100" stroke-dasharray="${percentage} ${100 - percentage}" stroke-dashoffset="${offset}" transform="rotate(-90 110 110)" tabindex="0" role="img" aria-label="${escapeHTML(details)}"><title>${escapeHTML(details)}</title></circle>`;
    }).join('');
    const legend = sorted.length ? `<ul class="community-legend" aria-label="${escapeHTML(title)} breakdown">${sorted.map(row => `<li data-bin="${escapeHTML(row.id)}"><span class="community-legend-label"><svg class="community-legend-swatch" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="3" fill="${colorFor(row.id, known)}"/></svg><span>${escapeHTML(row.label)}</span></span><span class="community-legend-value"><strong>${number(row.count)}</strong><span class="community-legend-share">${escapeHTML(shareLabel(row.count, total))}</span></span></li>`).join('')}</ul>` : '<p class="community-legend-empty">No searches in this window.</p>';
    const totalLabel = number(total);
    const description = `${title}: ${totalLabel} submitted ${total === 1 ? 'search' : 'searches'}`;
    return `<div class="community-donut" data-dimension="${escapeHTML(dimension)}"><svg class="community-donut-chart" viewBox="0 0 220 220" role="img" aria-label="${escapeHTML(description)}"><title>${escapeHTML(description)}</title><circle class="community-donut-track" cx="110" cy="110" r="76" fill="none" stroke="#e8ece9" stroke-width="26" aria-hidden="true"/>${segments}<text class="community-donut-total${totalLabel.length > 5 ? ' community-donut-total-long' : ''}" x="110" y="106" text-anchor="middle" aria-hidden="true">${totalLabel}</text><text class="community-donut-caption" x="110" y="128" text-anchor="middle" aria-hidden="true">${total === 1 ? 'search' : 'searches'}</text></svg>${legend}</div>`;
  } catch {
    return unavailable();
  }
}
