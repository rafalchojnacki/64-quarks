import { Chess } from 'chess.js';

// Scores are stored as UCI reports them: from the side to move's point of view.
export const MATE_CP = 10000;

// Parses one UCI "info" line. Returns null for lines without an exact score.
export function parseInfoLine(line) {
  if (!line.startsWith('info ')) return null;
  const tokens = line.trim().split(/\s+/);
  const value = (key) => {
    const i = tokens.indexOf(key);
    return i >= 0 ? tokens[i + 1] : undefined;
  };
  const depth = Number(value('depth'));
  const scoreIndex = tokens.indexOf('score');
  const pvIndex = tokens.indexOf('pv');
  if (!Number.isFinite(depth) || scoreIndex < 0 || pvIndex < 0) return null;
  // Bounds (lowerbound/upperbound) are not exact scores; skip them.
  if (tokens.includes('lowerbound') || tokens.includes('upperbound')) return null;
  const kind = tokens[scoreIndex + 1];
  const amount = Number(tokens[scoreIndex + 2]);
  if (!Number.isFinite(amount)) return null;
  let score;
  if (kind === 'cp') score = { cp: amount };
  else if (kind === 'mate') score = { mate: amount };
  else return null;
  const multipv = Number(value('multipv') ?? 1);
  const nodes = Number(value('nodes'));
  const wdlIndex = tokens.indexOf('wdl');
  let wdl = null;
  if (wdlIndex >= 0 && wdlIndex + 3 < tokens.length) {
    const w = Number(tokens[wdlIndex + 1]);
    const d = Number(tokens[wdlIndex + 2]);
    const l = Number(tokens[wdlIndex + 3]);
    if (Number.isFinite(w) && Number.isFinite(d) && Number.isFinite(l)) {
      const total = w + d + l;
      if (total > 0) wdl = { win: w / total, draw: d / total, loss: l / total };
    }
  }
  return {
    depth,
    multipv: Number.isFinite(multipv) ? multipv : 1,
    nodes: Number.isFinite(nodes) ? nodes : null,
    score,
    pv: tokens.slice(pvIndex + 1),
    wdl,
  };
}

// Side-to-move score as a centipawn number. Mates become large values that
// keep their sign and are closer to zero the further away they are.
export function scoreToCp(score) {
  if (score.mate !== undefined) {
    const sign = score.mate > 0 ? 1 : -1;
    return sign * (MATE_CP - Math.abs(score.mate) * 100);
  }
  return score.cp;
}

// White's point of view, in pawns (one decimal) or as a mate distance.
export function formatScore(score, sideToMove) {
  const sign = sideToMove === 'w' ? 1 : -1;
  if (score.mate !== undefined) {
    const mate = sign * score.mate;
    return mate < 0 ? `-#${Math.abs(mate)}` : `#${mate}`;
  }
  const pawns = Number(((sign * score.cp) / 100).toFixed(1));
  if (pawns === 0) return '0.0';
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

// 1 to 5 circles for a probability in [0, 1].
export function circlesForProbability(p) {
  if (!Number.isFinite(p)) return 1;
  if (p < 0.01) return 0;
  return Math.min(5, Math.max(1, Math.ceil(p * 5)));
}

// Move-list glyph tint ids (see --glyph-tint-N in style.css), by centipawns lost
// relative to the best line for the side to move.
const LOSS_BANDS = [
  { max: 10, tint: 1, label: 'Best' },
  { max: 50, tint: 5, label: 'Good' },
  { max: 150, tint: 6, label: 'Inaccuracy' },
  { max: 300, tint: 2, label: 'Mistake' },
  { max: Infinity, tint: 4, label: 'Blunder' },
];

export function lossBand(lossCp) {
  const cp = Math.max(0, lossCp);
  return LOSS_BANDS.find((band) => cp <= band.max);
}

// Centipawns lost by a line compared with the best line, mover's point of view.
export function lossForLine(bestScore, lineScore) {
  return scoreToCp(bestScore) - scoreToCp(lineScore);
}

// Child positions are scored from the opponent's side to move. Flipping gives
// the WDL of the side that just moved.
export function swapWdl(wdl) {
  return { win: wdl.loss, draw: wdl.draw, loss: wdl.win };
}

// Converts a mover-relative WDL to White's point of view.
export function wdlFromWhite(moverWdl, moverColor) {
  return moverColor === 'w' ? moverWdl : swapWdl(moverWdl);
}

// Applies a UCI move to a FEN. Returns the new FEN, or null if the move is illegal.
export function applyUci(fen, uci) {
  const chess = new Chess(fen);
  const move = tryMove(chess, uci);
  return move ? chess.fen() : null;
}

function tryMove(chess, uci) {
  try {
    return chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
  } catch {
    return null;
  }
}

// SAN of one UCI move in a position, or null if the move is illegal.
export function uciToSan(fen, uci) {
  const move = tryMove(new Chess(fen), uci);
  return move ? move.san : null;
}

// Converts UCI moves to a numbered SAN string, e.g. "12. Nf3 Nc6 13. O-O".
// One entry per ply of a UCI line: SAN, move number, side that moved, and the
// FEN after the move. Stops at the first illegal move.
export function uciLineParts(fen, uciMoves, maxPlies = 10) {
  const chess = new Chess(fen);
  const parts = [];
  for (const uci of uciMoves.slice(0, maxPlies)) {
    const color = chess.turn();
    const moveNumber = chess.moveNumber();
    const move = tryMove(chess, uci);
    if (!move) break;
    parts.push({ san: move.san, color, moveNumber, fen: chess.fen() });
  }
  return parts;
}

// 8x8 grid of piece codes such as 'wK' or 'bp' (null for empty), rank 8 first.
export function boardGrid(fen) {
  return new Chess(fen)
    .board()
    .map((row) => row.map((square) => (square ? `${square.color}${square.type.toUpperCase()}` : null)));
}

export function sideToMoveOf(fen) {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

export function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}
