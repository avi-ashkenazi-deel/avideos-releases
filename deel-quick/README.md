# Deel Quick

Instant design iteration on real Deel screens — inspired by
[Shopify's Quick](https://shopify.engineering/quick).

You're logged into the Deel app, looking at a real screen. One click captures
that exact rendered screen — design system, fonts, current UI state — as a
single self-contained HTML file. Hand it to Claude, say what you want to
improve, and iterate in seconds with versions at a stable shareable URL.
No deployment. No infra. It's just there.

```
[app.deel.com]  ──click──▶  [Deel Quick extension]
                                 │  deel-<screen>--<date>-capture.html
                                 │  + ready-to-paste prompt on your clipboard
                                 ▼
                            [Claude + quick-iterate skill]
                                 │  sanitize → PII check → publish
                                 │  "denser table" → v2 → "collapsible sidebar" → v3
                                 ▼
                            [claude.ai artifact URL — private, versioned, shareable]
```

## 5-minute quickstart

1. **Install the extension**: generate the icons once
   (`python3 tools/make-icons.py` — they're built, not stored in git), then
   `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select
   the `extension/` folder. (Details: `docs/INSTALL.md`.)
2. **Install the skill**: copy `skill/quick-iterate/` into your Claude skills
   (see `docs/INSTALL.md` for claude.ai / Claude Code / Cowork paths).
3. On any Deel screen: click the ⚡ Deel Quick icon → optionally type what you
   want to improve → **Capture this screen**.
4. Open a Claude chat, attach the downloaded file, paste (the prompt is
   already on your clipboard), and go. You'll get a share URL; every further
   request updates the same URL as v2, v3…

Full workflow with conventions: `docs/WORKFLOW.md`.

## What's in here

| Path | What |
|---|---|
| `extension/` | Chrome MV3 extension — the capture pipeline. Plain JS, no build step. |
| `skill/quick-iterate/` | The Claude skill that sanitizes, publishes, and iterates. |
| `snippet/deel-quick-snippet.js` | The capture pipeline as a paste-into-DevTools snippet (generated). |
| `docs/` | Install, workflow, troubleshooting. |
| `tools/` | `make-snippet.sh` (regenerates the snippet), `make-icons.py` (generates the extension icons — run once after cloning). |

## Extension permissions (and why)

- `activeTab` + `scripting` — inject the capture code into the current tab
  only, on your click. No persistent content script, no `<all_urls>`.
- `host_permissions` on Deel domains only — lets the background worker fetch
  stylesheets/fonts from Deel asset CDNs when CORS blocks the page-context
  fetch. Nothing else is requested; there is no `downloads` permission (the
  file is saved via a plain in-page link) and no data leaves your browser —
  the capture goes to your Downloads folder, nowhere else.

## Constraints worth knowing

- **One screen per prototype.** Multi-screen flows: capture each screen,
  then ask Claude to link them (`docs/WORKFLOW.md`).
- **16MB ceiling** per published artifact, everything inlined. The extension
  shows a per-category size ledger and offers image downscaling; the skill
  has a trim playbook.
- **Prototypes are static + inline JS.** The capture strips all app
  JavaScript; interactivity you ask for is re-added by Claude as inline
  scripts. The logic won't be perfect — that's fine, it's a prototype.
- **Captured screens can contain real customer/employee data.** The skill
  asks about anonymizing on every ingest — take the question seriously, and
  prefer demo accounts when you can.
