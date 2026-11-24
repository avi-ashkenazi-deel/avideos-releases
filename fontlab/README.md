# FontLab — funky font maker

Draw a handful of letters (or photograph your handwriting, or remix an existing
font), let FontLab grow the rest of the alphabet in the same style, bend the
whole typeface with **Style DNA** sliders, and download a real `.otf`, a
variable `.ttf` with custom axes, or an animated specimen.

Everything runs in the browser. No server, no accounts. Fonts live in an
in-browser **Fonts** list (Font menu): every change autosaves into the open
font, **Reset** offers to save first, and any font can be exported as `.json`.
**Font → Versions…** keeps named snapshots of a font: compare one with the
font as it is now (letters added, removed or redrawn since), restore it, or
open it as a separate font to try an alternative. FontLab also takes an
automatic version before a reset, a font import, Generate, auto spacing and
a restore.
The **Check** button in the header runs automatic checks after every build
(empty letters, lowercase that is a copy of the capitals, stray specks, ink
that will be clipped, letters wider than their space, width, height and
weight outliers, heavy outlines, extreme kerning) and offers one-click fixes
where it can; click a letter in the list to open it.

## Live site

Every push deploys `fontlab/` to GitHub Pages at
<https://avi-ashkenazi-deel.github.io/avideos-releases/> via
`.github/workflows/fontlab-pages.yml` (unit tests must pass first). One-time
setup in the GitHub repo: **Settings → Pages → Source: GitHub Actions**; if a
run reports that the branch may not deploy, add it under **Settings →
Environments → github-pages → Deployment branches**.

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
   **Pen** (after [Shift](https://shift.graphics)) draws new shapes the way
   font editors do: click for corners, click and drag for curves (Alt while
   dragging breaks the handles into a cusp), click the first point or press
   Enter to close, Backspace removes the last point, Escape cancels. The
   closed shape is added to the letter; drawn inside ink it cuts a hole,
   inside a counter it fills.
   All drawing tools sit in one strip above the canvas, with single-key
   shortcuts: Brush (B), Edit points (V), Pen (P), **Rectangle** (R) and
   **Ellipse** (O; Shift for a square or circle, Alt from the centre),
   **Knife** (K: drag right through a stroke or shape to cut it in two, the
   pieces then move separately in Edit points; Alt leaves a gap) and
   **Note** (N: pin a review comment to a spot on a letter). Notes show as
   numbered pins, are listed under Check → Review notes, travel in the
   `.json` and the specimen site, and a reviewer's notes come back with
   Font → Import review notes.
3. **Generate the rest of the alphabet.** FontLab measures your seeds (stroke
   width, x-height, cap height, slant, overshoot, spacing, terminals, wobble)
   and builds the missing letters from parametric recipes. Letters related to a
   seed are borrowed from it (`n → h m u`, `b → d p q`). **Mutation** adds
   randomness; **Re-roll** redraws one glyph; **Lock** protects a glyph.
   **Keep as alternate** saves the current version of a letter as a
   stylistic set (up to three: ss01, ss02, ss03) before you re-roll or
   redraw it; the grid's right-click menu can swap an alternate in as the
   main letter or remove them. The exported font carries them as real
   OpenType stylistic sets, plus tabular figures (`tnum`) and arrow
   ligatures (`->` `=>` `<-` `<->` become arrows when the Interface
   symbols block is on); the chips under the preview switch them on.
   The draw canvas doubles as an inspector: metric lines show their
   values, the title shows the Unicode code, and **Points** shows the
   built outline's points.
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
   settings; **Back** returns to what you had). **XY pad** (after
   [Allo](https://allo.joshpuckett.me/)'s weight × roundness pad) maps any
   two effect sliders to a square you drag in; the letter and its points
   update as you drag.
   **Colour font** (bottom of the Effects panel) splits every letter into
   coloured layers and exports a real colour font (COLR/CPAL): *Strokes*
   gives each stroke you drew its own colour, *Stripes* cuts bands that line
   up across letters, *Shadow* puts an offset copy behind, *Outline* a rim.
   Pick two to eight colours. Apps without colour-font support show the
   plain letter; variable fonts stay one colour.
   **Show original** turns every effect off for preview and export; it
   switches on by itself after a font import so you see the font as it is.
   **Advanced: sets** reveals effect sets: a second set starts again from the
   original glyph and is added to, cut from, intersected or xor'd with the
   result (the Halo preset is "inflated minus original").
   **Spacing** (header) opens spacing and kerning, after
   [Inkvar](https://www.inkvar.com/)'s idea of measuring the white between
   letters. *Auto space all letters* sets the space on both sides of every
   letter from its shape, so round letters sit closer than straight ones and
   open ones (T, L, r) are pulled in; Tightness sets how much. Letters whose
   width you set by hand are left alone. *Auto kerning* then adjusts single
   pairs (AV, To, r.) on the final shapes, effects included; type any pair to
   see it large and set its value by hand, which always wins. Kerning is
   written into the exported fonts as a real `kern` feature and into the UFO.
5. **Pick your scripts.** The **Character set** panel switches blocks on:
   Latin (always), Punctuation, Symbols, Interface symbols (← → ↑ ↓ ↔ ⇒ ⌘ ⌥
   ⇧ ⏎ ⌫ ✓ ✗ ★ ♥ ⚠ ● ○ ■ □ ▲ ▼, drawn in your font's stroke), Latin accents (Zürich, façade,
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
   on first use), `Animate…` (defaults to **Write on**, after
   [Tegaki](https://tegaki.ink): your text writes itself stroke by stroke in
   the order you drew it, imported letters skeletonised first, as a GIF, a
   WebM or a looping animated SVG; it can also sweep one effect; the
   preview's **Write on** button plays it in place), `UFO source (.ufo.zip)` (the font as a
   standard UFO 3 source with kerning and features, for Glyphs, FontLab 8,
   RoboFont or Fontra: no lock-in), `SVG glyphs`
   (every letter as its own vector group, for Illustrator or Figma; a
   single letter is available from the grid's right-click menu), `SVG
   specimen` (an animated poster of your font) and `Specimen site (.html)`
   (an Allo-style one-page site with the font embedded: a colourful
   multilingual hero, axis rows when a variable font was built, the
   stylistic sets and other features, a type tester, every glyph with an
   inspector, and a download button; host it anywhere).
   **Combine weights into a variable font…** (also in Export, after
   [Static to Variable](https://blode.co/static-to-variable)) works on any
   family, not just yours: add Thin, Regular, Bold (or any set of weights)
   as .ttf, .otf, .woff or .woff2 files, check the weights it read from each
   file, and get one variable font with a `wght` axis and named instances,
   built in the browser with fontTools. Glyphs whose outlines differ between
   the files cannot be interpolated and are left out (the dialog lists
   them); kerning that cannot be merged is dropped with a note. All files
   must be TrueType or all CFF.
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
