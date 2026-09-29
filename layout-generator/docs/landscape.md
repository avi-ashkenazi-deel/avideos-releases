# Landscape: how tools generate layouts today

Research notes behind the prototype, September 2026. The question was narrow: when a tool turns a prompt plus brand assets into a layout, what is actually doing the layout work, and how much of the brand's own system does it respect?

## The trigger

Marvin Schwaibold (Director of Design, Shopify Product Design Studio, co-founder of Molly) posted a prototype on September 28, 2026: layouts generated inside a strict rule set (column grid, padding, safe space, underlying pixel grid), producing 180+ variations to scan and compare. He calls the idea, from a 2019 thesis, **structured randomization**: the model can only play within the boundaries, and the designer keeps the decision.

Source: https://x.com/MSchwaibold/status/2104640742861779151

## Presentation tools

| Tool | How layouts are produced | Brand control | Editable output | Takeaway |
|---|---|---|---|---|
| **Pitch** (Pitch Agent) | Picks from 90+ slide layouts inside your template's design system; can build a branded template from a domain | Fonts, colors, layouts from the template | Yes, in Pitch | Template selection, not generation. Strong brand lock-in inside their editor. |
| **Gamma** (3.0, Gamma Agent) | 20+ models in parallel: text, image selection, layout decisions, consistency. Assigns a layout per card by content type | Themes; agent can restyle a whole deck | Yes, in Gamma; exports | Layout as classification (which card layout fits this content). Fast, polished, closed. |
| **Beautiful.ai** (Smart Slides) | 300+ smart layouts that realign, resize, and animate as content changes | Theme switch re-styles the deck | Yes, in the editor | The best example of constraint-driven layout: rules keep slides valid while content changes. |
| **Tome** | Tile-based structure that reflows content to any screen | Smart themes | Yes | Adaptive layout, not generative variety. |
| **Plus AI** | "Remix" offers alternative layouts for a slide (columns, comparison, timeline, cards) while preserving content | Uses the deck's theme | Yes, in Slides/PowerPoint | Closest to "show me variations of this one slide". |
| **Presentations.ai** | Reads content, picks a layout per slide, applies brand ("Brand Sync") | Brand kit | Yes; PPT export | Same pattern as Gamma with a stronger brand story. |
| **Figma Slides / Figma Make** | Agent generates on canvas using your library's real components, spacing tokens, and variables | Design system components | Fully editable in Figma | The right end state for editability. Product UI focus today. |

## Design and marketing tools

| Tool | How layouts are produced | Brand control | Takeaway |
|---|---|---|---|
| **Canva Magic Design** | 8 to 12 template-based options from a prompt, filled with Brand Kit colors, fonts, logos | Brand Kit | Wide reach, template-shaped output. |
| **Adobe Express** (text to template) | Generates editable templates from a description; "See variations" per template | Brand kit, fonts | Editable, still a template picker underneath. |
| **Microsoft Designer** | Multiple layout options from a prompt with copy included | Limited | Fast, generic. |
| **Recraft** | Vector generation with a Brand Consistency Engine trained from 3 to 5 references | Style reference | Asset generation, not layout. |
| **Relume / Framer** | Sitemaps, wireframes, and pages from component libraries | Component library | Web layout, not comms. |

## Research thread

Academic work treats layout as structured generation: a model emits boxes (type, x, y, w, h) under constraints, often in JSON or HTML.

- **LayoutPrompter** (Microsoft Research Asia, NeurIPS 2023): in-context learning turns an LLM into a layout generator without training.
- **PosterLlama**: LLM fine-tuned to emit content-aware poster layouts as HTML, avoiding salient image regions.
- **COLE** (Microsoft Research Asia, Peking University) and **CreatiPoster**: hierarchical, multi-layer, editable graphic design generation.
- **LayoutGPT** (CVPR 2025): compositional visual planning with LLMs.
- **PosterCopilot** (2025) and **PRISM** (2026): layout reasoning and learning design knowledge from data for stylistic improvement.
- Collections: https://github.com/wd1511/Awesome-Layout-Generation and https://github.com/JosephKJ/Awesome-Layout-Generators

The prototype follows this idea with explicit rules instead of a trained model. It trades some cleverness for something that runs in a browser tab, is auditable, and never breaks a brand rule.

## Where our approach differs

1. **The brand's own grid is the constraint, not a template library.** Column grid, pixel grid, safe space, approved color pairs, logo colors and clear zone, type scale. These already exist in every design system we run.
2. **Variety is the product.** Not one answer, but 24 to 360 valid answers to scan. The designer decides.
3. **Design-system agnostic by construction.** The kit is JSON. Swap the kit, keep the engine.
4. **Editable by design.** Every output is an SVG and a JSON spec with blocks on cells, so editing, cross-format rendering, and Figma export are additions, not rewrites.

## Sources

- Pitch: https://pitch.com/use-cases/ai-presentation-maker · https://pitch.com/product
- Gamma: https://gamma.app/explore/content/guides/what-is-gamma-and-how-does-it-use-ai-to-build-presentations
- Beautiful.ai: https://www.beautiful.ai/smart-slides
- Plus AI: https://guide.plusai.com/ai-for-presentations/generate-a-presentation/slide-by-slide
- Presentations.ai: https://www.presentations.ai/features
- Figma: https://www.figma.com/solutions/ai-design-presentation-generator/ · https://www.figma.com/solutions/ai-layout-automation-tool/
- Canva: https://www.canva.com/help/use-magic-design/ · https://www.canva.com/help/create-on-brand-designs/
- Adobe Express: https://helpx.adobe.com/express/web/create-with-templates/text-to-template.html
- Microsoft Designer: https://support.microsoft.com/en-us/designer/welcome-to-microsoft-designer
- Relume: https://blog.logrocket.com/ux-design/relume-ai/ · Framer: https://www.framer.com/ai/
- Research: https://arxiv.org/html/2512.04082 (PosterCopilot) · https://arxiv.org/pdf/2601.11747 (PRISM) · https://arxiv.org/pdf/2509.16891 (LLMs as Layout Designers)
