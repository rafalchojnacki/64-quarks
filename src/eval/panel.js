import { StockfishEngine } from './stockfish.js';
import { loadMaia, scoreMoves } from './maia.js';
import {
  MIN_DB_GAMES,
  fetchMastersDatabase,
  fetchPeerDatabase,
  gameSpeed,
  validateLichessToken,
} from './lichess.js';
import { el, positionPopover, segmentedGroup } from '../ui.js';
import { setSplitEnabled } from '../sidebar-split.js';
import {
  applyUci,
  formatPercent,
  formatScore,
  lossBand,
  lossForLine,
  sideToMoveOf,
  boardGrid,
  swapWdl,
  uciLineParts,
  uciToSan,
  wdlFromWhite,
} from './format.js';
import {
  LINE_COUNTS,
  MASTER_RANGES,
  QUALITY_LEVELS,
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
// Outer size of the move preview in pixels, frame included.
const PREVIEW_SIZE = 200;

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
  circles.append(label('Masters'));
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
function columnValues({ fen, lines, peer, masters, maia }) {
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

  const mastersShare = (uci) => gamesOf(masters.moves.get(uci)) / masters.total;
  const mastersMoves = lines.map((line, index) => {
    const uci = line.pv[0];
    if (masters && hasMasters(uci)) {
      return { source: 'masters', probability: mastersShare(uci), games: gamesOf(masters.moves.get(uci)) };
    }
    const estimate = maia?.moves[index];
    return estimate?.probability !== null && estimate?.probability !== undefined
      ? { source: 'maia', probability: estimate.probability }
      : null;
  });

  // Circles are scaled against the most probable move. Database shares and Maia
  // probabilities are both shares of the position, so the top is the larger of
  // the two lists (only lists that exist are considered).
  const tops = [
    masters ? Math.max(0, ...[...masters.moves.keys()].map(mastersShare)) : null,
    maia?.topProbability ?? null,
  ].filter((value) => value !== null);
  const mastersTop = tops.length ? Math.max(...tops) : null;

  return {
    peer: { moves: peerMoves },
    masters: { moves: mastersMoves, topProbability: mastersTop },
  };
}

// Total games behind one database move (0 when the move has no games).
function gamesOf(counts) {
  return counts ? counts.white + counts.draws + counts.black : 0;
}

// Fixed-width slot to the right of a value, always present so values stay in
// place. "D" marks a value from the database, "E" one estimated by Maia3 (used
// when the database had too few games). Empty when no value exists.
// The tooltip is a custom one (see showTip).
function sourceSlot(source, databaseName, games = null, hasToken = true) {
  const slot = el('span', 'eval-source-slot');
  let lines;
  if (source === 'maia') {
    slot.textContent = 'E';
    slot.classList.add('eval-source-maia');
    // Without a token the database is never queried, so say that instead.
    lines = [hasToken ? 'Estimated (not enough games in the database)' : 'Estimated (Lichess token is not set in Settings)'];
  } else if (source === 'lichess' || source === 'masters') {
    slot.textContent = 'D';
    slot.classList.add('eval-source-db');
    lines = [`${games.toLocaleString('en-US')} games`];
  } else {
    return slot;
  }
  slot.setAttribute('role', 'img');
  slot.setAttribute('aria-label', lines.join('. '));
  attachTip(slot, lines);
  return slot;
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
    this.hoverFen = null;
    // Called with a UCI line (from the current position) when a continuation move is clicked.
    this.onPickLine = null;
    this.toggle = doc.getElementById('eval-toggle');
    this.settingsBtn = doc.getElementById('eval-settings-btn');
    this.settingsMenu = doc.getElementById('eval-settings');
    this.ratingBtn = doc.getElementById('eval-rating-btn');
    this.ratingLabel = doc.getElementById('eval-rating-label');
    this.ratingList = doc.getElementById('eval-rating-list');
    this.previewInput = doc.getElementById('eval-preview');
    this.tokenInput = doc.getElementById('eval-token');
    this.tokenCheck = doc.getElementById('eval-token-check');
    this.tokenStatus = doc.getElementById('eval-token-status');
    this.section = doc.getElementById('eval-section');
    this.body = doc.getElementById('eval-body');

    this.settings = loadSettings();
    this.enabled = false;
    this.fen = null;
    // Lichess speed of the open game (see setFen).
    this.speed = gameSpeed(null);
    this.engine = null;
    this.runId = 0;
    this.view = null;

    this.buildControls(doc);
    this.syncControls();
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
    this.masterGroup = segmentedGroup(
      doc.getElementById('eval-master'),
      MASTER_RANGES.map((range) => ({ value: range.value, label: range.label })),
      (value) => this.updateSettings({ master: value }),
    );
    this.ratingItems = RATINGS.map((rating) => {
      const item = el('li', 'eval-dd-item', String(rating));
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
    let pressed = null;
    this.body.addEventListener('mousedown', (event) => {
      pressed = event.target.closest?.('[data-pick]')?.dataset.pick ?? null;
    });
    this.body.addEventListener('click', (event) => {
      const node = event.target.closest?.('[data-pick]');
      const ucis = node ? node.dataset.pick : pressed;
      pressed = null;
      if (ucis) this.onPickLine?.(ucis.split(' '));
    });
  }

  bind() {
    this.bindPick();
    this.toggle.addEventListener('change', () => this.setEnabled(this.toggle.checked));
    this.previewInput.addEventListener('change', () => this.updateSettings({ preview: this.previewInput.checked }));
    // The token is applied only after Check validates it (see checkToken).
    this.tokenCheck.addEventListener('click', () => this.checkToken());
    this.tokenInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.checkToken();
      }
    });
    this.tokenInput.addEventListener('input', () => this.setTokenStatus(null));

    this.settingsBtn.addEventListener('click', () => this.toggleSettingsMenu());
    window.addEventListener('resize', () => {
      if (!this.settingsMenu.hidden) positionPopover(this.settingsMenu, this.settingsBtn);
    });

    this.ratingBtn.addEventListener('click', () => {
      if (this.ratingList.hidden) this.openRatingList();
      else this.closeRatingList();
    });

    document.addEventListener('click', (event) => {
      if (
        !this.settingsMenu.hidden &&
        !this.settingsMenu.contains(event.target) &&
        !this.settingsBtn.contains(event.target)
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
    if (this.settingsMenu.hidden) {
      positionPopover(this.settingsMenu, this.settingsBtn);
      this.settingsMenu.hidden = false;
      this.settingsBtn.setAttribute('aria-expanded', 'true');
    } else {
      this.closeSettingsMenu();
    }
  }

  closeSettingsMenu() {
    this.settingsMenu.hidden = true;
    this.settingsBtn.setAttribute('aria-expanded', 'false');
  }

  // Called from the main board refresh; a no-op when neither the position nor the
  // game's time control changed. timeControl is the PGN TimeControl value of the
  // open game (or null if unknown); it selects the Lichess speed for the peer data.
  setFen(fen, timeControl = null) {
    const speed = gameSpeed(timeControl);
    if (fen === this.fen && speed === this.speed) return;
    this.fen = fen;
    this.speed = speed;
    if (this.enabled) this.run();
  }

  toggleEnabled() {
    this.setEnabled(!this.enabled);
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    this.toggle.checked = this.enabled;
    if (this.enabled) {
      this.run();
    } else {
      this.runId += 1;
      this.engine?.cancel();
      this.view = null;
      this.render();
    }
  }

  // The peer data depends on the game's speed, so the speed is part of the key.
  cacheKey(fen) {
    return `${this.speed}|${fen}`;
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
      this.updateSettings({ token: '' });
      return;
    }
    this.tokenCheck.disabled = true;
    this.setTokenStatus('pending', 'Checking…');
    try {
      await validateLichessToken(token);
    } catch (error) {
      this.setTokenStatus('error', error.message);
      return;
    } finally {
      this.tokenCheck.disabled = false;
    }
    this.setTokenStatus('ok', 'Token accepted');
    this.updateSettings({ token });
  }

  // kind: 'pending' | 'ok' | 'error' | null (no message).
  setTokenStatus(kind, message = '') {
    this.tokenStatus.textContent = message;
    this.tokenStatus.dataset.kind = kind ?? '';
  }

  updateSettings(patch) {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    saveSettings(this.settings);
    this.syncControls();
    // The preview setting only affects display. Any other setting changes the
    // analysis, so the remembered evaluations are no longer valid.
    if (Object.keys(patch).some((key) => key !== 'preview')) this.cache.clear();
    if (this.enabled && !('preview' in patch)) this.run();
    if (!this.settings.preview) this.hidePreview();
  }

  syncControls() {
    this.linesGroup.setValue(this.settings.lines);
    this.qualityGroup.setValue(this.settings.quality);
    this.masterGroup.setValue(String(this.settings.master));
    this.previewInput.checked = this.settings.preview;
    this.tokenInput.value = this.settings.token;
    this.tokenInput.placeholder = this.settings.token ? '' : 'Not set';
    this.ratingLabel.textContent = String(this.settings.rating);
    this.ratingItems.forEach((item) => {
      const selected = item.dataset.value === String(this.settings.rating);
      item.setAttribute('aria-selected', String(selected));
      item.classList.toggle('selected', selected);
    });
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
      this.view = { state: 'done', fen, lines: cached.lines, scored: cached.scored };
      this.render();
      return;
    }

    this.engine ??= new StockfishEngine();
    const { lines: count, quality, rating, master, token } = this.settings;

    // Both engines are initialized before the search starts: Stockfish is started,
    // and the Maia3 model is downloaded and loaded (its progress is shown). Only then
    // does the search begin, so the first evaluation does not wait for Maia3 later.
    this.view = { state: 'loading', fen, lines: [], maia: null };
    this.render();
    const maiaLoad = loadMaia((status) => this.onMaiaStatus(runId, status)).then(
      () => null,
      (error) => error,
    );
    try {
      await this.engine.ready;
    } catch (error) {
      if (runId !== this.runId) return;
      this.view = { state: 'error', fen, message: `Engine failed: ${error.message}` };
      this.render();
      return;
    }
    // A Maia3 load failure does not stop the search; the Maia3 values are then missing.
    const maiaLoadError = await maiaLoad;
    if (runId !== this.runId) return;

    this.view = { state: 'searching', fen, lines: [], progress: 0 };
    this.render();

    const result = await this.engine.analyze({
      fen,
      multiPV: count,
      nodes: QUALITY_LEVELS[quality].nodes,
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
    if (runId !== this.runId) return;
    if (result.error) {
      this.view = { state: 'error', fen, message: `Engine failed: ${result.error.message}` };
      this.render();
      return;
    }
    if (result.cancelled) return;

    if (!result.lines.length) {
      this.view = { state: 'done', fen, lines: [], scored: null, message: 'No legal moves.' };
      this.render();
      return;
    }

    this.view = { state: 'scoring', fen, lines: result.lines, scored: null, maia: null };
    this.render();

    const fetched = await this.fetchDatabases(fen, rating, this.speed, token);
    const { notes } = fetched;
    if (runId !== this.runId) return;

    // Per line: a line takes its value from the database if the database has
    // its move, otherwise from Maia3. Maia3 runs only when some line needs it.
    const lineUcis = result.lines.map((line) => line.pv[0]);
    const peer = fetched.peer;
    const masters = fetched.masters;
    const needPeer = !peer || lineUcis.some((uci) => !uci || gamesOf(peer.moves.get(uci)) === 0);
    const needMasters = !masters || lineUcis.some((uci) => !uci || gamesOf(masters.moves.get(uci)) === 0);

    let maia = null;
    let maiaError = maiaLoadError;
    if (!maiaError && (needPeer || needMasters)) {
      this.view = { ...this.view, maia: null };
      this.render();
      try {
        maia = await this.scoreWithMaia({
          runId,
          fen,
          lines: result.lines,
          rating,
          master,
          wantPeer: needPeer,
          wantMasters: needMasters,
        });
      } catch (error) {
        maiaError = error;
      }
      if (runId !== this.runId) return;
    }

    const messages = [...notes];
    if (maiaError) messages.push(`Maia3 failed: ${maiaError.message}`);
    const scored = columnValues({ fen, lines: result.lines, peer: fetched.peer, masters: fetched.masters, maia });
    this.view = { state: 'done', fen, lines: result.lines, scored, message: messages.join(' ') };
    // Results with a failed source are not cached, so the next visit retries them.
    if (!messages.length) this.remember(key, result.lines, scored);
    this.render();
  }

  // Queries both Lichess databases for the position. A database counts only if
  // it has at least MIN_DB_GAMES games there. A failed query is reported in notes.
  // Without a token the explorer is not queried at all, so both columns use Maia3.
  async fetchDatabases(fen, rating, speed, token) {
    const notes = [];
    if (!token) return { peer: null, masters: null, notes };
    const query = async (name, request) => {
      try {
        const db = await request();
        return db.total >= MIN_DB_GAMES ? db : null;
      } catch (error) {
        notes.push(`${name} database unavailable: ${error.message}.`);
        return null;
      }
    };
    const peer = await query('Lichess', () => fetchPeerDatabase({ fen, rating, speed, token }));
    const masters = await query('Masters', () => fetchMastersDatabase({ fen, token }));
    return { peer, masters, notes };
  }

  async scoreWithMaia({ runId, fen, lines, rating, master, wantPeer, wantMasters }) {
    await loadMaia((status) => this.onMaiaStatus(runId, status));
    const moves = lines.map((line) => {
      const uci = line.pv[0];
      return { uci, childFen: uci ? applyUci(fen, uci) : null };
    });
    const ratings = MASTER_RANGES.find((range) => range.value === master).ratings;
    return scoreMoves({ fen, moves, rating, ratings, wdl: wantPeer, probabilities: wantMasters });
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

  render() {
    // Rows are replaced here, so a tooltip on a removed node would never get its mouseleave.
    hideTip();
    this.maiaProgress = null;
    this.toggle.checked = this.enabled;
    // Collapse the section to its header while evaluation is off.
    this.section.classList.toggle('collapsed', !this.enabled);
    setSplitEnabled(this.enabled);
    this.settingsBtn.setAttribute('aria-pressed', String(!this.settingsMenu.hidden));
    this.body.replaceChildren();

    if (!this.enabled) {
      this.body.append(el('p', 'eval-empty', 'Evaluation is off. Press E to show it.'));
      return;
    }

    if (!this.view || !this.view.fen) {
      this.renderPlaceholders();
      return;
    }

    const { view } = this;
    if (view.state === 'error') {
      this.body.append(el('p', 'eval-empty eval-error', view.message));
      return;
    }

    if (view.state === 'done' && view.lines.length === 0) {
      this.body.append(el('p', 'eval-empty', view.message));
      return;
    }

    if ((view.state === 'loading' || view.state === 'scoring') && view.maia?.phase === 'download') {
      this.maiaProgress = maiaProgressElement(view.maia);
      this.body.append(this.maiaProgress);
    }

    this.body.append(this.progressSlot(view));

    const lines = view.lines;
    const scoredAll = view.state === 'done' ? view.scored : null;
    if (lines.length) this.body.append(columnHeader());
    const rows = Math.max(this.settings.lines, lines.length);
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

    if (view.message && view.state === 'done') {
      this.body.append(el('p', 'eval-empty eval-error', view.message));
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
    for (let index = 0; index < this.settings.lines; index += 1) {
      this.body.append(this.placeholderLine());
    }
  }

  placeholderLine() {
    const row = el('div', 'eval-line eval-line-pending');
    row.setAttribute('aria-hidden', 'true');
    const primary = el('div', 'eval-primary');
    primary.append(
      el('span', 'eval-skeleton eval-skeleton-move'),
      el('span', 'eval-skeleton eval-skeleton-score'),
      placeholderWdl(),
      placeholderCircles(),
    );
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
    primary.append(el('span', 'eval-score', formatScore(line.score, sideToMoveOf(fen))));

    if (complete) {
      primary.append(this.buildWdl(fen, scored.peer, scored.peer.moves[index]));
    } else {
      primary.append(placeholderWdl());
    }

    primary.append(this.buildCircles(scored?.masters, scored?.masters.moves[index], complete));
    row.append(primary);

    const parts = afterFirst ? uciLineParts(afterFirst, line.pv.slice(1), CONTINUATION_PLIES) : [];
    row.append(this.buildContinuation(line.pv, parts));
    return row;
  }

  // Each ply is a button. Clicking one plays the line up to it in the move list;
  // hovering or focusing it shows a preview of the position after that ply.
  buildContinuation(pv, parts) {
    const wrap = el('div', 'eval-continuation');
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

  // Circles are scaled against the most probable move in the position, so that
  // move always shows all DOTS filled.
  // column is the Masters column value ({ source, topProbability }); entry is this line's value.
  buildCircles(column, entry, complete) {
    if (!complete) return placeholderCircles();
    const hasToken = Boolean(this.settings.token);
    const wrap = el('div', 'eval-circles-wrap');
    const circles = el('span', 'eval-circles');
    wrap.append(circles, sourceSlot(entry?.source, 'Masters', entry?.games, hasToken));
    // A zero probability means the move has no games in the database.
    if (!entry || !entry.probability || !column?.topProbability) {
      circles.append(el('span', 'eval-empty-inline', '—'));
      return wrap;
    }
    const count = Math.min(DOTS, Math.max(1, Math.round((entry.probability / column.topProbability) * DOTS)));
    circles.setAttribute('role', 'img');
    circles.setAttribute('aria-label', `Probability ${count} of ${DOTS}`);
    attachTip(circles, [formatPercent(entry.probability)]);
    for (let i = 0; i < DOTS; i += 1) {
      circles.append(el('span', i < count ? 'eval-dot eval-dot-on' : 'eval-dot'));
    }
    return wrap;
  }

  // column is the Peer results column value ({ source, moves }); entry is this line's value.
  buildWdl(fen, column, entry) {
    const wrap = el('div', 'eval-wdl-wrap');
    const hasToken = Boolean(this.settings.token);
    if (!entry || !entry.wdl) {
      wrap.append(el('div', 'eval-empty-inline', '—'), sourceSlot(entry?.source, 'Lichess', entry?.games, hasToken));
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
    wrap.append(bar, sourceSlot(entry?.source, 'Lichess', entry?.games, hasToken));
    return wrap;
  }
}

export const evalPanel = new EvalPanel();
