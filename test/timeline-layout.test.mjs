import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { load } from 'cheerio';
import { bulletinData, modelData } from './fixtures/model-bulletins.mjs';

const savedProfile = { country: 'India', category: 'EB2', priorityDate: '2017-04-21', chart: 'finalAction', filingPath: 'aos' };

async function browserHarness({ route = '/', search = '', saved = [], failData = false } = {}) {
  let $ = load('<main id="main" data-published-route="/"><table><tr><td>Published cutoffs</td></tr></table></main>'), version = 0, total = 10;
  const requests = [], listeners = {}, observers = [], storage = new Map([['gct.profiles', JSON.stringify(saved)]]);
  const location = { pathname: route, search, origin: 'https://example.test' };
  const summary = () => ({
    status: 'ready', total, window: { from: '2026-09-13', through: '2026-10-12', days: 30 },
    countries: [{ id: 'India', label: 'India', count: total }],
    categories: [{ id: 'EB2', label: 'EB2', count: total }],
    priorityPeriods: [{ id: '2015-2019', label: '2015-2019', count: total }],
  });
  function wrap(node) {
    if (!node) return null;
    const current = version, element = {
      get id() { return $(node).attr('id'); },
      get value() { return $(node).val(); }, set value(value) { $(node).val(value); },
      get hidden() { return $(node).attr('hidden') != null; }, set hidden(value) { value ? $(node).attr('hidden', '') : $(node).removeAttr('hidden'); },
      get textContent() { return $(node).text(); }, set textContent(value) { $(node).text(value); },
      get innerHTML() { return $(node).html(); },
      set innerHTML(value) { if (node.attribs?.id === 'main') { $ = load(`<main id="main">${value}</main>`); version++; } else $(node).html(value); },
      get isConnected() { return current === version; },
      get dataset() { return Object.fromEntries(Object.entries(node.attribs || {}).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])); },
      getAttribute: name => $(node).attr(name),
      setAttribute: (name, value) => $(node).attr(name, String(value)),
      removeAttribute: name => $(node).removeAttr(name),
      hasAttribute: name => $(node).attr(name) != null,
      querySelector: selector => wrap($(node).find(selector)[0]),
      querySelectorAll: selector => $(node).find(selector).toArray().map(wrap),
      closest: selector => wrap($(node).closest(selector)[0]),
      classList: { toggle(name, active) { $(node).toggleClass(name, active); } },
      setCustomValidity(message) { node.validationMessage = message; },
      reportValidity: () => !$(node).find('input').toArray().some(field => field.validationMessage),
      getBoundingClientRect: () => ({ width: 400 }),
      replaceChildren: content => $(node).html(content),
      remove: () => $(node).remove(),
      insertAdjacentHTML(position, content) { position === 'afterbegin' ? $(node).prepend(content) : $(node).append(content); },
    };
    return element;
  }
  const main = {
    get innerHTML() { return $('#main').html(); }, set innerHTML(value) { $('#main').html(value); version++; },
    getAttribute: name => $('#main').attr(name), removeAttribute: name => $('#main').removeAttr(name),
    querySelector: selector => wrap($('#main').find(selector)[0]),
    insertAdjacentHTML(position, content) { position === 'afterbegin' ? $('#main').prepend(content) : $('#main').append(content); },
  };
  const document = {
    querySelector: selector => selector === '#main' ? main : wrap($(selector)[0]),
    querySelectorAll: selector => $(selector).toArray().map(wrap),
    addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    body: { append() {} },
    createElement() { return { innerHTML: '', setAttribute() {}, remove() {}, querySelector(selector) { return load(this.innerHTML)(selector).toString(); } }; },
  };
  const navigate = url => { const next = new URL(url, location.origin); location.pathname = next.pathname; location.search = next.search; };
  const context = vm.createContext({
    document, location,
    window: { addEventListener() {}, scrollTo() {} },
    history: { pushState(_, __, url) { navigate(url); }, replaceState(_, __, url) { navigate(url); } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    FormData: class { constructor(form) { this.values = form.querySelectorAll('[name]').map(field => [field.getAttribute('name'), field.value]); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } },
    URL, URLSearchParams, setTimeout: () => 1, clearTimeout() {},
    ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.startsWith('/data/') && failData) throw new Error('Offline');
      if (url === '/data/bulletins.json') return { ok: true, async json() { return bulletinData; } };
      if (url === '/data/model.json') return { ok: true, async json() { return modelData; } };
      if (options?.method === 'POST') { total++; return { ok: true, async json() { return { accepted: true, summary: summary() }; } }; }
      return { ok: true, async json() { return summary(); } };
    },
  });
  const url = new URL('../src/app.js', import.meta.url), source = await readFile(url, 'utf8');
  const app = new vm.SourceTextModule(`${source}\nexport { renderRoute };`, { context });
  await app.link(async specifier => {
    const values = specifier.endsWith('.css') ? {} : await import(specifier === 'lucide' ? specifier : new URL(specifier, url).href);
    const exports = specifier === 'lucide' ? { ...values, createIcons() {} }
      : specifier === './community-client.js' ? { ...values, createCommunityRecorder(options = {}) { return values.createCommunityRecorder({ ...options, fetchImpl: context.fetch }); } } : values;
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context });
  });
  await app.evaluate();
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const trigger = async (type, selector) => { const event = { target: document.querySelector(selector), preventDefault() {}, button: 0 }; for (const listener of listeners[type] || []) await listener(event); await settle(); };
  return { app: app.namespace, html: () => load(main.innerHTML), document, location, requests, observers, trigger, settle };
}

