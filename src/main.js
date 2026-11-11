import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import '@fontsource/geist-mono/700.css';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import { evalPanel } from './eval/panel.js';
import { initSidebarSplit } from './sidebar-split.js';
import { initMovesSettings, loadMoveLayout } from './move-layout.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const MOVE_GLYPHS = [
  { id: 1, symbol: '!', name: 'Good move' },
  { id: 2, symbol: '?', name: 'Mistake' },
  { id: 3, symbol: '!!', name: 'Brilliant move' },
  { id: 4, symbol: '??', name: 'Blunder' },
  { id: 5, symbol: '!?', name: 'Interesting move' },
  { id: 6, symbol: '?!', name: 'Dubious move' },
  { id: 7, symbol: '□', name: 'Only move' },
  { id: 22, symbol: '⨀', name: 'Zugzwang' },
];

const POSITION_GLYPHS = [
  { id: 10, symbol: '=', name: 'Equal position' },
  { id: 13, symbol: '∞', name: 'Unclear position' },
  { id: 14, symbol: '⩲', name: 'White is slightly better' },
  { id: 15, symbol: '⩱', name: 'Black is slightly better' },
  { id: 16, symbol: '±', name: 'White is better' },
  { id: 17, symbol: '∓', name: 'Black is better' },
  { id: 18, symbol: '+−', name: 'White is winning' },
  { id: 19, symbol: '−+', name: 'Black is winning' },
];

const MOVE_GLYPH_BY_ID = new Map(MOVE_GLYPHS.map((glyph) => [glyph.id, glyph]));
const POSITION_GLYPH_BY_ID = new Map(POSITION_GLYPHS.map((glyph) => [glyph.id, glyph]));
const MOVE_GLYPH_IDS = MOVE_GLYPHS.map((glyph) => glyph.id);
const POSITION_GLYPH_IDS = POSITION_GLYPHS.map((glyph) => glyph.id);

const importBtn = document.getElementById('import-btn');
const clearMovesBtn = document.getElementById('clear-moves-btn');
const clearAnnotationsBtn = document.getElementById('clear-annotations-btn');
const importDialog = document.getElementById('import-dialog');
const importInput = document.getElementById('import-input');
const importError = document.getElementById('import-error');
const importWarning = document.getElementById('import-warning');const importCancel = document.getElementById('import-cancel');
const importConfirm = document.getElementById('import-confirm');
const boardEl = document.getElementById('board');
const moveIndicator = document.getElementById('move-indicator');
const coordsFilesTop = document.getElementById('coords-files-top');
const coordsRanksLeft = document.getElementById('coords-ranks-left');
const coordsRanksRight = document.getElementById('coords-ranks-right');
const coordsFilesBottom = document.getElementById('coords-files-bottom');
const navFirst = document.getElementById('nav-first');
const navPrev = document.getElementById('nav-prev');
const navNext = document.getElementById('nav-next');
const navLast = document.getElementById('nav-last');
const moveList = document.getElementById('move-list');
const moveSelector = document.getElementById('move-selector');
const moveContextMenu = document.getElementById('move-context-menu');
const deleteDialog = document.getElementById('delete-dialog');
const deleteDialogTitle = document.getElementById('delete-dialog-title');
const deleteDialogMessage = document.getElementById('delete-dialog-message');
const deleteCancel = document.getElementById('delete-cancel');
const deleteConfirm = document.getElementById('delete-confirm');

const promotionOverlay = document.getElementById('promotion');
const promotionMenu = document.getElementById('promotion-menu');

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];
const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];
const PROMOTION_NAMES = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

let currentFen = START_FEN;
let flipped = false;
let game = null;
let moveTree = createRoot(START_FEN);
let currentNodeId = moveTree.id;
let lastScrolledNodeId = null;
let selectionParentId = null;
let selectionMainChildId = null;
let selectedChildId = null;
let nodeById = new Map();
let parentById = new Map();
let nextNodeId = 1;
let pendingPromotion = null;
let pendingConfirm = null;
let importOverrideConfirmed = false;// How the move list shows moves: 'inline', 'columns' or 'mixed'.
let moveLayout = loadMoveLayout();
let pendingImportChord = false;
let pendingImportChordTimeout = null;
let showDests = localStorage.getItem('64-quarks.showDests') !== 'false';
let showLastMove = localStorage.getItem('64-quarks.showLastMove') !== 'false';
let currentPieces = localStorage.getItem('64-quarks.pieces') || 'staunty';
const STATE_KEY = '64-quarks.state';

const turnColor = (fen) => (fen.trim().split(/\s+/)[1] === 'w' ? 'white' : 'black');
const orientation = () => (flipped ? 'black' : 'white');

function createRoot(fen, metadata = {}) {
  return {
    id: 'root',
    fen,
    san: null,
    from: null,
    to: null,
    promotion: null,
    moveNumber: null,
    color: null,
    moveGlyph: null,
    positionGlyph: null,
    engineEval: null,
    // Imported PGN tags (Event, White, Result, ...). FEN and SetUp are not
    // stored here because they are derived from the root position.
    metadata,
    children: [],
    mainChildId: null,
  };
}

const DERIVED_TAGS = new Set(['FEN', 'SetUp']);

function metadataFromHeaders(headers) {
  const metadata = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!DERIVED_TAGS.has(key) && typeof value === 'string') metadata[key] = value;
  }
  return metadata;
}

// Reads the tag pairs of a PGN, honouring \" and \\ escapes in values (chess.js
// does not unescape them). Returns the values and the PGN with every tag line
// removed except FEN/SetUp, which chess.js needs to set up the start position.
function parsePgnTags(pgn) {
  const tagLine = /^[ \t]*\[(\w+)[ \t]+"((?:[^"\\\n]|\\.)*)"[ \t]*\][ \t]*$/gm;
  const tags = {};
  for (const match of pgn.matchAll(tagLine)) {
    tags[match[1]] = match[2].replace(/\\(.)/g, '$1');
  }
  const sanitized = pgn.replace(tagLine, (line, key) => (DERIVED_TAGS.has(key) ? line : ''));
  return { tags, sanitized };
}

function formatTagValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Returns the PGN tag lines for the tree: the metadata, plus SetUp/FEN when the
// tree does not start from the standard position. Also returns the termination
// marker, taken from the Result tag when it is a valid result.
function pgnHeaderLines(root) {
  const lines = [];
  if (root.fen !== START_FEN) {
    lines.push('[SetUp "1"]', `[FEN "${root.fen}"]`);
  }
  for (const [key, value] of Object.entries(root.metadata || {})) {
    if (DERIVED_TAGS.has(key)) continue;
    lines.push(`[${key} "${formatTagValue(value)}"]`);
  }
  const result = root.metadata?.Result;
  const termination = ['1-0', '0-1', '1/2-1/2', '*'].includes(result) ? result : '*';
  return { lines, termination };
}

function assemblePgn(lines, movetext, termination) {
  const body = `${movetext} ${termination}`.trim();
  return lines.length ? `${lines.join('\n')}\n\n${body}` : body;
}

function isValidEngineEval(engineEval) {
  if (!engineEval || (engineEval.type !== 'cp' && engineEval.type !== 'mate')) return false;
  if (typeof engineEval.value !== 'number' || !Number.isFinite(engineEval.value)) return false;
  return engineEval.type !== 'mate' || Number.isInteger(engineEval.value);
}

function normalizeAnnotations(node) {
  if (!MOVE_GLYPH_BY_ID.has(node.moveGlyph)) node.moveGlyph = null;
  if (!POSITION_GLYPH_BY_ID.has(node.positionGlyph)) node.positionGlyph = null;
  if (!isValidEngineEval(node.engineEval)) node.engineEval = null;
}

