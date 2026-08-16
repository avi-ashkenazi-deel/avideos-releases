# Size playbook — fitting under the 16MB artifact ceiling

The rendered artifact page must stay under 16MB. The extension warns at 10MB
and flags at 14MB (leaving headroom for iteration edits). The metadata
comment's `size:` line tells you which category to attack. In order of
typical payoff:

## 1. Images (usually the biggest)

- Re-encode large raster data-URIs: decode, downscale to max 1200px width,
  re-encode as JPEG quality 0.8 (skip icons/anything under 50KB, skip SVG).
  The extension can do this at capture time ("Downscale large images"); ask
  the designer to re-capture with it on if images dominate.
- Replace decorative/hero images that don't matter to the iteration with a
  sized neutral placeholder block.
- Avatars: swap for initials blocks (also the PII-safe move).

## 2. Canvas snapshots

Chart snapshots are PNG data-URIs. If large: re-encode as JPEG q0.8 — charts
tolerate it well. If a chart is not the subject of the iteration, a sized
placeholder with the chart's title is acceptable.

## 3. Fonts

- The extension already drops @font-face rules for unloaded weights. Check
  for stragglers: any `@font-face` whose family/weight you can't find used in
  the visible design can go.
- Keep at most 400/500/600 of the primary family if desperate; let the
  browser synthesize other weights (acceptable for a prototype).

## 4. CSS

- Deel ships one large app bundle stylesheet; most rules are unused on any
  single screen. As a last resort, run an unused-rule pass: drop a rule only
  if its selector (pseudo-classes/elements stripped) matches nothing in the
  document. Do this conservatively and visually verify — dynamic states
  (hover menus you later re-add) may need rules that match nothing at rest.

## 5. DOM

- Long virtualized lists sometimes capture hundreds of off-screen rows. Keep
  the first ~30 rows and delete the rest — prototypes don't need the data,
  just the pattern.

After trimming, update the `size:` line in the metadata comment so the ledger
stays honest.
