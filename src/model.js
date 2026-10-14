const DAY = 86_400_000;
const AVERAGE_MONTH_DAYS = 365.25 / 12;
const CHARTS = ['finalAction', 'filing'];

export function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function parseInputDate(value) {
  if (typeof value !== 'string' || !/^\d{2}-\d{2}-\d{4}$/.test(value)) return null;
  const [month, day, year] = value.split('-');
  const iso = `${year}-${month}-${day}`;
  return parseDate(iso) ? iso : null;
}

export function formatInputDate(value) {
  if (!parseDate(value)) return null;
  const [year, month, day] = value.split('-');
  return `${month}-${day}-${year}`;
}

export function formatDate(value) {
  if (value === 'C') return 'Current';
  if (value === 'U') return 'Unavailable';
  const date = parseDate(value);
  return date ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date) : 'Not verified';
}

export function categoryGroup(category, bulletinData) {
  const group = bulletinData?.categories?.find(item => item.id === category)?.group;
  return group === 'family' || group === 'employment' ? group : /^F\d/.test(category ?? '') ? 'family' : 'employment';
}

export function monthIndex(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split('-').map(Number);
  return year * 12 + month - 1;
}

export function monthsBetween(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  return start && end ? (end.getTime() - start.getTime()) / DAY / AVERAGE_MONTH_DAYS : null;
}

export function cutoffStatus(priorityDate, cutoff) {
  if (!parseDate(priorityDate)) return { status: 'invalid', current: null };
  if (cutoff === 'C') return { status: 'current', current: true };
  if (cutoff === 'U') return { status: 'unavailable', current: false };
  if (!parseDate(cutoff)) return { status: 'unknown', current: null };
  const current = priorityDate < cutoff;
  return { status: current ? 'current' : 'waiting', current };
}

export function compareCutoffs(previous, current) {
  if (previous === current) return { type: 'unchanged', months: 0 };
  if (current === 'U') return { type: 'unavailable', months: null };
  if (current === 'C') return { type: 'current', months: null };
  if (previous === 'U') return { type: 'available', months: null };
  if (previous === 'C') return { type: 'retrogressed', months: null };
  const movement = monthsBetween(previous, current);
  if (movement === null) return { type: 'unknown', months: null };
  return { type: movement > 0 ? 'advanced' : 'retrogressed', months: movement };
}

function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * (position - lower);
}

export function deriveSeries(bulletinData, country, category, chart, parameters = {}) {
  const windowMonths = parameters.rollingWindowMonths ?? 6;
  const points = (bulletinData.bulletins ?? []).map(bulletin => ({
    month: bulletin.month,
    cutoff: bulletin.charts?.[chart]?.[category]?.[country] ?? null,
    sourceUrl: bulletin.sourceUrl,
  })).sort((a, b) => a.month.localeCompare(b.month));
  const rates = [];
  let advanced = 0;
  let retrogressed = 0;
  let unchanged = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (monthIndex(points[i].month) - monthIndex(points[i - 1].month) !== 1) continue;
    const movement = compareCutoffs(points[i - 1].cutoff, points[i].cutoff);
    if (movement.type === 'advanced') advanced += 1;
    else if (movement.type === 'retrogressed') retrogressed += 1;
    else if (movement.type === 'unchanged') unchanged += 1;
  }
  // A complete window must contain every month and no Current/Unavailable gaps.
  for (let i = windowMonths; i < points.length; i += 1) {
    const window = points.slice(i - windowMonths, i + 1);
    if (window.some((point, offset) => !parseDate(point.cutoff) || monthIndex(point.month) !== monthIndex(window[0].month) + offset)) continue;
    rates.push(monthsBetween(window[0].cutoff, window.at(-1).cutoff) / windowMonths);
  }
  const first = points[0];
  const latest = points.at(-1);
  const monthsObserved = first && latest ? monthIndex(latest.month) - monthIndex(first.month) : 0;
  const netMovementMonths = first && latest ? monthsBetween(first.cutoff, latest.cutoff) : null;
  return {
    points,
    monthsObserved,
    fromMonth: first?.month ?? null,
    toMonth: latest?.month ?? null,
    netMovementMonths,
    averagePace: netMovementMonths === null || !monthsObserved ? null : netMovementMonths / monthsObserved,
    advancedMonths: advanced,
    retrogressedMonths: retrogressed,
    unchangedMonths: unchanged,
    currentMonths: points.filter(point => point.cutoff === 'C').length,
    unavailableMonths: points.filter(point => point.cutoff === 'U').length,
    completeWindows: rates.length,
    positiveWindows: rates.filter(rate => rate > 0).length,
    pace: { slower: quantile(rates, 0.25), typical: quantile(rates, 0.5), faster: quantile(rates, 0.75) },
    lastMovement: points.length > 1 ? compareCutoffs(points.at(-2).cutoff, latest.cutoff) : { type: 'unknown', months: null },
  };
}

