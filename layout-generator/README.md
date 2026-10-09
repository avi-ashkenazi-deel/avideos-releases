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
2. **Brief → copy.** The brief also writes the Content panel. A rule-based copywriter finds the subject ("Akai", "the LATAM payroll webinar"), the kind of message (launch, event, hiring, report, offer, quote, guide, feature, proof), an audience, a date, an offer or a stat, and drafts eyebrow, headline, subhead, body and CTA in that register. Quoted text, `cta:` and `stat:` in the brief always win, and an appositive ("Akai, Deel's AI assistant that answers HR questions") becomes the subhead. A brief about the kit's own subject keeps the kit's copy. **Rewrite** cycles phrasings; typing in a field locks the copy until **From brief** is ticked again. In deck mode the subject also renames the sample deck and sets its cover and closing.
3. **Grid.** Each format gets a modular grid from the kit's rules: pixel unit, safe space, gutter, columns. Cells are multiples of the unit. Story formats exclude the rows platform UI covers.
4. **Moves.** A seeded generator picks a composition family, a column span, an anchor, a type step, an approved color pair, a crop, a shape. Only moves the rules allow.
5. **Checks.** Text is measured and must fit its cells. Nothing textual may leave the safe area or overlap. Text on a photo needs a scrim or a panel, chosen from the image's luminance map. Text on a color field needs WCAG contrast. The logo uses only its allowed colors and keeps its clear zone. Duplicates are dropped.
6. **Output.** Each survivor is an SVG plus a JSON spec in which every text block carries its copy capacity. Export PNG, SVG, JSON, or an editable PowerPoint slide (favorites export as one deck per format). Regenerate a favorite as 24 close variations, or render the same idea across every format.

## Deck mode

Switch the top-left toggle to **Deck**. The brief becomes an outline (one intent per slide), the engine generates variations for every slide under one palette and type level, you pick one per slide, and the picks export as one editable PowerPoint deck or a set of PNGs.

- **Outline.** Written by the rule parser from the brief (an explicit list such as "cover, why now, what you get, how it works, proof, before and after, quote, next steps" wins; otherwise the kit's sample deck, trimmed to the requested count), or by Claude when a key is set. Every row is editable in the sidebar: intent, headline, and details (one item per line).
- **Intents.** cover, agenda, statement, big number, comparison, process, cards, quote, body copy, closing. Each maps to the families that can express it.
- **Consistency.** One background, text, and accent color for the whole deck; one type step; the logo stays in the same corner after the cover.
- **Shuffle** regenerates one slide's variations; **Reshuffle deck** starts over with a new palette.

## Canvas

Pick layouts in Single mode (tick cards, or favorite them) or pick slides in Deck mode, then **Send to canvas**. The canvas is an infinite stage where every frame is one layout spec and editing the frame is editing that JSON.

- **Tools.** Select (V), Hand (H), Frame (F), Text (T), Rectangle (R), Ellipse (O), Image (I). Space to pan, ⌘ wheel to zoom, 0 to fit. Drag to move, handles to resize, ⌥ drag to duplicate, marquee to multi-select, arrows to nudge (⇧ for one grid unit), [ and ] to reorder, ⌘Z / ⇧⌘Z undo and redo, ⌘D duplicate, ⌘L copy link.
- **Layers.** Frames and their blocks, with search, visibility, and lock. Click to select, shift-click to add.
- **Properties.** Position and size on the pixel grid, align and distribute, order, lock, decorative flag. Typography (font, size, weight, line height, tracking, alignment, case, fit size to box). Fill, radius, opacity. Image crop focus and replace. Icon picker. Frame: name, format, clip content, grid overlay, background.
- **Layout (flex).** Turn a frame's auto layout on as a vertical stack or horizontal row with gap, padding, align, justify, and stretch. Content blocks reflow in reading order; backgrounds stay. Drag a block to reorder it.
- **Code.** Every frame and block shows its JSON. Edit and apply. Export copies a frame as HTML/CSS.
- **Export.** Frame to PNG or SVG, all frames of one format to an editable PPTX, every frame to PNGs, or the whole canvas to one PNG.
- **Frames.** ＋ Frame adds a blank frame of the chosen format on a free spot in view (⇧N). The Frame tool (F) places one on click or draws one at any size on drag.
- **Between frames.** Drag a block onto another frame to move it there (⌥ drag copies first). ⌘C, ⌘X and ⌘V copy, cut and paste blocks or a whole frame; the copy also lands on the system clipboard as JSON, so it pastes into another tab or session.
- **Palette.** Every color field shows the brand palette as swatches; pick one or type any hex. The pencil opens the palette editor on the canvas panel, where colors can be renamed, re-roled, added or removed, and reset to the preset. Edits feed the generator too.
- **Images.** An image block has a Generate section: a prompt drafted from the frame's copy and palette, sent to Google Gemini (Gemini 2.5 Flash Image, Imagen 4) or OpenAI (GPT Image 1, DALL·E 3) with a key from Settings. The provider layer in `js/imagegen.js` is where more models plug in. Like the Claude paths, it runs locally or from your own host, not in the published copy.
- **Share.** Copy link puts the canvas (layout and copy, not images) into the URL hash. Save and Load move the whole canvas as JSON. The canvas also persists in the browser.

## Copy that fits

Every editable block carries its copy capacity, so a layout can be turned into a content schema. In the detail view, **Copy content schema** gives you the JSON schema for that exact layout, and **Fill copy with Claude** (with a key in Settings) asks Claude for copy inside those limits and refits it into the same layout, same seed, same moves. Decorative blocks (fields, shapes, scrims, rules, icons, the logo) are flagged `decorative: true` in the spec; everything else is content.

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
| Agenda | Headline plus a numbered or bulleted list of sections. |
| Comparison | Two cards or two columns side by side, bullets in each, optional highlight. |
| Process | Three to five steps with number badges or icons, horizontal on wide formats and a vertical timeline on tall ones. |
| Cards | Two to four cards with icon, title, and text. Grid on wide and square formats, stacked on stories. |
| Quote | Quotation with attribution, optional large mark and portrait image. |

Icons come from a curated set of 63 Phosphor icons (MIT), picked by keyword from the card or step text.

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
js/icons.js         curated Phosphor icon set (MIT) and keyword picker
js/deck.js          outline from brief (rules or Claude), per-slide variations, picks
js/canvas.js        canvas document: frames, block ops, flex auto layout, links, HTML export, history
js/canvas-ui.js     canvas editor: stage, selection, tools, layers, properties, code view, export
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
- Canvas share links carry layout and copy only; images are referenced by id and need the same session's assets. A hosted link with assets is the next step.
- The Claude interpreter calls Anthropic directly from the browser with your key. It is off by default and never used in published copies.
- Hex values in the Deel preset were read from the guidelines PDF. Confirm against the Figma library before production use.
- PPTX export references fonts by name; install the brand fonts to see exact type in PowerPoint. Image corner radii and gradient scrims are approximated (scrims and arcs become transparent image layers).