function assertCommunity($, beside) {
  assert.equal($('#community-trends').length, 1);
  assert.equal($('#community-trends-heading').length, 1);
  assert.equal($('#community-totals').length, 1);
  assert.equal($('.workspace > #community-trends').length, beside ? 1 : 0);
  assert.equal($('.workspace ~ #community-trends').length, beside ? 0 : 1);
  assert.equal($('#community-totals .community-summary strong').text(), '10');
}

test('priority-date workspace switches community and results without changing recording behavior', async () => {
  if (!vm.SourceTextModule) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return;
  }
  for (const route of ['/', '/family-green-card/']) {
    const harness = await browserHarness({ route });
    const $ = harness.html();
    assert.equal($('#priority-date').val(), '');
    assert.equal($('#priority-date').attr('placeholder'), 'MM-DD-YYYY');
    assert.equal($('.results, .chart').length, 0);
    assertCommunity($, true);
    assert.equal(harness.requests.filter(request => request.url === '/api/community').length, 1);
    assert.equal(harness.requests.filter(request => request.options?.method === 'POST').length, 0);
    assert.equal(harness.observers.length, 0);
    assert.equal($('#category option').toArray().every(node => $(node).val().startsWith('F')), route !== '/');
  }

  const invalid = await browserHarness();
  invalid.document.querySelector('#priority-date').value = '02-29-2025';
  await invalid.trigger('submit', '#profile-form');
  assert.equal(invalid.html()('#priority-date').attr('aria-invalid'), 'true');
  assert.equal(invalid.html()('#priority-date-error').attr('hidden'), undefined);
  assert.equal(invalid.html()('.results').length, 0);
  assertCommunity(invalid.html(), true);
  assert.equal(invalid.requests.filter(request => request.options?.method === 'POST').length, 0);
  await invalid.trigger('click', '[data-chart="filing"]');
  assert.equal(invalid.html()('[data-chart="filing"]').attr('aria-pressed'), 'true');
  assert.equal(invalid.html()('#priority-date').val(), '02-29-2025');
  assert.equal(invalid.html()('.results').length, 0);

  const submitted = await browserHarness();
  submitted.document.querySelector('#priority-date').value = '04-21-2017';
  await submitted.trigger('click', '[data-chart="filing"]');
  assert.equal(submitted.html()('#priority-date').attr('aria-invalid'), undefined);
  assert.equal(submitted.html()('#priority-date').val(), '04-21-2017');
  assert.equal(submitted.html()('.results').length, 0);
  await submitted.trigger('submit', '#profile-form');
  let $ = submitted.html();
  assert.equal($('.workspace > .results').length, 1);
  assert.equal($('.chart svg').length, 1);
  assert.equal($('.workspace > #community-trends').length, 0);
  assert.equal($('.workspace ~ #community-trends').length, 1);
  assert.equal($('#community-totals').length, 1);
  assert.equal($('#community-totals .community-summary strong').text(), '11');
  assert.equal(submitted.requests.filter(request => request.options?.method === 'POST').length, 1);
  assert.equal(submitted.requests.filter(request => request.url === '/api/community' && request.options?.method !== 'POST').length, 1);
  await submitted.trigger('submit', '#profile-form');
  assert.equal(submitted.requests.filter(request => request.options?.method === 'POST').length, 2);
  assert.equal(submitted.html()('#community-totals .community-summary strong').text(), '12');
  submitted.document.querySelector('#priority-date').value = 'invalid';
  await submitted.trigger('submit', '#profile-form');
  assert.equal(submitted.html()('.results').length, 1);
  assert.equal(submitted.requests.filter(request => request.options?.method === 'POST').length, 2);

  submitted.location.pathname = '/family-green-card/';
  submitted.app.renderRoute();
  await submitted.settle();
  assert.equal(submitted.html()('#priority-date').val(), '');
  assert.equal(submitted.html()('.workspace > #community-trends').length, 1);
  assert.equal(submitted.html()('.results').length, 0);
  submitted.location.pathname = '/';
  submitted.app.renderRoute();
  await submitted.settle();
  assert.equal(submitted.html()('.workspace > .results').length, 1);
  assert.equal(submitted.html()('#community-totals').length, 1);
  assert.equal(submitted.requests.filter(request => request.options?.method === 'POST').length, 2);

  const saved = await browserHarness({ saved: [savedProfile, { ...savedProfile, category: 'F2A' }] });
  await saved.trigger('click', '[data-load-profile="0"]');
  assert.equal(saved.html()('#priority-date').val(), '04-21-2017');
  assert.equal(saved.html()('.workspace > .results').length, 1);
  assertCommunity(saved.html(), false);
  await saved.trigger('click', '[data-load-profile="1"]');
  assert.equal(saved.location.pathname, '/family-green-card/');
  assert.equal(saved.html()('.workspace > .results').length, 1);
  assertCommunity(saved.html(), false);
  assert.equal(saved.requests.filter(request => request.options?.method === 'POST').length, 0);

  for (const category of ['EB2', 'F2A']) {
    const shared = await browserHarness({ search: `?country=India&category=${category}&priorityDate=2017-04-21&chart=finalAction&filingPath=aos` });
    assert.equal(shared.location.pathname, category === 'F2A' ? '/family-green-card/' : '/');
    assert.equal(shared.location.search, '');
    assert.equal(shared.html()('#priority-date').val(), '04-21-2017');
    assert.equal(shared.html()('.workspace > .results').length, 1);
    assertCommunity(shared.html(), false);
    assert.equal(shared.requests.filter(request => request.options?.method === 'POST').length, 0);
  }
  const invalidShared = await browserHarness({ search: '?priorityDate=2025-02-29' });
  assert.equal(invalidShared.html()('.results').length, 0);
  assert.equal(invalidShared.html()('#priority-date').val(), '');
  assertCommunity(invalidShared.html(), true);
  const failed = await browserHarness({ failData: true });
  assert.match(failed.html().text(), /Published cutoffs/);
  assert.match(failed.html().text(), /Interactive data could not be loaded/);
  assert.equal(failed.requests.filter(request => request.options?.method === 'POST').length, 0);
});
