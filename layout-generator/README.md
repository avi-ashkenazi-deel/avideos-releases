# Layout Engine

Structured randomization for brand layouts. Give it a brief and your brand assets, get up to 360 on-grid variations you can scan, compare, favorite, and export.

Prototype status: **visual generation only**. Editing, Figma export, and per-design-system connectors come next. The layout JSON is written so those can be added without changing the engine.

![Gallery](docs/gallery.png)

## Run it

No build step. Open `index.html` from a local web server (fonts and exports need `http://`, not `file://`):

```bash
cd layout-generator
npx http-server -p 8123 .      # or: python3 -m http.server 8123
open http://127.0.0.1:8123/
```

Single-file build for sharing (produces `dist/layout-engine.html` for publishing and `dist/layout-engine.standalone.html` for opening anywhere):

```bash
node build.mjs
```

## What it does

1. **Brief → constraints.** The prompt becomes a small JSON intent: formats, count, loudness, light or dark, image-led or type-led, density, composition families, quoted copy, brand color names. A rule parser handles this offline. Optionally Claude reads the brief into the same schema (Settings → paste an API key).
2. **Grid.** Each format gets a modular grid from the kit's rules: pixel unit, safe space, gutter, columns. Cells are multiples of the unit. Story formats exclude the rows platform UI covers.
3. **Moves.** A seeded generator picks a composition family, a column span, an anchor, a type step, an approved color pair, a crop, a shape. Only moves the rules allow.
4. **Checks.** Text is measured and must fit its cells. Nothing textual may leave the safe area or overlap. Text on a photo needs a scrim or a panel, chosen from the image's luminance map. Text on a color field needs WCAG contrast. The logo uses only its allowed colors and keeps its clear zone. Duplicates are dropped.
5. **Output.** Each survivor is an SVG plus a JSON spec in which every text block carries its copy capacity. Export PNG, SVG, JSON, or an editable PowerPoint slide (favorites export as one deck per format). Regenerate a favorite as 24 close variations, or render the same idea across every format.

## Composition families

| Family | What it does |
|---|---|
| Type-led | Headline carries the piece. Optional brand shape. |
| Split | Image (or color field) on one side, bleeding to the edge or inset on the grid. |
| Full-bleed image | Photo fills the canvas. Text anchor chosen where the image is calmest; scrim or panel added when it is not. |
| Framed image | Image inside the grid, text above or below. |
| Mosaic | Two to four image tiles plus text. |
| Color blocks | Bands, columns, corners, or stripes in approved field colors. Text on the ground or on a block with contrast checked. |
| Editorial | Narrow column, hairline rule, small image, lots of air. |
| Statement stat | One big number with a supporting line. |

## Brand kit contract

Any design system that can be described like this can run through the engine. Download, edit, and load kits as JSON from the sidebar.

```json
{
  "name": "Deel",
  "colors": [{ "name": "Acai", "hex": "#5938B8", "role": "core" }, { "name": "Latte", "hex": "#FEF0D9", "role": "background" }],
  "logo": { "kind": "svg", "allowedColors": ["#5938B8", "#000000", "#FFFFFF"], "monochrome": true, "clearZone": 1.0 },
  "fonts": { "display": "Bricolage Grotesque", "body": "Inter", "displayWeight": 600, "headlineCase": "sentence", "tracking": -0.025 },
  "grid": { "unit": 8, "marginRatio": 0.06, "gutterUnits": 3, "radius": 1 },
  "shapes": ["circle", "pill", "quarter"],
  "content": { "headline": "Run payroll in 150+ countries from one platform", "cta": "Book a demo" }
}
```

Color roles: `core` (can be a ground or a big field), `accent` (pops, CTAs), `background` (calm grounds), `neutral` (text only). Readable pairs are derived automatically from WCAG contrast, so adding a color never produces an unreadable layout.

The Deel preset carries the palette and type roles from the 2026 brand guidelines (Acai, Blueberry, Deelberry, Slate, Smoothie, Seltzer, Tangelo, Cornbread, Latte). Bagoss is a licensed face, so Bricolage Grotesque stands in until you upload the real font file from the sidebar. Upload the wordmark SVG the same way; the engine recolors it to the three permitted logo colors.

## Start from an existing deck

`tools/pptx_to_kit.py` reads a .pptx (or a folder of them) with the standard library only and writes a brand-kit draft the engine loads, plus layout priors mined from the slides (archetype shares, text anchors, headline sizes):

```bash
python3 tools/pptx_to_kit.py path/to/deck.pptx --kit my-brand.json --priors priors.json --name "Acme"
```

Load the kit from the sidebar, review the color roles and fonts, upload the logo, and generate. See `docs/learnings.md` for where this came from.

## Files

```
index.html          app shell
css/app.css         tool UI
js/rng.js           seeded randomness
js/color.js         contrast, mixing, palette extraction, luminance maps
js/brand.js         brand kit presets, approved pairs, logo handling, demo imagery
js/grid.js          formats and the modular grid
js/text.js          canvas text measurement and fitting
js/engine.js        the generator: eight families, validation, metrics, dedup
js/render.js        SVG renderer, PNG/SVG export with embedded fonts
js/export-pptx.js   layout spec -> editable PowerPoint (pptxgenjs)
js/prompt.js        brief parser + optional Claude interpreter
js/app.js           UI state and wiring
build.mjs           single-file bundler
tools/pptx_to_kit.py  deck -> brand-kit draft + layout priors
docs/pitch.md       the case for building this properly
docs/landscape.md   research: how other tools generate layouts
docs/learnings.md   what Presenton and a 2,415-slide corpus taught us
```

## Known limits

- In the published copy, exports go through the viewer's save prompt and PNGs use fallback fonts (font files cannot be fetched there). Run locally for exact type.
- The Claude interpreter calls Anthropic directly from the browser with your key. It is off by default and never used in published copies.
- Hex values in the Deel preset were read from the guidelines PDF. Confirm against the Figma library before production use.
- PPTX export references fonts by name; install the brand fonts to see exact type in PowerPoint. Image corner radii and gradient scrims are approximated (scrims and arcs become transparent image layers).
