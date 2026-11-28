import { StockfishEngine } from './stockfish.js';
import { pawnStructureName } from './pawn-structure.js';
import { loadMaia, maiaModelUrl, scoreMoves, predictPositionWdl } from './maia.js';
import { DSC_MODEL_URL, loadDsc, predictDsc } from './dsc.js';
import {
  fetchMastersDatabase,
  fetchPeerDatabase,
  validateLichessToken,
  fetchLichessAccount,
  fetchLichessRatings,
  FALLBACK_SPEED,
} from './lichess.js';
import { el, positionPopover, segmentedGroup } from '../ui.js';
import { setSplitEnabled } from '../sidebar-split.js';
import {
  applyUci,
  formatPercent,
  formatScore,
  scoreToCp,
  lossBand,
  lossForLine,
  sideToMoveOf,
  boardGrid,
  swapWdl,
  uciLineParts,
  uciToSan,
  wdlFromWhite,
  materialSummary,
} from './format.js';
import {
  LINE_COUNTS,
  PLAY_RATE_VIEWS,
  QUALITY_LEVELS,
  RESULT_VIEWS,
  RATINGS,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './settings.js';

const DOTS = 5;
// Plies shown in the continuation line, after the best move.
const CONTINUATION_PLIES = 6;

const MIB = 1024 * 1024;
// Finished evaluations kept in memory, so revisiting a position is instant.
const CACHE_SIZE = 10;
// Explorer rows shown before the remaining database moves are grouped into "Other moves".
const EXPLORER_MOVES = 6;

// Time-range choices of the Database view. `years` is how far back a preset reaches.
const EXPLORER_RANGE_PRESETS = [
  { value: 'all', label: 'All time' },
  { value: 'last50', label: 'Last 50 years', years: 50 },
  { value: 'last25', label: 'Last 25 years', years: 25 },
  { value: 'last10', label: 'Last 10 years', years: 10 },
  { value: 'last5', label: 'Last 5 years', years: 5 },
  { value: 'custom', label: 'Custom' },
];
// Earliest year the Lichess and Masters explorers hold games for.
const EXPLORER_FIRST_YEAR = 1952;
// A single-move exact search gets this many times the quality's node budget.
const EXACT_REFINE_FACTOR = 4;
// Outer size of the move preview in pixels, frame included.
const PREVIEW_SIZE = 200;
// Placement, side to move, castling and en passant fields of the starting position.
const INITIAL_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

// Progress bar for the Maia model download (see loadMaia in maia.js). Shown only
// during the download phase: a determinate fill when the total size is known,
// and an indeterminate sweep otherwise.
function maiaProgressElement(status) {
  const wrap = el('div', 'eval-progress');
  wrap.setAttribute('role', 'progressbar');
  wrap.setAttribute('aria-label', 'Loading Maia3 model');
  const label = el('p', 'eval-empty eval-progress-label');
  const track = el('div', 'eval-progress-track');
  track.append(el('div', 'eval-progress-fill'));
  wrap.append(label, track);
  updateMaiaProgress(wrap, status);
  return wrap;
}

// Column labels for the evaluation rows. The Move column has no label. Widths
// mirror the .eval-* classes used in buildLine, so the labels line up with the values.
function columnHeader() {
  const header = el('div', 'eval-columns');
  header.setAttribute('aria-hidden', 'true');
  const label = (text) => el('span', 'eval-col-label', text);
  header.append(
    el('span', 'eval-col eval-col-move'),
    el('span', 'eval-col eval-col-score'),
    el('span', 'eval-col eval-col-wdl'),
    el('span', 'eval-col eval-col-circles'),
  );
  const [, score, wdl, circles] = header.children;
  score.append(label('Score'));
  wdl.append(label('Peer results'));
  circles.append(label('Play rate'));
  return header;
}

// Determinate bar showing how much of the Stockfish node budget is searched.
function analysisProgressElement(fraction) {
  const wrap = el('div', 'eval-progress eval-progress-analysis');
  wrap.setAttribute('role', 'progressbar');
  wrap.setAttribute('aria-label', 'Analysis progress');
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  wrap.setAttribute('aria-valuenow', String(percent));
  const track = el('div', 'eval-progress-track');
  const fill = el('div', 'eval-progress-fill');
  fill.style.width = `${percent}%`;
  track.append(fill);
  wrap.append(track);
  return wrap;
}

function updateMaiaProgress(wrap, status) {
  const label = wrap.querySelector('.eval-progress-label');
  const fill = wrap.querySelector('.eval-progress-fill');
  const determinate = status.phase === 'download' && status.total > 0;
  wrap.classList.toggle('indeterminate', !determinate);
  if (determinate) {
    const fraction = Math.min(1, status.loaded / status.total);
    fill.style.width = `${(fraction * 100).toFixed(1)}%`;
    wrap.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    label.textContent = `Downloading evaluation modes… ${(status.loaded / MIB).toFixed(1)} of ${(status.total / MIB).toFixed(1)} MB`;
  } else {
    fill.style.width = '';
    wrap.removeAttribute('aria-valuenow');
    label.textContent = 'Downloading evaluation modes…';
  }
}

// Peer results from a database move's counts, in the mover's point of view
// (buildWdl converts it to White's). Null when the move has no games.
function databaseWdl(counts, mover) {
  if (!counts) return null;
  const total = counts.white + counts.draws + counts.black;
  if (!total) return null;
  const white = { win: counts.white / total, draw: counts.draws / total, loss: counts.black / total };
  return mover === 'w' ? white : swapWdl(white);
}

// Values for the two columns, one entry per line. The source is chosen per line:
// a line uses the database when the database has its move, otherwise Maia3's
// value for that line. Each entry carries its own source ('lichess', 'masters'
// or 'maia'), which decides the D/E badge. Null when no value exists at all.
function columnValues({ fen, lines, peer, masters, maia, dsc }) {
  const mover = sideToMoveOf(fen);
  const hasPeer = (uci) => gamesOf(peer?.moves.get(uci)) > 0;
  const hasMasters = (uci) => gamesOf(masters?.moves.get(uci)) > 0;

  const peerMoves = lines.map((line, index) => {
    const uci = line.pv[0];
    if (peer && hasPeer(uci)) {
      const counts = peer.moves.get(uci);
      return { source: 'lichess', wdl: databaseWdl(counts, mover), games: gamesOf(counts) };
    }
    const estimate = maia?.moves[index];
    return estimate?.wdl ? { source: 'maia', wdl: estimate.wdl } : null;
  });

  const mastersWdlMoves = lines.map((line, index) => {
    const uci = line.pv[0];
    if (masters && hasMasters(uci)) {
      const counts = masters.moves.get(uci);
      return { source: 'masters', wdl: databaseWdl(counts, mover), games: gamesOf(counts) };
    }
    const estimate = maia?.moves[index];
    return estimate?.wdl ? { source: 'maia', wdl: estimate.wdl } : null;
  });

  const engineMoves = lines.map((line) => {
    return line.wdl ? { source: 'engine', wdl: line.wdl } : null;
  });

  const peerShare = (uci) => gamesOf(peer.moves.get(uci)) / peer.total;
  const peerProbMoves = lines.map((line, index) => {
    const uci = line.pv[0];
    if (peer && hasPeer(uci)) {
      return { source: 'lichess', probability: peerShare(uci), games: gamesOf(peer.moves.get(uci)) };
    }
    const estimate = maia?.moves[index];
    return estimate?.peerProbability !== null && estimate?.peerProbability !== undefined
      ? { source: 'maia', probability: estimate.peerProbability }
      : null;
  });

  const mastersShare = (uci) => gamesOf(masters.moves.get(uci)) / masters.total;
  const mastersMoves = lines.map((line, index) => {
    const uci = line.pv[0];
    if (masters && hasMasters(uci)) {
      return { source: 'masters', probability: mastersShare(uci), games: gamesOf(masters.moves.get(uci)) };
    }
    const dscProbability = dsc?.moves instanceof Map ? dsc.moves.get(uci) : dsc?.moves?.[uci];
    if (dscProbability !== null && dscProbability !== undefined) {
      return { source: 'dsc', probability: dscProbability };
    }
    return null;
  });

  // Circles are scaled against the most probable move. Database shares and Maia
  // probabilities are both shares of the position, so the top is the larger of
  // the two lists (only lists that exist are considered).
  const peerProbTops = [
    peer ? Math.max(0, ...[...peer.moves.keys()].map(peerShare)) : null,
    maia?.peerTopProbability ?? null,
  ].filter((value) => value !== null);
  const peerProbTop = peerProbTops.length ? Math.max(...peerProbTops) : null;

  const mastersTops = [
    masters ? Math.max(0, ...[...masters.moves.keys()].map(mastersShare)) : null,
    maia?.topProbability ?? null,
    dsc?.topProbability ?? null,
  ].filter((value) => value !== null);
  const mastersTop = mastersTops.length ? Math.max(...mastersTops) : null;

  return {
    peer: { moves: peerMoves },
    mastersWdl: { moves: mastersWdlMoves },
    engine: { moves: engineMoves },
    peers: { moves: peerProbMoves, topProbability: peerProbTop },
    masters: { moves: mastersMoves, topProbability: mastersTop },
  };
}

// Total games behind one database move (0 when the move has no games).
function gamesOf(counts) {
  return counts ? counts.white + counts.draws + counts.black : 0;
}

// One combined entry for several database moves: summed counts and games, no uci.
function aggregateMoves(entries) {
  const counts = { white: 0, draws: 0, black: 0 };
  for (const entry of entries) {
    counts.white += entry.counts.white;
    counts.draws += entry.counts.draws;
    counts.black += entry.counts.black;
  }
  return { counts, games: entries.reduce((sum, entry) => sum + entry.games, 0) };
}

// Fixed-width slot to the right of a value, always present so values stay in
// place. "D" marks a value from the database, "E" one estimated by Maia3 (used
// when the database had too few games). Empty when no value exists.
// The tooltip is a custom one (see showTip).
function sourceSlot(source, databaseName, games = null, hasToken = true) {
  // No source indicators remain after removing Evaluation reference data and
  // database-backed evaluation; keep an empty fixed-width slot for alignment.
  return el('span', 'eval-source-slot');
}

// Indicator for the Score column: T when the score comes from the tablebase,
// E when it comes from the engine evaluation.
function scoreSourceSlot(source) {
  // No score-source indicators remain; keep an empty fixed-width slot.
  return el('span', 'eval-source-slot');
}

// Hover tooltip for a node, in the custom style (see showTip). Native title
// tooltips are not used because the browser draws them and ignores the theme.
function attachTip(node, lines) {
  node.addEventListener('mouseenter', () => showTip(node, lines));
  node.addEventListener('mouseleave', hideTip);
}

// One tooltip element shared by all indicators. It sits on <body> with fixed
// positioning, so the scrolling evaluation body cannot clip it, and it shows
// without the browser's delay.
let tipEl = null;

function showTip(anchor, lines) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'eval-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
  }
  tipEl.replaceChildren(...lines.map((text) => el('span', 'eval-tip-line', text)));
  tipEl.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = tipEl;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const top = Math.max(8, rect.top - height - 6);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}

