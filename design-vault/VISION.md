# Design Vault — vision

Where this is going: a **hive brain for design reference**. One shared, massive
library that many designers feed and draw from — with personal space, shareable
boards, and AI-native search. This file is the map from today's repo to that.

## End state

- **Users & buckets** — every user has their own bucket of inspo; the mass
  library is the union. You choose what's personal and what's shared.
- **Boards, Pinterest-style** — curated sets cutting across collections;
  shareable with other users; a board is the unit of collaboration.
- **Tags with context** — an item's tags can differ per board (a Braun poster
  is "grid" on a typography board and "1960s" on an era board), with AI
  mapping/normalizing the vocabulary across users.
- **Selective sync** — a local client keeps chosen collections/boards on your
  machine; offline stuff can stay offline (never uploaded) or sync up.
- **AI search, local** — "all red logos" answered on-device: color/metadata
  filters first (already works), CLIP-style embeddings for true semantic
  matches ("playful fintech onboarding") next.
- **Provenance forever** — every file keeps source, license, sharer, year, no
  matter whose bucket or board it lands in.

## Phases

| Phase | What | Status |
|---|---|---|
| 1. Repo as database | Collections + catalogs + vault.db + galleries; everything offline via git | ✅ live |
| 2. Local app | `app/serve.py` UI: search, color + collection filters, boards, git sync | ✅ live |
| 3. Auto-tagging | Dominant-color buckets on every item (`vault.py colors`) — makes "red logos" work | ✅ live |
| 4. Semantic search | Local CLIP embeddings (runs on a Mac; index committed like vault.db); query by meaning, find-similar | next |
| 5. Hosted hive | Postgres + object storage (e.g. Supabase/S3) behind the same catalog schema; auth; user buckets; board sharing; web app = today's local app pointed at the API | later |
| 6. Sync client | Two-way selective sync between local folders and the hive; conflict-free because items are immutable + append-only catalogs | later |

## Design decisions already made for the end state

- **Catalog schema is the contract.** `items.json` / `vault.db` fields
  (collection, file, title, year, tags, license, artist, source/page URL,
  batch) are exactly what the hosted DB will store — migration is an import,
  not a redesign.
- **Items are immutable, curation is additive.** Files never change once
  approved; tags, boards, and buckets layer on top. That's what makes
  multi-user sync tractable.
- **Boards are references, not copies** (`boards.json` holds
  {collection, file} refs) — same model scales to shared boards with
  per-board tags later.
- **AI enrichment is a batch job over the catalog** (colors today, embeddings
  next, tag-mapping later) — it never blocks ingestion.