function reindexTree() {
  nodeById = new Map();
  parentById = new Map();
  const visit = (node, parent = null) => {
    normalizeAnnotations(node);
    nodeById.set(node.id, node);
    if (parent) parentById.set(node.id, parent.id);
    if (!Array.isArray(node.children)) node.children = [];
    if (node.children.length && !node.children.some((child) => child.id === node.mainChildId)) {
      node.mainChildId = node.children[0].id;
    }
    if (!node.children.length) node.mainChildId = null;
    node.children.forEach((child) => visit(child, node));
  };
  visit(moveTree);
  while (nodeById.has(`node-${nextNodeId}`)) nextNodeId += 1;
}

function currentNode() {
  return nodeById.get(currentNodeId) || moveTree;
}

function parentOf(node) {
  return nodeById.get(parentById.get(node.id)) || null;
}

function mainChildOf(node) {
  return node.children.find((child) => child.id === node.mainChildId) || null;
}

function orderedChildren(node) {
  const main = mainChildOf(node);
  if (!main) return [...node.children];
  return [main, ...node.children.filter((child) => child.id !== main.id)];
}

function resetMoveSelection() {
  selectionParentId = null;
  selectionMainChildId = null;
  selectedChildId = null;
}

function syncMoveSelection() {
  const node = currentNode();
  const main = mainChildOf(node);
  const defaultChildId = main ? main.id : node.children[0]?.id || null;

  if (selectionParentId !== node.id || selectionMainChildId !== node.mainChildId) {
    selectionParentId = node.id;
    selectionMainChildId = node.mainChildId;
    selectedChildId = defaultChildId;
  }
  if (!node.children.some((child) => child.id === selectedChildId)) {
    selectedChildId = defaultChildId;
  }
}

function newNodeId() {
  const id = `node-${nextNodeId}`;
  nextNodeId += 1;
  return id;
}

const ground = Chessground(boardEl, {
  fen: START_FEN,
  coordinates: false,
  viewOnly: false,
  drawable: { enabled: false },
  movable: {
    free: false,
    showDests: true,
    events: { after: onMove },
  },
  premovable: { enabled: false },
  draggable: { enabled: true, showGhost: true },
  selectable: { enabled: true },
  animation: { enabled: true, duration: 200 },
});

function span(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

function formatEngineEval(engineEval) {
  if (!isValidEngineEval(engineEval)) return '';
  if (engineEval.type === 'mate') {
    return `#${engineEval.value}`;
  }
  return `${engineEval.value > 0 ? '+' : ''}${engineEval.value.toFixed(2)}`;
}

function parseEngineEval(comment) {
  if (!comment) return null;
  const match = /\[%eval\s+([^\]]+)\]/i.exec(comment);
  if (!match) return null;
  const raw = match[1].trim();
  if (raw.startsWith('#')) {
    const mate = Number(raw.slice(1));
    return Number.isInteger(mate) ? { type: 'mate', value: mate } : null;
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? { type: 'cp', value } : null;
}

function renderCoords(orientation) {
  const horizontal = orientation === 'white' ? FILES : [...FILES].reverse();
  const vertical = orientation === 'white' ? RANKS : [...RANKS].reverse();
  coordsFilesTop.replaceChildren(...horizontal.map(span));
  coordsFilesBottom.replaceChildren(...horizontal.map(span));
  coordsRanksLeft.replaceChildren(...vertical.map(span));
  coordsRanksRight.replaceChildren(...vertical.map(span));
}

function setTurn(turn) {
  moveIndicator.classList.toggle('turn-white', turn === 'w');
  moveIndicator.classList.toggle('turn-black', turn === 'b');
}

function isValidFen(fen) {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 6) return false;

  const ranks = parts[0].split('/');
  if (ranks.length !== 8) return false;

  for (const rank of ranks) {
    let count = 0;
    for (const ch of rank) {
      if (/[1-8]/.test(ch)) count += Number(ch);
      else if (/[prnbqkPRNBQK]/.test(ch)) count += 1;
      else return false;
    }
    if (count !== 8) return false;
  }

  if (!/^[wb]$/.test(parts[1])) return false;
  if (!/^(KQ?k?q?|Q?k?q?|k?q?|-)$/.test(parts[2])) return false;
  if (!/^(-|[a-h][36])$/.test(parts[3])) return false;

  if (parts.length > 4 && !/^\d+$/.test(parts[4])) return false;
  if (parts.length > 5 && !/^\d+$/.test(parts[5])) return false;

  return true;
}

function isCheck(fen) {
  const field = fen.trim().split(/\s+/)[3] || '';
  return /[kK]/.test(field);
}

