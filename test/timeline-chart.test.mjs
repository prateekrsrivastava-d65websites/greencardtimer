import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { load } from 'cheerio';
import { bulletinData, modelData } from './fixtures/model-bulletins.mjs';

async function browserHarness() {
  const observers = [], draws = [], location = { pathname: '/', origin: 'https://example.test', search: '' };
  const chart = { getBoundingClientRect: () => ({ width: 400 }), replaceChildren: svg => draws.push(svg) };
  const main = { querySelector: selector => selector === '.chart' ? chart : null, insertAdjacentHTML() {} };
  const document = {
    querySelector: selector => selector === '#main' ? main : null, querySelectorAll: () => [], addEventListener() {},
    createElement: () => ({ innerHTML: '', querySelector(selector) { return load(this.innerHTML)(selector).toString(); } }),
  };
  const context = vm.createContext({
    document, location, window: { addEventListener() {} }, fetch: () => new Promise(() => {}),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
      deliver(width) { if (!this.disconnected) this.callback([{ contentRect: { width } }]); }
    },
  });
  const url = new URL('../src/app.js', import.meta.url);
  const source = await readFile(url, 'utf8');
  // Export the existing functions for the harness without changing production module exports.
  const app = new vm.SourceTextModule(`${source}\nexport { historyChart, observeHistoryChart, stopHistoryChartObserver, renderTimeline, renderRoute };
    export function configureTest(data, config, range) { bulletins = data; model = config; chartWindow = range; }`, { context });
  await app.link(async specifier => {
    const values = specifier.endsWith('.css') ? {} : await import(specifier === 'lucide' ? specifier : new URL(specifier, url).href);
    const exports = specifier === 'lucide' ? { ...values, createIcons() {} } : values;
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await app.evaluate();
  app.namespace.configureTest(bulletinData, modelData, 24);
  return { app: app.namespace, observers, draws, chart, location };
}

test('cutoff charts use allocated width, avoid narrow tick collisions and clean up resize observers', async () => {
  if (!vm.SourceTextModule) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return;
  }
  const { app, observers, draws, chart, location } = await browserHarness();
  const points = Array.from({ length: 25 }, (_, i) => ({ month: new Date(Date.UTC(2024, 9 + i, 1)).toISOString().slice(0, 7), cutoff: '2014-01-01' }));
  const svg = width => load(app.historyChart(points, width))('svg');
  for (const [width, expected] of [[undefined, 720], [400, 400], [100, 240], [1200, 720]]) {
    assert.equal(svg(width).attr('viewBox'), `0 0 ${expected} 215`);
  }
  for (const width of [240, 280, 339, 340, 720]) {
    const labels = svg(width).children('text[y="203"]').toArray();
    assert.equal(labels.length, width < 340 ? 3 : 4);
    assert.equal(load(labels[0]).text(), 'Oct 2024');
    assert.equal(load(labels.at(-1)).text(), 'Oct 2026');
    // Seven pixels per character is a conservative bound for the 11px abbreviated-date labels.
    const bounds = labels.map(label => { const node = load(label)('text'), x = Number(node.attr('x')), width = node.text().length * 7; return [x - width * (node.attr('text-anchor') === 'end' ? 1 : .5), x + (node.attr('text-anchor') === 'end' ? 0 : width / 2)]; });
    for (let i = 1; i < bounds.length; i++) assert.ok(bounds[i][0] > bounds[i - 1][1], `Overlapping ${width}px chart labels`);
    if (width === 280) assert.ok(bounds.at(-1)[0] - bounds.at(-2)[1] >= 20);
  }
  assert.equal(load(app.historyChart(points.slice(0, 1), 280))('text[y="203"]').length, 1);
  assert.equal(load(app.historyChart(points.slice(0, 2), 280))('text[y="203"]').length, 2);
  app.observeHistoryChart(points);
  const first = observers.at(-1);
  assert.equal(first.target, chart);
  assert.equal(load(draws.at(-1))('svg').attr('viewBox'), '0 0 400 215');
  first.deliver(280);
  first.deliver(280.1);
  assert.equal(draws.length, 2);
  assert.equal(load(draws.at(-1))('svg').attr('viewBox'), '0 0 280 215');
  app.renderTimeline();
  assert.equal(first.disconnected, true);
  const replacement = observers.at(-1);
  assert.notEqual(replacement, first);
  location.pathname = '/privacy/';
  app.renderRoute();
  assert.equal(replacement.disconnected, true);
  app.stopHistoryChartObserver();
});
