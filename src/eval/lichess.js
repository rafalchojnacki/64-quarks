// Lichess opening explorer, used for the Peer results and Masters columns.
// https://lichess.org/api#tag/Opening-Explorer

const LICHESS_URL = 'https://explorer.lichess.org/lichess';
const MASTERS_URL = 'https://explorer.lichess.org/masters';

// A database is used for a position only when it has at least this many games there.
export const MIN_DB_GAMES = 100;

// Rating groups the Lichess database accepts. Each group runs from its value up
// to the next one.
const RATING_GROUPS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];

// After an HTTP 429, no request is sent for this long.
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const CACHE_LIMIT = 100;

export class LichessError extends Error {}

// The Lichess rating group that contains `rating` (e.g. 1500 -> 1400).
export function ratingGroup(rating) {
  return RATING_GROUPS.filter((group) => group <= rating).at(-1);
}

// Speed used when the game's time control is unknown.
export const FALLBACK_SPEED = 'blitz';

// Classifies a PGN TimeControl value ("900+10", seconds) the way Lichess does:
// the estimated duration is base + 40 * increment, compared with the thresholds
// below. Lichess's ultraBullet (under 30 s) is treated as bullet, so the four
// speeds shown in the UI are the only ones used. Returns null when the value is
// missing or not a clock time control (e.g. "-" or "1/86400").
export function speedForTimeControl(value) {
  const text = String(value ?? '').trim();
  if (/^\d+\/\d+$/.test(text)) return 'correspondence';
  const match = /^(\d+)(?:\+(\d+))?$/.exec(text);
  if (!match) return null;
  const estimated = Number(match[1]) + 40 * Number(match[2] ?? 0);
  if (estimated < 30) return 'ultraBullet';
  if (estimated < 180) return 'bullet';
  if (estimated < 480) return 'blitz';
  if (estimated < 1500) return 'rapid';
  return 'classical';
}

export function gameSpeed(timeControl) {
  return speedForTimeControl(timeControl) ?? FALLBACK_SPEED;
}

// Requests go one at a time, as the Lichess API asks.
let queue = Promise.resolve();
let cooldownUntil = 0;
// Successful responses by URL. Failed requests are not cached.
const cache = new Map();
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

// The explorer writes castling as the king moving onto its rook (e1h1); chess
// moves and engine lines use the king's destination (e1g1).
const CASTLING_UCI = { e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' };

// Turns a raw explorer response into { total, moves: Map<uci, {white, draws, black}> }.
// Counts are from White's point of view.
function normalize(data) {
  const total = (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0);
  const moves = new Map();
  for (const move of data.moves ?? []) {
    const uci = CASTLING_UCI[move.uci] ?? move.uci;
    moves.set(uci, { white: move.white, draws: move.draws, black: move.black, averageRating: move.averageRating ?? null });
  }
  return {
    total,
    moves,
    opening: data.opening ?? null,
    counts: { white: data.white ?? 0, draws: data.draws ?? 0, black: data.black ?? 0 },
  };
}

// The explorer rejects anonymous requests, so every request needs a token.
// Callers check for a token first; this guard keeps that rule in one place.
async function getExplorer(url, token, requireToken = true) {
  if (requireToken && !token) throw new LichessError('a Lichess API token is required');
  if (cache.has(url)) return cache.get(url);
  return enqueue(async () => {
    if (cache.has(url)) return cache.get(url);
    if (Date.now() < cooldownUntil) throw new LichessError('rate limited, try again later');

    let response;
    try {
      response = await fetch(url, token ? { headers: authHeaders(token) } : {});
    } catch {
      throw new LichessError('network error');
    }
    if (response.status === 429) {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw new LichessError('rate limited, try again later');
    }
    if (response.status === 401 || response.status === 403) {
      throw new LichessError('Lichess rejected the API token');
    }
    if (!response.ok) throw new LichessError(`HTTP ${response.status}`);

    const data = normalize(await response.json());
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(url, data);
    return data;
  });
}

function authHeaders(token) {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

// Checks that the explorer accepts the token. Resolves when it does and throws a
// LichessError otherwise. Not cached, so each check reaches the server.
export function validateLichessToken(token) {
  const url = `${MASTERS_URL}?${new URLSearchParams({ fen: START_FEN })}`;
  return enqueue(async () => {
    let response;
    try {
      response = await fetch(url, { headers: authHeaders(token) });
    } catch {
      throw new LichessError('network error, try again');
    }
    if (response.status === 401 || response.status === 403) {
      throw new LichessError('Lichess rejected this token');
    }
    if (response.status === 429) throw new LichessError('rate limited, try again later');
    if (!response.ok) throw new LichessError(`Lichess returned HTTP ${response.status}`);
    return true;
  });
}

// Fetches the account behind a token, so the connected username can be shown.
// Resolves with the username string, or throws a LichessError.
export function fetchLichessAccount(token) {
  return enqueue(async () => {
    let response;
    try {
      response = await fetch('https://lichess.org/api/account', { headers: authHeaders(token) });
    } catch {
      throw new LichessError('network error, try again');
    }
    if (response.status === 401 || response.status === 403) {
      throw new LichessError('Lichess rejected this token');
    }
    if (response.status === 429) throw new LichessError('rate limited, try again later');
    if (!response.ok) throw new LichessError(`Lichess returned HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !data.username) throw new LichessError('Lichess did not return a username');
    return data.username;
  });
}

// Fetches the most recent games of a Lichess user. Resolves with an array of
// game objects (NDJSON), newest first. Needs a token for the user's own games;
// anonymous access is throttled and only sees public games.
export function fetchLichessGames(username, token, max = 10) {
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${encodeURIComponent(String(max))}&opening=true`;
  return enqueue(async () => {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/x-ndjson',
          ...(token ? authHeaders(token) : {}),
        },
      });
    } catch {
      throw new LichessError('network error, try again');
    }
    if (response.status === 401 || response.status === 403) {
      throw new LichessError('Lichess rejected the API token');
    }
    if (response.status === 429) throw new LichessError('rate limited, try again later');
    if (!response.ok) throw new LichessError(`Lichess returned HTTP ${response.status}`);
    const text = await response.text();
    return text
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new LichessError('invalid response from Lichess');
        }
      });
  });
}

