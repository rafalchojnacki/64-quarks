# 64 Quarks

A browser-based chess analysis board. Paste or build a position, explore the
move tree, and see engine lines with human-likelihood data.

## Features

- Board with move tree, PGN import and export, and a timer.
- Evaluation panel: Stockfish 18 (lite, WASM) lines with win/draw/loss.
- Peer and Masters columns from the Lichess opening explorer (needs a token).
  Peer data is filtered by the game's time control (speed derived from its PGN
  TimeControl, defaulting to blitz when unknown); the Masters database holds
  classical games only. Maia3 estimates are conditioned on a Lichess player
  rating and do not use the game's time control.
- Maia3 human-move estimates where the database has too few games (marked `E`).
- DSC-23M-FEN (ChessDS) master-focused human-move estimates for the Masters
  probability column where the Masters database has too few games (marked `E`).
- Five page themes and three piece sets.

## Evaluation models

Stockfish is bundled with the app. The human-move models run locally in the
browser and are loaded when evaluation needs them.

- **Maia3-23M** estimates Peer results and move probabilities. It is conditioned
  on a Lichess player rating and does not use the game's time control.
- **DSC-23M-FEN** estimates move probabilities for the Masters column when the
  Lichess Masters database has too few games for a move. It is master-focused:
  the app queries it with classical, FIDE, over-the-board inputs at 2578 Elo,
  independently of the Peer rating.

The DSC model file is not shipped with this repository (it is about 90 MB).
Serve a converted ONNX export as `public/models/dsc-23m-fen.onnx`, or host it
elsewhere and update `DSC_MODEL_URL` in `src/eval/dsc.js`. Without that file,
the Masters probability has no fallback value and the panel reports a DSC
error.

## Run

Requires Node.js 18+.

```sh
npm install
npm run dev      # development server
npm run build    # production build in dist/
```

## License

64 Quarks is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License v3.0 or later (see `LICENSE`).

Third-party components, their licenses and the open items are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The piece sets Staunty and
Maestro are CC BY-NC-SA 4.0 and are for non-commercial use only.
