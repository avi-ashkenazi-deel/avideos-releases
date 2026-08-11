# Mobile intake — screenshots & videos into the vault

The phone-to-vault bridge is Google Drive. Claude's sessions can read your
Drive, so anything you drop in one folder becomes vault material.

## One-time setup

Create a folder in your Google Drive called **`Design Vault Intake`**.
(First time Claude touches Drive in a session you'll get an approval prompt — one tap.)

## Screenshots (Instagram, X, YouTube, anywhere)

1. Screenshot on your phone.
2. Share → **Save to Drive** → pick `Design Vault Intake`. If you can, rename to
   something meaningful (`ig-braun-poster-1968.png` beats `IMG_4231.png` — the
   filename becomes the title and any year in it is picked up automatically).
3. Next session, say **"process intake"** (optionally with routing:
   *"process intake — the watch ones go to watch-faces, tag seiko"*).

Claude then: lists new files in the folder → downloads them → stages them in
`_inbox/intake/<date>/` (or straight into a collection you named) → shows the
review gallery → files your keepers with `source: drive-intake` metadata.

## Videos → storyboards

Same drop, different processing:

1. Save the video to `Design Vault Intake` (screen recordings work great for
   Instagram/TikTok; for YouTube, a saved file is more reliable than a URL —
   see below).
2. Say **"storyboard this"** — Claude downloads it and runs:

```bash
python3 design-vault/scripts/storyboard.py <video> \
  --collection storyboards --tags "<film>,titles" --threshold 0.3
```

`storyboard.py` grabs a frame at every hard cut (ffmpeg scene detection);
continuous shots fall back to an even 12-frame grid. Every frame keeps its
timecode, so the approved storyboard stays ordered. Tune `--threshold` down
(0.2) for subtle cuts, up (0.4) for noisy footage.

## Straight from URLs — what works and what doesn't

| Source | Route |
|---|---|
| Pinterest board | `hunt_url.py <board-url>` — works directly, no login |
| Are.na channel | `hunt_url.py` with `ARENA_TOKEN` set |
| Flickr | `hunt_url.py "flickr.com/photos/tags/<tag>"` — keyless public feed, photographer + date kept |
| VSCO | `hunt_url.py "vsco.co/<user>/gallery"` — Cloudflare blocks datacenter IPs; run from local Claude Code (capture year kept) |
| FFFFOUND! and other dead sites | `hunt_url.py <domain> --wayback` — relics via the Wayback Machine. archive.org is blocked in the cloud environment's egress policy; run from local Claude Code |
| Mobbin | Via the Mobbin MCP in a session that has it connected (local Claude Desktop/Code, or add it as a custom connector on claude.ai to use it in cloud sessions) — see "MCP-fed sources" below |
| pttrns | The original mobile-UI directory is dead (the domain is now an unrelated blog) — relics via `hunt_url.py pttrns.com --wayback`, run locally |
| layers.so / layers.to | Fully client-rendered + gated — no scrape route; screenshot to Drive |
| Generic web page | `hunt_url.py` — og:image + large images |
| Live rendered UI (component galleries, landing pages, dashboards) | `hunt_screenshot.py <url>` — headless-Chromium capture, sliced into review-sized sections (`--whole` for one full-page shot, `--paths /,/pricing` for multi-page) |
| YouTube | Claude can try `yt-dlp` in-session for the video (datacenter IPs are often blocked — the Drive drop is the reliable path). Thumbnails always work: `https://img.youtube.com/vi/<id>/maxresdefault.jpg` |
| Instagram / X / TikTok | Login-walled against scraping — screenshot or screen-record to Drive |

## MCP-fed sources (Mobbin etc.)

Some sources are best reached through an MCP server rather than a scraper —
Mobbin is the flagship case for the interface-design collection. Any Claude
session that has the MCP connected can feed the vault directly; no adapter
script needed. The convention for the session to follow:

1. Query the MCP for what the brief asks ("onboarding flows", "empty states",
   "fintech dashboards") and download the screen images.
2. Write them to `design-vault/_inbox/<collection>/<date>-<topic>/` with an
   `items.json` in the standard shape — one entry per image:

```json
{
  "collection": "interface-design",
  "batch": "2026-08-09-onboarding-flows",
  "source": "mobbin-mcp",
  "items": [{
    "id": 1,
    "file": "01-revolut-onboarding-step1.png",
    "title": "Revolut — onboarding, step 1",
    "year": 2025,
    "tags": ["onboarding", "fintech", "mobile"],
    "page_url": "<mobbin screen url>",
    "source_url": "<image url>",
    "license": "unknown (personal reference)",
    "artist": "Revolut",
    "query": "onboarding flows",
    "status": "pending"
  }]
}
```

3. Run `python3 design-vault/scripts/vault.py review --embed` and show the
   gallery; resolve as usual. The app name goes in `artist`, the pattern names
   in `tags`, and the screen-capture year in `year` — Mobbin knows all three.

If the Mobbin MCP is a remote server (has a URL), adding it as a custom
connector on claude.ai (Settings → Connectors) makes it available in cloud
sessions too — then the whole flow runs from anywhere, phone included.

## Provenance

Everything from intake is cataloged as `license: unknown (personal reference)`.
Private swipe file: fine. Publishing or reusing in client work: check the original.
