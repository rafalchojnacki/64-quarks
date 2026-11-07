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
  const match = /^(\d+)(?:\+(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const estimated = Number(match[1]) + 40 * Number(match[2] ?? 0);
  if (estimated < 180) return 'bullet';
  if (estimated < 480) return 'blitz';
  if (estimated < 1500) return 'rapid';
  return 'classical';
}

// Speed for the open game: its own class, or the blitz reference if unknown.
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

// Turns a raw explorer response into { total, moves: Map<uci, {white, draws, black}> }.
// Counts are from White's point of view.
function normalize(data) {
  const total = (data.white ?? 0) + (data.draws ?? 0) + (data.black ?? 0);
  const moves = new Map();
  for (const move of data.moves ?? []) {
    moves.set(move.uci, { white: move.white, draws: move.draws, black: move.black });
  }
  return { total, moves };
}

// The explorer rejects anonymous requests, so every request needs a token.
// Callers check for a token first; this guard keeps that rule in one place.
async function getExplorer(url, token) {
  if (!token) throw new LichessError('a Lichess API token is required');
  if (cache.has(url)) return cache.get(url);
  return enqueue(async () => {
    if (cache.has(url)) return cache.get(url);
    if (Date.now() < cooldownUntil) throw new LichessError('rate limited, try again later');

    let response;
    try {
      response = await fetch(url, { headers: authHeaders(token) });
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

// Lichess games for the position, limited to the rating group of `rating` and
// to games of the same speed (bullet, blitz, rapid or classical). Needs a token.
export function fetchPeerDatabase({ fen, rating, speed, token }) {
  const params = new URLSearchParams({
    variant: 'standard',
    fen,
    ratings: String(ratingGroup(rating)),
    speeds: speed,
  });
  return getExplorer(`${LICHESS_URL}?${params}`, token);
}

// Masters database (all recorded classical games between strong players). Needs a token.
export function fetchMastersDatabase({ fen, token }) {
  return getExplorer(`${MASTERS_URL}?${new URLSearchParams({ fen })}`, token);
}
