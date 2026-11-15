export const LINE_COUNTS = [1, 2, 3, 4, 5, 6];

// Keys are stored in saved settings, so they stay the same when labels change.
// nodes is the Stockfish node budget for one search.
export const QUALITY_LEVELS = {
  fast: { label: 'Low', nodes: 500_000 },
  standard: { label: 'Balanced', nodes: 2_000_000 },
  deep: { label: 'High', nodes: 10_000_000 },
};

// Maia3 strength levels: 600 to 2600 in steps of 100.
export const RATINGS = Array.from({ length: 21 }, (_, i) => 600 + i * 100);

// Which move-probability lines are shown in the squashed Peers/Masters column.
// 'off' hides the probability column entirely.
export const PROBABILITY_VIEWS = [
  { value: 'masters', label: 'Masters' },
  { value: 'peers', label: 'Peers' },
  { value: 'both', label: 'Both' },
  { value: 'off', label: 'Off' },
];

// Which external data source is used for evaluation. 'off' uses neither; 'both'
// enables both the Lichess game databases and the endgame tablebases.
export const EXTERNAL_DATA_MODES = ['off', 'databases', 'tablebases', 'both'];

// Which WDL is shown in the Results column.
export const RESULT_VIEWS = [
  { value: 'engine', label: 'Engine' },
  { value: 'masters', label: 'Masters' },
  { value: 'peers', label: 'Peer' },
  { value: 'off', label: 'Off' },
];

// token is an optional Lichess API token. Empty means anonymous access.
export const DEFAULT_SETTINGS = { lines: 3, quality: 'standard', rating: 1500, probView: 'masters', resultsView: 'peers', preview: false, token: '', externalData: 'off' };

const STORAGE_KEY = '64-quarks.eval';

export function loadSettings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    /* ignore corrupt storage */
  }
  return normalizeSettings(saved);
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
  } catch {
    /* ignore storage errors */
  }
}

// Falls back to defaults for any missing or out-of-range value.
export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const lines = Number(source.lines);
  const rating = Number(source.rating);
  const probView = source.probView;
  const resultsView = source.resultsView;
  const externalData = source.externalData;
  return {
    lines: LINE_COUNTS.includes(lines) ? lines : DEFAULT_SETTINGS.lines,
    quality: Object.hasOwn(QUALITY_LEVELS, source.quality) ? source.quality : DEFAULT_SETTINGS.quality,
    rating: RATINGS.includes(rating) ? rating : DEFAULT_SETTINGS.rating,
    probView: PROBABILITY_VIEWS.some((view) => view.value === probView) ? probView : DEFAULT_SETTINGS.probView,
    resultsView: RESULT_VIEWS.some((view) => view.value === resultsView) ? resultsView : DEFAULT_SETTINGS.resultsView,
    preview: source.preview === true,
    token: typeof source.token === 'string' ? source.token.trim() : DEFAULT_SETTINGS.token,
    externalData: EXTERNAL_DATA_MODES.includes(externalData) ? externalData : DEFAULT_SETTINGS.externalData,
  };
}