// Fetches the account's ratings per speed. Resolves with
// { bullet, blitz, rapid, classical } (numbers or null), or throws.
export function fetchLichessRatings(token) {
  return enqueue(async () => {
    let response;
    try {
      response = await fetch('https://lichess.org/api/account', { headers: authHeaders(token) });
    } catch {
      throw new LichessError('network error, try again');
    }
    if (response.status === 401 || response.status === 403) {
      throw new LichessError('Lichess rejected this token');
    }
    if (response.status === 429) throw new LichessError('rate limited, try again later');
    if (!response.ok) throw new LichessError(`Lichess returned HTTP ${response.status}`);
    const data = await response.json();
    const perfs = data?.perfs || {};
    const get = (key) => (perfs[key] && typeof perfs[key].rating === 'number' ? perfs[key].rating : null);
    return { ultraBullet: get('ultraBullet'), bullet: get('bullet'), blitz: get('blitz'), rapid: get('rapid'), classical: get('classical'), correspondence: get('correspondence') };
  });
}

// Lichess games for the position, limited to the rating group of `rating` and
// to games of the same speed (bullet, blitz, rapid or classical). The speed is
// derived from the game's PGN TimeControl (see gameSpeed/speedForTimeControl)
// and defaults to blitz when it is missing or not a clock time control.
// Needs a token.
export function fetchPeerDatabase({ fen, rating, speed, years = null, token }) {
  const params = addYears(new URLSearchParams({
    variant: 'standard',
    fen,
    ratings: String(ratingGroup(rating)),
    speeds: speed,
  }), years, true);
  return getExplorer(`${LICHESS_URL}?${params}`, token, true);
}

// Masters database (all recorded classical games between strong players). It is
// not filtered by speed or rating: every game in it is classical, so the time
// control is effectively fixed to classical. Needs a token.
export function fetchMastersDatabase({ fen, years = null, token }) {
  const params = addYears(new URLSearchParams({ fen }), years, false);
  return getExplorer(`${MASTERS_URL}?${params}`, token, false);
}

// Adds the time range to an explorer request. `years` is { from, to } (either end
// may be null, meaning open) or null for all games. The peer database takes
// YYYY-MM months, the masters database plain years.
function addYears(params, years, monthly) {
  if (!years) return params;
  const bound = (year, end) => (monthly ? `${year}-${end ? '12' : '01'}` : String(year));
  if (years.from != null) params.set('since', bound(years.from, false));
  if (years.to != null) params.set('until', bound(years.to, true));
  return params;
}

// Lichess Syzygy tablebases. Public, no token required.
const TABLEBASE_URL = 'https://tablebase.lichess.org/standard';
const tablebaseCache = new Map();

export function fetchTablebase(input) {
  const fen = typeof input === 'string' ? input : input?.fen;
  if (!fen) throw new LichessError('a FEN is required');
  if (tablebaseCache.has(fen)) return Promise.resolve(tablebaseCache.get(fen));
  const url = `${TABLEBASE_URL}?${new URLSearchParams({ fen })}`;
  return enqueue(async () => {
    if (tablebaseCache.has(fen)) return tablebaseCache.get(fen);
    let response;
    try {
      response = await fetch(url);
    } catch {
      throw new LichessError('network error');
    }
    if (response.status === 429) {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw new LichessError('rate limited, try again later');
    }
    if (!response.ok) throw new LichessError(`HTTP ${response.status}`);
    const data = await response.json();
    if (tablebaseCache.size >= CACHE_LIMIT) tablebaseCache.delete(tablebaseCache.keys().next().value);
    tablebaseCache.set(fen, data);
    return data;
  });
}

export const fetchTablebaseDatabase = fetchTablebase;

export function isTablebaseAvailable(data) {
  return Boolean(data && Array.isArray(data.moves) && data.category && data.category !== 'unknown');
}

export function tablebasePositionScore(data) {
  if (!isTablebaseAvailable(data)) return null;
  const category = data.category;
  if (category === 'draw' || category === 'insufficient_material') {
    return { cp: 0 };
  }
  if (category === 'win') {
    return { mate: data.dtm != null ? data.dtm : 1 };
  }
  if (category === 'loss') {
    return { mate: data.dtm != null ? data.dtm : -1 };
  }
  return null;
}

export function tablebaseMoveScore(entry) {
  if (!entry) return null;
  const category = entry.category;
  if (category === 'unknown') return null;
  if (category === 'draw' || category === 'insufficient_material' || entry.insufficient_material) {
    return { cp: 0 };
  }
  if (category === 'win') {
    const distance = entry.dtm != null ? Math.abs(entry.dtm) + 1 : 1;
    return { mate: -distance };
  }
  if (category === 'loss') {
    const distance = entry.dtm != null ? Math.abs(entry.dtm) + 1 : 1;
    return { mate: distance };
  }
  if (entry.checkmate) {
    return { mate: -1 };
  }
  if (entry.stalemate) {
    return { cp: 0 };
  }
  return null;
}
