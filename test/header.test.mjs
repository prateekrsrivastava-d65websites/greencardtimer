import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { load } from 'cheerio';
import { ROUTES, routeHTML } from '../scripts/postbuild.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

test('D65 ownership metadata survives prerendering without obsolete verification files', async () => {
  const $ = load(html);
  const token = $('head meta[name="google-site-verification"]').attr('content');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const rendered = load(routeHTML(html, ROUTES[0], 'https://greencardtimer.pages.dev'));
  assert.equal(rendered('head meta[name="google-site-verification"]').length, 1);
  assert.equal(rendered('head meta[name="google-site-verification"]').attr('content'), token);
  assert.equal((await readdir(new URL('../public/', import.meta.url))).filter(name => /^google[0-9a-f]+\.html$/.test(name)).length, 0);
});

test('header places the free access promise beneath the linked brand without duplicate labels', () => {
  const $ = load(html);
  const brand = $('header .brand');
  assert.equal(brand.length, 1);
  assert.equal(brand.attr('href'), '/');
  assert.equal(brand.attr('aria-label'), 'Green Card Timer home');
  assert.equal(brand.find('.brand-name').text(), 'Green Card Timer');
  assert.equal(brand.find('.brand-name').next('.brand-subtitle').text(), 'Free. No signup. No subscription.');
  assert.equal(brand.attr('aria-describedby'), brand.find('.brand-subtitle').attr('id'));
  assert.equal(brand.find('.brand-mark').attr('aria-hidden'), 'true');
  assert.equal(brand.find('h1, h2, h3').length, 0);
  assert.equal($('header .free-label').length, 0);
  assert.equal($('header').text().match(/No signup\. No subscription\./g)?.length, 1);
  assert.doesNotMatch($('header').text(), /Free\. No account\./);
});

test('header keeps existing navigation links and landmark label', () => {
  const $ = load(html);
  assert.equal($('header nav').attr('aria-label'), 'Main navigation');
  assert.deepEqual($('header nav a').map((_, node) => $(node).attr('href')).get(), [
    '/', '/family-green-card/', '/visa-bulletin/', '/processing-times/',
    '/employers/', '/salary-data/', '/community/',
  ]);
});

test('brand copy can shrink and its subtitle wraps without a fixed height', () => {
  const rules = Object.fromEntries([...css.matchAll(/(\.header \.brand(?:-[a-z]+)?)\s*\{([^}]+)\}/g)]
    .map(([, selector, declarations]) => [selector, declarations]));
  assert.match(rules['.header .brand'], /min-width:0/);
  assert.match(rules['.header .brand'], /max-width:100%/);
  assert.match(rules['.header .brand-copy'], /display:grid/);
  assert.match(rules['.header .brand-copy'], /min-width:0/);
  assert.match(rules['.header .brand-mark'], /flex-shrink:0/);
  assert.match(rules['.header .brand-subtitle'], /white-space:normal/);
  assert.doesNotMatch(rules['.header .brand-copy'] + rules['.header .brand-subtitle'], /(?:^|;)height:|overflow:hidden/);
});
