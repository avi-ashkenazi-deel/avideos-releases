# FontLab — funky font maker

Draw a handful of letters (or photograph your handwriting, or remix an existing
font), let FontLab grow the rest of the alphabet in the same style, bend the
whole typeface with **Style DNA** sliders, and download a real `.otf`, a
variable `.ttf` with custom axes, or an animated specimen.

Everything runs in the browser. No server, no accounts. Fonts live in an
in-browser **Fonts** list (Font menu): every change autosaves into the open
font, **Reset** offers to save first, and any font can be exported as `.json`.

## Run it

**Easiest (macOS):** double-click `fontlab/FontLab.command` in Finder. It pulls
the latest version, installs anything new and opens the app in your browser.
Leave that window open while you use FontLab; close it to stop. Run it again
whenever you want to update: nothing else to type.

Or from a terminal, in the `fontlab` folder:

```
npm start        # pull + install + open the app (same as the .command file)
npm run dev      # just start it, no update
npm run build    # static site in dist/
npm test         # unit tests
npm run test:e2e # Playwright
```

If the browser says the page is offline, the server window was closed. Run
`FontLab.command` (or `npm start`) again and reload.

## How to use it

The header is just the font's name (a dot marks unsaved changes), a **Test**
button, an **Export** menu and a **Font** menu (Save, Save as new, Fonts…,
Export / Import JSON, Reset). The left column is **Add letters** with three
tabs: **Draw**, **Photo or video**, **Font file**.

1. **Seed it.** In the Draw tab pick a letter in the strip and draw it.
   Pressure and speed change the stroke width; the brush details have width,
   smoothing, cap style and a mirror mode. Good seeds: `o n a e s H` — round,
   arch, bowl, cross-stroke, S-curve, straight. **Photo or video** traces
   handwriting, a type specimen or a frame from an mp4 (light-on-dark is
   detected, frames and halos are removed, glued letters are split, bold faces
   are traced as exact outlines; type the letters in order or under each
   tile). **Font file** imports `.ttf`, `.otf`, `.woff` or `.woff2` and keeps
   the exact outlines by default; tick "convert to strokes" when you want
   Weight, terminals and the variable axes on it.
   Drawing on a letter that already exists (imported, traced or generated)
   **adds** the stroke on top of it; the imported outline stays. **Undo /
   Redo** (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z) cover every change to the font:
   strokes, deleting a tile, Clear, Re-roll, Generate, imports. In the
   **Letters** grid, click a tile and press Delete to remove it, Shift-click
   or Cmd/Ctrl-click to select several, and right-click a tile for Lock,
   Re-roll and "Remove all lowercase / uppercase / digits / block" (handy
   when an imported all-caps font fills the lowercase tiles with capitals).
2. **Edit points.** The **Edit points** button under the canvas turns any
   letter (drawn, traced, imported or generated) into nodes and handles like a
   font editor: drag nodes or handles, drag on empty space to marquee-select,
   double-click a segment to add a point, Delete removes, arrows nudge
   (Shift for 10), Alt+drag a node changes its stroke width (or use the Point
   width slider), Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo and redo (the editor
   keeps its own history while it is open). Imported outlines keep their real
   curves; strokes drawn on top of an outline are not editable as points
   until you press **To strokes**.
3. **Generate the rest of the alphabet.** FontLab measures your seeds (stroke
   width, x-height, cap height, slant, overshoot, spacing, terminals, wobble)
   and builds the missing letters from parametric recipes. Letters related to a
   seed are borrowed from it (`n → h m u`, `b → d p q`). **Mutation** adds
   randomness; **Re-roll** redraws one glyph; **Lock** protects a glyph.
