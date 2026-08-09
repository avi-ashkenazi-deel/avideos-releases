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
| Unsplash | `hunt_url.py` with `UNSPLASH_ACCESS_KEY` set (free at unsplash.com/developers) — direct scraping is anti-bot walled |
| FFFFOUND! and other dead sites | `hunt_url.py <domain> --wayback` — relics via the Wayback Machine. archive.org is blocked in the cloud environment's egress policy; run from local Claude Code |
| layers.so / layers.to | Fully client-rendered + gated — no scrape route; screenshot to Drive |
| Generic web page | `hunt_url.py` — og:image + large images |
| YouTube | Claude can try `yt-dlp` in-session for the video (datacenter IPs are often blocked — the Drive drop is the reliable path). Thumbnails always work: `https://img.youtube.com/vi/<id>/maxresdefault.jpg` |
| Instagram / X / TikTok | Login-walled against scraping — screenshot or screen-record to Drive |

## Provenance

Everything from intake is cataloged as `license: unknown (personal reference)`.
Private swipe file: fine. Publishing or reusing in client work: check the original.
