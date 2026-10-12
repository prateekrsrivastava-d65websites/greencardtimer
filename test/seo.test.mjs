import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { ROUTES, employerRoute, routeMetadata, structuredData, serializeStructuredData, applyPageMetadata } from '../src/seo.js';
import { searchContext } from '../src/search-context.js';
import { routeHTML } from '../scripts/postbuild.mjs';

const bulletinData = { latestMonth: '2026-10', bulletins: [{ month: '2026-10', label: 'October 2026' }] };
const careerData = {
  scope: { label: 'FY2026_Q3', records: 391764, employers: 53787, decisionFrom: '2025-10-01', decisionTo: '2026-06-30' },
  sources: [{ url: 'https://www.dol.gov/official.xlsx' }],
};

function documentFixture() {
  const nodes = [];
  const document = {
    title: '',
    head: { append: node => nodes.push(node) },
    createElement: tag => ({ tag, attributes: {}, textContent: '', setAttribute(name, value) { this.attributes[name] = value; }, remove() { nodes.splice(nodes.indexOf(this), 1); } }),
    querySelector(selector) {
      if (selector === '#page-schema') return nodes.find(node => node.id === 'page-schema') ?? null;
      const [, tag, attribute, value] = /^(\w+)\[([\w:]+)="([^"]+)"\]$/.exec(selector);
      return nodes.find(node => node.tag === tag && node.attributes[attribute] === value) ?? null;
    },
  };
  return { document, nodes, content: selector => document.querySelector(selector)?.attributes.content };
}

test('metadata targets real data coverage rather than the calendar or invented wait times', () => {
  assert.equal(new Set(ROUTES.map(route => route.title)).size, ROUTES.length);
  const bulletin = routeMetadata('/visa-bulletin/', { bulletinData });
  assert.equal(bulletin.title, 'October 2026 Visa Bulletin | Green Card Timer');
  assert.match(bulletin.description, /October 2026/);
  for (const path of ['/salary-data/', '/employers/']) {
    const route = routeMetadata(path, { careerData });
    assert.match(route.description, /FY2026 Q3: 391,764/);
    assert.match(route.description, /53,787 employers/);
  }
  assert.match(routeMetadata('/').title, /Green Card Wait Time/);
  assert.match(routeMetadata('/').description, /not a guaranteed approval date/);
  assert.doesNotMatch(routeMetadata('/employers/').description, /visa approval rate|currently hiring/);
});

test('client navigation updates every metadata field and keeps the configured production origin', () => {
  const { document, nodes, content } = documentFixture();
  for (const path of ['/', '/visa-bulletin/', '/salary-data/', '/employers/']) {
    const route = routeMetadata(path, { bulletinData, careerData });
    applyPageMetadata(document, route, 'https://timer.example', { careerData });
    assert.equal(document.title, route.title);
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) assert.equal(content(selector), route.description);
    for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) assert.equal(content(selector), route.title);
    assert.equal(document.querySelector('link[rel="canonical"]').attributes.href, `https://timer.example${path}`);
    assert.equal(content('meta[property="og:url"]'), `https://timer.example${path}`);
    assert.equal(nodes.filter(node => node.id === 'page-schema').length, 1);
    const graph = JSON.parse(document.querySelector('#page-schema').textContent)['@graph'];
    assert.equal(graph.find(item => item['@id'].endsWith('#webpage')).url, `https://timer.example${path}`);
  }
  assert.equal(nodes.filter(node => node.attributes.name === 'description').length, 1);
});

test('unknown routes are noindex and valid navigation removes stale error metadata and schema', () => {
  const { document, content } = documentFixture();
  applyPageMetadata(document, routeMetadata('/'), 'https://timer.example');
  const route = routeMetadata('/not-a-page/');
  assert.equal(route.noindex, true);
  applyPageMetadata(document, route, 'https://timer.example');
  assert.equal(content('meta[name="robots"]'), 'noindex, follow');
  assert.equal(document.querySelector('#page-schema'), null);
  applyPageMetadata(document, routeMetadata('/family-green-card/'), 'https://timer.example');
  assert.equal(document.querySelector('meta[name="robots"]'), null);
  assert.match(document.title, /Family-Based/);
  assert.ok(document.querySelector('#page-schema'));
});

test('employer schema describes a sourced case subset without invented vacancies or affiliations', () => {
  const employerProfile = { ...careerData, name: 'EXAMPLE </script><img src=x>', path: '/employers/example--abcdef0123456789/', filings: 10, wages: { median: 150000 } };
  const route = employerRoute(employerProfile);
  assert.match(route.description, /10 certified H-1B LCA cases; \$150,000 median/);
  const graph = structuredData(route, 'https://timer.example', { employerProfile });
  const dataset = graph['@graph'].find(item => item['@type'] === 'Dataset');
  assert.equal(dataset.isBasedOn, careerData.sources[0].url);
  assert.equal(dataset.temporalCoverage, '2025-10-01/2026-06-30');
  assert.equal(dataset.isAccessibleForFree, true);
  assert.equal(dataset.version, 'FY2026_Q3');
  const breadcrumbs = graph['@graph'].find(item => item['@type'] === 'BreadcrumbList').itemListElement;
  assert.deepEqual(breadcrumbs.map(item => item.position), [1, 2, 3]);
  assert.equal(breadcrumbs[1].item, 'https://timer.example/employers/');
  assert.equal(breadcrumbs[2].name, employerProfile.name);
  assert.doesNotMatch(JSON.stringify(graph), /JobPosting|ProfilePage|aggregateRating|hiringOrganization|sameAs|license/);
  const html = routeHTML('<html><head></head><body><main id="main"></main></body></html>', route, 'https://timer.example', { employerProfile: { ...employerProfile, id: 'abcdef0123456789', firstFiled: '2026-01-01', lastFiled: '2026-02-01', lastDecision: '2026-02-02', fullTimeCounts: { fullTime: 10, partTime: 0 }, topTitles: [], worksiteStates: [], topWorksites: [], filingMonths: [] } });
  const $ = load(html);
  assert.equal($('img, script:not([type="application/ld+json"])').length, 0);
  assert.equal(JSON.parse($('#page-schema').text())['@graph'].find(item => item['@type'] === 'BreadcrumbList').itemListElement.at(-1).name, employerProfile.name);
  assert.equal(JSON.parse(serializeStructuredData(graph))['@graph'][2].itemListElement.at(-1).name, employerProfile.name);
  assert.doesNotMatch(serializeStructuredData(graph), /<\/script>/);
  assert.equal(structuredData(route, null, { employerProfile }), null);
});

test('domain explanations and contextual links are shared with the visible static HTML', () => {
  for (const path of ['/', '/family-green-card/', '/visa-bulletin/', '/employers/', '/salary-data/']) {
    const context = searchContext(path);
    const $ = load(context);
    assert.equal($('[hidden], [aria-hidden="true"]').length, 0);
    assert.equal($('nav a').length, 3);
    assert.ok($('nav a').toArray().every(element => ROUTES.some(route => route.path === $(element).attr('href'))));
    const route = routeMetadata(path);
    const page = load(routeHTML('<html><head></head><body><main id="main"></main></body></html>', route));
    assert.equal(page('.search-context').length, 1);
    assert.equal(page('.search-context').text(), $('.search-context').text());
  }
  assert.match(searchContext('/'), /not establish a future approval date/);
  assert.equal(searchContext('/privacy/'), '');
});
