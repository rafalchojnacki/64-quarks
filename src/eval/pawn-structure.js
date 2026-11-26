// Named middlegame pawn structures (see public/data/pawn-structures.json and
// docs/designs/pawn-structures-data.md).
//
// Pattern notation: WHITE_PAWNS / BLACK_PAWNS. Each side is a list of file entries in
// ascending file order. A file entry is a file letter followed by either:
//   `-`          no pawn of that colour on the file;
//   squares      e.g. `c6` or `d2,d4`: exactly these pawns, and no others, on the file.
// Files that are not written are unconstrained. A pattern matches when every written
// entry holds for the position, either as-is or with the colours inverted.

const DATA_URL = '/data/pawn-structures.json';

let structuresPromise = null;
const compiledPatterns = new Map();

export function loadPawnStructures() {
  structuresPromise ??= fetch(DATA_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .catch(() => {
      // Allow a later call to retry after a transient failure.
      structuresPromise = null;
      return [];
    });
  return structuresPromise;
}

// Returns { white: Set<square>, black: Set<square> } from the placement field of a FEN.
export function pawnsOf(fen) {
  const white = new Set();
  const black = new Set();
  const placement = (fen ?? '').split(' ')[0] ?? '';
  const ranks = placement.split('/');
  for (let r = 0; r < ranks.length && r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
        continue;
      }
      if (ch === 'P' || ch === 'p') {
        const square = `${'abcdefgh'[file]}${8 - r}`;
        (ch === 'P' ? white : black).add(square);
      }
      file += 1;
    }
  }
  return { white, black };
}

function invertColours({ white, black }) {
  const flip = (square) => `${square[0]}${9 - Number(square[1])}`;
  return { white: new Set([...black].map(flip)), black: new Set([...white].map(flip)) };
}

// Parses one side ("c4 d- e4"). Returns the entries, or null if the text is malformed.
function parseSide(text) {
  if (!text) return [];
  const entries = [];
  let lastFile = '';
  for (const token of text.split(/\s+/)) {
    const file = token[0];
    if (!/^[a-h]$/.test(file ?? '') || file <= lastFile) return null;
    lastFile = file;
    const rest = token.slice(1);
    if (rest === '-') {
      entries.push({ file, squares: [] });
      continue;
    }
    const squares = token.split(',');
    const valid = squares.every((square) => /^[a-h][2-7]$/.test(square) && square[0] === file);
    if (!valid || new Set(squares).size !== squares.length) return null;
    entries.push({ file, squares });
  }
  return entries;
}

// Compiles a pattern once. Malformed patterns compile to null and are reported once.
function compilePattern(pattern) {
  if (compiledPatterns.has(pattern)) return compiledPatterns.get(pattern);
  const parts = String(pattern).split('/');
  const white = parts.length === 2 ? parseSide(parts[0].trim()) : null;
  const black = parts.length === 2 ? parseSide(parts[1].trim()) : null;
  let compiled = null;
  if (white && black) {
    // Score: how many constraints the pattern makes. Used to prefer the more specific pattern.
    const score = [...white, ...black].reduce((total, entry) => total + Math.max(1, entry.squares.length), 0);
    compiled = { white, black, score };
  } else {
    console.warn(`Malformed pawn structure pattern: "${pattern}"`);
  }
  compiledPatterns.set(pattern, compiled);
  return compiled;
}

// A file entry holds when the colour's pawns on that file are exactly the listed squares.
function sideMatches(entries, squares) {
  return entries.every(({ file, squares: wanted }) => {
    const actual = [...squares].filter((square) => square[0] === file);
    return actual.length === wanted.length && wanted.every((square) => squares.has(square));
  });
}

function patternMatches(compiled, pawns) {
  return sideMatches(compiled.white, pawns.white) && sideMatches(compiled.black, pawns.black);
}

// Pure matcher: returns the name of the most specific matching structure, or null.
// Ties keep dataset order.
export function matchPawnStructure(fen, structures) {
  if (!structures?.length) return null;
  const pawns = pawnsOf(fen);
  const inverted = invertColours(pawns);
  let best = null;
  for (const structure of structures) {
    for (const pattern of structure.patterns ?? []) {
      const compiled = compilePattern(pattern);
      if (!compiled) continue;
      if (best && compiled.score <= best.score) continue;
      if (patternMatches(compiled, pawns) || patternMatches(compiled, inverted)) {
        best = { name: structure.name, score: compiled.score };
      }
    }
  }
  return best?.name ?? null;
}

export async function pawnStructureName(fen) {
  return matchPawnStructure(fen, await loadPawnStructures());
}
