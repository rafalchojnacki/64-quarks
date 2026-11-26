# Pawn structures data format

`public/data/pawn-structures.json` is the reference list of named middlegame pawn structures used by the Summary view (`src/eval/pawn-structure.js`). It is served at `/data/pawn-structures.json`.

## File structure

The file is a JSON array with one object per structure, in display order. Dataset order is used as the final tie-break when matching.

```json
[
  {
    "name": "Carlsbad",
    "patterns": [ ... ]
  }
]
```

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Text shown in the UI. |
| `patterns` | string[] | One or more alternative patterns. Any of them may match. |
| `summary` | string (optional) | Free-text description of the structure for display or reference. Not used by the matcher. |

## Pattern notation

### 1. Purpose

The format is intended to be a compact, human-readable, one-line
format for describing or matching the pawn placement of both sides
in a chess position.

The notation describes pawn placement only. It does not encode pieces,
side to move, castling rights, en-passant rights, move history, or
strategic classifications.

### 2. Overall format

A pattern consists of two groups separated by a forward slash (`/`):

``` text
WHITE_PAWNS / BLACK_PAWNS
```

Each group is a sequence of file entries, in ascending file order (`a` before `h`). Each file appears at most once per group. Only the files that matter for the structure are written. A file that is not written is unconstrained.

Example (Maróczy Bind):

``` text
c4 d- e4 / c- d6 e7
```

The left-hand group describes White's pawns. The right-hand group describes Black's pawns. Either group may be empty, which leaves that side unconstrained.

### 3. File-entry syntax

Each file entry begins with its file letter (`a` through `h`), followed by one of two forms:

  -----------------------------------------------------------------------
  Form                                Meaning
  ----------------------------------- -----------------------------------
  `c-`                                No pawn of that colour is present
                                      on the c-file.

  `c6`                                Exactly one pawn is present on c6,
                                      and no other pawn of that colour is
                                      on the c-file.

  `d2,d4`                             Pawns are present on d2 and d4, and
                                      no other pawn of that colour is on
                                      the d-file.
  -----------------------------------------------------------------------

#### 3.1 Empty file: `-`

A hyphen means that the specified side has no pawn on that file.

Example:

``` text
c-
```

This is an exact constraint.

#### 3.2 Explicit pawn squares

List the rank of each pawn on the file, using standard algebraic square coordinates.

Examples:

``` text
c6
d4
d2,d4
d2,d4,d6
```

Multiple squares on the same file are separated by commas, with no spaces.

An explicit list is an exact specification: the listed pawns must be present, and no additional pawns of that colour may be present on that file.

#### 3.3 Unconstrained files

A file that is not written is unconstrained: any pawn configuration on that file is allowed. There is no wildcard symbol.

### 4. Whitespace and separators

-   Separate file entries with one space.
-   Separate the White and Black groups with `/`.
-   The slash must occur exactly once.
-   Commas separate multiple pawn squares within a file entry.
-   Do not use spaces around commas.

Canonical formatting uses one space between entries and one space on each side of the slash.

### 5. Validation

-   File letters are `a` through `h`. Each appears at most once per group, in ascending order.
-   Every square in a file entry must lie on that entry's file. In the `c` entry, only squares such as `c6` are valid.
-   Pawns may not stand on rank 1 or rank 8, for either colour.
-   A file entry is either `-` or a list of squares, never both.
-   A square list must not repeat a square.

### 6. Examples

#### 6.1 Maróczy Bind

``` text
c4 d- e4 / c- d6 e7
```

White has pawns on c4 and e4 and none on the d-file. Black has no c-pawn, and has pawns on d6 and e7.

#### 6.2 Maróczy Bind, second variant

``` text
c4 d- e4 / c- d7 e6
```

#### 6.3 Carlsbad

``` text
c- d4 e3 / c7 d5 e-
```

#### 6.4 Doubled pawns

``` text
c- d2,d4 / c6 d-
```

White has two pawns on the d-file, on d2 and d4.

#### 6.5 Tripled pawns

``` text
d2,d4,d6 / d-
```

White has three pawns on the d-file.