function makeGame(fen) {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function legalDests() {
  const dests = new Map();
  if (!game || game.isGameOver()) return dests;
  for (const move of game.moves({ verbose: true })) {
    const targets = dests.get(move.from);
    if (targets) targets.push(move.to);
    else dests.set(move.from, [move.to]);
  }
  return dests;
}

function saveState() {
  try {
    sessionStorage.setItem(
      STATE_KEY,
      JSON.stringify({ moveTree, currentNodeId, flipped }),
    );
  } catch {
    /* ignore storage errors */
  }
}

function refresh() {
  const entry = currentNode();
  currentFen = entry.fen;
  syncMoveSelection();
  const ori = orientation();
  const turn = turnColor(currentFen);
  ground.set({
    fen: currentFen,
    orientation: ori,
    turnColor: turn,
    check: game ? game.isCheck() : isCheck(currentFen),
    lastMove: showLastMove && entry && entry.from ? [entry.from, entry.to] : undefined,
    movable: {
      free: false,
      color: turn,
      dests: legalDests(),
      showDests,
    },
  });
  renderCoords(ori);
  setTurn(turn === 'white' ? 'w' : 'b');
  navFirst.disabled = entry.id === moveTree.id;
  navPrev.disabled = entry.id === moveTree.id;
  navNext.disabled = !entry.children.length;
  navLast.disabled = !mainChildOf(entry);
  clearMovesBtn.disabled = moveTree.children.length === 0;
  clearAnnotationsBtn.disabled = !hasAnnotations();
  renderMoveList();
  renderMoveSelector();
  ensureActiveMoveVisible();
  evalPanel.setFen(currentFen, moveTree?.metadata?.TimeControl ?? null);
  renderMetaPanel();
  saveState();
}

function ensureActiveMoveVisible() {
  if (!moveList || lastScrolledNodeId === currentNodeId) return;

  const container = moveList.closest('.movies-panel-body');
  if (!container || !container.clientHeight) return;
  lastScrolledNodeId = currentNodeId;

  const active = moveList.querySelector('.move-ply.active');
  if (!active) {
    container.scrollTop = 0;
    container.scrollLeft = 0;
    return;
  }

  const line = active.closest('.move-line') || active;
  const lineRect = line.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const margin = 8;
  const top = containerRect.top + margin;
  const bottom = containerRect.bottom - margin;
  const left = containerRect.left + margin;
  const right = containerRect.right - margin;

  // Rows of the main move list. Variations shown inline have no row of their own,
  // so the second-line rule only applies to the row layout.
  const rows = [...moveList.querySelectorAll('.move-line')];
  const index = rows.indexOf(line);
  const maxScroll = container.scrollHeight - container.clientHeight;
  const atBottom = container.scrollTop >= maxScroll - 1;

  if (index >= 1 && !atBottom) {
    // Put the active line on the third visible row. The first row (the first
    // two moves) is left to the normal visibility rule below.
    const step = rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top;
    const padTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
    const thirdRowTop = containerRect.top + padTop + 2 * step;
    const next = container.scrollTop + (lineRect.top - thirdRowTop);
    container.scrollTop = Math.min(Math.max(next, 0), maxScroll);
  } else if (lineRect.top < top) {
    container.scrollTop -= top - lineRect.top;
  } else if (lineRect.bottom > bottom) {
    container.scrollTop += lineRect.bottom - bottom;
  }

  if (lineRect.left < left) {
    container.scrollLeft -= left - lineRect.left;
  } else if (lineRect.right > right) {
    container.scrollLeft += lineRect.right - right;
  }
}

function createMoveButton(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `move-ply${entry.id === currentNodeId ? ' active' : ''}`;
  if (MOVE_GLYPH_BY_ID.has(entry.moveGlyph)) {
    button.dataset.moveGlyph = String(entry.moveGlyph);
  }

  const san = document.createElement('span');
  san.className = 'move-san';
  san.textContent = entry.san;
  button.appendChild(san);

  const moveGlyph = MOVE_GLYPH_BY_ID.get(entry.moveGlyph);
  if (moveGlyph) {
    const glyph = document.createElement('span');
    glyph.className = 'move-glyph';
    glyph.textContent = moveGlyph.symbol;
    glyph.title = moveGlyph.name;
    button.appendChild(glyph);
  }

  const positionGlyph = POSITION_GLYPH_BY_ID.get(entry.positionGlyph);
  if (positionGlyph) {
    const glyph = document.createElement('span');
    glyph.className = 'position-glyph';
    glyph.textContent = positionGlyph.symbol;
    glyph.title = positionGlyph.name;
    button.appendChild(glyph);
  }

  const engineEval = formatEngineEval(entry.engineEval);
  if (engineEval) {
    const evaluation = document.createElement('span');
    evaluation.className = 'move-eval';
    evaluation.textContent = engineEval;
    button.appendChild(evaluation);
  }

  const annotations = [
    moveGlyph?.name,
    positionGlyph?.name,
    engineEval ? `engine evaluation ${engineEval}` : null,
  ].filter(Boolean);
  button.setAttribute(
    'aria-label',
    `Move ${entry.moveNumber}${entry.color === 'w' ? ', White' : ', Black'}: ${entry.san}${annotations.length ? `, ${annotations.join(', ')}` : ''}`,
  );
  button.addEventListener('click', () => goto(entry.id));
  button.addEventListener('contextmenu', (event) => openMoveContextMenu(event, entry));
  return button;
}

function updateMoveCellWidth() {
  if (!moveList) return;

  const lines = [...moveList.querySelectorAll('.move-line')];
  if (!lines.length || !moveList.clientWidth) {
    moveList.style.removeProperty('--move-cell-width');
    return;
  }

  const listRect = moveList.getBoundingClientRect();
  const listWidth = moveList.clientWidth;
  const firstLine = lines[0];
  const numberWidth = firstLine.querySelector('.move-number')?.getBoundingClientRect().width || 0;
  const gap = parseFloat(getComputedStyle(firstLine).columnGap) || 0;

  moveList.style.setProperty('--move-cell-width', 'max-content');

  let widest = 0;
  let minAvailable = listWidth;
  for (const line of lines) {
    const indent = Math.max(0, line.getBoundingClientRect().left - listRect.left);
    minAvailable = Math.min(minAvailable, listWidth - indent - numberWidth - gap * 2);
    for (const cell of line.querySelectorAll('.move-cell')) {
      widest = Math.max(widest, cell.getBoundingClientRect().width);
    }
  }

  const maxCellWidth = Math.max(0, Math.floor(minAvailable / 2));
  moveList.style.setProperty(
    '--move-cell-width',
    `min(max(var(--move-cell-min-width), ${Math.ceil(widest)}px), ${maxCellWidth}px)`,
  );
}

function renderMoveList() {
  if (!moveList) return;

  if (!moveTree.children.length) {
    const empty = document.createElement('div');
    empty.className = 'move-list-empty';
    empty.textContent = 'No moves yet';
    moveList.replaceChildren(empty);
    moveList.style.removeProperty('--move-cell-width');
    return;
  }

  const createLine = () => {
    const line = document.createElement('div');
    line.className = 'move-line';
    const number = document.createElement('span');
    number.className = 'move-number';
    const white = document.createElement('span');
    white.className = 'move-cell';
    const black = document.createElement('span');
    black.className = 'move-cell';
    line.append(number, white, black);
    return { el: line, number, white, black, started: false };
  };

  const createVariationGroup = () => {
    const group = document.createElement('div');
    group.className = 'variation-group';
    return group;
  };

  const appendMove = (line, node) => {
    if (!line.started) {
      line.number.textContent = `${node.moveNumber}${node.color === 'w' ? '.' : '...'}`;
      line.started = true;
    }
    const cell = node.color === 'w' ? line.white : line.black;
    cell.replaceChildren(createMoveButton(node));
  };

  const renderSequence = (startNode, initialVariations = []) => {
    const fragment = document.createDocumentFragment();
    let line = null;
    let lineMoveNumber = null;
    let afterRow = [...initialVariations];
    let carried = [];

    const appendVariationGroups = (variations) => {
      variations.forEach((variation) => {
        appendVariation(fragment, variation);
      });
    };

    const flushRound = () => {
      if (!line) return;
      fragment.appendChild(line.el);
      appendVariationGroups(afterRow);
      line = null;
      lineMoveNumber = null;
      afterRow = carried;
      carried = [];
    };

    let node = startNode;
    while (node) {
      if (!line || node.color === 'w' || node.moveNumber !== lineMoveNumber) {
        flushRound();
        line = createLine();
        lineMoveNumber = node.moveNumber;
      }

      appendMove(line, node);
      const sideVariations = node.children.filter(
        (child) => child.id !== node.mainChildId,
      );
      if (node.color === 'w') {
        afterRow.push(...sideVariations);
      } else {
        carried.push(...sideVariations);
      }

      node = mainChildOf(node);
      if (!node || node.color === 'w') flushRound();
    }
    flushRound();
    appendVariationGroups(afterRow);
    return fragment;
  };

  const parenthesis = (text) => {
    const span = document.createElement('span');
    span.className = 'move-paren';
    span.textContent = text;
    return span;
  };

  // Inline layout: the whole line is one run of wrapping text. A variation is
  // written in parentheses right after the move it replaces, and the line
  // continues after it. `alternatives` are the variations that replace startNode.
  const flowInline = (wrap, startNode, alternatives) => {
    let needNumber = true;
    let alts = alternatives;

    const appendAlternatives = (variations) => {
      variations.forEach((variation) => {
        wrap.appendChild(parenthesis('('));
        flowInline(wrap, variation, []);
        wrap.appendChild(parenthesis(')'));
      });
      needNumber = true;
    };

    for (let node = startNode; node; node = mainChildOf(node)) {
      if (needNumber || node.color === 'w') {
        const number = document.createElement('span');
        number.className = 'move-number';
        number.textContent = `${node.moveNumber}${node.color === 'w' ? '.' : '...'}`;
        wrap.appendChild(number);
      }
      needNumber = false;
      wrap.appendChild(createMoveButton(node));

      if (alts.length) appendAlternatives(alts);
      alts = node.children.filter((child) => child.id !== node.mainChildId);
    }
    if (alts.length) appendAlternatives(alts);
  };

  const renderInlineSequence = (startNode, alternatives = []) => {
    const wrap = document.createElement('div');
    wrap.className = 'move-inline';
    flowInline(wrap, startNode, alternatives);
    return wrap;
  };

  // Adds one top-level variation to target. Columns: an indented block of
  // columns. Mixed: an indented block of text. Inline (only when the game has
  // no main line): a parenthesised line of text.
  const appendVariation = (target, variation) => {
    if (moveLayout === 'columns' || moveLayout === 'mixed') {
      const group = createVariationGroup();
      group.appendChild(moveLayout === 'columns' ? renderSequence(variation) : renderInlineSequence(variation));
      target.appendChild(group);
      return;
    }
    const wrap = renderInlineSequence(variation);
    wrap.prepend(parenthesis('('));
    wrap.append(parenthesis(')'));
    target.appendChild(wrap);
  };

  const moves = document.createDocumentFragment();
  const rootVariations = moveTree.children.filter(
    (child) => child.id !== moveTree.mainChildId,
  );
  const main = mainChildOf(moveTree);
  if (main) {
    moves.appendChild(
      moveLayout === 'inline'
        ? renderInlineSequence(main, rootVariations)
        : renderSequence(main, rootVariations),
    );
  } else {
    rootVariations.forEach((variation) => {
      appendVariation(moves, variation);
    });
  }

  moveList.replaceChildren(moves);
  updateMoveCellWidth();
}

function renderMoveSelector() {
  if (!moveSelector) return;

  const node = currentNode();
  const candidates = orderedChildren(node);
  if (candidates.length <= 1) {
    moveSelector.hidden = true;
    moveSelector.replaceChildren();
    return;
  }

  moveSelector.hidden = false;
  moveSelector.replaceChildren(
    ...candidates.map((child) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `move-choice${child.id === selectedChildId ? ' selected' : ''}`;
      button.textContent = child.san;
      button.title = child.id === node.mainChildId
        ? `Main line: ${child.san}`
        : `Variation: ${child.san}`;
      button.setAttribute('aria-pressed', String(child.id === selectedChildId));
      button.addEventListener('click', () => goto(child.id));
      return button;
    }),
  );

  const selected = moveSelector.querySelector('.move-choice.selected');
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function goto(id) {
  const entry = nodeById.get(id);
  if (!entry) return;
  currentNodeId = id;
  currentFen = entry.fen;
  game = makeGame(currentFen);
  refresh();
}

function cycleMoveSelection(direction) {
  const candidates = orderedChildren(currentNode());
  if (candidates.length <= 1) return;

  const index = candidates.findIndex((child) => child.id === selectedChildId);
  const start = index < 0 ? 0 : index;
  selectedChildId = candidates[(start + direction + candidates.length) % candidates.length].id;
  renderMoveSelector();
}

function gotoSelectedChild() {
  const candidates = orderedChildren(currentNode());
  if (!candidates.length) return;
  const target = candidates.find((child) => child.id === selectedChildId) || candidates[0];
  goto(target.id);
}

navFirst.addEventListener('click', () => goto(moveTree.id));
navPrev.addEventListener('click', () => {
  const parent = parentOf(currentNode());
  if (parent) goto(parent.id);
});
navNext.addEventListener('click', () => {
  gotoSelectedChild();
});
navLast.addEventListener('click', () => {
  let last = currentNode();
  while (mainChildOf(last)) last = mainChildOf(last);
  goto(last.id);
});

function commitMove(move, moveNumber, color) {
  const parent = currentNode();
  const existing = parent.children.find(
    (child) => child.from === move.from && child.to === move.to && child.promotion === (move.promotion || null),
  );
  if (existing) {
    goto(existing.id);
    return;
  }
  const entry = {
    id: newNodeId(),
    fen: game.fen(),
    san: move.san,
    from: move.from,
    to: move.to,
    promotion: move.promotion || null,
    moveNumber,
    color,
    moveGlyph: null,
    positionGlyph: null,
    engineEval: null,
    children: [],
    mainChildId: null,
  };
  parent.children.push(entry);
  if (!parent.mainChildId) parent.mainChildId = entry.id;
  reindexTree();
  currentNodeId = entry.id;
  currentFen = game.fen();
  refresh();
}

// Plays a UCI line from the current position. Moves already in the move list are
// reused; the last move of the line becomes the current one.
function playUciLine(ucis) {
  for (const uci of ucis) {
    game = makeGame(currentFen);
    const moveNumber = game.moveNumber();
    const color = game.turn();
    let move = null;
    try {
      move = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
    } catch {
      move = null;
    }
    if (!move) break;
    commitMove(move, moveNumber, color);
  }
}

evalPanel.onPickLine = playUciLine;

function isSideVariation(entry) {
  const parent = parentOf(entry);
  return Boolean(parent && parent.mainChildId !== entry.id);
}

function toggleMoveGlyph(entry, glyphId) {
  if (!entry.san || !MOVE_GLYPH_BY_ID.has(glyphId)) return;
  entry.moveGlyph = entry.moveGlyph === glyphId ? null : glyphId;
  refresh();
}

function togglePositionGlyph(entry, glyphId) {
  if (!entry.san || !POSITION_GLYPH_BY_ID.has(glyphId)) return;
  entry.positionGlyph = entry.positionGlyph === glyphId ? null : glyphId;
  refresh();
}

function closeMoveContextMenu() {
  if (moveContextMenu) {
    moveContextMenu.hidden = true;
    moveContextMenu.replaceChildren();
  }
}

function addContextAction(label, action, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', () => {
    closeMoveContextMenu();
    action();
  });
  moveContextMenu.appendChild(button);
}

