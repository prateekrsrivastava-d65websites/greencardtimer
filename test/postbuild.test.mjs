import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { assetCacheRules, faviconMarkup, initialContent, ROUTES, routeHTML, siteOrigin } from '../scripts/postbuild.mjs';
import { samePublishedBulletin } from '../scripts/refresh-bulletins.mjs';

const bulletinData = JSON.parse(readFileSync(new URL('../public/data/bulletins.json', import.meta.url), 'utf8'));

test('route metadata uses configured real origin only', () => {
  const html = '<!doctype html><html><head><title>Old</title><meta name="description" content="Old"><link rel="canonical" href="https://old.example/"></head><body><script type="module" src="/assets/app-abc12345.js"></script></body></html>';
  const route = ROUTES.find(item => item.path === '/visa-bulletin/');
  const $ = load(routeHTML(html, route, 'https://timer.example'));
  assert.equal($('title').text(), route.title);
  assert.equal($('meta[name="description"]').length, 1);
  assert.equal($('link[rel="canonical"]').attr('href'), 'https://timer.example/visa-bulletin/');
  assert.equal($('script').attr('src'), '/assets/app-abc12345.js');
  const withoutOrigin = load(routeHTML(html, route));
  assert.equal(withoutOrigin('link[rel="canonical"], meta[property="og:url"]').length, 0);
});

test('site origin rejects placeholder paths and credentials', () => {
  assert.equal(siteOrigin(''), null);
  assert.equal(siteOrigin('https://timer.example/'), 'https://timer.example');
  for (const value of ['ftp://timer.example', 'https://timer.example/path', 'https://user:password@timer.example', 'https://timer.example/?query']) {
    assert.throws(() => siteOrigin(value));
  }
});

test('immutable caching is limited to hashed build assets', () => {
  const rules = assetCacheRules(['app-Abc_1234.js', 'app-Abc_1234.css', 'logo.svg', 'data.json']);
  assert.match(rules, /\/assets\/app-Abc_1234\.js/);
  assert.match(rules, /immutable/);
  assert.doesNotMatch(rules, /logo\.svg|data\.json|\/assets\/\*/);
});

test('favicon is generated from a valid Lucide icon tree', () => {
  const $ = load(faviconMarkup(), { xmlMode: true });
  assert.equal($('svg').attr('viewBox'), '0 0 24 24');
  assert.equal($('svg').attr('stroke'), '#16765c');
  assert.ok($('svg').children().length > 0);
});

test('initial bulletin HTML publishes both sourced fifty-cell cutoff charts', () => {
  const route = ROUTES.find(item => item.path === '/visa-bulletin/');
  const $ = load(initialContent(route, { bulletinData }));
  assert.equal($('table').length, 2);
  assert.equal($('tbody tr').length, 10);
  assert.equal($('tbody td').length, 50);
  assert.match($.text(), /October 2026/);
  assert.match($.text(), /strictly earlier/);
  assert.equal($('a').first().attr('href'), bulletinData.bulletins[0].sourceUrl);
});

test('initial salary HTML identifies full release scope without inventing absent counts', () => {
  const route = ROUTES.find(item => item.path === '/salary-data/');
  const data = { scope: { label: 'FY2026_Q3', records: 391764, employers: 53787, decisionFrom: '2025-10-01', decisionTo: '2026-06-30' } };
  const html = initialContent(route, { careerData: data });
  assert.match(html, /391,764/);
  assert.match(html, /53,787/);
  assert.match(html, /\$5,000 through \$1,000,000/);
  assert.doesNotMatch(initialContent(route), /391,764|53,787|NaN/);
});

test('unchanged bulletin tables ignore key order and verification-only timestamps', () => {
  const old = bulletinData.bulletins[0];
  const next = structuredClone(old);
  next.verifiedAt = '2026-10-12';
  next.charts.finalAction.EB2 = Object.fromEntries(Object.entries(next.charts.finalAction.EB2).reverse());
  assert.equal(samePublishedBulletin(old, next), true);
  next.charts.finalAction.EB2.India = '2013-12-01';
  assert.equal(samePublishedBulletin(old, next), false);
});
