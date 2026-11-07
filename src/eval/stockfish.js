import { parseInfoLine } from './format.js';

export const ENGINE_URL = '/engine/stockfish-18-lite-single.js';

// Wraps a Stockfish Web Worker. Only one search runs at a time: Stockfish
// misbehaves if `go` arrives before the previous `bestmove`, so a new request
// stops the running search and waits for its bestmove. Only the newest pending
// request is kept; older ones resolve with `cancelled: true`.
export class StockfishEngine {
  constructor(url = ENGINE_URL) {
    this.worker = new Worker(url);
    this.current = null;
    this.pending = null;
    this.isReady = false;
    this.readyResolve = null;
    this.readyReject = null;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Callers await `ready` when they need it; this keeps an unawaited rejection quiet.
    this.ready.catch(() => {});
    this.worker.onmessage = (event) => this.handleLine(String(event.data));
    this.worker.onerror = (event) => this.fail(event.message || 'Engine failed');
    this.worker.postMessage('uci');
  }

  handleLine(line) {
    if (line === 'uciok') {
      this.worker.postMessage('isready');
      return;
    }
    if (line === 'readyok') {
      this.isReady = true;
      this.readyResolve();
      this.startNext();
      return;
    }
    if (!this.current) return;

    if (line.startsWith('info ')) {
      const info = parseInfoLine(line);
      if (!info) return;
      const search = this.current;
      const existing = search.lines.get(info.multipv);
      if (existing && existing.depth > info.depth) return;
      search.lines.set(info.multipv, info);
      if (!search.cancelled) {
        if (info.nodes !== null) search.onProgress?.(Math.min(1, info.nodes / search.nodes));
        search.onUpdate?.(sortedLines(search.lines));
      }
      return;
    }

    if (line.startsWith('bestmove')) {
      const search = this.current;
      this.current = null;
      search.resolve({
        cancelled: search.cancelled,
        lines: sortedLines(search.lines),
      });
      this.startNext();
    }
  }

  // Starts the newest pending search, or stops the running one so the pending
  // search can start after its bestmove.
  // onProgress(fraction) receives 0..1, the share of the node budget searched so far.
  analyze({ fen, multiPV, nodes, onUpdate, onProgress }) {
    return new Promise((resolve) => {
      const request = {
        fen,
        multiPV,
        nodes,
        onUpdate,
        onProgress,
        resolve,
        lines: new Map(),
        cancelled: false,
      };
      if (this.pending) this.pending.resolve({ cancelled: true, lines: [] });
      this.pending = request;
      if (this.current) {
        this.current.cancelled = true;
        this.worker.postMessage('stop');
      } else {
        this.startNext();
      }
    });
  }

  // Stops the running search and drops any pending one.
  cancel() {
    if (this.pending) {
      this.pending.resolve({ cancelled: true, lines: [] });
      this.pending = null;
    }
    if (this.current) {
      this.current.cancelled = true;
      this.worker.postMessage('stop');
    }
  }

  startNext() {
    if (!this.isReady || this.current || !this.pending) return;
    const search = this.pending;
    this.pending = null;
    this.current = search;
    this.worker.postMessage(`setoption name MultiPV value ${search.multiPV}`);
    this.worker.postMessage(`position fen ${search.fen}`);
    this.worker.postMessage(`go nodes ${search.nodes}`);
  }

  fail(message) {
    const error = new Error(message);
    if (!this.isReady) this.readyReject?.(error);
    if (this.current) {
      const search = this.current;
      this.current = null;
      search.resolve({ cancelled: true, lines: [], error });
    }
    if (this.pending) {
      this.pending.resolve({ cancelled: true, lines: [], error });
      this.pending = null;
    }
  }

  destroy() {
    this.cancel();
    this.worker.terminate();
  }
}

function sortedLines(map) {
  return [...map.values()].sort((a, b) => a.multipv - b.multipv);
}