function addContextDivider() {
  const divider = document.createElement('div');
  divider.className = 'context-menu-divider';
  divider.setAttribute('role', 'separator');
  moveContextMenu.appendChild(divider);
}

function addGlyphSection(label, glyphs, getCurrentId, onSelect, shortcutPrefix) {
  const section = document.createElement('div');
  section.className = 'context-menu-section';

  const heading = document.createElement('div');
  heading.className = 'context-menu-label';
  heading.textContent = label;

  const grid = document.createElement('div');
  grid.className = 'context-menu-glyphs';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', label);

  glyphs.forEach((glyph, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.glyphId = String(glyph.id);
    button.textContent = glyph.symbol;
    button.title = `${glyph.name} (${glyph.symbol}) — ${shortcutPrefix}${index + 1}`;
    button.setAttribute('aria-label', `${glyph.name} (${glyph.symbol}), shortcut ${shortcutPrefix}${index + 1}`);
    button.setAttribute('aria-pressed', String(glyph.id === getCurrentId()));
    button.classList.toggle('active', glyph.id === getCurrentId());
    button.addEventListener('click', () => {
      onSelect(glyph.id);
      closeMoveContextMenu();
    });
    grid.appendChild(button);
  });

  section.append(heading, grid);
  moveContextMenu.appendChild(section);
}

function promoteVariation(entry) {
  const parent = parentOf(entry);
  if (!parent || parent.mainChildId === entry.id) return;
  parent.mainChildId = entry.id;
  refresh();
}

function reorderVariation(entry, direction) {
  const parent = parentOf(entry);
  if (!parent || parent.mainChildId === entry.id) return;
  const variationIndexes = parent.children
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => child.id !== parent.mainChildId);
  const position = variationIndexes.findIndex(({ child }) => child.id === entry.id);
  const target = position + direction;
  if (position < 0 || target < 0 || target >= variationIndexes.length) return;
  const sourceIndex = variationIndexes[position].index;
  const targetIndex = variationIndexes[target].index;
  [parent.children[sourceIndex], parent.children[targetIndex]] = [
    parent.children[targetIndex],
    parent.children[sourceIndex],
  ];
  refresh();
}

function isInSubtree(root, entry) {
  let current = entry;
  while (current) {
    if (current.id === root.id) return true;
    current = parentOf(current);
  }
  return false;
}

function countSubtree(entry) {
  return 1 + entry.children.reduce((count, child) => count + countSubtree(child), 0);
}

function closeDeleteDialog() {
  pendingConfirm = null;
  deleteDialog.hidden = true;
}

