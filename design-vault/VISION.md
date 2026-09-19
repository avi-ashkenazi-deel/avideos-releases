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

## Front end — modeled on Spark

[get-spark.io](https://get-spark.io) is the reference for the product shape:

- **Drop any link → saved in seconds.** One ＋ Add entry point that accepts
  X, Pinterest, Instagram, TikTok, YouTube, Vimeo, any page — and *gets the
  full video*, not a thumbnail. (`app/serve.py` → `/api/add`, live.)
- **Save from anywhere.** Share sheet → Slack channel or Drive folder today;
  Chrome extension and Instagram-DM-to-library in the hosted phase.
- **Library is image-first.** Dense grid, no captions until hover, videos
  hover-play with real poster frames. Sidebar: Library · Inbox · Frames ·
  Favorites · Collections · Boards. (live)
- **AI on arrival.** Thumbnails + color tags now; vision tagging,
  transcription, and embeddings next — then search "understands design
  language, not filenames".
- **Boards are a canvas, not a list.** Spark mixes references, notes and
  scripts on one shareable canvas and exports moodboards to decks. Ours are
  reference lists today; canvas + export is the board roadmap.
- **Review stays ours.** Spark auto-files; we keep the Inbox keep/drop step —
  the hive only gets what a human chose.

## Learned from Inspo (inspomcp.dev)

Inspo proved the second interface: **the library as tools for agents.** Their
pitch — *"agents have tools but not taste"* — is the hive brain's pitch too.
What we took, and what's ours:

- **MCP server over the catalog** (`mcp/server.py`, live): `recommend(brief)`,
  `search`, `get_item` (real pixels to a vision model), `find_similar`,
  `get_filters`, boards. Same read-only stance as Inspo, plus one write tool
  (`annotate`) so agents enrich the hive instead of only consuming it.
- **Baked-in guidance**: Inspo ships hero/spacing rules with every response
  because they kill the two most common AI-built-UI failures. Ours ride in
  `recommend()` too; they'll become per-collection rules (motion, type, print).
- **Desktop + mobile pairs**: `hunt_screenshot.py --mobile` captures both.
- **DESIGN.md per item**: Inspo extracts fonts, CSS variables and type ramps
  from the DOM. Our `notes` field is the seed; the DOM-extraction pass on live
  captures is the next step for interface-design items.
- **Not theirs**: Inspo is a public archive of websites. The vault is a
  *private, curated, multi-medium* hive — passports, banknotes, motion clips,
  a team's Slack candy — with provenance and human review. Inspo is a great
  complementary source: `claude mcp add --transport http inspo https://inspomcp.dev/api/mcp`
  alongside ours gives an agent both the web's taste and yours.

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
