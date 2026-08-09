# Design Vault

A curated, reviewable collection of design reference: logos, posters, passports,
currency, interface design, and general inspiration. Everything lives in folders
in this repo, with metadata (source, license, why it was picked) next to every image.

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
   - Other sources (web search, specific sites) are hunted ad hoc by Claude in a
     session; anything downloaded still lands in `_inbox` with the same metadata shape.
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
    └── vault.py              # review gallery + approve/reject resolution
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

# Build the review gallery from everything pending in the inbox
python3 design-vault/scripts/vault.py review

# Apply a decision to a batch
python3 design-vault/scripts/vault.py resolve currency/2026-08-09-swiss-franc \
  --keep 1,4,7 --rest reject
```

## Ground rules

- **Provenance always** — no image enters `collections/` without `source_url` and
  `license` in the catalog. If the license is unclear, it stays out or gets flagged.
- **Reference, not reproduction** — passports and banknotes are collected as
  design reference (engraving, guilloché, typography, layout systems). Specimen
  and declassified/superseded designs are preferred.
- **Interface design** — screenshot-heavy sources (Dribbble, Mobbin, live products)
  are captured per-brief in a session; same inbox → review flow applies.