// Shows the shared confirm dialog; onConfirm runs only if the user confirms.
function openConfirmDialog({ title, message, label, onConfirm }) {
  pendingConfirm = onConfirm;
  deleteDialogTitle.textContent = title;
  deleteDialogMessage.textContent = message;
  deleteConfirm.textContent = label;
  deleteDialog.hidden = false;
  deleteConfirm.focus();
}

function performDelete(entry) {
  const parent = parentOf(entry);
  if (!parent) return;
  const activeWasDeleted = isInSubtree(entry, currentNode());
  parent.children = parent.children.filter((child) => child.id !== entry.id);
  if (parent.mainChildId === entry.id) {
    parent.mainChildId = parent.children[0]?.id || null;
  }
  reindexTree();
  if (activeWasDeleted) {
    currentNodeId = parent.id;
    currentFen = parent.fen;
    game = makeGame(currentFen);
  }
  refresh();
}

function deleteMove(entry) {
  const count = countSubtree(entry);
  if (count === 1) {
    performDelete(entry);
    return;
  }
  openConfirmDialog({
    title: 'Delete moves?',
    message: `Delete ${entry.san} and ${count - 1} move${count === 2 ? '' : 's'} that follow it?`,
    label: 'Delete',
    onConfirm: () => performDelete(entry),
  });
}

function hasAnnotations() {
  let found = false;
  const walk = (node) => {
    if (found) return;
    if (node.moveGlyph !== null || node.positionGlyph !== null || node.engineEval !== null) {
      found = true;
      return;
    }
    node.children.forEach(walk);
  };
  walk(moveTree);
  return found;
}

// Removes every move glyph, position glyph, and engine-eval marker from the game.
function clearAnnotations() {
  const walk = (node) => {
    node.moveGlyph = null;
    node.positionGlyph = null;
    node.engineEval = null;
    node.children.forEach(walk);
  };
  walk(moveTree);
  refresh();
}

// Clears the board and all moves, returning to the starting position.
function resetGame() {
  currentFen = START_FEN;
  game = makeGame(START_FEN);
  moveTree = createRoot(START_FEN);
  currentNodeId = moveTree.id;
  lastScrolledNodeId = null;
  nextNodeId = 1;
  reindexTree();
  resetMoveSelection();
  refresh();
}

function openMoveContextMenu(event, entry) {
  event.preventDefault();
  if (!moveContextMenu) return;
  moveContextMenu.replaceChildren();

  addGlyphSection(
    'Move',
    MOVE_GLYPHS,
    () => entry.moveGlyph,
    (glyphId) => toggleMoveGlyph(entry, glyphId),
    '',
  );
  addGlyphSection(
    'Position',
    POSITION_GLYPHS,
    () => entry.positionGlyph,
    (glyphId) => togglePositionGlyph(entry, glyphId),
    'Shift+',
  );
  addContextDivider();

  if (isSideVariation(entry)) {
    const parent = parentOf(entry);
    const variations = parent.children.filter((child) => child.id !== parent.mainChildId);
    const variationIndex = variations.findIndex((child) => child.id === entry.id);
    addContextAction('Make main line', () => promoteVariation(entry));
    if (variations.length > 1) {
      addContextAction('Move variation up', () => reorderVariation(entry, -1), variationIndex === 0);
      addContextAction('Move variation down', () => reorderVariation(entry, 1), variationIndex === variations.length - 1);
    }
  }

  addContextAction('Delete moves from here', () => deleteMove(entry));
  moveContextMenu.hidden = false;
  const { width, height } = moveContextMenu.getBoundingClientRect();
  moveContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
  moveContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
}

function onMove(orig, dest) {
  if (!game) {
    refresh();
    return;
  }

  const candidates = game.moves({ verbose: true }).filter(
    (move) => move.from === orig && move.to === dest,
  );

  if (!candidates.length) {
    refresh();
    return;
  }

  if (candidates.some((move) => move.promotion)) {
    ground.set({ fen: currentFen });
    openPromotion(orig, dest, candidates[0].color);
    return;
  }

  const moveNumber = game.moveNumber();
  const color = game.turn();
  const move = game.move({ from: orig, to: dest });
  commitMove(move, moveNumber, color);
}

function openPromotion(orig, dest, color) {
  pendingPromotion = { orig, dest, color };
  promotionMenu.replaceChildren(
    ...PROMOTION_PIECES.map((piece) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = PROMOTION_NAMES[piece];
      btn.setAttribute('aria-label', PROMOTION_NAMES[piece]);
      const img = document.createElement('img');
      img.src = `/piece/${currentPieces}/${color}${piece.toUpperCase()}.svg`;
      img.alt = PROMOTION_NAMES[piece];
      btn.appendChild(img);
      btn.addEventListener('click', () => completePromotion(piece));
      return btn;
    }),
  );
  promotionOverlay.hidden = false;
}

function closePromotion() {
  pendingPromotion = null;
  promotionOverlay.hidden = true;
  promotionMenu.replaceChildren();
}

function completePromotion(piece) {
  if (!pendingPromotion) return;
  const { orig, dest } = pendingPromotion;
  closePromotion();
  try {
    const moveNumber = game.moveNumber();
    const color = game.turn();
    const move = game.move({ from: orig, to: dest, promotion: piece });
    commitMove(move, moveNumber, color);
  } catch {
    refresh();
  }
}

function importFen(fen) {
  const trimmed = fen.trim();
  if (!isValidFen(trimmed)) return false;
  const parsed = makeGame(trimmed);
  if (!parsed) return false;
  const color = trimmed.split(/\s+/)[1];
  currentFen = trimmed;
  game = parsed;
  flipped = color === 'b';
  moveTree = createRoot(trimmed);
  currentNodeId = moveTree.id;
  lastScrolledNodeId = null;
  nextNodeId = 1;
  reindexTree();
  resetMoveSelection();
  refresh();
  return true;
}

function importPgn(pgn) {
  try {
    const { tags, sanitized } = parsePgnTags(pgn);
    const importedGame = new Chess();
    importedGame.loadPgn(sanitized);
    const headers = importedGame.getHeaders();
    const rootFen = headers.FEN || START_FEN;
    if (!isValidFen(rootFen)) return false;
    const replay = new Chess(rootFen);
    const moves = importedGame.history({ verbose: true });
    if (!moves.length && !Object.keys(headers).length) return false;

    const commentsByFen = new Map();
    for (const { fen, comment } of importedGame.getComments()) {
      const existing = commentsByFen.get(fen);
      commentsByFen.set(fen, existing ? `${existing} ${comment}` : comment);
    }

    const tree = createRoot(rootFen, metadataFromHeaders(tags));
    let parent = tree;
    let importedNodeId = 1;
    for (const importedMove of moves) {
      const moveNumber = replay.moveNumber();
      const color = replay.turn();
      const move = replay.move({
        from: importedMove.from,
        to: importedMove.to,
        promotion: importedMove.promotion,
      });
      if (!move) return false;
      const entry = {
        id: `node-${importedNodeId++}`,
        fen: replay.fen(),
        san: move.san,
        from: move.from,
        to: move.to,
        promotion: move.promotion || null,
        moveNumber,
        color,
        moveGlyph: null,
        positionGlyph: null,
        engineEval: parseEngineEval(commentsByFen.get(replay.fen())),
        children: [],
        mainChildId: null,
      };
      parent.children.push(entry);
      parent.mainChildId = entry.id;
      parent = entry;
    }

    moveTree = tree;
    currentNodeId = parent.id;
    lastScrolledNodeId = null;
    currentFen = parent.fen;
    game = replay;
    flipped = rootFen.split(/\s+/)[1] === 'b';
    nextNodeId = importedNodeId;
    reindexTree();
    resetMoveSelection();
    refresh();
    return true;
  } catch {
    return false;
  }
}

function closeImportDialog() {
  importDialog.hidden = true;
  importError.hidden = true;
  importBtn.setAttribute('aria-expanded', 'false');
}

