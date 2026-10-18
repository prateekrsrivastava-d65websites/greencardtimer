import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAnalyticsUrl, initializeAnalytics } from '../src/analytics.js';

test('Analytics sends page views only after consent and without profile query fields', () => {
  const original = {
    location: globalThis.location,
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
  };
  const scripts = [];
  globalThis.location = new URL('https://greencardtimer.com/?priorityDate=2026-01-01&country=India#results');
  globalThis.document = {
    referrer: 'https://greencardtimer.com/family-green-card/?category=F2A',
    title: 'Green Card Timer',
    createElement: () => ({}),
    head: { append: script => scripts.push(script) },
  };
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => 'accepted' };
  try {
    assert.equal(cleanAnalyticsUrl(location.href), 'https://greencardtimer.com/');
    assert.equal(cleanAnalyticsUrl('javascript:alert(1)'), '');
    initializeAnalytics();
    assert.equal(scripts.length, 1);
    assert.match(scripts[0].src, /^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-/);
    const calls = window.dataLayer.map(args => Array.from(args));
    assert.equal(calls.find(call => call[0] === 'config')[2].send_page_view, false);
    const pageView = calls.find(call => call[0] === 'event' && call[1] === 'page_view')[2];
    assert.equal(pageView.page_location, 'https://greencardtimer.com/');
    assert.equal(pageView.page_referrer, 'https://greencardtimer.com/family-green-card/');
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