function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// Placeholders use the same wrappers and widths as the final cells, so the
// skeleton sits exactly where the value will appear. The empty slot keeps the
// space that the D/E badge takes up.
function placeholderWdl() {
  const wrap = el('div', 'eval-wdl-wrap');
  wrap.append(el('span', 'eval-skeleton eval-skeleton-wdl'), el('span', 'eval-source-slot'));
  return wrap;
}

function placeholderCircles() {
  const wrap = el('div', 'eval-circles-wrap');
  wrap.append(el('span', 'eval-skeleton eval-skeleton-circles'), el('span', 'eval-source-slot'));
  return wrap;
}

function placeholderCirclesPair() {
  const wrap = el('div', 'eval-circles-pair');
  wrap.append(placeholderCircles(), placeholderCircles());
  return wrap;
}

// The evaluation panel lives in the right side panel's analysis section.
// Views:
//   off        panel disabled
//   searching  Stockfish is streaming lines (placeholders for Maia parts)
//   scoring    Stockfish done, Maia is scoring the moves
//   done       everything available
//   error      something failed
export class EvalPanel {
  constructor(doc = document) {
    this.doc = doc;
    this.preview = null;
    // Finished evaluations by FEN, for the current analysis settings.
    this.cache = new Map();
    this.summaryCache = new Map();
    this.openingCache = new Map();
    this.ancestors = null;
    this.hoverFen = null;
    // Called with a UCI line (from the current position) when a continuation move is clicked.
    this.onPickLine = null;
    this.toggle = doc.getElementById('eval-toggle');
    this.modeGroup = segmentedGroup(
      doc.getElementById('analysis-mode'),
      [
        { value: 'off', label: 'Off' },
        { value: 'evaluationSummary', label: 'Summary' },
        { value: 'engineLines', label: 'Engine Lines' },
        { value: 'explorer', label: 'Game Databases' },
      ],
      (value) => this.setMode(value),
    );
    this.explorerSourceGroup = null;
    this.settingsBtn = doc.getElementById('eval-settings-btn');
    this.settingsMenu = doc.getElementById('eval-settings');
    this.ratingBtn = doc.getElementById('eval-rating-btn');
    this.ratingLabel = doc.getElementById('eval-rating-label');
    this.ratingList = doc.getElementById('eval-rating-list');
    this.previewInput = doc.getElementById('eval-preview');
    this.explorerScoresInput = doc.getElementById('explorer-scores');
    this.tokenInput = doc.getElementById('eval-token');
    this.tokenCheck = doc.getElementById('eval-token-check');
    this.tokenClear = doc.getElementById('eval-token-clear');
    this.tokenStatus = doc.getElementById('eval-token-status');
    this.lichessName = doc.getElementById('lichess-account-name');
    this.lichessIcon = doc.getElementById('lichess-account-icon');
    this.lichessConnectedDisplay = doc.getElementById('lichess-connected-display');
    this.lichessModalName = doc.getElementById('lichess-modal-name');
    this.lichessUnlinkLink = doc.getElementById('lichess-unlink-link');
    this.lichessLinkForm = doc.getElementById('lichess-link-form');
    this.lichessLinkBtn = doc.getElementById('lichess-link-btn');
    this.lichessLinkForm = doc.getElementById('lichess-link-form');
    this.section = doc.getElementById('eval-section');
    this.body = doc.getElementById('eval-body');

    this.settings = loadSettings();
    this.enabled = false;
    this.mode = 'off';
    this.explorerSource = 'masters';
    this.explorerLichessSpeed = 'all';
    // Database view time range: { value: a preset value, from, to } (from/to only for custom).
    this.explorerRange = { value: 'all', from: null, to: null };
    this.explorerView = null;
    // Stockfish scores of explorer moves, by quality, line count and FEN.
    this.explorerScores = new Map();
    // Moves already searched alone, by engineScores map, so each is tried once per position.
    this.explorerRefineTried = new WeakMap();
    this.fen = null;
    // Errors the user has dismissed for the current evaluation session. Ephemeral:
    // cleared when a new session starts (evaluation toggled on or a new game loaded).
    this.hiddenErrors = new Set();
    this.engine = null;
    this.runId = 0;
    this.view = null;

    this.buildControls(doc);
    this.syncControls();
    if (this.settings.token) {
      if (!this.settings.lichessUsername) {
        fetchLichessAccount(this.settings.token)
          .then((username) => this.updateSettings({ lichessUsername: username }))
          .catch(() => {});
      }
      if (!this.settings.lichessRatings) {
        fetchLichessRatings(this.settings.token)
          .then((ratings) => this.updateSettings({ lichessRatings: ratings }))
          .catch(() => {});
      }
    }
    this.bind();
    this.render();
  }

  buildControls(doc) {
    this.linesGroup = segmentedGroup(
      doc.getElementById('eval-lines'),
      LINE_COUNTS.map((count) => ({ value: count, label: String(count) })),
      (value) => this.updateSettings({ lines: value }),
    );
    this.qualityGroup = segmentedGroup(
      doc.getElementById('eval-quality'),
      Object.entries(QUALITY_LEVELS).map(([key, level]) => ({ value: key, label: level.label })),
      (value) => this.updateSettings({ quality: value }),
    );

    this.playRateViewGroup = segmentedGroup(
      doc.getElementById('eval-prob-view'),
      PLAY_RATE_VIEWS.map((view) => ({ value: view.value, label: view.label })),
      (value) => this.updateSettings({ playRateView: value }),
    );
    this.resultsViewGroup = segmentedGroup(
      doc.getElementById('eval-results-view'),
      RESULT_VIEWS.map((view) => ({ value: view.value, label: view.label })),
      (value) => this.updateSettings({ resultsView: value }),
    );
    const ratingOptions = ['auto', ...RATINGS];
    this.ratingItems = ratingOptions.map((rating) => {
      const label = rating === 'auto' ? 'Auto' : String(rating);
      const item = el('li', 'eval-dd-item', label);
      item.setAttribute('role', 'option');
      item.dataset.value = String(rating);
      item.addEventListener('click', () => {
        this.closeRatingList();
        this.updateSettings({ rating });
      });
      this.ratingList.append(item);
      return item;
    });
  }

  // A click fires only when mousedown and mouseup hit the same element. Rows are
  // replaced on every engine update, so the release can land on a new node, and
  // the click then targets the container. The move is therefore remembered on
  // mousedown, and used when the click reaches the container.
  bindPick() {
    // Trigger on mousedown (not click): rows are rebuilt while the engine
    // streams, so a click can be lost when its target node is replaced
    // between mousedown and click.
    this.body.addEventListener('mousedown', (event) => {
      const ucis = event.target.closest?.('[data-pick]')?.dataset.pick;
      if (ucis) this.onPickLine?.(ucis.split(' '));
    });
  }