function openImportDialog() {
  importInput.value = '';
  importError.hidden = true;
  const willOverride = moveTree.children.length > 0 || currentFen !== START_FEN;
  importWarning.hidden = !willOverride;
  importDialog.hidden = false;
  importBtn.setAttribute('aria-expanded', 'true');
  importInput.focus();
}

function importText() {
  const text = importInput.value.trim();
  if (importFen(text) || importPgn(text)) {
    closeImportDialog();
  } else {
    importError.hidden = false;
  }
}



promotionOverlay.addEventListener('click', (event) => {
  if (event.target === promotionOverlay) {
    closePromotion();
    refresh();
  }
});

importCancel.addEventListener('click', closeImportDialog);
importConfirm.addEventListener('click', importText);
importDialog.addEventListener('click', (event) => {
  if (event.target === importDialog) closeImportDialog();
});
importInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    importText();
  }
});

deleteCancel.addEventListener('click', closeDeleteDialog);
deleteConfirm.addEventListener('click', () => {
  const action = pendingConfirm;
  closeDeleteDialog();
  if (action) action();
});

importBtn.addEventListener('click', openImportDialog);

// Clearing discards every move, so it always asks first. The button is disabled
// when there are no moves, so the confirm dialog is only reachable with moves present.
clearMovesBtn.addEventListener('click', () => {
  if (moveTree.children.length === 0) return;
  openConfirmDialog({
    title: 'Clear all moves?',
    message: 'This clears the board and deletes all moves. This cannot be undone.',
    label: 'Clear',
    onConfirm: resetGame,
  });
});

clearAnnotationsBtn.addEventListener('click', () => {
  openConfirmDialog({
    title: 'Clear all annotations?',
    message: 'This removes all move glyphs, position glyphs, and engine eval markers. This cannot be undone.',
    label: 'Clear',
    onConfirm: clearAnnotations,
  });
});

deleteDialog.addEventListener('click', (event) => {
  if (event.target === deleteDialog) closeDeleteDialog();
});

function isEditableTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

function digitIndexFromEvent(event) {
  const match = /^(?:Digit|Numpad)([1-8])$/.exec(event.code || '');
  return match ? Number(match[1]) - 1 : null;
}

function applyMoveGlyphShortcut(index) {
  const entry = currentNode();
  const glyphId = MOVE_GLYPH_IDS[index];
  if (!entry.san || glyphId === undefined) return;
  toggleMoveGlyph(entry, glyphId);
  closeMoveContextMenu();
}

function applyPositionGlyphShortcut(index) {
  const entry = currentNode();
  const glyphId = POSITION_GLYPH_IDS[index];
  if (!entry.san || glyphId === undefined) return;
  togglePositionGlyph(entry, glyphId);
  closeMoveContextMenu();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !importDialog.hidden) {
    closeImportDialog();
    return;
  }
  if (event.key === 'Escape' && !deleteDialog.hidden) {
    closeDeleteDialog();
    return;
  }
  if (event.key === 'Escape' && moveContextMenu && !moveContextMenu.hidden) {
    closeMoveContextMenu();
    return;
  }
  if (event.key === 'Escape' && pendingPromotion) {
    closePromotion();
    refresh();
    return;
  }
  if (event.key === 'Escape' && settingsMenu && !settingsMenu.hidden) {
    closeSettings();
    return;
  }
  if (isEditableTarget(event.target)) return;
  if (pendingPromotion) return;

  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    if (pendingTimerChord) {
      pendingTimerChord = false;
      if (pendingTimerChordTimeout) {
        clearTimeout(pendingTimerChordTimeout);
        pendingTimerChordTimeout = null;
      }
    }
    pendingImportChord = true;
    if (pendingImportChordTimeout) {
      clearTimeout(pendingImportChordTimeout);
    }
    pendingImportChordTimeout = setTimeout(() => {
      pendingImportChord = false;
      pendingImportChordTimeout = null;
    }, 800);
    return;
  }

  if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.key.toLowerCase() === 't') {
    event.preventDefault();
    if (pendingImportChord) {
      pendingImportChord = false;
      if (pendingImportChordTimeout) {
        clearTimeout(pendingImportChordTimeout);
        pendingImportChordTimeout = null;
      }
    }
    pendingTimerChord = true;
    if (pendingTimerChordTimeout) {
      clearTimeout(pendingTimerChordTimeout);
    }
    pendingTimerChordTimeout = setTimeout(() => {
      pendingTimerChord = false;
      pendingTimerChordTimeout = null;
    }, 800);
    return;
  }

  if (pendingTimerChord && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const k = event.key.toLowerCase();
    if (k === 'r') {
      event.preventDefault();
      pendingTimerChord = false;
      if (pendingTimerChordTimeout) {
        clearTimeout(pendingTimerChordTimeout);
        pendingTimerChordTimeout = null;
      }
      restartTimer();
      return;
    }
    if (k === 'c') {
      event.preventDefault();
      pendingTimerChord = false;
      if (pendingTimerChordTimeout) {
        clearTimeout(pendingTimerChordTimeout);
        pendingTimerChordTimeout = null;
      }
      resetTimer();
      return;
    }
    if (k === 's') {
      event.preventDefault();
      pendingTimerChord = false;
      if (pendingTimerChordTimeout) {
        clearTimeout(pendingTimerChordTimeout);
        pendingTimerChordTimeout = null;
      }
      if (!timerRunning) {
        startTimer();
      }
      return;
    }
    if (k === 'p') {
      event.preventDefault();
      pendingTimerChord = false;
      if (pendingTimerChordTimeout) {
        clearTimeout(pendingTimerChordTimeout);
        pendingTimerChordTimeout = null;
      }
      pauseTimer();
      return;
    }
    if (k === 't') {
      event.preventDefault();
      pendingTimerChord = false;
      if (pendingTimerChordTimeout) {
        clearTimeout(pendingTimerChordTimeout);
        pendingTimerChordTimeout = null;
      }
      toggleTimerPanel();
      return;
    }
    pendingTimerChord = false;
    if (pendingTimerChordTimeout) {
      clearTimeout(pendingTimerChordTimeout);
      pendingTimerChordTimeout = null;
    }
  }

  if (pendingImportChord && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.key.toLowerCase() === 'i') {
      event.preventDefault();
      pendingImportChord = false;
      if (pendingImportChordTimeout) {
        clearTimeout(pendingImportChordTimeout);
        pendingImportChordTimeout = null;
      }
      openImportDialog();
      return;
    }
    pendingImportChord = false;
    if (pendingImportChordTimeout) {
      clearTimeout(pendingImportChordTimeout);
      pendingImportChordTimeout = null;
    }
  }

  if (event.key.toLowerCase() === 'e' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    if (!event.repeat) evalPanel.toggleEnabled();
    return;
  }
  if (event.key.toLowerCase() === 'f') {
    flipped = !flipped;
    refresh();
    return;
  }
  const digitIndex = digitIndexFromEvent(event);
  if (digitIndex !== null && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    if (!event.repeat) {
      if (event.shiftKey) applyPositionGlyphShortcut(digitIndex);
      else applyMoveGlyphShortcut(digitIndex);
    }
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const parent = parentOf(currentNode());
      if (parent) goto(parent.id);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      gotoSelectedChild();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cycleMoveSelection(-1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      cycleMoveSelection(1);
    }
  }
});

function formatEvalComment(engineEval) {
  if (!isValidEngineEval(engineEval)) return '';
  if (engineEval.type === 'mate') return `{ [%eval #${engineEval.value}] }`;
  return `{ [%eval ${engineEval.value.toFixed(2)}] }`;
}

