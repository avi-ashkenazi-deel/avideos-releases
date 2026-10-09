# The case for a layout engine

A short read for the people who decide whether we can turn brand assets into a repeatable, rule-bound generation pipeline for every design system we run.

## The problem

Every campaign, launch, and internal deck starts with the same manual loop: open a template, place the logo, fit the headline, try three crops, check the safe area, repeat for four formats. The work is not creative. It is compliance with rules we already wrote down. Meanwhile the AI tools on the market pick a template or paint pixels. Neither respects our grid, our logo rules, or our color pairs, and neither gives a designer a field of options to choose from.

## The idea

Take the rules a design system already has (column grid, pixel grid, safe space, approved color pairs, logo colors and clear zone, type scale) and let chance move only inside them. Generate not one answer but 24 to 360 valid answers. The designer scans, compares, and decides. The engine removes the blank canvas and the manual iteration. Marvin Schwaibold at Shopify calls this structured randomization, and his prototype from last week is the reference point.

## What the prototype proves

The prototype in this folder runs in a browser tab with no backend.

- **Brief in, variations out.** "Launch posts for Deel Global Payroll, bold, image-led, square and story" produces 96 valid layouts in under a second.
- **Rules are enforced, not suggested.** Text is measured and must fit. Nothing leaves the safe area. Text on a photo gets a scrim or a panel based on the image's own luminance. Text on a color field must pass WCAG contrast. The wordmark only appears in its three permitted colors. Invalid attempts are rejected, and the readout shows how many.
- **Design-system agnostic.** The brand is a JSON kit: colors with roles, fonts, logo rules, grid rules, shapes. Switch from Deel to a serif editorial kit or a playful pastel kit and the same engine produces on-brand results for each.
- **Multi-format from one idea.** Any variation can be re-rendered as a square post, story, LinkedIn post, slide, poster, or banner on that format's own grid.
- **Whole decks, not just posts.** Deck mode turns a brief into an outline, generates variations per slide under one palette, and exports the picks as an editable PowerPoint.
- **Editable by design.** Each output is an SVG plus a JSON spec with every block on grid cells and every text block's copy capacity. The same spec already exports as an editable PowerPoint slide, and is the surface a future editor, a Figma exporter, or a Pitch template can read.
- **Starts from what exists.** Point the mining tool at a folder of our decks and it drafts a brand kit (colors with roles, fonts) and layout priors without a model in the loop.

## What we are asking for

1. **Permission to use the real assets.** The Bagoss font files, the wordmark SVG, the illustration and photography library. Today the prototype uses a Google Fonts stand-in and procedural placeholders.
2. **A pilot with two teams.** One marketing squad producing social and one product marketing team producing launch decks. Four weeks. Measure time from brief to approved asset before and after.
3. **A brand owner in the loop.** Someone from Brand & Creative to sign off the kit JSON for Deel, so the rules the engine enforces are the rules we mean.

## Roadmap

| Phase | Scope | Outcome |
|---|---|---|
| Now | Single pieces and whole decks from a brief, gallery and per-slide picks, PNG/SVG/JSON and editable PPTX export, copy refitted by Claude inside each layout's limits, kit drafts mined from existing decks | Prove the thesis; collect what designers keep and discard |
| Next | Edit in place (drag on cells, swap image, re-fit text), lock elements and regenerate the rest, charts and tables as blocks | Designers refine instead of restart |
| Then | Connectors: Figma (frames from the JSON spec), Pitch and Slides templates, a brand-kit importer from Figma variables | Every design system becomes a kit without hand-writing JSON |
| Later | Learn from choices: rank variations by what teams pick; content-aware crops with real salience models | Fewer variations that are better |

## Risks and answers

- **"AI will make things off-brand."** The engine cannot output anything the kit forbids. That is the point of rules-first generation. The risk moves to the kit, which a brand owner signs off.
- **"Designers will feel replaced."** The tool produces options; it does not pick. The decision, and the craft, stay with the designer.
- **"Another tool to maintain."** It is a static web page and a JSON contract. No servers, no accounts, no model training.

## How to see it

Open the prototype, type a brief, press Generate. Try "quiet editorial posters with lots of whitespace", then switch the kit to Editorial Mono and run it again. Click any card for the grid overlay, the spec, and the same idea in every format.
