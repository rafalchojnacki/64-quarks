import { Chess } from 'chess.js';
import { swapWdl } from './format.js';

// Hosted on Hugging Face rather than bundled: the ~88 MiB model exceeds
// Cloudflare Pages' 25 MiB per-file limit.
export const MAIA_MODEL_URL =
  'https://huggingface.co/cemoss17/maia3-onnx/resolve/main/maia3_23m.onnx';
let loading = null;
let statusListener = null;

function emitStatus(status) {
  statusListener?.(status);
}

// Loading has two stages, reported to onStatus:
//   { phase: 'download', loaded, total }  fetching the weights (total may be 0 if
//                                          the server omits Content-Length)
//   { phase: 'prepare' }                  building the ONNX session
// A cached model skips the download stage, so only 'prepare' is reported.
// The maia3-js and onnxruntime code is loaded on first use, not at page load.
export function loadMaia(onStatus) {
  if (onStatus) statusListener = onStatus;
  if (!loading) {
    loading = (async () => {
      const { Maia3, ensureModelWeb } = await import('maia3-js/web');
      const modelBytes = await ensureModelWeb({
        variant: '23m',
        url: MAIA_MODEL_URL,
        onProgress: (loaded, total) => emitStatus({ phase: 'download', loaded, total }),
      });
      emitStatus({ phase: 'prepare' });
      const instance = new Maia3({
        variant: '23m',
        modelBytes,
        numThreads: 1,
        simd: true,
        proxy: false,
      });
      await instance.load();
      return instance;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Scores the candidate moves of one position.
//   fen:       position being analysed (side to move is the mover)
//   moves:     [{ uci, childFen }] one entry per engine line, childFen is the
//              position after that move
//   rating:    rating used for the peer win/draw/loss and the peer move probability
//              (blitz-scale; Maia does not use the game's time control)
//   ratings:   Maia3 ratings averaged for the Masters move probability (see
//              MASTER_RANGES); blitz-scale, independent of the game's time control
//   probabilities: compute the Masters move probability (averaged over `ratings`).
//   peerProbability: compute the Peer move probability (for `rating`).
//   wdl:       compute the peer win/draw/loss from the child positions.
// Skipping a value saves inference when that column is taken from a database.
// Returns { moves, topProbability, peerTopProbability }: moves has one
// { probability, peerProbability, wdl } per input move; topProbability is the
// highest averaged Masters probability, peerTopProbability the highest Peer
// probability. Values that were not requested are null.
export async function scoreMoves({ fen, moves, rating, ratings, probabilities = true, peerProbability = false, wdl = true }) {
  const instance = await loadMaia();

  const positions = probabilities
    ? await instance.predictBatch(
        ratings.map((selfElo) => ({ fen, selfElo })),
        { onError: 'collect' },
      )
    : [];

  const peerPositions = peerProbability
    ? await instance.predictBatch([{ fen, selfElo: rating }], { onError: 'collect' })
    : [];

  const childInputs = [];
  const childIndex = [];
  moves.forEach((move, index) => {
    if (!wdl || !move.childFen || isGameOver(move.childFen)) return;
    childInputs.push({ fen: move.childFen, selfElo: rating, oppoElo: rating });
    childIndex.push(index);
  });
  const children = childInputs.length
    ? await instance.predictBatch(childInputs, { onError: 'collect' })
    : [];

  const valid = positions.filter((position) => !(position instanceof Error));
  const validPeer = peerPositions.filter((position) => !(position instanceof Error));

  // Highest averaged probability over every legal move in the position.
  // Circles are scaled against it, so the most probable move is always full.
  const sums = new Map();
  for (const position of valid) {
    for (const [uci, p] of position.moves) sums.set(uci, (sums.get(uci) ?? 0) + p);
  }
  const topProbability = valid.length
    ? Math.max(0, ...[...sums.values()].map((sum) => sum / valid.length))
    : null;

  const peerSums = new Map();
  for (const position of validPeer) {
    for (const [uci, p] of position.moves) peerSums.set(uci, (peerSums.get(uci) ?? 0) + p);
  }
  const peerTopProbability = validPeer.length
    ? Math.max(0, ...[...peerSums.values()].map((sum) => sum / validPeer.length))
    : null;

  const results = moves.map((move) => {
    const probabilities = valid.map((position) => position.moves.get(move.uci) ?? 0);
    const peerProbabilities = validPeer.map((position) => position.moves.get(move.uci) ?? 0);
    return {
      probability: probabilities.length ? average(probabilities) : null,
      peerProbability: peerProbabilities.length ? average(peerProbabilities) : null,
      wdl: null,
    };
  });

  children.forEach((child, i) => {
    if (child instanceof Error) return;
    // The child is scored from the opponent's side to move.
    results[childIndex[i]].wdl = swapWdl(child.wdl);
  });

  return { moves: results, topProbability, peerTopProbability };
}

function isGameOver(fen) {
  const chess = new Chess(fen);
  return chess.isGameOver();
}
