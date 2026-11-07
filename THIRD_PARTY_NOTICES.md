# Third-party notices

64 Quarks is licensed under the GNU Affero General Public License v3.0 or later (see `LICENSE`).
The license texts of the components below are shipped with the app in `public/licenses/`
(served at `/licenses/`).

Source code of this app: https://github.com/rafalchojnacki/64-quarks

## Shipped in `public/` (served to the browser)

| Component | Path | License | Source and notes |
|---|---|---|---|
| Stockfish 18, lite single-threaded, WASM build | `public/engine/stockfish-18-lite-single.js`, `public/engine/stockfish-18-lite-single.wasm` | GPL-3.0 (`public/licenses/GPL-3.0.txt`) | Stockfish, copyright the Stockfish developers (see its `AUTHORS` file). Binaries from npm `stockfish@18.0.8` (copyright Chess.com, LLC and Nathan Rugg, https://github.com/nmrugg/stockfish.js). Corresponding source: https://github.com/official-stockfish/Stockfish and the stockfish.js 18.0.8 release. Unmodified. |
| Staunty piece set | `public/piece/staunty/` | CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode) | Author sadsnake1, as listed in the Lichess `COPYING.md` (https://github.com/lichess-org/lila/blob/master/COPYING.md). Used unmodified, for non-commercial purposes only. |
| Maestro piece set | `public/piece/maestro/` | CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode) | Author sadsnake1, as listed in the Lichess `COPYING.md`. Used unmodified, for non-commercial purposes only. |
| Cardinal piece set | `public/piece/cardinal/` | CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode) | Author sadsnake1, as listed in the Lichess `COPYING.md`. Copied unmodified from https://github.com/lichess-org/lila/tree/master/public/piece/cardinal. Used for non-commercial purposes only. See "Open items". |
| Board themes | `public/board/walnut.svg`, `birch.svg`, `graphite.svg`, `paper.svg`, `navy.svg` | Unknown | All are procedural SVG (noise filters and plain rectangles), no external images. Origin of `graphite.svg` and `paper.svg` is not recorded in this repository. |
| Maia3 model metadata | `public/models/maia3_23m.onnx.json` | — | Only the JSON description (variant, hyperparameters, SHA-256) is shipped. It contains no model weights. |

## Downloaded at runtime (not shipped in this repository)

| Component | Where it is loaded from | License | Notes |
|---|---|---|---|
| Maia3-23M model weights (ONNX export, fp32) | https://huggingface.co/cemoss17/maia3-onnx (file `maia3_23m.onnx`, SHA-256 in `public/models/maia3_23m.onnx.json`) | Not stated by the export. Upstream model card (https://huggingface.co/UofTCSSLab/Maia3-23M) gives CC BY 4.0 for the paper and refers to the repository for the code and weights license. | Model by the CSSLab, University of Toronto (Monroe, Eilender, Chalmers, Tang, Anderson; "Chessformer", ICLR 2026). Inference code: https://github.com/CSSLab/maia3 (AGPL-3.0). |
| Lichess opening explorer data | `https://explorer.lichess.org/lichess` and `/masters` (requests use the user's own Lichess API token) | Lichess Terms of Service (https://lichess.org/terms-of-service) | Data from Lichess.org. Lichess is not affiliated with this app. The Lichess game database is released under CC0 (https://database.lichess.org/). |

## Runtime dependencies (npm, bundled into the app build)

| Package | Version | License | Copyright holder | License text |
|---|---|---|---|---|
| `maia3-js` | 0.2.0 | MIT | Cem Unuvar | `public/licenses/MIT-maia3-js.txt` |
| `onnxruntime-web` (and `onnxruntime-common`) | 1.31.1 | MIT | Microsoft Corporation | `public/licenses/MIT-onnxruntime.txt`. The npm package ships no license file; the text is taken from the upstream repository (https://github.com/microsoft/onnxruntime). The bundled WASM may include further third-party code under its own licenses, listed in the upstream `ThirdPartyNotices.txt`. |
| `chess.js` | 1.4.0 | BSD-2-Clause | Jeff Hlywa | `public/licenses/BSD-2-Clause-chess.js.txt` |
| `@lichess-org/chessground` | 10.1.1 | GPL-3.0-or-later | Lichess Team | `public/licenses/GPL-3.0.txt` |
| `@fontsource/geist-mono` (Geist Mono font) | 5.3.0 | SIL Open Font License 1.1 | The Geist Project Authors | `public/licenses/OFL-1.1-geist-mono.txt` |
| `@fontsource/geist-sans` (Geist Sans font) | 5.3.0 | SIL Open Font License 1.1 | © 2023 Vercel, made in collaboration with basement.studio | `public/licenses/OFL-1.1-geist-sans.txt` |

Build-only tools (`vite` 8.3.0, MIT) are not shipped.
