export const ROUTES = [
  { path: '/', title: 'Green Card Wait Time & Priority Date Tracker | Green Card Timer', description: 'Compare your employment-based green card priority date with verified visa bulletin cutoffs. See EB-1, EB-2, EB-3 and EB-5 history, not a guaranteed approval date. Free, no signup.' },
  { path: '/visa-bulletin/', title: 'Employment & Family Visa Bulletin | Green Card Timer', description: 'Official employment-based and family-sponsored visa bulletin cutoffs: Final Action Dates, Dates for Filing, and historical movement by country and preference category.' },
  { path: '/family-green-card/', title: 'Family-Based Green Card Tracker | Green Card Timer', description: 'Check family-based green card priority dates for F1, F2A, F2B, F3 and F4. Compare verified visa bulletin cutoffs and monthly history. Free, no signup.' },
  { path: '/salary-data/', title: 'H-1B Salary Data & LCA Filings | Green Card Timer', description: 'Search public Department of Labor H-1B LCA filings by employer, job title and worksite. Compare reported annualized base wages and download matching records for free.' },
  { path: '/employers/', title: 'H-1B Employer Sponsorship Data & Filings | Green Card Timer', description: 'Research H-1B employer sponsorship activity using certified DOL LCA filings, reported wages, roles and worksites. Public records, not job openings or green-card sponsorship guarantees.' },
  { path: '/methodology/', title: 'Sources & Methodology | Green Card Timer', description: 'Official data sources, priority-date cutoff rules, historical trend methods and limitations behind Green Card Timer. No guaranteed approval dates.' },
  { path: '/privacy/', title: 'Privacy | Green Card Timer', description: 'How submitted priority-date checks become public search counts, how profiles stay local, and what hosting providers receive. No account required.' },
  { path: '/processing-times/', title: 'PERM & PWD Processing Times | Green Card Timer', description: 'Compare your filing month with official DOL PERM and prevailing-wage processing months. Weekly-checked source data, without a signup or approval predictions.' },
  { path: '/community/', title: 'Community Search Trends | Green Card Timer', description: 'Public search counts by country, visa preference and priority-date range over the last 30 UTC days, including today. Repeat submissions count again.' },
];

const number = value => Number(value).toLocaleString('en-US');
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const release = scope => String(scope?.label ?? 'the published DOL release').replaceAll('_', ' ');

export function employerRoute(profile) {
  const wage = Number.isFinite(profile.wages?.median) ? `; ${money(profile.wages.median)} median annualized base wage` : '';
  return {
    path: profile.path,
    title: `${profile.name} H-1B Filings & Salaries | Green Card Timer`,
    description: `${profile.name}: ${number(profile.filings)} certified H-1B LCA cases${wage} in ${release(profile.scope)}. Reported job titles and primary worksites.`,
  };
}

export function routeMetadata(path, { bulletinData, careerData, employerProfile } = {}) {
  if (employerProfile) return employerRoute(employerProfile);
  const route = ROUTES.find(item => item.path === path);
  if (!route) return { path, title: 'Page Not Found | Green Card Timer', description: 'This page was not found. Browse verified visa bulletin cutoffs, priority-date trackers and public H-1B employer filings.', noindex: true };
  const result = { ...route };
  const latest = bulletinData?.bulletins.find(item => item.month === bulletinData.latestMonth);
  if (path === '/visa-bulletin/' && latest) {
    result.title = `${latest.label} Visa Bulletin | Green Card Timer`;
    result.description = `${latest.label} employment and family visa bulletin: verified Final Action Dates and Dates for Filing for India, China, Mexico, the Philippines and other chargeability groups. Compare monthly movement.`;
  }
  if (careerData?.scope && ['/salary-data/', '/employers/'].includes(path)) {
    result.description = `${release(careerData.scope)}: ${number(careerData.scope.records)} certified H-1B LCA cases across ${number(careerData.scope.employers)} employers. ${path === '/salary-data/' ? 'Search reported annualized base wages by employer, title and worksite.' : 'Research employer filing activity, reported wages, roles and worksites. Not open jobs or green-card sponsorship guarantees.'}`;
  }
  return result;
}

