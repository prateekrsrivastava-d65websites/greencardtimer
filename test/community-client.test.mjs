import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommunityRecorder } from '../src/community-client.js';

const profile = { country: 'India', category: 'EB2', priorityDate: '2017-04-21' };
const acceptedResponse = () => ({ ok: true, async json() { return { accepted: true }; } });

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
  assert.equal(await record({ ...profile, chart: 'filing', id: 'private-id', name: 'Private name', query: 'unrestricted text' }), true);
  assert.deepEqual(requests, [['/api/community', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: 'India', category: 'EB2', priorityPeriod: '2015-2019' }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  }]]);
});

test('malformed dates, missing fields and unrecognized categories or countries never submit', async () => {
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: async () => { requests++; return acceptedResponse(); } });
  for (const invalid of [null, {}, { ...profile, priorityDate: '2025-02-29' }, { ...profile, priorityDate: '04-21-2017' }, { ...profile, priorityDate: 2017 }, { ...profile, country: 'Unknown' }, { ...profile, category: 'F5' }]) {
    assert.equal(await record(invalid), false);
  }
  assert.equal(requests, 0);
});

test('enabled privacy signals prevent submissions without reserving the search', async () => {
  let blocked = true;
  let requests = 0;
  const record = createCommunityRecorder({ privacySignal: () => blocked, fetchImpl: async () => { requests++; return acceptedResponse(); } });
  assert.equal(await record(profile), false);
  assert.equal(requests, 0);
  blocked = false;
  assert.equal(await record(profile), true);
  assert.equal(requests, 1);
});

test('privacy preferences are checked dynamically for each submitted search', async () => {
  let blocked = false;
  let requests = 0;
  const record = createCommunityRecorder({ privacySignal: () => blocked, fetchImpl: async () => { requests++; return acceptedResponse(); } });
  assert.equal(await record(profile), true);
  blocked = true;
  const other = { ...profile, category: 'F2A' };
  assert.equal(await record(other), false);
  assert.equal(requests, 1);
  blocked = false;
  assert.equal(await record(other), true);
  assert.equal(requests, 2);
});

test('concurrent identical buckets reserve once, including different exact dates in the same period', async () => {
  const pending = pendingResponse();
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: () => { requests++; return pending.promise; } });
  const first = record(profile);
  assert.equal(await record({ ...profile, priorityDate: '2019-12-31' }), false);
  assert.equal(requests, 1);
  pending.resolve(acceptedResponse());
  assert.equal(await first, true);
  assert.equal(await record(profile), false);
  assert.equal(requests, 1);
});

test('each tab recorder has its own deduplication without a persistent visitor identifier', async () => {
  let requests = 0;
  const options = { fetchImpl: async () => { requests++; return acceptedResponse(); } };
  const first = createCommunityRecorder(options);
  const second = createCommunityRecorder(options);
  assert.equal(await first(profile), true);
  assert.equal(await first(profile), false);
  assert.equal(await second(profile), true);
  assert.equal(requests, 2);
});

test('at most ten accepted contributions are submitted in a tab', async () => {
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: async () => { requests++; return acceptedResponse(); } });
  const categories = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5', 'F1', 'F2A', 'F2B', 'F3', 'F4'];
  for (const category of categories) assert.equal(await record({ ...profile, category }), true);
  assert.equal(await record({ ...profile, country: 'China' }), false);
  assert.equal(requests, 10);
});

test('the ten-contribution cap includes pending requests before any have completed', async () => {
  const pending = pendingResponse();
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: () => { requests++; return pending.promise; } });
  const categories = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5', 'F1', 'F2A', 'F2B', 'F3', 'F4'];
  const requestsPending = categories.map(category => record({ ...profile, category }));
  assert.equal(await record({ ...profile, country: 'China' }), false);
  assert.equal(requests, 10);
  pending.resolve(acceptedResponse());
  assert.deepEqual(await Promise.all(requestsPending), Array(10).fill(true));
});

test('failed HTTP responses and rejected contributions quietly allow a later retry', async () => {
  for (const response of [{ ok: false }, { ok: true, async json() { return { accepted: false }; } }, { ok: true, async json() { return { accepted: 'true' }; } }]) {
    let requests = 0;
    const record = createCommunityRecorder({ fetchImpl: async () => ++requests === 1 ? response : acceptedResponse() });
    assert.equal(await record(profile), false);
    assert.equal(await record(profile), true);
    assert.equal(await record(profile), false);
    assert.equal(requests, 2);
  }
});

test('network and JSON exceptions release the reservation and never escape', async () => {
  for (const failure of [() => { throw new Error('Offline'); }, () => ({ ok: true, json() { throw new Error('Malformed response'); } })]) {
    let requests = 0;
    const record = createCommunityRecorder({ fetchImpl: async () => ++requests === 1 ? failure() : acceptedResponse() });
    assert.equal(await record(profile), false);
    assert.equal(await record(profile), true);
    assert.equal(requests, 2);
  }
});

test('failed requests release capacity for other coarse searches', async () => {
  const pending = pendingResponse();
  let requests = 0;
  const record = createCommunityRecorder({ fetchImpl: async () => { requests++; return requests <= 10 ? pending.promise : acceptedResponse(); } });
  const categories = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5', 'F1', 'F2A', 'F2B', 'F3', 'F4'];
  const requestsPending = categories.map(category => record({ ...profile, category }));
  assert.equal(await record({ ...profile, country: 'China' }), false);
  pending.resolve({ ok: false });
  assert.deepEqual(await Promise.all(requestsPending), Array(10).fill(false));
  assert.equal(await record({ ...profile, country: 'China' }), true);
  assert.equal(requests, 11);
});

test('privacy signal errors fail closed without sending a request', async () => {
  let requests = 0;
  const record = createCommunityRecorder({ privacySignal() { throw new Error('Unavailable privacy preferences'); }, fetchImpl: async () => { requests++; return acceptedResponse(); } });
  assert.equal(await record(profile), false);
  assert.equal(requests, 0);
});