function formatMoveToken(node, forceNumber) {
  const parts = [];
  if (node.color === 'w') parts.push(`${node.moveNumber}. ${node.san}`);
  else parts.push(forceNumber ? `${node.moveNumber}... ${node.san}` : node.san);
  if (MOVE_GLYPH_BY_ID.has(node.moveGlyph)) parts.push(`$${node.moveGlyph}`);
  if (POSITION_GLYPH_BY_ID.has(node.positionGlyph)) parts.push(`$${node.positionGlyph}`);
  const evalComment = formatEvalComment(node.engineEval);
  if (evalComment) parts.push(evalComment);
  return parts.join(' ');
}

// Formats the line that starts at `first` (a child of `parent`) and continues
// along main children. PGN places a variation after the move it replaces, so
// the other children of a main-line move are emitted right after that move.
// Variation roots are not main children, so their siblings are not emitted
// again inside the variation (that would recurse forever).
function formatLine(first, parent, forceNumber = true, firstIsMain = true, mainOf = mainChildOf) {
  const tokens = [];
  let node = first;
  let owner = parent;
  let isMain = firstIsMain;
  let force = forceNumber;
  while (node) {
    tokens.push(formatMoveToken(node, force));
    const alternatives = isMain ? owner.children.filter((child) => child.id !== node.id) : [];
    for (const alternative of alternatives) {
      tokens.push(`(${formatLine(alternative, owner, true, false, mainOf).join(' ')})`);
    }
    force = alternatives.length > 0;
    owner = node;
    node = mainOf(node);
    isMain = true;
  }
  return tokens;
}

function buildPgn() {
  const { lines, termination } = pgnHeaderLines(moveTree);
  const main = mainChildOf(moveTree);
  const movetext = main ? formatLine(main, moveTree).join(' ') : '';
  return assemblePgn(lines, movetext, termination);
}

const copyFenBtn = document.getElementById('copy-fen-btn');
const copyPgnBtn = document.getElementById('copy-pgn-btn');
const downloadPgnBtn = document.getElementById('download-pgn-btn');

function copyTextFallback(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

copyFenBtn.addEventListener('click', async () => {
  const fen = currentFen;
  try {
    await navigator.clipboard.writeText(fen);
  } catch {
    if (!copyTextFallback(fen)) {
      window.alert('Could not copy the position to the clipboard.');
    }
  }
});

copyPgnBtn.addEventListener('click', async () => {
  const pgn = buildPgn();
  try {
    await navigator.clipboard.writeText(pgn);
  } catch {
    if (!copyTextFallback(pgn)) {
      window.alert('Could not copy the PGN to the clipboard.');
    }
  }
});

downloadPgnBtn.addEventListener('click', () => {
  const blob = new Blob([`${buildPgn()}\n`], { type: 'application/x-chess-pgn' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'game.pgn';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

const timerToggle = document.getElementById('timer-toggle');
const timerPanel = document.getElementById('timer-panel');
const timerDisplay = document.getElementById('timer-display');
const timerStartPause = document.getElementById('timer-startpause');
const timerReset = document.getElementById('timer-reset');
const timerRestart = document.getElementById('timer-restart');

let timerSeconds = 0;
let timerRunning = false;
let timerId = null;
let pendingTimerChord = false;
let pendingTimerChordTimeout = null;

const formatTime = (total) => {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

function renderTimer() {
  if (timerDisplay) {
    timerDisplay.textContent = formatTime(timerSeconds);
  }
  if (timerToggle) {
    timerToggle.classList.toggle('running', timerRunning);
  }
  if (timerStartPause) {
    timerStartPause.innerHTML = timerRunning
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon fill="currentColor" points="5 3 19 12 5 21 5 3" /></svg>';
    timerStartPause.setAttribute('aria-label', timerRunning ? 'Pause' : 'Start');
    timerStartPause.title = timerRunning ? 'Pause (Alt+T, P)' : 'Start (Alt+T, S)';
  }
  if (timerRestart) {
    timerRestart.disabled = !timerRunning;
  }
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
  }
  timerId = null;
  timerRunning = false;
}

function resetTimer() {
  stopTimer();
  timerSeconds = 0;
  renderTimer();
}

function restartTimer() {
  if (!timerRunning) return;
  timerSeconds = 0;
  if (timerId) {
    clearInterval(timerId);
  }
  timerId = setInterval(() => {
    timerSeconds += 1;
    renderTimer();
  }, 1000);
  renderTimer();
}

function toggleTimer() {
  if (timerRunning) {
    pauseTimer();
  } else {
    startTimer();
  }
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  if (timerId) {
    clearInterval(timerId);
  }
  timerId = setInterval(() => {
    timerSeconds += 1;
    renderTimer();
  }, 1000);
  renderTimer();
}

function pauseTimer() {
  if (!timerRunning) return;
  stopTimer();
  renderTimer();
}

function toggleTimerPanel() {
  if (!timerPanel || !timerToggle) return;
  const willShow = timerPanel.hidden;
  timerPanel.hidden = !willShow;
  timerToggle.setAttribute('aria-pressed', String(willShow));
  timerToggle.title = willShow ? 'Hide timer' : 'Show timer';
  if (!willShow && !timerRunning) resetTimer();
}

if (timerStartPause) {
  timerStartPause.addEventListener('click', toggleTimer);
}

if (timerReset) {
  timerReset.addEventListener('click', resetTimer);
}

if (timerRestart) {
  timerRestart.addEventListener('click', restartTimer);
}

if (timerToggle) {
  timerToggle.addEventListener('click', toggleTimerPanel);
}

const settingsToggle = document.getElementById('settings-toggle');
const settingsMenu = document.getElementById('settings-menu');
const showDestsInput = document.getElementById('setting-show-dests');
const showLastMoveInput = document.getElementById('setting-show-last-move');
const metaPanelEl = document.getElementById('meta-panel');
const themeButtons = document.querySelectorAll('.settings-theme-btn[data-theme-value]');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('64-quarks.theme', theme);
  themeButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === theme));
  });
}

let savedTheme = localStorage.getItem('64-quarks.theme') || 'walnut';
if (savedTheme === 'blue' || savedTheme === 'modern') savedTheme = 'navy';
if (savedTheme === 'classic' || savedTheme === 'brown' || savedTheme === 'wood') savedTheme = 'walnut';
if (savedTheme === 'gray' || savedTheme === 'mono') savedTheme = 'graphite';
if (savedTheme === 'light') savedTheme = 'birch';
if (savedTheme !== 'walnut' && savedTheme !== 'navy' && savedTheme !== 'graphite' && savedTheme !== 'birch' && savedTheme !== 'paper') savedTheme = 'walnut';
applyTheme(savedTheme);

themeButtons.forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeValue));
});

const pieceButtons = document.querySelectorAll('.settings-piece-btn');
const PIECE_ABBREVS = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];
const VALID_PIECES = ['staunty', 'maestro', 'cardinal'];

function applyPieces(set) {
  if (!VALID_PIECES.includes(set)) set = 'staunty';
  currentPieces = set;
  document.documentElement.dataset.pieces = set;
  for (const abbrev of PIECE_ABBREVS) {
    document.documentElement.style.setProperty(`--piece-${abbrev}`, `url('/piece/${set}/${abbrev}.svg')`);
  }
  localStorage.setItem('64-quarks.pieces', set);
  pieceButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.pieceValue === set));
  });
}

applyPieces(currentPieces);

pieceButtons.forEach((btn) => {
  btn.addEventListener('click', () => applyPieces(btn.dataset.pieceValue));
});

function closeSettings() {
  settingsMenu.hidden = true;
  settingsToggle.setAttribute('aria-expanded', 'false');
  settingsToggle.setAttribute('aria-pressed', 'false');
  settingsToggle.title = 'Settings';
}

