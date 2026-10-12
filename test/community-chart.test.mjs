import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { communityDonut } from '../src/community-chart.js';

const countries = [
  { id: 'India', label: 'India', count: 60 },
  { id: 'China', label: 'China', count: 30 },
  { id: 'Mexico', label: 'Mexico', count: 10 },
];
const chart = (rows, options = {}) => load(communityDonut(rows, { title: 'Country of chargeability', dimension: 'countries', ...options }));
const segments = $ => $('.community-donut-segment').toArray().map(element => ({
  id: $(element).attr('data-bin'),
  stroke: $(element).attr('stroke'),
  dash: $(element).attr('stroke-dasharray').split(' ').map(Number),
  offset: Number($(element).attr('stroke-dashoffset')),
}));

test('donut segments have exact proportions and cumulative offsets without padding', () => {
  const $ = chart(countries, { total: 100 });
  assert.deepEqual(segments($).map(({ id, dash, offset }) => ({ id, dash, offset })), [
    { id: 'India', dash: [60, 40], offset: 0 },
    { id: 'China', dash: [30, 70], offset: -60 },
    { id: 'Mexico', dash: [10, 90], offset: -90 },
  ]);
  assert.equal($('.community-donut-chart').attr('viewBox'), '0 0 220 220');
  assert.equal($('.community-donut-total').text(), '100');
  assert.equal($('.community-donut-caption').text(), 'searches');
  assert.deepEqual($('.community-legend-share').toArray().map(element => $(element).text()), ['60%', '30%', '10%']);
  assert.equal(segments($).reduce((sum, segment) => sum + segment.dash[0], 0), 100);
});

test('small nonzero slices stay proportional and use a less-than percentage label', () => {
  const $ = chart([{ id: 'India', label: 'India', count: 9999 }, { id: 'China', label: 'China', count: 1 }], { total: 10000 });
  const small = segments($).find(row => row.id === 'China');
  assert.equal(small.dash[0], 0.01);
  assert.equal(small.offset, -99.99);
  assert.equal($('.community-legend li[data-bin="China"] strong').text(), '1');
  assert.equal($('.community-legend li[data-bin="China"] .community-legend-share').text(), '<0.1%');
  assert.match($('.community-donut-segment[data-bin="China"]').attr('aria-label'), /1 search \(<0\.1%\)/);
});

test('large exact totals render without minimum-slice inflation or integer rounding', () => {
  const total = Number.MAX_SAFE_INTEGER;
  const $ = chart([{ id: 'India', label: 'India', count: total - 1 }, { id: 'China', label: 'China', count: 1 }], { total });
  assert.equal($('.community-donut-total').text(), total.toLocaleString('en-US'));
  const small = segments($).find(row => row.id === 'China');
  assert.equal(small.dash[0], 1 / total * 100);
  assert.ok(small.dash[0] > 0 && small.dash[0] < 0.000001);
  assert.equal($('.community-legend li').length, 2);
});

test('a single populated bin renders a full ring with its exact count and singular caption', () => {
  const $ = chart([{ id: 'India', label: 'India', count: 1 }], { total: 1 });
  assert.deepEqual(segments($)[0].dash, [100, 0]);
  assert.equal(segments($)[0].offset, 0);
  assert.equal($('.community-donut-total').text(), '1');
  assert.equal($('.community-donut-caption').text(), 'search');
  assert.equal($('.community-legend-share').text(), '100%');
});

test('long formatted totals receive a compact center-label modifier without changing shorter labels', () => {
  for (const total of [0, 1, 100, 1000, 9999]) {
    const $ = chart(total ? [{ id: 'India', label: 'India', count: total }] : [], { total });
    assert.equal($('.community-donut-total-long').length, 0);
    assert.equal($('.community-donut-total').text(), total.toLocaleString('en-US'));
  }
  for (const total of [10000, 100000, 300000]) {
    const $ = chart([{ id: 'India', label: 'India', count: total }], { total });
    assert.equal($('.community-donut-total-long').length, 1);
    assert.equal($('.community-donut-total').text(), total.toLocaleString('en-US'));
  }
});

test('empty and all-zero inputs use an empty track without invented slices', () => {
  for (const rows of [[], countries.map(row => ({ ...row, count: 0 }))]) {
    const $ = chart(rows, { total: 0 });
    assert.equal($('.community-donut-segment').length, 0);
    assert.equal($('.community-donut-track').length, 1);
    assert.equal($('.community-donut-total').text(), '0');
    assert.equal($('.community-legend li').length, 0);
    assert.match($('.community-legend-empty').text(), /No searches/);
    assert.doesNotMatch($.html(), /NaN|Infinity/);
  }
});

