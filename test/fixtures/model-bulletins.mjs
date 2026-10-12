const countries = ['India', 'China', 'Mexico', 'Philippines', 'ROW'].map(id => ({ id, label: id }));
const categories = ['EB1', 'EB2', 'EB3', 'EB3OW', 'EB5'].map(id => ({ id, label: id }));

// Freeze the India EB-2 regression history; other cells are distinct synthetic parser inputs.
const finalActionCutoffs = [
  '2013-11-01', 'U', 'U', 'U', '2013-09-01', '2014-07-15', '2014-07-15',
  '2013-09-15', '2013-07-15', '2013-07-15', '2013-05-15', '2013-04-01',
  '2013-04-01', '2013-01-01', '2013-01-01', '2013-01-01', '2013-01-01',
  '2013-01-01', '2013-01-01', '2012-12-01', '2012-10-15', '2012-10-01',
  '2012-08-01', '2012-07-15', '2012-07-15',
];

export const bulletinData = {
  generatedAt: '2026-10-11',
  latestMonth: '2026-10',
  countries,
  categories,
  bulletins: finalActionCutoffs.map((cutoff, offset) => {
    const date = new Date(Date.UTC(2026, 9 - offset, 1));
    const year = date.getUTCFullYear();
    const month = date.toISOString().slice(0, 7);
    const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
    const charts = Object.fromEntries(['finalAction', 'filing'].map((chart, chartIndex) => [chart,
      Object.fromEntries(categories.map((category, categoryIndex) => [category.id,
        Object.fromEntries(countries.map((country, countryIndex) => [country.id,
          country.id === 'ROW' ? 'C' : country.id === 'Philippines' ? 'U'
            : new Date(Date.UTC(2020 + chartIndex, categoryIndex, countryIndex + 1)).toISOString().slice(0, 10),
        ])),
      ])),
    ]));
    charts.finalAction.EB2.India = cutoff;
    charts.filing.EB2.India = '2015-01-15';
    return {
      month,
      label: `${monthName} ${year}`,
      sourceUrl: `https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/${year + (date.getUTCMonth() >= 9 ? 1 : 0)}/visa-bulletin-for-${monthName.toLowerCase()}-${year}.html`,
      publishedAt: '2026-09-04',
      verifiedAt: '2026-10-11',
      uscisEmploymentChart: null,
      charts,
    };
  }),
};

export const modelData = {
  methodology: {
    kind: 'historical-cutoff-scenarios',
    parameters: {
      rollingWindowMonths: 6,
      minimumHistoryMonths: 12,
      minimumPositiveWindows: 3,
      maximumHorizonMonths: 120,
    },
  },
};
