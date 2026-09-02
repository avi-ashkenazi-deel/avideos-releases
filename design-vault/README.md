# Design Vault

A curated, reviewable collection of design reference: logos, posters, passports,
currency, interface design, and general inspiration. Everything lives in folders
in this repo, with metadata (source, license, why it was picked) next to every image.
Where it's headed (multi-user hive brain, shared boards, AI search): [VISION.md](VISION.md).

## The app

```bash
git clone <this repo> && cd <repo> && git checkout claude/design-asset-collection-f97tdi
python3 design-vault/app/serve.py     # → http://localhost:5177
```

Search across everything ("red logos", "fabrizia motion", "1959"), filter by
collection and dominant color, hover-play videos, pin items to boards
(boards.json — travels with the repo), and hit **Sync** to git pull + push
without leaving the UI.

## How it works

The loop is: **brief → hunt → review → approve/reject → filed in folders**.

1. **Brief** — Add a request to `BRIEFS.md` (or just tell Claude in a session):
   a collection name plus what to look for, e.g. *"currency: engraved banknotes
   with strong typographic numerals"*.
2. **Hunt** — Claude searches and downloads candidates into `_inbox/<collection>/<batch>/`.
   Every candidate gets an entry in that batch's `items.json` (title, source page,
   direct URL, license, artist, and the query that found it).
   - `scripts/hunt_commons.py` hunts Wikimedia Commons (license-safe, great for
     currency, passports, vintage posters, historical logos).
   - `scripts/hunt_url.py` hunts a URL you spotted: a public Pinterest board
     (via Pinterest's widget endpoint, up to 50 pins, no login), an Are.na
     channel (set `ARENA_TOKEN` from dev.are.na), or any web page (scrapes
     `og:image` + large `<img>` tags). Items are recorded as
     "unknown (personal reference)" license — a private swipe file, not
     cleared for reuse.
   - `scripts/storyboard.py` breaks a video into key frames at scene cuts
     (ffmpeg), each frame carrying its timecode — for title sequences, TV
     interfaces in motion, anything worth studying shot by shot.
   - **From your phone**: screenshots and videos dropped in the
     `Design Vault Intake` Google Drive folder get pulled in on request —
     see [INTAKE.md](INTAKE.md).
   - Anything else (web search, screenshot hunts) is done ad hoc by Claude in a
     session; downloads land in `_inbox` with the same metadata shape.
3. **Review** — `scripts/vault.py review` builds `review.html`: a numbered gallery
   of everything pending. Claude publishes it as an artifact; you reply with which
   numbers to keep ("keep 2, 5, 9, drop the rest").
4. **Resolve** — `scripts/vault.py resolve <collection>/<batch> --keep 2,5,9 --rest reject`
   moves approved images into `collections/<collection>/`, appends their metadata to
   that collection's `items.json`, and deletes the rejects.

## Layout

```
design-vault/
├── BRIEFS.md                 # open requests — what to hunt next
├── _inbox/                   # staged candidates awaiting your review
│   └── <collection>/<batch>/ # one hunt = one batch (images + items.json)
├── collections/              # the approved, permanent library
│   ├── logos/
│   ├── posters/
│   ├── passports/
│   ├── currency/
│   ├── interface-design/
│   └── inspiration/
└── scripts/
    ├── hunt_commons.py       # search + download from Wikimedia Commons
    ├── hunt_url.py           # pull in a Pinterest board / Are.na channel / any page
    ├── hunt_screenshot.py    # capture live rendered UI as sliced screenshots
    ├── storyboard.py         # video → key frames with timecodes
    └── vault.py              # review gallery + approve/reject + tag + browse
```

Each collection folder holds the approved images plus an `items.json` catalog —
so the provenance of every file survives even after the inbox batch is gone.

## Tagging & years

Tagging is a first-class part of the catalog — every item carries a `year` (the
design's year, extracted from Commons metadata or the title, best-effort) and a
`tags` list. The hunter can stamp a whole batch (`--tags "swiss-style,grid"`),
and `vault.py tag` curates after the fact:

```bash
# Fix a wrong year (scrapers often pick up the upload date, not the design date)
python3 design-vault/scripts/vault.py tag logos --match mobil --year 1964 --add "chermayeff-geismar"

# Tag every entry in a collection
python3 design-vault/scripts/vault.py tag posters --match "" --add "typography,grid"
```

`vault.py browse` renders the whole approved library (`browse.html`) grouped by
collection, sorted by year, with decade filter chips.

## Commands

```bash
# Hunt: 12 candidates for the currency collection
python3 design-vault/scripts/hunt_commons.py \
  --collection currency --query "Swiss franc banknote" --count 12

# Saw a great collection online? Pull it in (Pinterest board / Are.na channel / any page)
python3 design-vault/scripts/hunt_url.py \
  "https://www.pinterest.com/<user>/<board>/" \
  --collection posters --tags "brutalism" --count 30

# Build the review gallery from everything pending in the inbox
python3 design-vault/scripts/vault.py review

# Apply a decision to a batch
python3 design-vault/scripts/vault.py resolve currency/2026-08-09-swiss-franc \
  --keep 1,4,7 --rest reject
```

## Offline access — everything together

The repo *is* the offline database: clone it and every approved image plus its
metadata is on your disk. Three layers, all committed and always in sync:

1. **Files** — `collections/<name>/` folders you can browse in Finder.
2. **`vault.db`** — one SQLite database over the whole library (collection,
   title, year, tags, license, artist, source). Rebuilt automatically on every
   resolve/tag; query it from anything that speaks SQLite:

   ```sql
   SELECT title, year FROM items WHERE tags LIKE '%swiss-style%' ORDER BY year;
   SELECT collection, COUNT(*) FROM items GROUP BY collection;
   ```

3. **`browse.html`** — open it straight from the local clone (images load from
   the repo folders, no network) for the visual, decade-filterable view.

To keep a machine current: `git pull`. On iPhone/iPad, a git client like
Working Copy gives you the same folders and galleries offline.

## Ground rules

- **Provenance always** — no image enters `collections/` without `source_url` and
  `license` in the catalog. If the license is unclear, it stays out or gets flagged.
- **Reference, not reproduction** — passports and banknotes are collected as
  design reference (engraving, guilloché, typography, layout systems). Specimen
  and declassified/superseded designs are preferred.
- **Interface design** — screenshot-heavy sources (Dribbble, Mobbin, live products)
  are captured per-brief in a session; same inbox → review flow applies.