settingsToggle.addEventListener('click', () => {
  if (settingsMenu.hidden) {
    settingsMenu.hidden = false;
    settingsToggle.setAttribute('aria-expanded', 'true');
    settingsToggle.setAttribute('aria-pressed', 'true');
    settingsToggle.title = 'Hide settings';
  } else {
    closeSettings();
  }
});

if (showDestsInput) {
  showDestsInput.checked = showDests;
  showDestsInput.closest('.settings-item')?.setAttribute('aria-checked', String(showDests));
}

if (showLastMoveInput) {
  showLastMoveInput.checked = showLastMove;
  showLastMoveInput.closest('.settings-item')?.setAttribute('aria-checked', String(showLastMove));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A PGN tag value is usable unless it is empty or a placeholder ("?", "*", "-").
function metaValue(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && !/^[?*-]+$/.test(text) ? text : null;
}

// PGN date (YYYY.MM.DD, with ?? for unknown parts) to a readable form, e.g. "1 Oct 2026".
function formatMetaDate(value) {
  const match = /^(\d{4}|\?{4})\.(\d{2}|\?{2})\.(\d{2}|\?{2})$/.exec(value || '');
  if (!match) return metaValue(value);
  const [, year, month, day] = match;
  const hasYear = /^\d{4}$/.test(year);
  const hasMonth = /^\d{2}$/.test(month) && Number(month) >= 1 && Number(month) <= 12;
  const hasDay = /^\d{2}$/.test(day) && Number(day) >= 1;
  if (hasYear && hasMonth && hasDay) return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  if (hasYear && hasMonth) return `${MONTHS[Number(month) - 1]} ${year}`;
  if (hasYear) return year;
  return null;
}

// Rating in brackets, or null when the tag is missing or not a number.
function metaElo(value) {
  const text = metaValue(value);
  return text && /^\d+$/.test(text) ? `(${text})` : null;
}

// PGN TimeControl ("300+3") to a readable form ("5+3"). Whole minutes are shown
// in minutes, other base times in seconds ("90s+1"). Values that do not match the
// clock format are shown as they are, e.g. "1/86400".
function formatTimeControl(value) {
  const text = metaValue(value);
  if (!text) return null;
  const match = /^(\d+)(?:\+(\d+))?$/.exec(text);
  if (!match) return text;
  const [, base, increment] = match;
  const seconds = Number(base);
  const baseText = seconds > 0 && seconds % 60 === 0 ? `${seconds / 60}` : `${seconds}s`;
  return increment === undefined ? baseText : `${baseText}+${increment}`;
}

// Fills the left side panel (game information) from the root metadata. Fields without a
// value are hidden. The panel is hidden when the right side panel is off or when there
// is nothing to show.
function renderMetaPanel() {
  if (!metaPanelEl) return;
  const meta = moveTree?.metadata || {};
  const white = metaValue(meta.White);
  const black = metaValue(meta.Black);
  const fields = {
    'meta-white-name': white,
    'meta-white-elo': metaElo(meta.WhiteElo),
    'meta-black-name': black,
    'meta-black-elo': metaElo(meta.BlackElo),
    'meta-result': metaValue(meta.Result),
    'meta-date': formatMetaDate(meta.Date),
    'meta-time': formatTimeControl(meta.TimeControl) ? `Time control: ${formatTimeControl(meta.TimeControl)}` : null,
    'meta-event': metaValue(meta.Event),
    'meta-round': metaValue(meta.Round) ? `Round ${metaValue(meta.Round)}` : null,
  };
  for (const [id, text] of Object.entries(fields)) {
    const node = document.getElementById(id);
    node.textContent = text ?? '';
    node.hidden = !text;
  }
  // A player row is shown only when the player's name is known.
  document.getElementById('meta-white').hidden = !white;
  document.getElementById('meta-black').hidden = !black;
  const hasData = Object.values(fields).some(Boolean);
  metaPanelEl.hidden = !hasData;
}


if (showDestsInput) {
  showDestsInput.addEventListener('change', () => {
    showDestsInput.closest('.settings-item')?.setAttribute('aria-checked', String(showDestsInput.checked));
    showDests = showDestsInput.checked;
    localStorage.setItem('64-quarks.showDests', String(showDests));
    refresh();
  });
}

if (showLastMoveInput) {
  showLastMoveInput.addEventListener('change', () => {
    showLastMoveInput.closest('.settings-item')?.setAttribute('aria-checked', String(showLastMoveInput.checked));
    showLastMove = showLastMoveInput.checked;
    localStorage.setItem('64-quarks.showLastMove', String(showLastMove));
    refresh();
  });
}


document.addEventListener('click', (event) => {
  if (!moveContextMenu.hidden && !moveContextMenu.contains(event.target)) {
    closeMoveContextMenu();
  }
  if (
    !settingsMenu.hidden &&
    !settingsToggle.contains(event.target) &&
    !settingsMenu.contains(event.target)
  ) {
    closeSettings();
  }
});

renderTimer();

initSidebarSplit();

function loadState() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(STATE_KEY));
  } catch {
    return false;
  }
  if (!saved) return false;

  if (saved.moveTree) {
    const ids = new Set();
    const isValidNode = (node, isRoot = false) => {
      if (!node || typeof node.id !== 'string' || ids.has(node.id) || !isValidFen(node.fen)) return false;
      if (!isRoot && (typeof node.san !== 'string' || !['w', 'b'].includes(node.color))) return false;
      if (!Array.isArray(node.children)) return false;
      ids.add(node.id);
      return node.children.every((child) => isValidNode(child));
    };
    if (!isValidNode(saved.moveTree, true)) return false;
    moveTree = saved.moveTree;
    if (!moveTree.metadata || typeof moveTree.metadata !== 'object') moveTree.metadata = {};
    nextNodeId = 1;
    reindexTree();
    currentNodeId = nodeById.has(saved.currentNodeId) ? saved.currentNodeId : moveTree.id;
  } else {
    if (!Array.isArray(saved.timeline) || saved.timeline.length === 0) return false;
    if (!saved.timeline.every((entry) => entry && isValidFen(entry.fen))) return false;
    moveTree = createRoot(saved.timeline[0].fen);
    let parent = moveTree;
    nextNodeId = 1;
    saved.timeline.slice(1).forEach((entry) => {
      const child = {
        ...entry,
        id: newNodeId(),
        promotion: entry.promotion || null,
        children: [],
        mainChildId: null,
      };
      parent.children.push(child);
      parent.mainChildId = child.id;
      parent = child;
    });
    reindexTree();
    const legacyCursor = Number.isInteger(saved.cursor) ? saved.cursor : saved.timeline.length - 1;
    const legacyPath = [moveTree, ...Array.from(nodeById.values()).filter((node) => node.id !== moveTree.id)];
    currentNodeId = legacyPath[Math.max(0, Math.min(legacyCursor, legacyPath.length - 1))].id;
  }

  resetMoveSelection();
  currentFen = currentNode().fen;
  game = makeGame(currentFen);
  if (!game) return false;
  flipped = Boolean(saved.flipped);
  return true;
}

if (!loadState()) {
  currentFen = START_FEN;
  game = makeGame(START_FEN);
  moveTree = createRoot(START_FEN);
  currentNodeId = moveTree.id;
  nextNodeId = 1;
  reindexTree();
}
initMovesSettings(moveLayout, (value) => {
  moveLayout = value;
  renderMoveList();
});
refresh();

if (moveList) {
  let lastMoveListWidth = moveList.clientWidth;
  const moveListResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0].contentRect.width;
    if (width === lastMoveListWidth) return;
    lastMoveListWidth = width;
    updateMoveCellWidth();
  });
  moveListResizeObserver.observe(moveList);
}
