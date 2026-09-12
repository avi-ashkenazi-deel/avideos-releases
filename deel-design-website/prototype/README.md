# Deel Design — homepage prototype

`index.html` is a self-contained, single-file mock of the deel.design homepage. It runs anywhere a browser does: open the file, or publish it as an Artifact.

## What's in it

| Section | What it does | Status |
|---|---|---|
| **Hero** | Glass `d.` rendered inside a three.js scene. Low-poly holographic landmarks stand on an invisible globe and orbit in front of and behind the mark. Hover (or wait) shows the place, its real coordinates, and the designer who lives there. | Working. Places are real; people are sample data. |
| **Ticker** | Scrolling list of cities the team designs from. | Driven by the same place data. |
| **Work** | Bento grid of shipped work: AI, brand, system, payroll, mobile, motion. | Each tile is a CSS stand-in for a GIF or clip. |
| **Life** | CSS-3D sphere of team photos, always rotating, pauses on hover. | Gradient placeholders with captions. |
| **People** | 4 featured stories, then a searchable, filterable list (articles, videos, interviews, newsletter). | Sample stories. |
| **Principles** | One-line teaser. | Links to nothing yet. |
| **Join us** | Single CTA out to Deel careers. | Confirm the design-filtered URL. |

## Dropping in real content

Everything is data-driven from the `<script>` block at the bottom:

- `PLACES` — one entry per designer: place, city, lat/lon, name, role, and a `kind` (`tower`, `bridge`, `dome`, `pier`, `market`, `lift`, or `lighthouse`) that picks the landmark shape. Add a row, and the hero, tooltip, and ticker update.
- `PHOTOS` — captions and (for now) gradients. Swap each gradient for a `url(...)` background when curated photos exist.
- `STORIES` — title, sub-line, person, date, kind, and `featured: true` for the top four.

Bento tiles are plain HTML; replace a tile's `.media` inner markup with an `<img>` or looping `<video>` when the real capture is ready.

## Notes

- Single committed dark theme, by design ("the purity of black").
- Type: Fraunces (display), Inter (body), IBM Plex Mono (coordinates and labels), Outfit (the `d.` mark stand-in).
- Respects `prefers-reduced-motion`: orbit, ticker, and sphere stop; the page still reads at rest.
- Loads two things from CDNs: Google Fonts and three.js r128. Nothing else is fetched.
