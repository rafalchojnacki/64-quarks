// DSC-23M-FEN inference in the browser. The model is a master-focused
// human-move predictor; only its move probabilities are used here, for the
// Masters probability column. The ONNX file is not shipped by default: place a
// converted file at public/models/dsc-23m-fen.onnx, or host it elsewhere and
// update DSC_MODEL_URL below.
import { Chess } from 'chess.js';

export const DSC_MODEL_URL = 'https://pub-30bb575c84bc40baa6d228c2660de2ad.r2.dev/dsc-23m-fen.onnx';

const TIME_CONTROL_CODES = { bullet: 1, blitz: 2, rapid: 3, classical: 4, correspondence: 5 };
const RATING_SYSTEM_CODES = { fide: 1, lichess: 2, other: 3 };
const VENUE_CODES = { otb: 1, online: 2 };

let sessionPromise = null;

function squareIndex(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  return (rank - 1) * 8 + file;
}

function orient(square, whiteToMove) {
  return whiteToMove ? square : square ^ 56;
}

function encodePosition(fen) {
  const parts = fen.split(/\s+/);
  const placement = parts[0];
  const whiteToMove = parts[1] !== 'b';
  const castling = parts[2] || '-';
  const ep = parts[3] || '-';
  const halfmove = Math.min(Number(parts[4] || 0), 100);
  const moverColor = whiteToMove ? 'w' : 'b';

  const pieceAt = new Array(64);
  const rows = placement.split('/');
  for (let r = 0; r < 8; r += 1) {
    const rank = 8 - r;
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        pieceAt[(rank - 1) * 8 + file] = ch;
        file += 1;
      }
    }
  }

  const pieceTypeIndex = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
  const tokens = new Uint8Array(64 * 104);
  for (let sq = 0; sq < 64; sq += 1) {
    const piece = pieceAt[sq];
    if (!piece) continue;
    const color = piece === piece.toUpperCase() ? 'w' : 'b';
    const moverPiece = color === moverColor;
    const pt = pieceTypeIndex[piece.toLowerCase()];
    const channel = moverPiece ? pt : 6 + pt;
    const oriented = orient(sq, whiteToMove);
    for (let k = 0; k < 8; k += 1) {
      tokens[oriented * 104 + k * 12 + channel] = 1;
    }
  }

  const moverK = moverColor === 'w' ? castling.includes('K') : castling.includes('k');
  const moverQ = moverColor === 'w' ? castling.includes('Q') : castling.includes('q');
  const oppK = moverColor === 'w' ? castling.includes('k') : castling.includes('K');
  const oppQ = moverColor === 'w' ? castling.includes('q') : castling.includes('Q');
  for (let sq = 0; sq < 64; sq += 1) {
    const o = sq * 104;
    tokens[o + 96] = moverK ? 1 : 0;
    tokens[o + 97] = moverQ ? 1 : 0;
    tokens[o + 98] = oppK ? 1 : 0;
    tokens[o + 99] = oppQ ? 1 : 0;
  }
  if (ep && ep !== '-') {
    const sq = squareIndex(ep);
    const oriented = orient(sq, whiteToMove);
    tokens[oriented * 104 + 100] = 1;
  }
  for (let sq = 0; sq < 64; sq += 1) {
    tokens[sq * 104 + 103] = halfmove;
  }
  return tokens;
}

function legalData(fen) {
  const board = new Chess(fen);
  const whiteToMove = board.turn() === 'w';
  const legal = new Uint8Array(16384);
  const indexToUci = new Map();
  for (const move of board.moves({ verbose: true })) {
    const from = squareIndex(move.from);
    const to = squareIndex(move.to);
    const of = orient(from, whiteToMove);
    const ot = orient(to, whiteToMove);
    const promoCode = move.promotion === 'r' ? 1 : move.promotion === 'b' ? 2 : move.promotion === 'n' ? 3 : 0;
    const idx = (of * 64 + ot) * 4 + promoCode;
    legal[idx] = 1;
    indexToUci.set(idx, `${move.from}${move.to}${move.promotion || ''}`);
  }
  return { legal, indexToUci, whiteToMove };
}

const DSC_CACHE_NAME = '64-quarks-models';

