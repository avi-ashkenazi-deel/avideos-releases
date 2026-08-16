# Installing Deel Quick

Two pieces: the Chrome extension (captures screens) and the quick-iterate
skill (publishes and iterates in Claude). ~5 minutes.

## 1. The Chrome extension

1. Get this folder onto your machine (clone the repo, or download the
   `deel-quick/` directory).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the `deel-quick/extension/` folder.
5. Pin it: puzzle-piece icon in the toolbar → pin **Deel Quick** (⚡).

Chrome may show a "developer mode extensions" reminder on restart — expected
for unpacked extensions; click through it.

**Updating**: pull the latest repo, then `chrome://extensions` → the reload
icon on the Deel Quick card.

## 2. The quick-iterate skill

The skill is the folder `deel-quick/skill/quick-iterate/`.

- **claude.ai / Claude Cowork**: Settings → Capabilities/Skills → add or
  upload the skill folder (or its zip). If your workspace supports org-shared
  skills, ask the workspace admin to add it once for the whole design team.
- **Claude Code (CLI/desktop)**: copy the folder to `~/.claude/skills/quick-iterate/`
  so it's available in every session:

  ```bash
  mkdir -p ~/.claude/skills
  cp -r deel-quick/skill/quick-iterate ~/.claude/skills/
  ```

Verify: start a new Claude conversation and type "do you have the
quick-iterate skill?" — it should confirm.

## 3. Sanity check

1. Go to any page on `app.deel.com` (a demo account is ideal).
2. Click ⚡ → **Capture this screen**.
3. A file `deel-<screen>--<date>-capture.html` lands in Downloads. Open it in
   a browser tab — it should look like the screen you were on (static, links
   dead — that's correct).
4. New Claude chat → attach the file → paste the prompt from your clipboard →
   you should get an artifact URL back.

Problems: `docs/TROUBLESHOOTING.md`.

## No-extension fallback (or M0 testing)

`snippet/deel-quick-snippet.js` is the same capture pipeline as one
paste-able file: DevTools Console (or Sources → Snippets) on a Deel page,
paste, then run:

```js
__deelQuick.run({ intent: 'make the table denser' })
```