4. **Stack effects.** Pick a **Preset** from the dropdown or add effects one
   by one from the menu, which is grouped with a playful name first and the
   plain one after it:
   - **Limber up · strokes**: Weight, Slant, Wobble, Bounce, Jitter.
   - **Clean cuts · sharp edits** (keep corners sharp; made for imported
     fonts): Weight (crisp), Stretch, Tracking, x-height, Chamfer / Fracture,
     Round corners (vector), Ink traps, Stencil.
   - **Bend it · warps** (sharp, deterministic deformers, inspired by
     [Typoclast](https://typoclast.com/)): Rotate, Flip, Perspective, Twist,
     Pinch, Pull, Wave, Ripple, Bulge, Refraction, Wind, Curl.
   - **Mess it up · shape**: Inflate, Melt, Glitch, Rust, Hollow/Inline,
     Low poly, Stipple with gravity.
   - **Wreck it · destroyers**: Echo (offset copies), Slice (shifted
     strips), Holes (swiss cheese), Spikes, Grid snap, Crush.
   - **Grind it · texture** (through a bitmap): Blob, Round corners, Pixelate,
     Crunch, Ink noise, Dilate/erode, Reaction-diffusion.

   Presets: Chonky, Melted, Rusty, Glitchy, Ransom, Nervous, Hollow, Inline,
   Blob, Pixel, Crunch, Ink, Crystal, Coral, Stipple, Gravity, Halo,
   Everything, Twisted, Keystone, Windswept, Rippled, Swiss cheese, Echoes,
   Shredded, Spiky, Griddled, Crushed, Crisp bold, Condensed, Extended,
   Chiselled, Fractured, Softened, Ink traps, Stencil cut, Tall x. The stack
   is ordered and inspired by
   [LivingPath](https://github.com/ivangrozny/LivingPath). Every effect is
   seeded, so the same seed always gives the same font; **Mutate** nudges
   every slider; **Randomize** throws the dice (2 to 4 random effects, random
   settings; **Back** returns to what you had).
   **Show original** turns every effect off for preview and export; it
   switches on by itself after a font import so you see the font as it is.
   **Advanced: sets** reveals effect sets: a second set starts again from the
   original glyph and is added to, cut from, intersected or xor'd with the
   result (the Halo preset is "inflated minus original").
5. **Pick your scripts.** The **Character set** panel switches blocks on:
   Latin (always), Punctuation, Symbols, Latin accents (Zürich, façade,
   Łódź…), Cyrillic and Hebrew. Accented letters are composed from *your*
   base letter plus a mark; Cyrillic look-alikes (А В Е К М Н О Р С Т Х …)
   are clones of your Latin glyphs and lowercase Cyrillic is small-capped from
   the uppercase, so one drawn `o` flows into ö, ő, ø, о and more. The
   "Add any characters" box accepts anything else (★, kana, Arabic…) for you
   to draw by hand. Right-to-left lines render correctly in the preview.
6. **Preview, test and export.** The preview is editable in place; **Insert
   sample text** drops a pangram for every script you switched on; **Drift**
   slowly animates the noise-based effects (Wobble, Melt, Ink noise,
   Reaction-diffusion) so the font keeps moving, and the Animate dialog can
   sweep the same time axis for a seamless loop. **Test** opens the in-app
   type tester (samples per script, size, line height, spacing, dark mode,
   waterfall, axis sliders). The **Export** menu has `Download .otf` (static,
   CFF outlines), `Variable font…` (a real OpenType variable `.ttf` with
   `wght`, `slnt` and custom `WOBL`, `MELT`, `BNCE` axes you can drive from CSS
   `font-variation-settings`; Rust, Glitch and Inflate change point counts,
   so they are static-only), `TrueType font (.ttf)` (the same font with
   quadratic outlines for apps that reject CFF; the converter is downloaded
   on first use), `Animate…` (GIF / WebM sweeping one axis), `SVG glyphs`
   (every letter as its own vector group, for Illustrator or Figma; a
   single letter is available from the grid's right-click menu), `SVG
   specimen` (an animated poster of your font) and `Tester .html` (a
   self-contained HTML type tester with the font embedded).
   The first time FontLab opens with an empty font it shows a four-step
   intro; the info button in the header brings it back. Left and right
   arrow keys move between letters.

## How it works

```
seeds (draw | trace | import)
  → generate/stats.ts      measure StyleStats
  → generate/compose.ts    recipes × stats × seeded mutation → stroke glyphs
  → generate/derive.ts     accents (base + mark), Ø/Ł/Đ additions, Cyrillic aliases, small caps
  → fx/stack.ts            effect groups in order; each layer runs on the
                           skeleton while it can, then on contours; raster
                           layers share one bitmap round trip
                           (fx/raster: rasterize → ops → marching squares)
  → outline/strokeExpand   centreline + widths → one ribbon polygon per stroke
  → outline/union          polygon-clipping, nonzero rule → clean contours
                           + booleanContours for add / cut / keep / xor groups
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
src/inputs      draw (pointer canvas, point editor + curves), image (threshold → thin → strokes / potrace), fontimport
src/generate    stats, primitives, compose, mutate, borrow
src/fx          effect stack (types, registry, stack, presets), ops (hollow, lowpoly, stipple), raster (bitmap, trace, ops, reaction-diffusion)
src/dna         the original nine operators + boolean/offset helpers (used by fx)
src/outline     strokeExpand, union, fitCurves
src/export      otf, variable (masters + Pyodide bridge + build_var.py), specimen (svg/gif/webm)
src/pipeline    buildAll (used by the worker and by specimen rendering)
src/ui          panels (header menus, add-letters tabs, grid, effects, preview, tester, library), icons, store, preview FontFace, worker client
src/project     schema, json storage, in-browser Fonts library (IndexedDB)
tests/unit      vitest; tests/e2e Playwright
```
