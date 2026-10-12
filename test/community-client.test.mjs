import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityRecorder } from '../src/community-client.js';

const profile = { country: 'India', category: 'EB2', priorityDate: '2017-04-21' };
const acceptedResponse = (value = { accepted: true }) => ({ ok: true, async json() { return value; } });

function pendingResponse() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('creating a recorder does not record page views or send network requests', () => {
  let requests = 0;
  createCommunityRecorder({ fetchImpl() { requests++; return acceptedResponse(); } });
  assert.equal(requests, 0);
});

test('a submitted valid search sends only the three coarse fields without cookies or referrer', async () => {
  const requests = [];
  const record = createCommunityRecorder({ fetchImpl: async (...args) => { requests.push(args); return acceptedResponse(); } });
  assert.deepEqual(await record({ ...profile, chart: 'filing', id: 'private-id', name: 'Private name', query: 'unrestricted text' }), { accepted: true });
  assert.deepEqual(requests, [['/api/community', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: 'India', category: 'EB2', priorityPeriod: '2015-2019' }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  }]]);
});

test('accepted response objects include the fresh server summary when available', async () => {
  const result = { accepted: true, summary: { status: 'ready', total: 3, countries: [{ label: 'India', count: 3 }] } };
  const record = createCommunityRecorder({ fetchImpl: async () => acceptedResponse(result) });
  assert.equal(await record(profile), result);
});

test('accepted submissions without a summary are still reported as successful', async () => {
  const result = { accepted: true };
  const record = createCommunityRecorder({ fetchImpl: async () => acceptedResponse(result) });
  assert.equal(await record(profile), result);
});

test('malformed dates, missing fields and unrecognized categories or countries never submit', async () => {
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: async () => { requests++; return acceptedResponse(); } });
  for (const invalid of [null, {}, { ...profile, priorityDate: '2025-02-29' }, { ...profile, priorityDate: '04-21-2017' }, { ...profile, priorityDate: 2017 }, { ...profile, country: 'Unknown' }, { ...profile, category: 'F5' }]) {
    assert.equal(await record(invalid), null);
  }
  assert.equal(requests, 0);
});

test('repeated identical profiles and matching coarse buckets each send a new contribution', async () => {
  const bodies = [];
  const record = createCommunityRecorder({ fetchImpl: async (_, options) => { bodies.push(options.body); return acceptedResponse(); } });
  assert.deepEqual(await record(profile), { accepted: true });
  assert.deepEqual(await record(profile), { accepted: true });
  assert.deepEqual(await record({ ...profile, priorityDate: '2019-12-31' }), { accepted: true });
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
});

test('more than ten submitted checks are independently counted without a per-tab cap', async () => {
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: async () => { requests++; return acceptedResponse(); } });
  for (let index = 0; index < 25; index++) assert.deepEqual(await record(profile), { accepted: true });
  assert.equal(requests, 25);
});

test('concurrent identical checks each send independently before earlier requests finish', async () => {
  const pending = pendingResponse();
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: () => { requests++; return pending.promise; } });
  const checks = Array.from({ length: 12 }, () => record(profile));
  assert.equal(requests, 12);
  pending.resolve(acceptedResponse());
  assert.deepEqual(await Promise.all(checks), Array.from({ length: 12 }, () => ({ accepted: true })));
});

test('HTTP failures and rejected or malformed acceptance values quietly return null', async () => {
  for (const response of [
    { ok: false },
    acceptedResponse({ accepted: false }),
    acceptedResponse({ accepted: 'true' }),
    acceptedResponse({ accepted: 1 }),
    acceptedResponse({}),
    acceptedResponse(null),
    acceptedResponse([]),
  ]) {
    let requests = 0;
    const record = createCommunityRecorder({ fetchImpl: async () => ++requests === 1 ? response : acceptedResponse() });
    assert.equal(await record(profile), null);
    assert.deepEqual(await record(profile), { accepted: true });
    assert.equal(requests, 2);
  }
});

test('network and JSON exceptions never escape or prevent later submissions', async () => {
  for (const failure of [
    () => { throw new Error('Offline'); },
    () => ({ ok: true, json() { throw new Error('Malformed response'); } }),
    () => ({ ok: true, async json() { throw new Error('Failed body download'); } }),
  ]) {
    let requests = 0;
    const record = createCommunityRecorder({ fetchImpl: async () => ++requests === 1 ? failure() : acceptedResponse() });
    assert.equal(await record(profile), null);
    assert.deepEqual(await record(profile), { accepted: true });
    assert.equal(requests, 2);
  }
});

test('a malformed profile property fails quietly without sending a request', async () => {
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: async () => { requests++; return acceptedResponse(); } });
  const malformed = { get priorityDate() { throw new Error('Invalid profile'); } };
  assert.equal(await record(malformed), null);
  assert.equal(requests, 0);
});
