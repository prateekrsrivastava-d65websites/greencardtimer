import { buildSearchContribution } from './community.js';

export function createCommunityRecorder({ fetchImpl = fetch, privacySignal = () => false } = {}) {
  const contributions = new Set();

  return async function record(profile) {
    let key;
    let reserved = false;
    let accepted = false;
    try {
      if (privacySignal()) return false;
      const contribution = buildSearchContribution(profile);
      if (!contribution) return false;
      key = JSON.stringify(contribution);
      if (contributions.has(key) || contributions.size >= 10) return false;
      // Reserve before fetching so overlapping searches cannot double count.
      contributions.add(key);
      reserved = true;
      const response = await fetchImpl('/api/community', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: key,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      accepted = Boolean(response.ok && (await response.json()).accepted === true);
      return accepted;
    } catch {
      return false;
    } finally {
      if (reserved && !accepted) contributions.delete(key);
    }
  };
}
