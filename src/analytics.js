const MEASUREMENT_ID = 'G-GS0SM7TPXQ';
const CHOICE_KEY = 'gct.analytics-consent';
let active = false;

export function cleanAnalyticsUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : '';
  } catch { return ''; }
}

function readChoice() {
  try { return localStorage.getItem(CHOICE_KEY); } catch { return null; }
}

function saveChoice(choice) {
  try { localStorage.setItem(CHOICE_KEY, choice); } catch { /* The choice still applies to this page. */ }
}

export function trackPageView() {
  if (!active) return;
  window.gtag('event', 'page_view', {
    page_location: cleanAnalyticsUrl(location.href),
    page_referrer: cleanAnalyticsUrl(document.referrer),
    page_title: document.title,
  });
}

function startAnalytics() {
  if (active) return;
  active = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied',
    ad_user_data: 'denied', ad_personalization: 'denied',
  });
  window.gtag('consent', 'update', { analytics_storage: 'granted' });
  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.append(script);
  trackPageView();
}

function stopAnalytics() {
  if (!active) return;
  active = false;
  window.gtag('consent', 'update', { analytics_storage: 'denied' });
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (/^_ga(?:_|$)/.test(name)) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

export function showAnalyticsChoices() {
  document.querySelector('#analytics-choice')?.remove();
  const banner = document.createElement('aside');
  banner.id = 'analytics-choice';
  banner.setAttribute('aria-label', 'Analytics choice');
  banner.innerHTML = '<p><strong>Help us improve Green Card Timer?</strong> Allow Google Analytics to count page visits. It is optional; the site works either way. <a href="/privacy/">Data practices</a>.</p><div><button type="button" data-analytics-choice="declined">No thanks</button><button type="button" data-analytics-choice="accepted">Allow analytics</button></div>';
  banner.addEventListener('click', event => {
    const choice = event.target.closest('[data-analytics-choice]')?.dataset.analyticsChoice;
    if (!choice) return;
    saveChoice(choice);
    banner.remove();
    if (choice === 'accepted') startAnalytics(); else stopAnalytics();
  });
  document.body.append(banner);
}

export function initializeAnalytics() {
  if (readChoice() === 'accepted') startAnalytics();
  else if (readChoice() !== 'declined') showAnalyticsChoices();
}
