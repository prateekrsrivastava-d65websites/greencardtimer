import { buildSearchContribution } from './community.js';

export function createCommunityRecorder({ fetchImpl = fetch } = {}) {
  return async function record(profile) {
    try {
      const contribution = buildSearchContribution(profile);
      if (!contribution) return null;
      const response = await fetchImpl('/api/community', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contribution),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) return null;
      const result = await response.json();
      return result?.accepted === true ? result : null;
    } catch {
      return null;
    }
  };
}