export function structuredData(route, origin, { careerData, employerProfile } = {}) {
  if (!origin || route.noindex) return null;
  const home = new URL('/', origin).href, url = new URL(route.path, origin).href;
  const graph = [
    { '@type': 'WebSite', '@id': `${home}#website`, name: 'Green Card Timer', url: home },
    { '@type': route.path === '/employers/' ? 'CollectionPage' : 'WebPage', '@id': `${url}#webpage`, url, name: route.title, description: route.description, isPartOf: { '@id': `${home}#website` }, inLanguage: 'en', isAccessibleForFree: true },
  ];
  const page = graph[1];
  if (route.path !== '/') {
    const items = [{ '@type': 'ListItem', position: 1, name: 'Green Card Timer', item: home }];
    if (employerProfile) items.push({ '@type': 'ListItem', position: 2, name: 'H-1B employers', item: new URL('/employers/', origin).href });
    items.push({ '@type': 'ListItem', position: items.length + 1, name: employerProfile?.name ?? route.title.replace(' | Green Card Timer', ''), item: url });
    page.breadcrumb = { '@id': `${url}#breadcrumb` };
    graph.push({ '@type': 'BreadcrumbList', '@id': `${url}#breadcrumb`, itemListElement: items });
  }
  const data = employerProfile ?? (route.path === '/salary-data/' ? careerData : null);
  const source = data?.sources?.[0]?.url;
  if (data?.scope && source) {
    const dataset = {
      '@type': 'Dataset', '@id': `${url}#dataset`, url,
      name: `${employerProfile ? `${employerProfile.name} ` : ''}Certified H-1B LCA filings and annualized base wages, ${release(data.scope)}`,
      description: `${route.description} Source case disclosures created by the U.S. Department of Labor; Green Card Timer filters, annualizes and summarizes these public records. Certified cases are not unique workers, open jobs, visa approvals or proof of green-card sponsorship.`,
      isBasedOn: source, isAccessibleForFree: true, version: data.scope.label,
      creator: { '@type': 'Organization', name: 'U.S. Department of Labor', url: 'https://www.dol.gov/' },
      license: 'https://www.dol.gov/general/aboutdol/copyright',
      variableMeasured: ['Certified LCA cases', 'Annualized base wage', 'Reported job title', 'Primary worksite'],
    };
    if (/^\d{4}-\d{2}-\d{2}$/.test(data.scope.decisionFrom) && /^\d{4}-\d{2}-\d{2}$/.test(data.scope.decisionTo)) dataset.temporalCoverage = `${data.scope.decisionFrom}/${data.scope.decisionTo}`;
    page.mainEntity = { '@id': dataset['@id'] };
    graph.push(dataset);
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

// Prevent disclosed employer names from closing an inert JSON-LD script element.
export function serializeStructuredData(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function applyPageMetadata(document, route, origin, data = {}) {
  document.title = route.title;
  if (!document.head) return;
  const meta = (attribute, name, content) => {
    let element = document.querySelector(`meta[${attribute}="${name}"]`);
    if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, name); document.head.append(element); }
    element.setAttribute('content', content);
  };
  meta('name', 'description', route.description);
  meta('property', 'og:title', route.title);
  meta('property', 'og:description', route.description);
  meta('property', 'og:type', 'website');
  meta('property', 'og:site_name', 'Green Card Timer');
  meta('name', 'twitter:card', 'summary');
  meta('name', 'twitter:title', route.title);
  meta('name', 'twitter:description', route.description);
  if (route.noindex) meta('name', 'robots', 'noindex, follow');
  else document.querySelector('meta[name="robots"]')?.remove();
  if (origin) {
    const url = new URL(route.path, origin).href;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) { canonical = document.createElement('link'); canonical.setAttribute('rel', 'canonical'); document.head.append(canonical); }
    canonical.setAttribute('href', url);
    meta('property', 'og:url', url);
  }
  const graph = structuredData(route, origin, data);
  let script = document.querySelector('#page-schema');
  if (graph) {
    if (!script) { script = document.createElement('script'); script.id = 'page-schema'; script.type = 'application/ld+json'; document.head.append(script); }
    script.textContent = serializeStructuredData(graph);
  } else script?.remove();
}
