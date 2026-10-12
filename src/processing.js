import { monthIndex, parseDate } from './model.js';

export function formatProcessingMonth(value) {
  if (monthIndex(value) === null) return 'Not published';
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDate(`${value}-01`));
}

export function compareProcessingMonth(filingMonth, queueMonth) {
  const filing = monthIndex(filingMonth);
  const queue = monthIndex(queueMonth);
  if (filing === null || queue === null) return { position: 'unknown', monthDifference: null };
  const monthDifference = filing - queue;
  return { position: monthDifference < 0 ? 'before' : monthDifference > 0 ? 'after' : 'same', monthDifference };
}

export function processingFreshness(data, today) {
  const now = parseDate(today);
  const current = data?.current ?? data;
  const age = value => now && parseDate(value) ? Math.floor((now - parseDate(value)) / 86_400_000) : null;
  const permDays = age(current?.perm?.asOf);
  const pwdDays = age(current?.pwd?.asOf);
  return { permDays, pwdDays, stale: permDays === null || pwdDays === null || permDays < 0 || pwdDays < 0 || permDays > 62 || pwdDays > 62 };
}

export function validateProcessingSnapshot(snapshot) {
  const requireMonth = (value, label, asOf, nullable = true) => {
    if (nullable && value === null) return;
    if (monthIndex(value) === null || value > asOf.slice(0, 7)) throw new Error(`Missing, invalid or future ${label}.`);
  };
  for (const section of ['perm', 'pwd']) {
    if (!parseDate(snapshot?.[section]?.asOf)) throw new Error(`Missing or invalid ${section} source date.`);
  }
  for (const queue of ['analystReview', 'auditReview', 'reconsideration']) requireMonth(snapshot.perm.queues?.[queue], `PERM ${queue}`, snapshot.perm.asOf, queue !== 'analystReview');
  for (const queue of ['analystReview', 'auditReview']) {
    const average = snapshot.perm.averages?.[queue];
    requireMonth(average?.month, `PERM ${queue} average month`, snapshot.perm.asOf, false);
    if (average?.days !== null && (!Number.isSafeInteger(average?.days) || average.days < 0)) throw new Error(`Missing or invalid PERM ${queue} average days.`);
  }
  for (const program of ['perm', 'h1b']) {
    for (const wageType of ['oews', 'nonOews']) requireMonth(snapshot.pwd.queues?.[program]?.[wageType], `PWD ${program}/${wageType}`, snapshot.pwd.asOf);
    requireMonth(snapshot.pwd.redeterminations?.[program], `PWD ${program} redetermination`, snapshot.pwd.asOf);
    requireMonth(snapshot.pwd.directorReviews?.[program], `PWD ${program} director review`, snapshot.pwd.asOf);
    const requests = snapshot.pwd.remainingRequests?.[program];
    if (!Array.isArray(requests) || !requests.length || requests.length > 120) throw new Error(`Missing or invalid PWD ${program} remaining requests.`);
    let previous = null;
    for (const request of requests) {
      requireMonth(request.month, `PWD ${program} receipt month`, snapshot.pwd.asOf, false);
      if (!Number.isSafeInteger(request.count) || request.count < 0 || (previous && request.month <= previous)) throw new Error(`Invalid or duplicate PWD ${program} remaining requests.`);
      previous = request.month;
    }
  }
  if (snapshot.pwd.queues.perm.oews === null && snapshot.pwd.queues.perm.nonOews === null) throw new Error('No PERM prevailing-wage queue was published.');
  return snapshot;
}
