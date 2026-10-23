# FontLab — funky font maker

Draw a handful of letters (or photograph your handwriting, or remix an existing
font), let FontLab grow the rest of the alphabet in the same style, bend the
whole typeface with **Style DNA** sliders, and download a real `.otf`, a
variable `.ttf` with custom axes, or an animated specimen.

Everything runs in the browser. No server, no accounts; projects autosave to
your browser and can be saved as `.json`.

## Run it

```bash
cd fontlab
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run test:e2e   # browser tests (Playwright, Chromium)
npm run build      # static site in dist/
```

A GitHub Pages workflow (`.github/workflows/fontlab-pages.yml`) builds and
deploys `dist/` on every push to the branch.

## How to use it

1. **Seed it.** Pick a letter in the strip and draw it. Pressure and speed change
   the stroke width; the brush panel has width, smoothing, cap style and a mirror
   mode. Good seeds: `o n a e s H` — round, arch, bowl, cross-stroke, S-curve,
   straight. Or click **Trace a photo of handwriting** / **Remix an existing font**.
2. **Generate the rest of the alphabet.** FontLab measures your seeds (stroke
   width, x-height, cap height, slant, overshoot, spacing, terminals, wobble)
   and builds the missing letters from parametric recipes. Letters related to a
   seed are borrowed from it (`n → h m u`, `b → d p q`). **Mutation** adds
   randomness; **Re-roll** redraws one glyph; **Lock** protects a glyph.
3. **Bend it with Style DNA.** Weight, Slant, Wobble, Melt, Inflate, Rust,
   Glitch, Bounce, Jitter. Every op is seeded, so the same seed always gives the
   same font. Presets: Chonky, Melted, Rusty, Glitchy, Ransom, Nervous,
   Everything. **Mutate!** nudges all sliders at once.
4. **Pick your scripts.** The **Character set** panel switches blocks on:
   Latin (always), Punctuation, Symbols, Latin accents (Zürich, façade,
   Łódź…), Cyrillic and Hebrew. Accented letters are composed from *your*
   base letter plus a mark; Cyrillic look-alikes (А В Е К М Н О Р С Т Х …)
   are clones of your Latin glyphs and lowercase Cyrillic is small-capped from
   the uppercase, so one drawn `o` flows into ö, ő, ø, о and more. The
   "Add any characters" box accepts anything else (★, kana, Arabic…) for you
   to draw by hand. Right-to-left lines render correctly in the preview.
5. **Export.** `Download .otf` (static, CFF outlines), `SVG specimen`
   (animated wiggle), `Animate…` (GIF / WebM sweeping one DNA axis), and
   `Variable font…` (a real OpenType variable `.ttf` with `wght`, `slnt` and
   custom `WOBL`, `MELT`, `BNCE` axes you can drive from CSS
   `font-variation-settings`). Rust, Glitch and Inflate change point counts,
   so they are static-only.

## How it works

```
seeds (draw | trace | import)
  → generate/stats.ts      measure StyleStats
  → generate/compose.ts    recipes × stats × seeded mutation → stroke glyphs
  → generate/derive.ts     accents (base + mark), Ø/Ł/Đ additions, Cyrillic aliases, small caps
  → dna/ (skeleton stage)  weight · slant · wobble · bounce · jitter
  → outline/strokeExpand   centreline + widths → one ribbon polygon per stroke
  → outline/union          polygon-clipping, nonzero rule → clean contours
  → dna/ (outline stage)   inflate · melt · glitch · rust
  → outline/fitCurves      corner-aware cubic Bézier fitting
  → export/otf.ts          opentype.js → ArrayBuffer → FontFace live preview
```

- Glyphs are stored as **centreline strokes with per-point width**, in font
  units (1000/em, y up). Imported and photo-traced outlines are stored as
  contours and go through the same DNA ops.
- All geometry work runs in a **Web Worker** (`src/worker/pipeline.worker.ts`)
  with a per-glyph cache keyed by glyph + DNA, so slider drags stay responsive.
- Variable fonts are built by **fontTools inside Pyodide**, loaded lazily on
  first use (~12 MB, cached). `src/export/variable/masters.ts` evaluates every
  glyph at each axis extreme with a fixed point structure so masters are
  point-compatible.

## Layout

```
src/core        data model, geometry, seeded PRNG + simplex noise, charsets, recipes (latin, punct, symbols, marks, cyrillic, hebrew)
src/inputs      draw (pointer canvas), image (threshold → thin → strokes / potrace), fontimport
src/generate    stats, primitives, compose, mutate, borrow
src/dna         the nine Style DNA operators + boolean helpers
src/outline     strokeExpand, union, fitCurves
src/export      otf, variable (masters + Pyodide bridge + build_var.py), specimen (svg/gif/webm)
src/pipeline    buildAll (used by the worker and by specimen rendering)
src/ui          panels, store, preview FontFace, worker client
tests/unit      vitest; tests/e2e Playwright
```