export async function loadDsc(onStatus) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // Try Cache Storage first, so the model is not re-downloaded after a
      // page refresh.
      if (typeof caches !== 'undefined') {
        try {
          const cache = await caches.open(DSC_CACHE_NAME);
          const cached = await cache.match(DSC_MODEL_URL);
          if (cached) {
            const bytes = new Uint8Array(await cached.arrayBuffer());
            if (bytes.length && bytes[0] === 60) {
              throw new Error('model file not found');
            }
            onStatus?.({ phase: 'prepare' });
            const ort = await import('onnxruntime-web');
            const session = await ort.InferenceSession.create(bytes.buffer, {
              executionProviders: ['wasm'],
              graphOptimizationLevel: 'basic',
            });
            return session;
          }
        } catch (error) {
          // Fall through to a network fetch.
        }
      }

      onStatus?.({ phase: 'download', loaded: 0, total: 0 });
      const response = await fetch(DSC_MODEL_URL);
      if (!response.ok) throw new Error(`DSC model unavailable: HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error('model file not found');
      }
      const total = Number(response.headers.get('content-length') || 0);
      const reader = response.body?.getReader();
      let bytes;
      if (reader) {
        const chunks = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loaded += value.byteLength;
            onStatus?.({ phase: 'download', loaded, total });
          }
        }
        bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      } else {
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (bytes.length && bytes[0] === 60) {
        throw new Error('model file not found');
      }

      // Store the downloaded model for subsequent page loads (best-effort).
      if (typeof caches !== 'undefined') {
        try {
          const cache = await caches.open(DSC_CACHE_NAME);
          const cacheResponse = new Response(bytes.buffer, {
            headers: { 'content-type': 'application/octet-stream' },
          });
          cache.put(DSC_MODEL_URL, cacheResponse).catch(() => {});
        } catch {
          // ignore cache errors
        }
      }

      onStatus?.({ phase: 'prepare' });
      const ort = await import('onnxruntime-web');
      const session = await ort.InferenceSession.create(bytes.buffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'basic',
      });
      return session;
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

export async function predictDsc({ fen, ratings = [2578], timeControl = 'classical', ratingSystem = 'fide', venue = 'otb' }) {
  const session = await loadDsc();
  const ort = await import('onnxruntime-web');
  const { legal, indexToUci, whiteToMove } = legalData(fen);
  const tokens = encodePosition(fen);
  const tc = TIME_CONTROL_CODES[timeControl] ?? 4;
  const rsys = RATING_SYSTEM_CODES[ratingSystem] ?? 1;
  const venueCode = VENUE_CODES[venue] ?? 1;
  const sums = new Map();

  let count = 0;
  for (const rating of ratings) {
    const elo = Number(rating);
    const feeds = {
      tokens: new ort.Tensor('uint8', tokens, [1, 64, 104]),
      legal: new ort.Tensor('bool', legal, [1, 16384]),
      elo_mover: new ort.Tensor('float32', new Float32Array([elo]), [1]),
      elo_opp: new ort.Tensor('float32', new Float32Array([elo]), [1]),
      tc: new ort.Tensor('int64', BigInt64Array.from([BigInt(tc)]), [1]),
      rsys: new ort.Tensor('int64', BigInt64Array.from([BigInt(rsys)]), [1]),
      venue: new ort.Tensor('int64', BigInt64Array.from([BigInt(venueCode)]), [1]),
      hist_count: new ort.Tensor('int64', BigInt64Array.from([BigInt(0)]), [1]),
    };
    const results = await session.run(feeds);
    const logits = results.policy_logits.data;
    let max = -Infinity;
    for (let i = 0; i < logits.length; i += 1) {
      if (legal[i] && logits[i] > max) max = logits[i];
    }
    let sum = 0;
    const exps = new Float64Array(logits.length);
    for (let i = 0; i < logits.length; i += 1) {
      if (legal[i]) {
        exps[i] = Math.exp(logits[i] - max);
        sum += exps[i];
      }
    }
    for (const [idx] of indexToUci) {
      const p = sum ? exps[idx] / sum : 0;
      sums.set(idx, (sums.get(idx) || 0) + p);
    }
    count += 1;
  }

  const moves = new Map();
  let topProbability = 0;
  for (const [idx, uci] of indexToUci) {
    const p = count ? (sums.get(idx) || 0) / count : 0;
    moves.set(uci, p);
    if (p > topProbability) topProbability = p;
  }
  return { moves, topProbability };
}