  bind() {
    this.bindPick();
    if (this.toggle) this.toggle.addEventListener('change', () => this.setEnabled(this.toggle.checked));
    this.previewInput.addEventListener('change', () => this.updateSettings({ preview: this.previewInput.checked }));
    this.explorerScoresInput?.addEventListener('change', () => this.updateSettings({ explorerScores: this.explorerScoresInput.checked }));
    // The token is applied only after Check validates it (see checkToken).
    this.tokenCheck?.addEventListener('click', (event) => { event.preventDefault(); this.checkToken(); });
    this.tokenClear?.addEventListener('click', (event) => { event.preventDefault(); this.clearToken(); });
    this.tokenInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.checkToken();
      }
    });
    this.tokenInput.addEventListener('input', () => {
      this.setTokenStatus(null);
      this.updateTokenButtons();
    });

    if (this.lichessUnlinkLink) {
      this.lichessUnlinkLink.addEventListener('click', (event) => { event.preventDefault(); this.clearToken(); });
    }

    if (this.lichessLinkBtn) {
      this.lichessLinkBtn.addEventListener('click', (event) => {
        event.preventDefault();
        if (this.lichessLinkForm && !this.lichessLinkForm.hidden) {
          this.toggleLichessForm(false);
        } else if (this.settings.lichessUsername) {
          this.clearToken();
        } else {
          this.toggleLichessForm(true);
        }
      });
    }
    if (this.settingsBtn) {
      this.settingsBtn.addEventListener('click', () => this.toggleSettingsMenu());
      window.addEventListener('resize', () => {
        if (this.settingsMenu && !this.settingsMenu.hidden) positionPopover(this.settingsMenu, this.settingsBtn);
      });
    }

    this.ratingBtn.addEventListener('click', () => {
      if (this.ratingList.hidden) this.openRatingList();
      else this.closeRatingList();
    });

    document.addEventListener('click', (event) => {
      if (
        this.settingsMenu &&
        !this.settingsMenu.hidden &&
        !this.settingsMenu.contains(event.target) &&
        (!this.settingsBtn || !this.settingsBtn.contains(event.target))
      ) {
        this.closeSettingsMenu();
      }
      if (!this.ratingList.hidden && !this.ratingBtn.parentElement.contains(event.target)) {
        this.closeRatingList();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.ratingList.hidden) {
        this.closeRatingList();
      }
    });
  }

  openRatingList() {
    this.ratingList.hidden = false;
    this.ratingBtn.setAttribute('aria-expanded', 'true');
    this.ratingItems.find((item) => item.dataset.value === String(this.settings.rating))?.scrollIntoView({ block: 'nearest' });
  }

  closeRatingList() {
    this.ratingList.hidden = true;
    this.ratingBtn.setAttribute('aria-expanded', 'false');
  }

  toggleSettingsMenu() {
    if (!this.settingsMenu) return;
    if (this.settingsMenu.hidden) {
      if (this.settingsBtn) positionPopover(this.settingsMenu, this.settingsBtn);
      this.settingsMenu.hidden = false;
      if (this.settingsBtn) this.settingsBtn.setAttribute('aria-expanded', 'true');
    } else {
      this.closeSettingsMenu();
    }
  }

  closeSettingsMenu() {
    if (!this.settingsMenu) return;
    this.settingsMenu.hidden = true;
    if (this.settingsBtn) this.settingsBtn.setAttribute('aria-expanded', 'false');
  }

  // Peer rating used for the Lichess peer database: the account's rating for the
  // current speed when "Auto" is selected and an account is linked, otherwise
  // the manual setting (or 1500 when Auto has no account rating to use).
  effectivePeerRating() {
    if (this.settings.rating !== 'auto') return this.settings.rating;
    const ratings = this.settings.lichessRatings;
    const accountRating = ratings && typeof ratings[FALLBACK_SPEED] === 'number' ? ratings[FALLBACK_SPEED] : null;
    return accountRating ?? 1500;
  }

  // Rating passed to Maia: the manual setting, or 1500 when Auto is selected.
  maiaRating() {
    return this.settings.rating === 'auto' ? 1500 : this.settings.rating;
  }

  // Called from the main board refresh.
  setFen(fen, ancestors = null) {
    if (fen === this.fen && ancestors === this.ancestors) return;
    this.fen = fen;
    this.ancestors = ancestors;
    if (this.mode === 'engineLines' && this.enabled) this.run();
    if (this.mode === 'evaluationSummary' && this.enabled) this.runEvaluationSummary();
    if (this.mode === 'explorer') this.runExplorer();
  }

  setExplorerLichessSpeed(value, { run = true } = {}) {
    const allowed = new Set(['all', 'ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence']);
    const next = allowed.has(value) ? value : 'all';
    if (next === this.explorerLichessSpeed) return;
    this.explorerLichessSpeed = next;
    if (run && this.mode === 'explorer' && this.explorerSource === 'lichess') this.runExplorer();
  }

  setExplorerRange({ value, from = null, to = null }) {
    const current = this.explorerRange;
    if (value === current.value && from === current.from && to === current.to) return;
    this.explorerRange = { value, from, to };
    if (this.mode === 'explorer') this.runExplorer();
  }

  // Year bounds { from, to } of the Database view's time range, or null for all games.
  explorerYears() {
    const range = this.explorerRange;
    if (range.value === 'custom') return { from: range.from, to: range.to };
    const preset = EXPLORER_RANGE_PRESETS.find((option) => option.value === range.value);
    if (!preset?.years) return null;
    return { from: new Date().getFullYear() - preset.years, to: null };
  }

  explorerRangeLabel() {
    const range = this.explorerRange;
    if (range.value === 'custom') return `${range.from}-${range.to}`;
    return EXPLORER_RANGE_PRESETS.find((option) => option.value === range.value)?.label ?? 'All time';
  }

  // Begins a new evaluation session: clears any errors the user dismissed earlier.
  startEvaluationSession() {
    this.hiddenErrors = new Set();
  }

  // Hides one error message for the rest of the current evaluation session.
  hideError(message) {
    this.hiddenErrors.add(message);
    this.render();
  }

  // Renders a single dismissible evaluation error line.
  errorLine(message) {
    const line = el('p', 'eval-empty eval-error');
    const text = el('span', 'eval-error-text', message);
    const hide = el('button', 'eval-error-hide', 'Hide');
    hide.type = 'button';
    hide.title = 'Hide this error for this evaluation session';
    hide.addEventListener('click', () => this.hideError(message));
    line.append(text, hide);
    return line;
  }

  setMode(value) {
    this.mode = value;
    this.enabled = value !== 'off';
    this.modeGroup?.setValue(this.mode);
    if (this.toggle) this.toggle.checked = this.enabled;
    if (value === 'off') {
      this.runId += 1;
      this.engine?.cancel();
      this.view = null;
      this.explorerView = null;
      this.render();
      return;
    }
    if (value === 'engineLines') {
      this.startEvaluationSession();
      this.run();
      return;
    }
    if (value === 'evaluationSummary') {
      this.startEvaluationSession();
      this.runEvaluationSummary();
      return;
    }
    // explorer
    this.runExplorer();
  }

  setEnabled(value) {
    this.setMode(value ? 'engineLines' : 'off');
  }

  toggleEnabled() {
    this.setMode(this.mode === 'off' ? 'engineLines' : 'off');
  }

  // The peer data depends on the game's speed, so the speed is part of the key.
  cacheKey(fen) {
    return `${this.settings.resultsView}|${fen}`;
  }

  // Keeps the most recent finished evaluations (CACHE_SIZE of them), oldest first.
  remember(key, lines, scored) {
    this.cache.delete(key);
    this.cache.set(key, { lines, scored });
    while (this.cache.size > CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  // Validates the typed token with Lichess and applies it only if it is accepted.
  // An empty field removes the token, which needs no check.
  async checkToken() {
    const token = this.tokenInput.value.trim();
    if (!token) {
      this.setTokenStatus(null);
      this.updateSettings({ token: '', lichessUsername: '', lichessRatings: null });
      return;
    }
    this.tokenCheck.disabled = true;
    this.tokenCheck.classList.add('is-loading');
    try {
      await validateLichessToken(token);
    } catch (error) {
      this.setTokenStatus('error', error.message);
      return;
    } finally {
      this.tokenCheck.classList.remove('is-loading');
      this.updateTokenButtons();
    }
    // Fetch the account behind the token so the connected username can be shown.
    let username = '';
    try {
      username = await fetchLichessAccount(token);
    } catch (error) {
      this.setTokenStatus('error', error.message);
      // Keep the token but without a resolved username.
      this.updateSettings({ token, lichessUsername: '' });
      this.syncControls();
      return;
    }
    let ratings = null;
    try {
      ratings = await fetchLichessRatings(token);
    } catch {
      ratings = null;
    }
    this.setTokenStatus('ok', `Connected as ${username}`);
    this.toggleLichessForm(false);
    this.updateSettings({ token, lichessUsername: username, lichessRatings: ratings });
  }

  // Removes the stored token without validating.
  clearToken() {
    this.tokenInput.value = '';
    this.setTokenStatus(null);
    this.toggleLichessForm(false);
    this.updateSettings({ token: '', lichessUsername: '', lichessRatings: null });
  }

  toggleLichessForm(force) {
    if (!this.lichessLinkForm) return;
    const open = force === undefined ? this.lichessLinkForm.hidden : force;
    this.lichessLinkForm.hidden = !open;
    if (this.lichessLinkBtn) {
      this.lichessLinkBtn.textContent = this.lichessLinkForm.hidden ? (this.settings.lichessUsername ? '[disconnect]' : '[connect]') : '[hide]';
    }
  }

  // kind: 'pending' | 'ok' | 'error' | null (no message).
  setTokenStatus(kind, message = '') {
    this.tokenStatus.textContent = message;
    this.tokenStatus.dataset.kind = kind ?? '';
  }

  // Apply is enabled only after the input differs from the stored token; Clear is
  // enabled only when a token is currently stored.
  updateTokenButtons() {
    const dirty = this.tokenInput.value.trim() !== this.settings.token;
    this.tokenCheck.disabled = !dirty;
    if (this.tokenClear) this.tokenClear.disabled = !this.settings.token;
  }

  updateSettings(patch) {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    saveSettings(this.settings);
    this.syncControls();
    // The preview setting only affects display. Any other setting changes the
    // analysis, so the remembered evaluations are no longer valid.
    if (Object.keys(patch).some((key) => key !== 'preview')) {
      this.cache.clear();
      this.summaryCache.clear();
    }
    if (!('preview' in patch)) {
      if (this.mode === 'engineLines') this.run();
      if (this.mode === 'evaluationSummary') this.runEvaluationSummary();
      if (this.mode === 'explorer') this.runExplorer();
    }
    if (!this.settings.preview) this.hidePreview();
  }

  syncControls() {
    this.modeGroup?.setValue(this.mode);
    if (this.explorerSourceGroup) this.explorerSourceGroup.setValue(this.explorerSource);
    this.linesGroup.setValue(this.settings.lines);
    this.qualityGroup.setValue(this.settings.quality);
    this.playRateViewGroup.setValue(this.settings.playRateView);
    this.resultsViewGroup.setValue(this.settings.resultsView);
    this.previewInput.checked = this.settings.preview;
    if (this.explorerScoresInput) this.explorerScoresInput.checked = this.settings.explorerScores;
    this.tokenInput.value = this.settings.token;
    this.tokenInput.placeholder = this.settings.token ? '' : 'Not set';
    this.updateTokenButtons();
    if (this.lichessName) {
      const name = this.settings.lichessUsername || (this.settings.token ? 'connected' : 'not connected');
      this.lichessName.textContent = name;
      this.lichessName.classList.toggle('is-connected', Boolean(this.settings.token));
    }
    if (this.lichessConnectedDisplay) {
      this.lichessConnectedDisplay.hidden = !this.settings.lichessUsername;
    }
    if (this.lichessModalName) {
      this.lichessModalName.textContent = this.settings.lichessUsername || '';
    }
    if (this.lichessLinkForm) {
      this.lichessLinkForm.hidden = Boolean(this.settings.lichessUsername);
    }
    if (this.tokenCheck) this.tokenCheck.hidden = Boolean(this.settings.lichessUsername);
    if (this.tokenClear) this.tokenClear.hidden = !this.settings.lichessUsername;
    if (this.tokenInput) this.tokenInput.disabled = Boolean(this.settings.lichessUsername);
    if (this.lichessIcon) {
      this.lichessIcon.querySelector('svg')?.classList.toggle('is-dim', !this.settings.lichessUsername);
    }
    if (this.lichessName) {
      this.lichessName.classList.toggle('is-dim', !this.settings.lichessUsername);
    }
    if (this.lichessLinkBtn && this.lichessLinkForm?.hidden) {
      this.lichessLinkBtn.textContent = this.settings.lichessUsername ? '[disconnect]' : '[connect]';
    }
    this.ratingLabel.textContent = this.settings.rating === 'auto' ? 'Auto' : String(this.settings.rating);
    this.ratingItems.forEach((item) => {
      const selected = item.dataset.value === String(this.settings.rating);
      item.setAttribute('aria-selected', String(selected));
      item.classList.toggle('selected', selected);
    });
  }

  async runExplorer() {
    const runId = ++this.runId;
    this.fen = this.fen || null;
    if (!this.fen) {
      this.explorerView = { state: 'done', fen: null, moves: [], total: 0, source: this.explorerSource, errors: [] };
      this.render();
      return;
    }
    const token = this.settings.token;
    if (!token) {
      this.explorerView = { state: 'error', fen: this.fen, message: 'A Lichess token is required for the opening explorer.', errors: ['A Lichess token is required for the opening explorer.'] };
      this.render();
      return;
    }
    this.explorerView = { state: 'loading', fen: this.fen, moves: [], total: 0, source: this.explorerSource, errors: [] };
    this.render();
    try {
      const years = this.explorerYears();
      const db = this.explorerSource === 'masters'
        ? await fetchMastersDatabase({ fen: this.fen, years, token })
        : await fetchPeerDatabase({ fen: this.fen, rating: this.effectivePeerRating(), speed: this.explorerLichessSpeed === 'all' ? 'ultraBullet,bullet,blitz,rapid,classical,correspondence' : this.explorerLichessSpeed, years, token });
      if (runId !== this.runId) return;
      const moves = [...(db.moves?.entries?.() ?? [])]
        .map(([uci, counts]) => ({ uci, counts, games: gamesOf(counts) }))
        .filter((entry) => entry.games > 0)
        .sort((a, b) => b.games - a.games);
      if (runId !== this.runId) return;
      const shown = moves.slice(0, EXPLORER_MOVES);
      const rest = moves.slice(EXPLORER_MOVES);
      const others = rest.length ? aggregateMoves(rest) : null;
      const ucis = shown.map((entry) => entry.uci);
      const scoreKey = `${this.settings.quality}|${ucis.join(' ')}|${this.fen}`;
      const cachedScores = this.explorerScores.get(scoreKey) ?? null;
      this.explorerView = { state: 'done', fen: this.fen, moves: shown, others, total: db.total, source: this.explorerSource, engineScores: cachedScores, errors: [] };
      if (!this.settings.explorerScores) this.engine?.cancel();
      else if (!cachedScores) this.scoreExplorer(runId, scoreKey, ucis);
    } catch (error) {
      if (runId !== this.runId) return;
      this.explorerView = { state: 'error', fen: this.fen, moves: [], total: 0, source: this.explorerSource, message: error.message, errors: [error.message] };
    }
    this.render();
    this.autoRefineExplorer();
  }

  triedFor(scores) {
    if (!this.explorerRefineTried.has(scores)) this.explorerRefineTried.set(scores, new Set());
    return this.explorerRefineTried.get(scores);
  }

  // Searches alone, one at a time, the first shown move that has no exact score.
  // Each move is tried once per position, so a search that finds no exact score
  // is not repeated.
  autoRefineExplorer() {
    const view = this.explorerView;
    if (!this.settings.explorerScores || !view || view.state !== 'done' || !view.engineScores || this.explorerRefining) return;
    const tried = this.triedFor(view.engineScores);
    const next = view.moves.find((entry) => !tried.has(entry.uci) && !view.engineScores.has(entry.uci));
    if (next) this.refineExplorerMove(next.uci);
  }

  // Scores the explorer's moves with Stockfish in the background. The engine
  // budget comes from the quality setting. Finished scores are cached per position.
  async scoreExplorer(runId, scoreKey, ucis) {
    const fen = this.fen;
    try {
      this.engine ??= new StockfishEngine();
      await this.engine.ready;
      const result = await this.engine.analyze({
        fen,
        multiPV: ucis.length,
        nodes: QUALITY_LEVELS[this.settings.quality].nodes * ucis.length,
        searchMoves: ucis,
      });
      if (runId !== this.runId || this.mode !== 'explorer' || !this.explorerView) return;
      if (result.error || result.cancelled) throw new Error(result.error?.message ?? 'cancelled');
      const scores = new Map();
      for (const line of result.lines) {
        // Only exact scores are kept; a bound is not shown and not searched further.
        if (line.pv[0] && !line.bound) scores.set(line.pv[0], { score: line.score });
      }
      this.explorerScores.delete(scoreKey);
      this.explorerScores.set(scoreKey, scores);
      while (this.explorerScores.size > CACHE_SIZE) {
        this.explorerScores.delete(this.explorerScores.keys().next().value);
      }
      this.explorerView = { ...this.explorerView, engineScores: scores };
      this.render();
      this.autoRefineExplorer();
    } catch {
      if (runId !== this.runId || !this.explorerView) return;
      this.explorerView = { ...this.explorerView, engineScores: new Map() };
      this.render();
    }
  }

  // Searches one move alone to get an exact score. The result is written into the
  // cached score map of the current position, so it stays after re-rendering.
  async refineExplorerMove(uci) {
    const view = this.explorerView;
    if (!view || view.state !== 'done' || !view.engineScores || this.explorerRefining) return;
    const runId = this.runId;
    const fen = this.fen;
    const scores = view.engineScores;
    this.explorerRefining = uci;
    this.triedFor(scores).add(uci);
    this.render();
    let exact = null;
    try {
      this.engine ??= new StockfishEngine();
      await this.engine.ready;
      const result = await this.engine.analyze({
        fen,
        multiPV: 1,
        nodes: QUALITY_LEVELS[this.settings.quality].nodes * EXACT_REFINE_FACTOR,
        searchMoves: [uci],
        onUpdate: (lines) => {
          for (const line of lines) {
            if (line.pv[0] === uci && !line.bound) exact = line.score;
          }
        },
      });
      const last = result.lines[0];
      if (last && last.pv[0] === uci && !last.bound) exact = last.score;
    } catch {
      exact = null;
    }
    this.explorerRefining = null;
    if (runId !== this.runId || fen !== this.fen) return;
    if (exact) scores.set(uci, { score: exact });
    this.render();
    this.autoRefineExplorer();
  }

  // Button and listbox dropdown shared by the Database view's tempo and time-range
  // controls. onPick(value) returns false to keep the current choice. onButtonClick()
  // returns true when it handled the click itself instead of opening the list.
  buildExplorerDropdown({ key, className, ariaLabel, options, selected, label, onPick, onButtonClick = null, onOutsideClick = null }) {
    const wrap = el('div', `${className} eval-dropdown`);
    const button = el('button', 'eval-dd-btn');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const buttonLabel = el('span', '', label);
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('fill', 'none');
    arrowPath.setAttribute('stroke', 'currentColor');
    arrowPath.setAttribute('stroke-width', '2');
    arrowPath.setAttribute('stroke-linecap', 'round');
    arrowPath.setAttribute('stroke-linejoin', 'round');
    arrowPath.setAttribute('d', 'M6 9l6 6 6-6');
    arrow.append(arrowPath);
    button.append(buttonLabel, arrow);

    const list = el('ul', 'eval-dd-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', ariaLabel);
    list.hidden = true;
    const closeList = () => {
      list.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };
    const items = options.map((option) => {
      const item = el('li', 'eval-dd-item', option.label);
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      if (option.value === selected) item.classList.add('selected');
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeList();
        if (onPick(option.value) === false) return;
        buttonLabel.textContent = option.label;
        items.forEach((entry) => entry.classList.toggle('selected', entry.dataset.value === option.value));
      });
      return item;
    });
    list.append(...items);

    button.addEventListener('click', (event) => {
      if (button.disabled) return;
      event.stopPropagation();
      if (onButtonClick?.()) {
        closeList();
        return;
      }
      const open = list.hidden;
      list.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    });

    // One outside-click listener per dropdown; the previous render's listener is removed.
    this._explorerDropdownHandlers ??= new Map();
    const previous = this._explorerDropdownHandlers.get(key);
    if (previous) document.removeEventListener('click', previous);
    const outside = (event) => {
      if (wrap.contains(event.target)) return;
      closeList();
      onOutsideClick?.();
    };
    this._explorerDropdownHandlers.set(key, outside);
    document.addEventListener('click', outside);

    wrap.append(button, list);
    return { wrap, button, buttonLabel };
  }

  renderExplorer() {
    this.body.replaceChildren();
    // source switch
    const srcContainer = el('div', 'eval-seg');
    this.explorerSourceGroup = segmentedGroup(
      srcContainer,
      [
        { value: 'masters', label: 'Masters' },
        { value: 'lichess', label: 'Lichess' },
      ],
      (value) => { this.explorerSource = value; this.runExplorer(); },
    );
    this.explorerSourceGroup.setValue(this.explorerSource);
    const srcWrap = el('div', 'eval-explorer-source');
    const mastersView = this.explorerSource === 'masters';
    const tempoOptions = [
      { value: 'all', label: 'Any tempo' },
      { value: 'ultraBullet', label: 'UltraBullet' },
      { value: 'bullet', label: 'Bullet' },
      { value: 'blitz', label: 'Blitz' },
      { value: 'rapid', label: 'Rapid' },
      { value: 'classical', label: 'Classical' },
      { value: 'correspondence', label: 'Correspondence' },
    ];
    const speedLabel = (value) => tempoOptions.find((option) => option.value === value)?.label ?? 'Any tempo';
    const tempo = this.buildExplorerDropdown({
      key: 'tempo',
      className: 'eval-explorer-tempo',
      ariaLabel: 'Lichess game tempo',
      options: tempoOptions,
      selected: this.explorerLichessSpeed,
      label: speedLabel(this.explorerLichessSpeed),
      onPick: (value) => this.setExplorerLichessSpeed(value),
    });
    tempo.wrap.classList.toggle('is-disabled', mastersView);
    tempo.button.disabled = mastersView;
    tempo.buttonLabel.textContent = mastersView ? '(Classical only)' : speedLabel(this.explorerLichessSpeed);

    // Time range: the Custom picker is a popover of two year selects inside the dropdown.
    const nowYear = new Date().getFullYear();
    const yearSelect = (label) => {
      const select = el('select', 'eval-range-select');
      select.setAttribute('aria-label', label);
      for (let year = EXPLORER_FIRST_YEAR; year <= nowYear; year++) {
        const option = el('option', '', String(year));
        option.value = String(year);
        select.append(option);
      }
      return select;
    };
    const fromSelect = yearSelect('From year');
    const toSelect = yearSelect('To year');
    const rangePop = el('div', 'eval-range-pop');
    rangePop.hidden = true;
    rangePop.setAttribute('role', 'dialog');
    rangePop.setAttribute('aria-label', 'Custom year range');
    const closeRangePicker = () => { rangePop.hidden = true; };
    const openRangePicker = () => {
      const current = this.explorerRange.value === 'custom'
        ? this.explorerRange
        : { from: nowYear - 10, to: nowYear };
      fromSelect.value = String(current.from);
      toSelect.value = String(current.to);
      rangePop.hidden = false;
    };
    fromSelect.addEventListener('change', () => {
      if (Number(fromSelect.value) > Number(toSelect.value)) toSelect.value = fromSelect.value;
    });
    toSelect.addEventListener('change', () => {
      if (Number(toSelect.value) < Number(fromSelect.value)) fromSelect.value = toSelect.value;
    });
    const applyBtn = el('button', 'eval-range-apply', 'Apply');
    applyBtn.type = 'button';
    applyBtn.addEventListener('click', () => {
      this.setExplorerRange({ value: 'custom', from: Number(fromSelect.value), to: Number(toSelect.value) });
    });
    const cancelBtn = el('button', 'eval-range-cancel', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', closeRangePicker);
    const rangeRow = el('div', 'eval-range-row');
    rangeRow.append(fromSelect, el('span', 'eval-range-sep', '–'), toSelect);
    const rangeActions = el('div', 'eval-range-actions');
    rangeActions.append(cancelBtn, applyBtn);
    rangePop.append(rangeRow, rangeActions);
    const range = this.buildExplorerDropdown({
      key: 'range',
      className: 'eval-explorer-range',
      ariaLabel: 'Games from years',
      options: EXPLORER_RANGE_PRESETS,
      selected: this.explorerRange.value,
      label: this.explorerRangeLabel(),
      onPick: (value) => {
        if (value === 'custom') {
          openRangePicker();
          return false;
        }
        this.setExplorerRange({ value });
      },
      // With Custom active, the label itself opens the year picker.
      onButtonClick: () => {
        if (this.explorerRange.value !== 'custom') return false;
        openRangePicker();
        return true;
      },
      onOutsideClick: closeRangePicker,
    });
    range.wrap.append(rangePop);

    srcWrap.append(srcContainer, tempo.wrap, range.wrap);
    this.body.append(srcWrap);

    const view = this.explorerView;
    if (!view || view.state === 'loading') {
      const showScores = this.settings.explorerScores;
      // Reserve the header and the full set of move slots up front, so the
      // layout does not shift when the database response arrives.
      const header = el('div', 'eval-columns');
      header.setAttribute('aria-hidden', 'true');
      const label = (text) => el('span', 'eval-col-label', text);
      const spans = [el('span', 'eval-col eval-col-move')];
      if (showScores) spans.push(el('span', 'eval-col eval-col-score'));
      spans.push(el('span', 'eval-col eval-col-wdl'), el('span', 'eval-col eval-col-circles'));
      header.append(...spans);
      if (showScores) header.querySelector('.eval-col-score').append(label('Score'));
      header.querySelector('.eval-col-wdl').append(label('Results'));
      header.querySelector('.eval-col-circles').append(label('Play rate'));
      this.body.append(header);

      for (let i = 0; i < EXPLORER_MOVES; i += 1) {
        const row = el('div', 'eval-line eval-line-pending');
        row.setAttribute('aria-hidden', 'true');
        const primary = el('div', 'eval-primary');
        primary.append(el('span', 'eval-skeleton eval-skeleton-move'));
        if (showScores) {
          const scoreWrap = el('span', 'eval-score-wrap');
          scoreWrap.append(el('span', 'eval-skeleton eval-skeleton-score'), el('span', 'eval-source-slot'));
          primary.append(scoreWrap);
        }
        primary.append(placeholderWdl());
        const circlesPair = el('div', 'eval-circles-pair');
        const circlesWrap = el('div', 'eval-circles-wrap');
        circlesWrap.append(el('span', 'eval-skeleton eval-skeleton-circles'), el('span', 'eval-source-slot'));
        circlesPair.append(circlesWrap, el('span', 'eval-games-count', '\u00A0'));
        primary.append(circlesPair);
        row.append(primary, this.buildContinuationPlaceholder());
        this.body.append(row);
      }
      return;
    }
    if (view.state === 'error') {
      this.body.append(el('p', 'eval-empty eval-error', view.message));
      return;
    }
    if (!view.moves.length) {
      this.body.append(el('p', 'eval-empty', 'Position not found'));
      return;
    }
    // header
    const header = el('div', 'eval-columns');
    header.setAttribute('aria-hidden', 'true');
    const label = (text) => el('span', 'eval-col-label', text);
    const showScores = this.settings.explorerScores;
    const spans = [el('span', 'eval-col eval-col-move')];
    if (showScores) spans.push(el('span', 'eval-col eval-col-score'));
    spans.push(el('span', 'eval-col eval-col-wdl'), el('span', 'eval-col eval-col-circles'));
    header.append(...spans);
    if (showScores) header.querySelector('.eval-col-score').append(label('Score'));
    header.querySelector('.eval-col-wdl').append(label('Results'));
    header.querySelector('.eval-col-circles').append(label('Play rate'));
    this.body.append(header);

    const total = view.total || view.moves.reduce((s, m) => s + m.games, 0);
    const topShare = Math.max(0, ...view.moves.map((m) => m.games / (total || 1)));
    const scores = view.engineScores ?? new Map();
    const bestScore = [...scores.values()].reduce((best, entry) => {
      return (!best || (scoreToCp(entry.score) ?? -Infinity) > (scoreToCp(best) ?? -Infinity)) ? entry.score : best;
    }, null);
    const rows = view.others ? [...view.moves, view.others] : view.moves;
    rows.forEach((entry) => {
      const row = el('div', 'eval-line');
      const sc = entry.uci ? scores.get(entry.uci) : null;
      if (sc && bestScore) {
        const band = lossBand(lossForLine(bestScore, sc.score));
        row.style.setProperty('--eval-tint', `var(--glyph-tint-${band.tint})`);
      }
      const uci = entry.uci;
      const san = uciToSan(this.fen, uci);
      const moveEl = el('span', 'eval-move');
      const text = el('span', 'eval-move-text', uci ? (san ?? '—') : 'other');
      moveEl.append(text);
      const afterFirst = uci ? applyUci(this.fen, uci) : null;
      if (afterFirst) {
        this.bindPreview(text, afterFirst);
        text.classList.add('eval-move-clickable');
        text.dataset.pick = uci;
      }
      // results (wdl) from db counts
      const mover = sideToMoveOf(this.fen);
      const white = { win: entry.counts.white / (entry.games || 1), draw: entry.counts.draws / (entry.games || 1), loss: entry.counts.black / (entry.games || 1) };
      const wdlWhite = white;
      // build wdl bar
      const wdlWrap = el('div', 'eval-wdl-wrap');
      const bar = el('div', 'eval-wdl');
      bar.setAttribute('role', 'img');
      const summary = `White ${formatPercent(wdlWhite.win)} · Draw ${formatPercent(wdlWhite.draw)} · Black ${formatPercent(wdlWhite.loss)}`;
      bar.setAttribute('aria-label', `White win ${formatPercent(wdlWhite.win)}, draw ${formatPercent(wdlWhite.draw)}, black win ${formatPercent(wdlWhite.loss)}`);
      attachTip(bar, summary.split(' · '));
      for (const [key, cls] of [['win','eval-wdl-w'],['draw','eval-wdl-d'],['loss','eval-wdl-b']]) {
        const seg = el('span', cls);
        seg.style.width = formatPercent(wdlWhite[key]);
        bar.append(seg);
      }
      wdlWrap.append(bar);
      // play rate circles
      const circlesWrap = el('div', 'eval-circles-pair');
      const lineWrap = el('div', 'eval-circles-wrap');
      const circlesEl = el('span', 'eval-circles');
      const prob = entry.games / (total || 1);
      const count = prob < 0.01 || !topShare ? 0 : Math.min(DOTS, Math.max(1, Math.round((prob / topShare) * DOTS)));
      const onClass = view.source === 'masters' ? 'eval-dot eval-dot-on eval-dot-master' : 'eval-dot eval-dot-on';
      const gamesLabel = view.source === 'masters' ? 'master games' : 'peer games';
      circlesEl.setAttribute('role', 'img');
      circlesEl.setAttribute('aria-label', `Probability ${count} of ${DOTS}`);
      attachTip(circlesEl, [prob < 0.01 ? `< 1% of ${gamesLabel}` : `${formatPercent(prob)} of ${gamesLabel}`]);
      for (let i = 0; i < DOTS; i += 1) circlesEl.append(el('span', i < count ? onClass : 'eval-dot'));
      lineWrap.append(circlesEl);
      circlesWrap.append(lineWrap);
      const games = entry.games;
      const gamesText =
        games > 999999
          ? `${Math.round(games / 1000000)}M games`
          : games > 999
            ? `${Math.round(games / 1000)}k games`
            : `${games} ${games === 1 ? 'game' : 'games'}`;
      const gamesLine = el('span', 'eval-games-count', gamesText);
      circlesWrap.append(gamesLine);

      const scoreWrap = el('span', 'eval-score-wrap');
      const scoreEntry = view.engineScores?.get(uci);
      const scoreVal = scoreEntry?.score;
      if (!uci) {
        // The "Other moves" row has no score.
      } else if (scoreVal) {
        scoreWrap.append(el('span', 'eval-score', formatScore(scoreVal, sideToMoveOf(this.fen))));
      } else if (view.engineScores === null || (this.explorerRefining === uci) || !this.explorerRefineTried.get(view.engineScores)?.has(uci)) {
        // Waiting for the score: the batch search or the automatic single-move search.
        scoreWrap.append(el('span', 'eval-skeleton eval-skeleton-score'), el('span', 'eval-source-slot'));
      } else {
        // The single-move search found no exact score.
        scoreWrap.append(el('span', 'eval-empty-inline', '—'));
      }
      const primary = el('div', 'eval-primary');
      primary.append(moveEl);
      if (showScores) primary.append(scoreWrap);
      primary.append(wdlWrap, circlesWrap);
      row.append(primary);
      row.append(this.buildContinuationPlaceholder());
      this.body.append(row);
    });
  }

  buildContinuationPlaceholder() {
    return el('div', 'eval-continuation');
  }

  async run() {
    const runId = ++this.runId;
    const fen = this.fen;
    if (!this.enabled || !fen) {
      this.render();
      return;
    }

    // A finished evaluation of this position under the current settings is reused.
    const key = this.cacheKey(fen);
    const cached = this.cache.get(key);
    if (cached) {
      // Stop any search still running for the previous position.
      this.engine?.cancel();
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.view = { state: 'done', fen, lines: cached.lines, scored: cached.scored, errors: [] };
      this.render();
      return;
    }

    this.engine ??= new StockfishEngine();
    const { lines: count, quality, token } = this.settings;
    const rating = this.maiaRating();
    const peerRating = this.effectivePeerRating();

    // Both engines are initialized before the search starts: Stockfish is started,
    // and the Maia3 model is downloaded and loaded (its progress is shown). Only then
    // does the search begin, so the first evaluation does not wait for Maia3 later.
    // Keep the previous lines around while the new search starts, so the panel
    // does not blank out between positions; they are replaced as soon as the
    // engine streams the first update.
    const previousLines = this.view?.lines?.length ? this.view.lines : [];
    this.view = { state: 'loading', fen, lines: previousLines, maia: null, errors: [] };
    this.render();

    if (runId !== this.runId) return;
    let result;
    try {
      await this.engine.ready;
    } catch (error) {
      if (runId !== this.runId) return;
      this.view = { state: 'error', fen, message: `Engine failed: ${error.message}`, errors: [`Engine failed: ${error.message}`] };
      this.render();
      return;
    }
    {
      const previousLines = this.view?.lines?.length ? this.view.lines : [];
      this.view = { state: 'searching', fen, lines: previousLines, progress: 0 };
      this.render();
      result = await this.engine.analyze({
        fen,
        multiPV: count,
        nodes: QUALITY_LEVELS[quality].nodes * count,
        onUpdate: (lines) => {
          if (runId !== this.runId) return;
          this.view = { ...this.view, state: 'searching', fen, lines };
          this.render();
        },
        onProgress: (progress) => {
          if (runId !== this.runId) return;
          this.view = { ...this.view, progress };
          this.render();
        },
      });
    }
    if (runId !== this.runId) return;
    if (result.error) {
      this.view = { state: 'error', fen, message: `Engine failed: ${result.error.message}`, errors: [`Engine failed: ${result.error.message}`] };
      this.render();
      return;
    }
    if (result.cancelled) return;

    if (!result.lines.length) {
      this.view = { state: 'done', fen, lines: [], scored: null, message: 'No legal moves.', errors: [] };
      this.render();
      return;
    }

    this.view = { state: 'scoring', fen, lines: result.lines, scored: null, maia: null, errors: [] };
    this.render();

    const fetched = { peer: null, masters: null, notes: [] };
    const { notes } = fetched;
    if (runId !== this.runId) return;

    for (const line of result.lines) {
      line.scoreSource = 'engine';
    }

    // Per line: a line takes its value from the database if the database has
    // its move, otherwise from Maia3. Maia3 runs only when some line needs it.
    const lineUcis = result.lines.map((line) => line.pv[0]);
    const peer = fetched.peer;
    const masters = fetched.masters;
    const resultsView = this.settings.resultsView;
    const playRateView = this.settings.playRateView;
    const needMasters = !masters || lineUcis.some((uci) => !uci || gamesOf(masters.moves.get(uci)) === 0);
    const needPeerDbMissing = !peer || lineUcis.some((uci) => !uci || gamesOf(peer.moves.get(uci)) === 0);
    let needPeerWdl = needPeerDbMissing;
    // Masters results fall back to Maia WDL when the masters DB is missing a move.
    if (resultsView === 'masters' && needMasters) needPeerWdl = true;
    const needPeerProb = (playRateView === 'peers' || playRateView === 'both') && needPeerDbMissing;
    const needMastersProb = false;
    const needDscProb = (playRateView === 'masters' || playRateView === 'both') && needMasters;

    let maia = null;
    let maiaError = null;
    let dsc = null;
    let dscError = null;
    const needMaia = needPeerWdl || needPeerProb;
    if (needMaia || needDscProb) {
      const contentLength = async (url) => {
        try {
          const response = await fetch(url, { method: 'HEAD' });
          return Number(response.headers.get('content-length') || 0);
        } catch {
          return 0;
        }
      };
      const maiaTotal = needMaia ? await contentLength(maiaModelUrl()) : 0;
      const dscTotal = needDscProb ? await contentLength(DSC_MODEL_URL) : 0;
      const combinedTotal = maiaTotal + dscTotal;
      let maiaLoaded = 0;
      let dscLoaded = 0;

      const isCached = async (url, cacheName) => {
        if (typeof caches === 'undefined') return false;
        try {
          const cache = await caches.open(cacheName);
          return Boolean(await cache.match(url));
        } catch {
          return false;
        }
      };
      const maiaCached = needMaia ? await isCached(maiaModelUrl(), 'maia3-js') : true;
      const dscCached = needDscProb ? await isCached(DSC_MODEL_URL, '64-quarks-models') : true;
      const showDownloadProgress = !(maiaCached && dscCached);

      if (showDownloadProgress) {
        this.view = { state: 'scoring', fen, lines: result.lines, scored: null, maia: { phase: 'download', loaded: 0, total: combinedTotal }, errors: [] };
        this.render();
      } else {
        this.view = { state: 'scoring', fen, lines: result.lines, scored: null, maia: null, errors: [] };
        this.render();
      }

      // Download both models concurrently, reporting their combined progress through
      // the single shared progress bar.
      const downloadTasks = [];
      if (needMaia) {
        downloadTasks.push((async () => {
          try {
            await loadMaia((status) => {
              if (!showDownloadProgress) return;
              if (status.phase === 'download') maiaLoaded = status.loaded;
              this.onMaiaStatus(runId, {
                phase: 'download',
                loaded: maiaLoaded + dscLoaded,
                total: combinedTotal || maiaLoaded + dscLoaded,
              });
            });
            if (showDownloadProgress) {
              maiaLoaded = maiaTotal;
              this.onMaiaStatus(runId, {
                phase: 'download',
                loaded: maiaLoaded + dscLoaded,
                total: combinedTotal || maiaLoaded + dscLoaded,
              });
            }
          } catch (error) {
            maiaError = error;
          }
        })());
      }
      if (needDscProb) {
        downloadTasks.push((async () => {
          try {
            await loadDsc((status) => {
              if (!showDownloadProgress) return;
              if (status.phase === 'download') dscLoaded = status.loaded;
              this.onMaiaStatus(runId, {
                phase: 'download',
                loaded: maiaLoaded + dscLoaded,
                total: combinedTotal || maiaLoaded + dscLoaded,
              });
            });
            if (showDownloadProgress) {
              dscLoaded = dscTotal;
              this.onMaiaStatus(runId, {
                phase: 'download',
                loaded: maiaLoaded + dscLoaded,
                total: combinedTotal || maiaLoaded + dscLoaded,
              });
            }
          } catch (error) {
            dscError = error;
          }
        })());
      }
      await Promise.all(downloadTasks);
      if (runId !== this.runId) return;

      // Hide the shared progress bar before scoring.
      this.view = { ...this.view, maia: null };
      this.render();

      if (needMaia && !maiaError) {
        try {
          maia = await this.scoreWithMaia({
            runId,
            fen,
            lines: result.lines,
            rating,
            wantPeerWdl: needPeerWdl,
            wantPeerProb: needPeerProb,
            wantMasters: false,
          });
        } catch (error) {
          maiaError = error;
        }
        if (runId !== this.runId) return;
      }
      if (needDscProb && !dscError) {
        try {
          dsc = await predictDsc({ fen, ratings: [2578], timeControl: 'classical', ratingSystem: 'fide', venue: 'otb' });
        } catch (error) {
          dscError = error;
        }
        if (runId !== this.runId) return;
      }
    }

    const messages = [...notes];
    if (dscError) messages.push(`DSC failed: ${dscError.message}`);
    if (maiaError) messages.push(`Maia3 failed: ${maiaError.message}`);
    const scored = columnValues({ fen, lines: result.lines, peer: fetched.peer, masters: fetched.masters, maia, dsc });
    this.view = { state: 'done', fen, lines: result.lines, scored, message: messages.join(' '), errors: [...messages] };
    // Results with a failed source are not cached, so the next visit retries them.
    if (!messages.length) this.remember(key, result.lines, scored);
    this.render();
  }

  async runEvaluationSummary() {
    const runId = ++this.runId;
    const fen = this.fen;
    if (!this.enabled || !fen) {
      this.view = {
        state: 'done',
        fen,
        score: null,
        peerResult: null,
        opening: null,
        pawnStructure: null,
        material: materialSummary(fen || ''),
        errors: [],
      };
      this.render();
      return;
    }

    const key = `summary|${this.settings.resultsView}|${fen}`;
    const cached = this.summaryCache.get(key);
    if (cached) {
      this.engine?.cancel();
      this.summaryCache.delete(key);
      this.summaryCache.set(key, cached);
      this.view = { ...cached, fen };
      this.render();
      return;
    }

    this.view = {
      state: 'loading',
      fen,
      score: null,
      peerResult: null,
      opening: null,
      pawnStructure: null,
      material: materialSummary(fen),
      progress: 0,
      errors: [],
    };
    this.render();

    this.engine ??= new StockfishEngine();
    const errors = [];
    let score = null;
    let engineWdl = null;

    try {
      await this.engine.ready;
    } catch (error) {
      if (runId !== this.runId) return;
      this.view = {
        state: 'error',
        fen,
        message: `Engine failed: ${error.message}`,
        errors: [`Engine failed: ${error.message}`],
      };
      this.render();
      return;
    }

    this.view = {
      ...this.view,
      state: 'searching',
      progress: 0,
    };
    this.render();

    try {
      const result = await this.engine.analyze({
        fen,
        multiPV: 1,
        nodes: QUALITY_LEVELS[this.settings.quality].nodes,
        onProgress: (progress) => {
          if (runId !== this.runId) return;
          this.view = { ...this.view, progress };
          this.render();
        },
      });
      if (runId !== this.runId) return;
      if (result.error) throw new Error(result.error.message);
      if (!result.cancelled && result.lines?.length) {
        score = result.lines[0].score;
        engineWdl = result.lines[0].wdl ?? null;
      }
    } catch (error) {
      if (runId !== this.runId) return;
      errors.push(`Engine failed: ${error.message}`);
    }

    let peerResult = null;
    let peerStats = null;
    if (this.settings.resultsView === 'engine') {
      if (engineWdl) peerResult = { source: 'engine', wdl: engineWdl };
    } else if (this.settings.resultsView === 'peers') {
      const token = this.settings.token;
      if (token) {
        try {
          const peerDb = await fetchPeerDatabase({
            fen,
            rating: this.effectivePeerRating(),
            speed: this.explorerLichessSpeed === 'all'
              ? 'ultraBullet,bullet,blitz,rapid,classical,correspondence'
              : this.explorerLichessSpeed,
            token,
          });
          if (runId !== this.runId) return;
          const total = peerDb.total || [...peerDb.moves.values()].reduce((sum, counts) => sum + counts.white + counts.draws + counts.black, 0);
          if (total > 0) {
            let games = 0;
            let ratingSum = 0;
            for (const counts of peerDb.moves.values()) {
              const gameCount = counts.white + counts.draws + counts.black;
              games += gameCount;
              if (typeof counts.averageRating === 'number') ratingSum += counts.averageRating * gameCount;
            }
            peerStats = {
              games: total,
              averageRating: games > 0 ? ratingSum / games : null,
            };
          }
        } catch (error) {
          if (runId !== this.runId) return;
          errors.push(error.message);
        }
      }
      try {
        await loadMaia();
        const wdl = await predictPositionWdl({ fen, rating: this.maiaRating() });
        if (wdl) peerResult = { source: 'maia', wdl };
      } catch (error) {
        if (runId !== this.runId) return;
        errors.push(`Maia3 failed: ${error.message}`);
      }
    }

    let opening = this.openingCache.get(fen);
    if (opening === undefined) {
      opening = await this.resolveOpeningName(fen, this.ancestors, runId);
      if (runId !== this.runId) return;
      this.openingCache.set(fen, opening);
    }

    const pawnStructure = await pawnStructureName(fen);
    if (runId !== this.runId) return;
    const view = {
      state: 'done',
      fen,
      score,
      peerResult,
      peerStats,
      opening,
      pawnStructure,
      progress: 1,
      material: materialSummary(fen),
      errors: [...errors],
    };
    this.view = view;
    if (!errors.length) {
      this.summaryCache.delete(key);
      this.summaryCache.set(key, view);
      while (this.summaryCache.size > CACHE_SIZE) {
        this.summaryCache.delete(this.summaryCache.keys().next().value);
      }
    }
    this.render();
  }

  async resolveOpeningName(fen, ancestors, runId) {
    const candidates = ancestors ? [...ancestors].reverse() : [fen];
    const limit = Math.min(candidates.length, 40);
    for (let i = 0; i < limit; i += 1) {
      if (runId !== this.runId) return null;
      const candidate = candidates[i];
      try {
        const db = await fetchMastersDatabase({ fen: candidate, token: this.settings.token || '' });
        if (runId !== this.runId) return null;
        if (db?.opening?.name) return db.opening;
      } catch {
        // Keep trying older positions; a failed lookup should not stop the search.
      }
    }
    return null;
  }

  async scoreWithMaia({ runId, fen, lines, rating, wantPeerWdl, wantPeerProb, wantMasters }) {
    await loadMaia((status) => this.onMaiaStatus(runId, status));
    const moves = lines.map((line) => {
      const uci = line.pv[0];
      return { uci, childFen: uci ? applyUci(fen, uci) : null };
    });
    return scoreMoves({ fen, moves, rating, ratings: [], wdl: wantPeerWdl, peerProbability: wantPeerProb, probabilities: wantMasters });
  }

  // Called by loadMaia while the model downloads or prepares. Updates the
  // progress bar in place; re-renders only if the bar isn't on screen yet.
  onMaiaStatus(runId, status) {
    if (runId !== this.runId || !['loading', 'scoring'].includes(this.view?.state)) return;
    this.view = { ...this.view, maia: status };
    if (status.phase !== 'download') {
      // Preparing: hide the bar. The render below leaves the slot out.
      if (this.maiaProgress?.isConnected) this.maiaProgress.remove();
      this.maiaProgress = null;
      return;
    }
    if (this.maiaProgress?.isConnected) {
      updateMaiaProgress(this.maiaProgress, status);
    } else {
      this.render();
    }
  }

  columnHeader() {
    const header = el('div', 'eval-columns');
    header.setAttribute('aria-hidden', 'true');
    const label = (text) => el('span', 'eval-col-label', text);
    const resultsView = this.settings.resultsView;
    const playRateView = this.settings.playRateView;
    const spans = [
      el('span', 'eval-col eval-col-move'),
      el('span', 'eval-col eval-col-score'),
    ];
    if (resultsView !== 'off') spans.push(el('span', 'eval-col eval-col-wdl'));
    if (playRateView !== 'off') spans.push(el('span', 'eval-col eval-col-circles'));
    header.append(...spans);
    const score = header.children[1];
    const scoreHeaderWrap = el('span', 'eval-score-wrap');
    scoreHeaderWrap.append(label('Score'));
    scoreHeaderWrap.append(el('span', 'eval-source-slot'));
    score.append(scoreHeaderWrap);
    if (resultsView !== 'off') {
      const wdl = header.querySelector('.eval-col-wdl');
      const labelText =
        resultsView === 'peers' ? 'Peer results' : resultsView === 'masters' ? 'Masters results' : 'Engine results';
      wdl.append(label(labelText));
    }
    if (playRateView !== 'off') {
      const circles = header.querySelector('.eval-col-circles');
      circles.append(label('Play rate'));
    }
    return header;
  }

  renderEvaluationSummary() {
    this.body.replaceChildren();
    hideTip();
    if (!this.view || !this.view.fen) {
      this.body.append(el('p', 'eval-empty', 'No position.'));
      return;
    }
    const view = this.view;
    if (view.state === 'error') {
      const message = view.message ?? view.errors?.[0];
      if (message && !this.hiddenErrors.has(message)) this.body.append(this.errorLine(message));
      return;
    }
    const loading = view.state === 'loading' || view.state === 'searching' || view.state === 'scoring';
    const card = el('div', 'eval-summary');
    card.append(this.progressSlot(view));

    const header = el('div', 'eval-columns');
    header.setAttribute('aria-hidden', 'true');
    const scoreCol = el('span', 'eval-col eval-col-score');
    const scoreWrap = el('span', 'eval-score-wrap');
    scoreWrap.append(el('span', 'eval-col-label', 'Score'));
    scoreWrap.append(el('span', 'eval-source-slot'));
    scoreCol.append(scoreWrap);
    header.append(el('span', 'eval-col eval-col-move'), scoreCol);
    if (this.settings.resultsView !== 'off') {
      const wdlCol = el('span', 'eval-col eval-col-wdl');
      wdlCol.append(el('span', 'eval-col-label', 'Peer result'));
      header.append(wdlCol);
    }
    card.append(header);

    const row = el('div', 'eval-line');
    const primary = el('div', 'eval-primary');
    primary.append(el('span', 'eval-move', 'Position'));
    const scoreWrapCell = el('span', 'eval-score-wrap');
    if (loading) {
      scoreWrapCell.append(el('span', 'eval-skeleton eval-skeleton-score'), el('span', 'eval-source-slot'));
    } else if (view.score) {
      scoreWrapCell.append(el('span', 'eval-score', formatScore(view.score, sideToMoveOf(view.fen))));
      scoreWrapCell.append(scoreSourceSlot('engine'));
    } else {
      scoreWrapCell.append(el('span', 'eval-empty-inline', '—'));
    }
    primary.append(scoreWrapCell);

    if (this.settings.resultsView !== 'off') {
      if (loading) {
        primary.append(placeholderWdl());
      } else if (view.peerResult?.wdl) {
        const entry = { wdl: view.peerResult.wdl, source: view.peerResult.source, games: view.peerResult.games ?? null };
        const column = { moves: [entry] };
        const dbName = view.peerResult.source === 'masters' ? 'Masters' : 'Lichess';
        primary.append(this.buildWdl(view.fen, column, entry, dbName));
      } else {
        const emptyWrap = el('div', 'eval-wdl-wrap');
        emptyWrap.append(el('div', 'eval-empty-inline', '—'));
        primary.append(emptyWrap);
      }
    }
    row.append(primary);
    card.append(row);

    // Keep placeholders only in the table (the score/peer-result row above);
    // the opening name and peer stats appear once the data is available.
    // The starting position shows no summary lines.
    const isInitial = view.fen.split(' ').slice(0, 4).join(' ') === INITIAL_POSITION;
    if (!loading && !isInitial && view.opening?.name) {
      card.append(el('p', 'eval-summary-line', `${view.opening.name}${view.opening.eco ? ` (${view.opening.eco})` : ''}`));
    }
    if (!loading && !isInitial && view.pawnStructure) {
      card.append(el('p', 'eval-summary-line', view.pawnStructure));
    }

    if (!loading && !isInitial && view.peerStats?.games) {
      const games = view.peerStats.games;
      const gamesText =
        games > 999999
          ? `${Math.round(games / 1000000)}M`
          : games > 999
            ? `${Math.round(games / 1000)}k`
            : `${games}`;
      const ratingText = view.peerStats.averageRating
        ? `, average rating ${Math.round(view.peerStats.averageRating)}`
        : '';
      card.append(el('p', 'eval-summary-line', `${gamesText} peer ${games === 1 ? 'game' : 'games'}${ratingText}`));
    }

    for (const message of view.errors ?? []) {
      if (message && !this.hiddenErrors.has(message)) card.append(this.errorLine(message));
    }
    this.body.append(card);
  }

  render() {
    // Rows are replaced here, so a tooltip on a removed node would never get its mouseleave.
    hideTip();
    this.maiaProgress = null;
    if (this.toggle) this.toggle.checked = this.enabled;
    // Collapse the section to its header while analysis is off.
    this.section.classList.toggle('collapsed', this.mode === 'off');
    setSplitEnabled(this.enabled);
    this.settingsBtn?.setAttribute('aria-pressed', String(this.settingsMenu ? !this.settingsMenu.hidden : false));
    this.body.replaceChildren();

    if (this.mode === 'off') {
      this.body.append(el('p', 'eval-empty', 'Analysis is off. Press E to show it.'));
      return;
    }

    if (this.mode === 'evaluationSummary') {
      this.renderEvaluationSummary();
      return;
    }

    if (this.mode === 'explorer') {
      this.renderExplorer();
      return;
    }

    if (!this.view || !this.view.fen) {
      this.renderPlaceholders();
      return;
    }

    const { view } = this;
    if (view.state === 'error') {
      const message = view.message;
      if (message && !this.hiddenErrors.has(message)) {
        this.body.append(this.errorLine(message));
      }
      return;
    }

    if (view.state === 'done' && view.lines.length === 0) {
      this.body.append(el('p', 'eval-empty', view.message));
      return;
    }

    if (view.state === 'done' && view.lines.length > 0) {
      for (const message of view.errors ?? []) {
        if (!message || this.hiddenErrors.has(message)) continue;
        this.body.append(this.errorLine(message));
      }
    }

    if ((view.state === 'loading' || view.state === 'scoring') && view.maia?.phase === 'download') {
      this.maiaProgress = maiaProgressElement(view.maia);
      this.body.append(this.maiaProgress);
    }

    this.body.append(this.progressSlot(view));

    const lines = view.lines;
    const scoredAll = view.state === 'done' ? view.scored : null;
    if (lines.length || view.state === 'loading' || view.state === 'scoring') {
      this.body.append(this.columnHeader());
    }
    // Keep the configured number of rows while searching/scoring, so the panel
    // height stays stable as lines arrive. Only when the search is finished and
    // the position actually has fewer legal moves than configured do we drop the
    // trailing placeholders.
    const rows =
      view.state === 'done' && lines.length > 0 && lines.length < this.settings.lines
        ? lines.length
        : this.settings.lines;
    for (let index = 0; index < rows; index += 1) {
      const line = lines[index];
      if (!line) {
        this.body.append(this.placeholderLine());
        continue;
      }
      this.body.append(
        this.buildLine(view.fen, lines, index, scoredAll, view.state === 'done'),
      );
    }

    this.restorePreview();
  }

  // Fixed-height slot for the analysis bar. It is kept in every state so the
  // rows below do not move when the bar appears or disappears.
  progressSlot(view) {
    const slot = el('div', 'eval-progress-slot');
    if (view?.state === 'searching') slot.append(analysisProgressElement(view.progress ?? 0));
    return slot;
  }

  renderPlaceholders() {
    this.body.append(this.progressSlot(null));
    this.body.append(this.columnHeader());
    for (let index = 0; index < this.settings.lines; index += 1) {
      this.body.append(this.placeholderLine());
    }
  }

  placeholderLine() {
    const row = el('div', 'eval-line eval-line-pending');
    row.setAttribute('aria-hidden', 'true');
    const primary = el('div', 'eval-primary');
    const items = [
      el('span', 'eval-skeleton eval-skeleton-move'),
      (() => {
        const wrap = el('span', 'eval-score-wrap');
        wrap.append(el('span', 'eval-skeleton eval-skeleton-score'), el('span', 'eval-source-slot'));
        return wrap;
      })(),
    ];
    if (this.settings.resultsView !== 'off') items.push(placeholderWdl());
    if (this.settings.playRateView !== 'off') items.push(this.placeholderCirclesPair());
    primary.append(...items);
    row.append(primary, el('div', 'eval-skeleton eval-skeleton-cont'));
    return row;
  }

  // scored holds the two column values (see columnValues), or null while searching.
  buildLine(fen, lines, index, scored, complete) {
    const line = lines[index];
    const row = el('div', 'eval-line');
    const best = lines[0];
    const band = lossBand(lossForLine(best.score, line.score));
    row.style.setProperty('--eval-tint', `var(--glyph-tint-${band.tint})`);

    const uci = line.pv[0];
    const san = uci ? uciToSan(fen, uci) : null;
    const primary = el('div', 'eval-primary');
    // The outer span keeps the column width; the inner span is the clickable text.
    const moveEl = el('span', 'eval-move');
    const text = el('span', 'eval-move-text', san ?? '—');
    moveEl.append(text);
    // The first move of the line is the best move. Hovering previews the position
    // after it, and clicking adds it to the move list.
    const afterFirst = uci ? applyUci(fen, uci) : null;
    if (afterFirst) {
      this.bindPreview(text, afterFirst);
      text.classList.add('eval-move-clickable');
      // Click handling is delegated to #eval-body (see bindPick): rows are rebuilt
      // while the engine streams, so a listener on this node could be lost.
      text.dataset.pick = uci;
    }
    primary.append(moveEl);
    const scoreWrap = el('span', 'eval-score-wrap');
    scoreWrap.append(el('span', 'eval-score', formatScore(line.score, sideToMoveOf(fen))));
    scoreWrap.append(scoreSourceSlot(line.scoreSource || 'engine'));
    primary.append(scoreWrap);

    const resultsView = this.settings.resultsView;
    const playRateView = this.settings.playRateView;
    if (resultsView !== 'off') {
      if (complete) {
        let column = scored.peer;
        let entry = scored.peer.moves[index];
        let dbName = 'Lichess';
        if (resultsView === 'peers') {
          column = scored.peer;
          entry = scored.peer.moves[index];
          dbName = 'Lichess';
        } else if (resultsView === 'masters') {
          column = scored.mastersWdl;
          entry = scored.mastersWdl.moves[index];
          dbName = 'Masters';
        } else if (resultsView === 'engine') {
          column = scored.engine;
          entry = scored.engine.moves[index];
          dbName = 'Engine';
        }
        primary.append(this.buildWdl(fen, column, entry, dbName));
      } else {
        primary.append(placeholderWdl());
      }
    }

    if (playRateView !== 'off') {
      primary.append(this.buildCirclesPair(
        scored?.peers, scored?.peers.moves[index],
        scored?.masters, scored?.masters.moves[index],
        complete,
      ));
    }
    row.append(primary);

    const parts = afterFirst ? uciLineParts(afterFirst, line.pv.slice(1), CONTINUATION_PLIES) : [];
    row.append(this.buildContinuation(line.pv, parts));
    return row;
  }

  // Each ply is a button. Clicking one plays the line up to it in the move list;
  // hovering or focusing it shows a preview of the position after that ply.
  buildContinuation(pv, parts) {
    const wrap = el('div', 'eval-continuation eval-continuation-eval');
    parts.forEach((part, index) => {
      if (index > 0) wrap.append(' ');
      const label = part.color === 'w' ? `${part.moveNumber}. ${part.san}` : part.san;
      const button = el('button', 'eval-cont-move', label);
      button.type = 'button';
      // pv[0] is the best move; continuation ply i is pv[i + 1].
      button.dataset.pick = pv.slice(0, index + 2).join(' ');
      this.bindPreview(button, part.fen, { focus: true });
      wrap.append(button);
    });
    return wrap;
  }

  // Shows the preview for `fen` while `node` is hovered (or focused, if requested).
  bindPreview(node, fen, { focus = false } = {}) {
    node.dataset.fen = fen;
    const show = () => {
      this.hoverFen = fen;
      this.showPreview(node, fen);
    };
    const hide = () => {
      this.hoverFen = null;
      this.hidePreview();
    };
    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', hide);
    if (focus) {
      node.addEventListener('focus', show);
      node.addEventListener('blur', hide);
    }
  }

  // Small non-interactive board next to the hovered move, in the current board theme.
  showPreview(anchor, fen) {
    if (!this.settings.preview) {
      this.hidePreview();
      return;
    }
    if (!this.preview) {
      // Same frame as the main board (.board-frame), without coordinates.
      this.preview = el('div', 'eval-preview');
      this.preview.setAttribute('aria-hidden', 'true');
      this.previewBoard = el('div', 'eval-preview-board');
      this.preview.append(this.previewBoard);
      this.doc.body.append(this.preview);
    }
    const board = this.doc.querySelector('cg-board');
    if (board) {
      const style = getComputedStyle(board);
      this.previewBoard.style.backgroundImage = style.backgroundImage;
      this.previewBoard.style.backgroundColor = style.backgroundColor;
    }
    this.previewBoard.replaceChildren(
      ...boardGrid(fen).flat().map((piece) => {
        const square = el('div', 'eval-preview-sq');
        if (piece) square.style.backgroundImage = `var(--piece-${piece})`;
        return square;
      }),
    );
    const rect = anchor.getBoundingClientRect();
    const size = PREVIEW_SIZE;
    const top = Math.min(Math.max(rect.top + rect.height / 2 - size / 2, 8), window.innerHeight - size - 8);
    const left = Math.max(8, rect.left - size - 12);
    this.preview.style.top = `${top}px`;
    this.preview.style.left = `${left}px`;
    this.preview.hidden = false;
  }

  hidePreview() {
    if (this.preview) this.preview.hidden = true;
  }

  // Rows are rebuilt while the engine streams. If the hovered move is still in the
  // list, move the preview to its new button; otherwise hide it.
  restorePreview() {
    if (!this.hoverFen) return;
    const button = [...this.body.querySelectorAll('[data-fen]')].find(
      (node) => node.dataset.fen === this.hoverFen,
    );
    if (button) this.showPreview(button, this.hoverFen);
    else this.hidePreview();
  }

  // Two probability lines stacked into one column: peers (top) and masters (bottom).
  buildCirclesPair(peerColumn, peerEntry, masterColumn, masterEntry, complete) {
    const wrap = el('div', 'eval-circles-pair');
    const view = this.settings.playRateView;
    if (view === 'peers' || view === 'both') {
      wrap.append(this.buildCircles(peerColumn, peerEntry, complete, 'Lichess'));
    }
    if (view === 'masters' || view === 'both') {
      wrap.append(this.buildCircles(masterColumn, masterEntry, complete, 'Masters'));
    }
    return wrap;
  }

  placeholderCirclesPair() {
    const wrap = el('div', 'eval-circles-pair');
    const view = this.settings.playRateView;
    if (view === 'peers' || view === 'both') wrap.append(placeholderCircles());
    if (view === 'masters' || view === 'both') wrap.append(placeholderCircles());
    return wrap;
  }

  // Circles are scaled against the most probable move in the position, so that
  // move always shows all DOTS filled.
  // column is the column value ({ source, topProbability }); entry is this line's value.
  buildCircles(column, entry, complete, databaseName = 'Masters') {
    if (!complete) return placeholderCircles();
    const hasToken = Boolean(this.settings.token);
    const wrap = el('div', 'eval-circles-wrap');
    const circles = el('span', 'eval-circles');
    wrap.append(circles, sourceSlot(entry?.source, databaseName, entry?.games, hasToken));
    // A zero probability means the move has no games in the database (for DB
    // entries) or Maia estimated it as never played. Null/undefined means
    // no value exists at all, which is shown as a dash instead of circles.
    if (!entry || entry.probability == null || column?.topProbability == null) {
      circles.append(el('span', 'eval-empty-inline', '—'));
      return wrap;
    }
    const count = entry.probability < 0.01 || !column.topProbability
      ? 0
      : Math.min(DOTS, Math.max(1, Math.round((entry.probability / column.topProbability) * DOTS)));
    const gamesLabel = databaseName === 'Masters' ? 'master games' : 'peer games';
    circles.setAttribute('role', 'img');
    circles.setAttribute('aria-label', `Probability ${count} of ${DOTS}`);
    attachTip(circles, [entry.probability < 0.01 ? `< 1% of ${gamesLabel}` : `${formatPercent(entry.probability)} of ${gamesLabel}`]);
    const onClass = databaseName === 'Masters' ? 'eval-dot eval-dot-on eval-dot-master' : 'eval-dot eval-dot-on';
    for (let i = 0; i < DOTS; i += 1) {
      circles.append(el('span', i < count ? onClass : 'eval-dot'));
    }
    return wrap;
  }

  // column is the results column value ({ source, moves }); entry is this line's value.
  buildWdl(fen, column, entry, databaseName = 'Lichess') {
    const wrap = el('div', 'eval-wdl-wrap');
    const hasToken = Boolean(this.settings.token);
    if (!entry || !entry.wdl) {
      wrap.append(el('div', 'eval-empty-inline', '—'), sourceSlot(entry?.source, databaseName, entry?.games, hasToken));
      return wrap;
    }
    const mover = sideToMoveOf(fen);
    const white = wdlFromWhite(entry.wdl, mover);
    const bar = el('div', 'eval-wdl');
    bar.setAttribute('role', 'img');
    const summary = `White ${formatPercent(white.win)} · Draw ${formatPercent(white.draw)} · Black ${formatPercent(white.loss)}`;
    bar.setAttribute('aria-label', `White win ${formatPercent(white.win)}, draw ${formatPercent(white.draw)}, black win ${formatPercent(white.loss)}`);
    attachTip(bar, summary.split(' · '));
    for (const [key, cls] of [
      ['win', 'eval-wdl-w'],
      ['draw', 'eval-wdl-d'],
      ['loss', 'eval-wdl-b'],
    ]) {
      const segment = el('span', cls);
      segment.style.width = formatPercent(white[key]);
      bar.append(segment);
    }
    wrap.append(bar, sourceSlot(entry?.source, databaseName, entry?.games, hasToken));
    return wrap;
  }
}

export const evalPanel = new EvalPanel();
