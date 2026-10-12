import { buildCommunitySummary, communityWindow, validContribution } from '../../src/community.js';

export const INSERT_CONTRIBUTION_SQL = `
  INSERT INTO community_daily (day, total, counters)
  VALUES (?1, 1, json_object('countries', json_object(?2, 1), 'categories', json_object(?3, 1), 'priorityPeriods', json_object(?4, 1)))
  ON CONFLICT(day) DO UPDATE SET
    total = community_daily.total + 1,
    counters = json_set(community_daily.counters,
      ?5, coalesce(json_extract(community_daily.counters, ?5), 0) + 1,
      ?6, coalesce(json_extract(community_daily.counters, ?6), 0) + 1,
      ?7, coalesce(json_extract(community_daily.counters, ?7), 0) + 1)
  WHERE community_daily.total < 10000
`;
export const SELECT_ROLLUPS_SQL = 'SELECT day, total, counters FROM community_daily WHERE day >= ?1 AND day <= ?2 ORDER BY day';
const MAX_BODY_BYTES = 512;
const BODY_TIMEOUT_MS = 3000;

function json(value, status = 200, cacheControl = 'no-store', extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  });
}

async function readSmallJSON(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Body timeout')), BODY_TIMEOUT_MS); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* An already closed request needs no cancellation. */ }
  }
}

async function publicSummary(context, url, now) {
  const window = communityWindow(now);
  const cache = globalThis.caches?.default;
  const cacheURL = new URL(url);
  cacheURL.search = `?snapshot=${window.through}`;
  const cacheKey = new Request(cacheURL, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch { /* Cache availability must not determine API availability. */ }
  }
  const result = await context.env.COMMUNITY_DB.prepare(SELECT_ROLLUPS_SQL).bind(window.from, window.through).all();
  if (!result.success || !Array.isArray(result.results)) throw new Error('Aggregate unavailable');
  const response = json(buildCommunitySummary(result.results, now), 200, 'public, max-age=3600');
  if (cache && typeof context.waitUntil === 'function') {
    try { context.waitUntil(cache.put(cacheKey, response.clone()).catch(() => {})); } catch { /* Optional edge caching must remain best effort. */ }
  }
  return response;
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (url.search) return json({ error: 'Query parameters are not supported.' }, 400);
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not supported.' }, 405, 'no-store', { Allow: 'GET, POST' });
  if (request.method === 'POST') {
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (request.headers.get('Origin') !== url.origin || (fetchSite !== null && fetchSite !== 'same-origin')) return json({ error: 'Same-origin requests only.' }, 403);
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(request.headers.get('Content-Type') ?? '')) return json({ error: 'JSON content type required.' }, 415);
    const contribution = await readSmallJSON(request);
    if (!validContribution(contribution)) return json({ error: 'Invalid contribution.' }, 400);
    if (!context.env?.COMMUNITY_DB) return json({ error: 'Community summary temporarily unavailable.' }, 503);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    try {
      const result = await context.env.COMMUNITY_DB.prepare(INSERT_CONTRIBUTION_SQL).bind(
        day, contribution.country, contribution.category, contribution.priorityPeriod,
        `$.countries.${contribution.country}`, `$.categories.${contribution.category}`, `$.priorityPeriods."${contribution.priorityPeriod}"`,
      ).run();
      if (!result.success) throw new Error('Aggregate unavailable');
      return json({ accepted: result.meta?.changes > 0 }, 202);
    } catch {
      return json({ error: 'Community summary temporarily unavailable.' }, 503);
    }
  }
  if (!context.env?.COMMUNITY_DB) return json({ error: 'Community summary temporarily unavailable.' }, 503);
  try {
    return await publicSummary(context, url, new Date());
  } catch {
    return json({ error: 'Community summary temporarily unavailable.' }, 503);
  }
}
