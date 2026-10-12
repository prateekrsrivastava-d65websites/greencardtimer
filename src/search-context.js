const questions = {
  '/': [
    ['How long is the green card wait?', 'There is no single green card waiting time. Visa-number availability depends on preference category, country of chargeability and priority date. Petition or application processing and individual eligibility are separate from the visa bulletin cutoff.'],
    ['Is a priority-date gap the same as time left to wait?', 'No. A gap measures the calendar distance between your priority date and a published cutoff. Cutoffs can advance, stop or move backward. Historical movement does not establish a future approval date.'],
  ],
  '/family-green-card/': [
    ['Which family preferences use the visa bulletin?', 'F1 covers unmarried sons and daughters age 21 or older of U.S. citizens; F2A covers spouses and unmarried children under 21 of permanent residents; F2B covers unmarried sons and daughters age 21 or older of permanent residents; F3 covers married sons and daughters of U.S. citizens; F4 covers siblings of U.S. citizens age 21 or older.'],
    ['Do immediate relatives have the same wait?', 'Immediate relatives of U.S. citizens are outside these preference-category numerical limits. A preference cutoff or a current date is not a prediction of an interview or approval.'],
  ],
  '/visa-bulletin/': [
    ['What is visa bulletin retrogression?', 'Retrogression is a cutoff moving backward. A priority date that met an earlier cutoff may no longer meet the new one. Current means no cutoff applies; Unavailable means no visas are authorized for that category in that bulletin.'],
    ['Does Dates for Filing mean I can file I-485?', 'Not by itself. USCIS selects the permitted adjustment-of-status chart each month, separately for employment and family preferences. Follow the official monthly selection and all other eligibility requirements.'],
  ],
  '/employers/': [
    ['What does H-1B sponsorship data establish?', 'A certified Labor Condition Application is a public employer filing, not a USCIS visa approval, an open job or a hiring commitment. One case can concern multiple workers. H-1B filings do not establish green-card sponsorship.'],
    ['Are reported H-1B wages total compensation?', 'No. These are disclosed base wage rates converted to annual amounts. Bonuses, equity and benefits are excluded. Different roles, locations and repeated filings can affect comparisons.'],
  ],
};

const links = {
  '/': [['/visa-bulletin/', 'Visa bulletin'], ['/family-green-card/', 'Family preference dates'], ['/processing-times/', 'PERM processing times']],
  '/family-green-card/': [['/visa-bulletin/', 'Visa bulletin'], ['/', 'Employment priority dates'], ['/methodology/', 'Sources and limitations']],
  '/visa-bulletin/': [['/', 'Employment priority dates'], ['/family-green-card/', 'Family preference dates'], ['/methodology/', 'Sources and limitations']],
  '/employers/': [['/salary-data/', 'H-1B salary records'], ['/processing-times/', 'PERM processing times'], ['/methodology/', 'Sources and limitations']],
  '/salary-data/': [['/employers/', 'H-1B employer filing profiles'], ['/processing-times/', 'PERM processing times'], ['/methodology/', 'Sources and limitations']],
};

export function searchContext(path) {
  if (!links[path]) return '';
  const content = questions[path] ? `<h2>${path === '/employers/' ? 'Understanding employer filings' : path === '/visa-bulletin/' ? 'Understanding visa bulletin dates' : 'Understanding green card waiting times'}</h2>${questions[path].map(([question, answer]) => `<details class="details"><summary>${question}</summary><p>${answer}</p></details>`).join('')}` : '';
  return `<section class="search-context reading" aria-label="${path === '/employers/' || path === '/salary-data/' ? 'Employer data context' : 'Visa date context'}">${content}<nav class="related-data" aria-label="Related data">${links[path].map(([url, label]) => `<a href="${url}">${label}</a>`).join('')}</nav></section>`;
}
