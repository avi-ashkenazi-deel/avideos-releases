# What two repositories taught us

Notes from reading `presenton/presenton` (an open-source AI presentation generator, Apache 2.0) and `mahdinasseri/Open-Presentations` (an archive of 51 real educational decks), October 2026. The question for each: what does it do that our engine does not, and which parts are worth borrowing.

## Presenton in one page

Presenton generates decks from a prompt or a document and exports editable PPTX. It has two generation modes and a template-import pipeline.

**Standard mode** is a fixed pipeline: outline → structure → content → hydrate → assets → export.

1. The model writes an outline (one entry per slide).
2. A second call picks a layout index for every outline entry from the template's layouts, using rules ("don't pick an image layout unless the content has an image", "adjacent slides should differ", "tables need a table layout").
3. For the chosen layout, only elements marked `decorative: false` become fields in a JSON schema. The model fills the schema, and each text field carries `max_length` derived from the box geometry: characters per line = floor(width / glyph width), lines = floor(height / line height), times a 0.85 safety factor.
4. The layout UI is deep-copied and the generated values are applied. Repeated groups (card grids, timelines) expand or contract within certified limits.
5. Images and icons are fetched or generated (1,512 Phosphor icons in six weights ship with it), then the deck is exported through a headless browser.

**Smart mode** skips templates: the model writes one Tailwind HTML `<section>` per slide inside a 1280×720 canvas under a long list of overflow rules (safe area, font step-down ladder 48→14, no clipping, flex/grid only, decorative layers marked `aria-hidden`). A deterministic linter (`smart_slide_layout.py`) then checks positioned boxes for off-canvas geometry and sibling overlap, and the generation is retried up to eight times.

**Template V2 import** turns a customer's PPTX into reusable layouts: PPTX → raw element JSON plus a rendered preview per slide → four vision-model passes (detect charts/tables/lists, mark editable vs decorative, find repeatable regions, calculate safe text capacity) → certified layouts → similar components merged → colors and fonts profiled into semantic theme roles (primary, background, card, stroke, background_text, primary_text, graph colors). Layouts live on a fixed 1280×720 coordinate system.

**Taxonomy.** Sixteen built-in templates with roughly 25 layouts each. The names are a useful vocabulary of slide intents: cover, agenda/TOC, title + bullets, title + image + bullets, metric cards, chart + summary, comparison cards, timeline, process steps, team cards, pricing cards, quote with portrait, table, closing. Across templates the same intents recur with different compositions.

## Open-Presentations in one page

Not an engine: 51 real PPTX decks (2,415 slides, mostly 4:3, Persian educational content). Useful as a corpus. A quick mining pass (see `tools/pptx_to_kit.py`) gives numbers our defaults can be checked against:

| Trait | Share of 2,415 slides |
|---|---|
| Short copy only (every text box ≤ 60 characters) | 60% |
| Full-bleed photo | 46% |
| Big color field or shape (≥ 25% of the slide) | 27% |
| Two or more images | 26% |
| Large inset photo (30 to 85% of the slide) | 23% |
| No photo at all | 19% |
| Giant numeral or glyph (≤ 4 characters, ≥ 100 pt) | 12% |
| Long body copy (> 300 characters in one box) | 1% |

Primary text anchor: center-top 31%, center-bottom 17%, center-middle 12%, the six corner and side anchors 3 to 7% each. Headline size as a share of slide height: median 6.7%, p75 10%, p90 16%.

Two things stand out. Real decks are far more image-led and far less wordy than the default output of prompt-to-deck tools. And the "statement stat" pattern (one giant number) is common enough to deserve its own family, which our engine already has.

## What we borrowed, and where it landed

1. **Copy capacity on every text block.** Presenton derives `max_length` from geometry so the model writes text that fits. We now compute the same thing after fitting: `capacity: {charsPerLine, maxLines, maxChars, currentChars}` on each text block in the layout JSON, using the measured average glyph width of the actual font and the stack's free height, with the same 0.85 safety factor. It shows in the detail panel. Next use: ask Claude for headline variants that fit a chosen layout instead of fitting layouts to a fixed headline.
2. **Editable PPTX export.** Presenton's main promise is an editable deck. Our spec is closer to PowerPoint than theirs (absolute boxes, not HTML), so the exporter is a direct mapping with pptxgenjs: fields, pills, circles, and rules become native shapes; images stay images with cover cropping; text stays text in the brand font with our line breaks; buttons are rounded shapes with text; gradients, arcs, and SVG logos are rasterized to transparent layers so stacking order survives. One slide from the detail view, or all favorites as one deck per format. Fonts are referenced by name, so the viewer needs them installed for exact rendering.
3. **Deck → brand kit draft and layout priors.** Presenton's Template V2 needs a vision model to read a deck. For the brand-kit half of that job the PPTX already says most of it: theme color scheme, theme fonts, and the colors and typefaces actually used on slides, weighted by count and fill area (the same weighting Presenton's theme profiler uses). `tools/pptx_to_kit.py` reads a deck or a folder of decks with the standard library only and writes a kit JSON the engine loads, plus priors (archetype shares, anchor distribution, headline sizes, suggested weights). This is the "take brand stuff from the real world" step without a model in the loop.
4. **Layout lint parity.** Presenton checks generated HTML for off-canvas boxes and overlapping siblings after the fact. Our validator already rejects those before a layout exists; nothing to add, but it confirms the approach.

## Worth borrowing next

- **A slide-intent vocabulary and a deck mode.** Presenton's outline → structure step is the missing piece for multi-slide output: a brief becomes an outline, each entry gets an intent (cover, agenda, stat, comparison, process, quote, closing), and the engine generates variations per intent while keeping one palette and type level across the deck. Our families cover cover/statement/editorial/split; comparison, process/timeline, and card grids are new archetypes to add.
- **Editable vs decorative.** Presenton marks every element. We should mark shapes and scrims as decorative in the JSON so editors and exporters can treat them as a locked layer.
- **Content schema generation.** Turn a layout's editable text blocks (with capacity) into a JSON schema and let Claude fill it. This is the natural follow-up to item 1 and reuses the interpreter we already have.
- **Icon library.** Phosphor icons (MIT) in six weights are a cheap way to add an `icon` block kind for metric cards and feature lists.
- **Theme-role mapping for imported kits.** Presenton's roles (primary, background, card, stroke, text pairs) map cleanly onto our color roles; `pptx_to_kit.py` assigns roles heuristically and a reviewer confirms them in the sidebar.

## Not worth borrowing

- **HTML as the layout language for the model.** Smart mode asks the model to write Tailwind and then lints it. It produces variety but no guarantees, needs eight retries, and the output is only editable through a DOM editor. Our rules-first approach keeps the guarantees and the JSON.
- **Browser-based export.** Presenton renders slides with Puppeteer and converts the DOM. Mapping from our spec is simpler and runs in the page.
- **Vision-model certification of templates.** Expensive and slow for what a brand kit needs. Keep it for the day we import whole template libraries rather than brand rules.

## Sources

- Presenton: https://github.com/presenton/presenton (docs/template-v2.md, docs/presentation-generation-modes.md, servers/fastapi/templates/v2, servers/fastapi/utils/llm_calls, servers/fastapi/utils/smart_slide_layout.py, templates/*/template.json)
- Open-Presentations: https://github.com/mahdinasseri/Open-Presentations
- pptxgenjs: https://github.com/gitbrent/PptxGenJS (MIT)