test('malformed counts, inconsistent totals and duplicate or unknown bins fail safely', () => {
  const good = { id: 'India', label: 'India', count: 1 };
  for (const rows of [
    null, {}, 'India', [null], [[]], [{}], [{ ...good, id: '' }], [{ ...good, label: '' }],
    [{ ...good, count: -1 }], [{ ...good, count: 1.5 }], [{ ...good, count: NaN }],
    [{ ...good, count: Infinity }], [{ ...good, count: '1' }], [{ ...good, count: Number.MAX_SAFE_INTEGER + 1 }],
    [good, good], [{ ...good, id: 'Unknown' }],
    [{ ...good, count: Number.MAX_SAFE_INTEGER }, { id: 'China', label: 'China', count: 1 }],
  ]) {
    const $ = chart(rows);
    assert.equal($('.community-donut-error').length, 1);
    assert.equal($('.community-donut-segment').length, 0);
  }
  for (const total of [-1, '1', 0, 2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(chart([good], { total })('.community-donut-error').length, 1);
});

test('malformed options and throwing profile properties do not escape', () => {
  for (const options of [null, false, [], { title: null }, { dimension: false }]) assert.match(communityDonut(countries, options), /Chart data is unavailable/);
  assert.match(communityDonut([{ get count() { throw new Error('Malformed'); } }]), /Chart data is unavailable/);
});

test('all dynamic titles, labels, bin identifiers and dimensions are escaped', () => {
  const title = '<img src=x onerror="evil()">';
  const label = 'India & <script>alert("x")</script>';
  const $ = chart([{ id: 'India', label, count: 1 }], { title });
  assert.equal($('script, img').length, 0);
  assert.equal($('.community-legend-label span').text(), label);
  assert.equal($('.community-donut-chart').attr('aria-label'), `${title}: 1 submitted search`);
  const id = 'bin" onfocus="evil()';
  const dimension = '<dimension "unsafe">';
  const generic = load(communityDonut([{ id, label, count: 1 }], { title, dimension }));
  assert.equal(generic('[onfocus]').length, 0);
  assert.equal(generic('.community-donut-segment').attr('data-bin'), id);
  assert.equal(generic('.community-donut').attr('data-dimension'), dimension);
});

test('colors stay tied to canonical identifiers as counts and incoming order change', () => {
  const before = segments(chart(countries));
  const after = segments(chart(countries.toReversed().map(row => ({ ...row, count: row.id === 'Mexico' ? 100 : row.count }))));
  assert.equal(new Set(before.map(row => row.stroke)).size, 3);
  for (const row of before) assert.equal(after.find(next => next.id === row.id).stroke, row.stroke);
  const categories = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5', 'F1', 'F2A', 'F2B', 'F3', 'F4'].map(id => ({ id, label: id, count: 1 }));
  const categoryChart = load(communityDonut(categories, { dimension: 'categories' }));
  assert.equal(new Set(segments(categoryChart).map(row => row.stroke)).size, 10);
});

test('rows sort by descending count and canonical tie order without mutating input', () => {
  const rows = [{ id: 'Mexico', label: 'Mexico', count: 1 }, { id: 'India', label: 'India', count: 2 }, { id: 'China', label: 'China', count: 2 }];
  const original = structuredClone(rows);
  for (const row of rows) Object.freeze(row);
  Object.freeze(rows);
  const $ = chart(rows);
  assert.deepEqual(segments($).map(row => row.id), ['India', 'China', 'Mexico']);
  assert.deepEqual(rows, original);
  assert.deepEqual(segments(chart([...rows].reverse())).map(row => row.id), ['India', 'China', 'Mexico']);
  const generic = load(communityDonut([{ id: 'z', label: 'Z', count: 1 }, { id: 'a', label: 'A', count: 1 }]));
  assert.deepEqual(segments(generic).map(row => row.id), ['a', 'z']);
});

test('segment details are keyboard reachable with titles and matching accessible legends', () => {
  const $ = chart(countries);
  for (const element of $('.community-donut-segment').toArray()) {
    const segment = $(element), id = segment.attr('data-bin');
    assert.equal(segment.attr('tabindex'), '0');
    assert.equal(segment.attr('role'), 'img');
    assert.equal(segment.find('title').text(), segment.attr('aria-label'));
    const legend = $(`.community-legend li[data-bin="${id}"]`);
    assert.equal(legend.find('.community-legend-swatch rect').attr('fill'), segment.attr('stroke'));
    assert.ok(legend.find('strong').text());
  }
  assert.equal($('button, [role="button"], script, [style]').length, 0);
});