export function buildModelData(bulletinData, template) {
  const series = {};
  for (const country of bulletinData.countries) {
    for (const category of bulletinData.categories) {
      for (const chart of CHARTS) {
        const { points, ...summary } = deriveSeries(bulletinData, country.id, category.id, chart, template.methodology.parameters);
        series[`${country.id}:${category.id}:${chart}`] = summary;
      }
    }
  }
  return { ...template, generatedAt: bulletinData.generatedAt, bulletinMonth: bulletinData.latestMonth, series };
}

export function evaluateProfile(profile, bulletinData, modelData) {
  const { country, category, priorityDate, chart = 'finalAction', filingPath = 'aos', bulletinMonth } = profile;
  const bulletin = (bulletinData.bulletins ?? []).find(item => item.month === (bulletinMonth ?? bulletinData.latestMonth)) ?? null;
  const cutoff = bulletin?.charts?.[chart]?.[category]?.[country] ?? null;
  const group = categoryGroup(category, bulletinData);
  const filingChart = bulletin?.[group === 'family' ? 'uscisFamilyChart' : 'uscisEmploymentChart'] ?? null;
  const base = { cutoff, bulletin, categoryGroup: group, current: null, monthsBehind: null, scenarios: null, trend: null, canFile: null, approvalEligible: null, chartChoiceKnown: false, filingChart, forecastKind: 'history-only', forecastReason: 'Published Visa Bulletins show cutoff history only. They do not predict individual approval dates or remaining waiting times.' };
  if (!parseDate(priorityDate) || !CHARTS.includes(chart) || !['aos', 'consular'].includes(filingPath)) {
    return { ...base, status: 'invalid', reason: 'Enter a valid priority date, chart and filing path.' };
  }
  if (!bulletin || cutoff === null) return { ...base, status: 'unknown', reason: 'This country, category or bulletin is not in the verified dataset.' };
  const selected = cutoffStatus(priorityDate, cutoff);
  const finalActionCutoff = bulletin.charts?.finalAction?.[category]?.[country] ?? null;
  const filingCutoff = bulletin.charts?.filing?.[category]?.[country] ?? null;
  const chartChoiceKnown = CHARTS.includes(filingChart);
  const numericFiling = cutoffStatus(priorityDate, filingCutoff).current;
  const canFile = filingPath === 'consular' ? numericFiling : chartChoiceKnown ? cutoffStatus(priorityDate, bulletin.charts[filingChart]?.[category]?.[country]).current : null;
  const history = { ...bulletinData, bulletins: bulletinData.bulletins.filter(item => item.month <= bulletin.month) };
  const parameters = modelData?.methodology?.parameters ?? {};
  const trend = deriveSeries(history, country, category, chart, parameters);
  const gap = parseDate(cutoff) ? Math.max(0, monthsBetween(cutoff, priorityDate)) : null;
  return { ...base, ...selected, finalActionCutoff, filingCutoff, monthsBehind: gap, trend, canFile, chartChoiceKnown, approvalEligible: cutoffStatus(priorityDate, finalActionCutoff).current };
}
