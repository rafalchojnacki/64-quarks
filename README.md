# 64 Quarks

A browser-based chess analysis board. Paste or build a position, explore the
move tree, and see engine lines with human-likelihood data.

## Features

- Board with move tree, PGN import and export, and a timer.
- Evaluation panel: Stockfish 18 (lite, WASM) lines with win/draw/loss.
- Peer and Masters columns from the Lichess opening explorer (needs a token).
  Peer data is filtered by the game's time control (speed derived from its PGN
  TimeControl, defaulting to blitz when unknown); the Masters database holds
  classical games only. Maia3 estimates use blitz-scale ratings and do not use
  the game's time control.
- Maia3 human-move estimates where the database has too few games (marked `E`).
- Five page themes and two piece sets.

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
