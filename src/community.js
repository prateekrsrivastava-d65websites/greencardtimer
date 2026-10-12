import { parseDate } from './model.js';

export const COMMUNITY_COUNTRIES = Object.freeze([
  { id: 'India', label: 'India' },
  { id: 'China', label: 'China' },
  { id: 'Mexico', label: 'Mexico' },
  { id: 'Philippines', label: 'Philippines' },
  { id: 'ROW', label: 'All other countries' },
]);
export const COMMUNITY_CATEGORIES = Object.freeze(
  ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5', 'F1', 'F2A', 'F2B', 'F3', 'F4'].map(id => ({ id, label: id === 'EB3OW' ? 'EB3 Other Workers' : id })),
);
export const COMMUNITY_PERIODS = Object.freeze([
  { id: 'before2000', label: 'Before 2000' },
  ...[2000, 2005, 2010, 2015, 2020, 2025].map(year => ({ id: `${year}-${year + 4}`, label: `${year}-${year + 4}` })),
  { id: '2030plus', label: '2030 or later' },
]);
export const COMMUNITY_DAILY_LIMIT = 10_000;
const DAY = 86_400_000;
const DIMENSIONS = Object.freeze({ countries: COMMUNITY_COUNTRIES, categories: COMMUNITY_CATEGORIES, priorityPeriods: COMMUNITY_PERIODS });
const includesId = (values, value) => values.some(item => item.id === value);

export function validContribution(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'category,country,priorityPeriod'
    && includesId(COMMUNITY_COUNTRIES, value.country)
    && includesId(COMMUNITY_CATEGORIES, value.category)
    && includesId(COMMUNITY_PERIODS, value.priorityPeriod));
}

// Call only for a valid submitted search. The exact date never enters the payload.
export function buildSearchContribution(profile) {
  if (!profile || !parseDate(profile.priorityDate)) return null;
  const year = Number(profile.priorityDate.slice(0, 4));
  const priorityPeriod = year < 2000 ? 'before2000' : year >= 2030 ? '2030plus' : `${Math.floor(year / 5) * 5}-${Math.floor(year / 5) * 5 + 4}`;
  const contribution = { country: profile.country, category: profile.category, priorityPeriod };
  return validContribution(contribution) ? contribution : null;
}

export function communityWindow(now = new Date()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const midnight = new Date(`${today}T00:00:00Z`).getTime();
  return {
    from: new Date(midnight - 29 * DAY).toISOString().slice(0, 10),
    through: today,
    days: 30,
  };
}

export function validCommunitySummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'categories,countries,priorityPeriods,status,total,window'
    || !Number.isInteger(value.total) || value.total < 0 || value.total > 30 * COMMUNITY_DAILY_LIMIT
    || value.status !== (value.total > 0 ? 'ready' : 'empty')) return false;
  const window = value.window;
  if (!window || typeof window !== 'object' || Array.isArray(window)
    || Object.keys(window).sort().join(',') !== 'days,from,through' || window.days !== 30) return false;
  const from = parseDate(window.from), through = parseDate(window.through);
  if (!from || !through || through.getTime() - from.getTime() !== 29 * DAY) return false;
  for (const [dimension, known] of Object.entries(DIMENSIONS)) {
    const bins = value[dimension];
    if (!Array.isArray(bins)) return false;
    const seen = new Set();
    let sum = 0;
    for (const bin of bins) {
      if (!bin || typeof bin !== 'object' || Array.isArray(bin)
        || Object.keys(bin).sort().join(',') !== 'count,id,label') return false;
      const metadata = known.find(item => item.id === bin.id);
      if (!metadata || bin.label !== metadata.label || seen.has(bin.id)
        || !Number.isInteger(bin.count) || bin.count <= 0 || bin.count > value.total) return false;
      seen.add(bin.id);
      sum += bin.count;
    }
    if (sum !== value.total) return false;
  }
  return true;
}

export function buildCommunitySummary(rollups, now = new Date()) {
  const window = communityWindow(now);
  const counts = Object.fromEntries(Object.entries(DIMENSIONS).map(([name, values]) => [name, Object.fromEntries(values.map(({ id }) => [id, 0]))]));
  let total = 0;
  const seenDays = new Set();
  for (const row of rollups) {
    if (!parseDate(row.day)) throw new Error('Invalid aggregate day');
    if (row.day < window.from || row.day > window.through) continue;
    if (seenDays.has(row.day) || !Number.isInteger(row.total) || row.total < 0 || row.total > COMMUNITY_DAILY_LIMIT) throw new Error('Invalid aggregate total');
    seenDays.add(row.day);
    const counters = typeof row.counters === 'string' ? JSON.parse(row.counters) : row.counters;
    if (!counters || typeof counters !== 'object' || Array.isArray(counters) || Object.keys(counters).sort().join(',') !== 'categories,countries,priorityPeriods') throw new Error('Invalid aggregate dimensions');
    for (const [dimension, values] of Object.entries(DIMENSIONS)) {
      const bins = counters[dimension];
      if (!bins || typeof bins !== 'object' || Array.isArray(bins)) throw new Error('Invalid aggregate bins');
      let sum = 0;
      for (const [id, count] of Object.entries(bins)) {
        if (!includesId(values, id) || !Number.isInteger(count) || count < 0 || count > row.total) throw new Error('Invalid aggregate count');
        sum += count;
      }
      if (sum !== row.total) throw new Error('Aggregate counts do not match');
      for (const { id } of values) counts[dimension][id] += bins[id] ?? 0;
    }
    total += row.total;
  }
  const summary = { status: total > 0 ? 'ready' : 'empty', window, total };
  for (const [dimension, values] of Object.entries(DIMENSIONS)) {
    summary[dimension] = values.filter(({ id }) => counts[dimension][id] > 0)
      .map(({ id, label }) => ({ id, label, count: counts[dimension][id] }));
  }
  return summary;
}
