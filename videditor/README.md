# Videditor

Make videos with your agent, render them frame-exact, review them with timestamped notes, repeat.

Videditor is a self-hosted take on two tools: an agent-first video editor in the spirit of
[HyperFrames Studio](https://hyperframes.studio) (the video *is* HTML; an agent writes it; a renderer
turns it into MP4) and a review workspace in the spirit of [Flask](https://flask.do) (talk, draw and
point at the frame; the agent reads the notes and ships the next version). Everything runs on your
machine: a zero-dependency Node server, your installed Chrome, ffmpeg, and Claude Code on your own
subscription. No accounts, no credits.

## What's inside

**Studio** (`#/studio/<project>`)
- **Composition engine.** A video is a folder whose `index.html` is the composition. Clips are
  elements with `data-start` / `data-duration` / `data-track-index`; animations are plain CSS
  keyframes or Web Animations; media are `<video>` / `<audio>` tags. `engine/runtime.js` makes the
  page deterministic: for any time `t` it sets every clip's visibility, every animation's current time
  and every media element's position, so the preview, the timeline and the renderer all agree.
- **Agent chat.** Type what you want. The server runs **Claude Code** (`claude -p …`) inside the project
  folder with a skill that teaches it the format (`skills/videditor/SKILL.md`). You see every file it
  edits as it works; the preview reloads live. Click an element in the preview to talk about it
  ("About `#title`: make it bigger").
- **Run-through.** Press Run-through (R): the video plays from the start and you just talk, drawing
  if you like, as it runs. Every remark is pinned to the moment it was said and to the cut on screen (the
  brief also names the cut just before it, for fast cuts). When the video ends, all of it goes to the
  agent in one go. Press R to start it.
- **Timeline.** Lanes per track; drag a clip to move it, drag an edge to trim. Edits are written straight
  into `index.html` by element id. Layers panel and a numeric inspector for exact values. Files panel
  with an in-app editor for `index.html`, CSS and `BRIEF.md`.
- **Renderer.** `lib/render.mjs` drives Chrome through Playwright, frame-exact, no dropped frames:
  - *Parallel*: the film is cut into chunks; several Chrome workers (one per spare core) take chunks from a
    queue, capture them through CDP and encode them, and the chunks are joined without re-encoding, with
    the composition's audio mixed in.
  - *Virtual clock* (`engine/clock.js`): `performance.now`, `Date`, `requestAnimationFrame` and timers follow
    the video's time, in the preview and in every worker, so JavaScript animation renders exactly.
  - *Unchanged frames* (holds, end cards) reuse the previous capture: the runtime knows when no animation,
    DOM change, video or script could have changed the picture.
  - *Footage*: clips get a cached render copy with every frame a keyframe at the composition's frame rate,
    so each seek costs ~30 ms instead of up to half a second; the frame is captured only once the browser
    has presented it.
  - Benchmarked against HyperFrames 0.9.15 on the same machine and compositions (1080p30, CRF 18): UI
    motion 14.6 s vs 22.5 s, JavaScript animation 9.2 s vs 23.5 s, footage 16.3 s vs 24.3 s, with frame
    positions identical to the pixel. `VD_PROFILE=1` logs where render time goes; `VD_NO_REUSE=1` turns
    unchanged-frame reuse off for comparison.

**Assets and media analysis**
- Link any folder on your computer (**Studio → Assets**, or when creating a video). Videditor watches it:
  anything you drop in is picked up and analyzed. Each video gets its **cut times**, a **contact sheet** and
  **keyframes** (the agent opens them to judge content: UI vs text vs people); anything with sound gets a
  **tempo estimate, first beat and beat grid**, plus loud moments. All of it is written to `MEDIA.md` in
  the project and into the agent's context, so you can say *"cut `library/demo.mp4` to the music, UI shots
  only, no text on screen, 15 seconds"*. Use files as `library/<name>` in compositions; `assets/` is the
  project's own folder. **Insert at playhead** drops a clip onto the timeline without the agent; the beat
  grid can be shown on the ruler.

**Brand kit and templates**
- `brand.json` → `brand.css` with `--brand-primary`, `--brand-background`, `--brand-text`, `--brand-muted`,
  `--brand-accent`, `--brand-font`, `--brand-logo`. Edit it in **Studio → Brand**; templates and the agent
  use the variables, so rebranding never touches the composition. Templates: blank, teaser (title, three
  features, call to action). Formats: 16:9, vertical 9:16, square.

**Variants and history**
- A project can hold several compositions: the main one plus `variants/*.html`. Switch in the Studio top bar,
  create one from the current composition, or ask the agent ("make another version that is warmer"). Each
  render notes which variant it came from.
- **History** (Studio tab): a snapshot of the composition before and after every change (timeline drags,
  Files edits, agent runs), with one-click restore.

**Export**
- Formats: MP4 H.264 (plays everywhere), MP4 HEVC, MP4 or WebM **AV1** (smallest files), WebM VP9 (with
  transparency), MOV ProRes 4444 (for editing, with alpha), GIF, PNG sequence. Only formats your ffmpeg
  can encode are offered (Homebrew's ffmpeg has all of them).
- Quality draft / normal / high maps to a per-codec CRF; **Advanced** exposes CRF, a bitrate cap (Mbps),
  frame rate, audio on/off and transparent background.
- Size: composition, 720p, 1080p or 4K (supersampled, text stays crisp), or **Render all sizes**.
- **What**: the whole composition, an in/out range (I / O on the timeline), all variants in one queue, or the
  outputs listed in `render.json`. Ask the agent "make me 4 one-minute videos" and it creates four variants
  plus a `render.json`; one click renders all four. A long timeline can be cut into files with `start`/`end`.
  Each render becomes a version in Review (ProRes and GIF show a download instead of a player).
- **Auto-render** (checkbox next to Render, on by default): after the agent changes the composition, Studio
  renders it in the background without you pressing anything. It uses `render.json` when present, otherwise
  your last Render settings. Rendering never blocks: a progress pill sits in the transport, the chat shows
  "⏳ Auto-rendering v5…" then "✅ Auto-rendered v5 · Review", and a toast lets you jump to the new version.
  Nothing renders when the agent only answered a question, or when it already rendered itself.

**Review** (`#/p/<project>`)
- Frame-accurate player, timestamped notes pinned to a moment or a range, **drawings** on the frame
  (brush) that replay in sync, **voice notes** transcribed live with *pointing phrases*
  ("this", "here") logged against the video time and a captured frame each.
- Each note records which clips were on screen. Versions, side-by-side / wipe **compare**, open/done,
  threads, tags, reference images.
- The **Send** menu hands the open notes to the agent, copies a brief for any other agent, copies the
  link, or shows the file in Finder. **Copy prompt** builds a brief for any agent. The **MCP server** (`mcp.mjs`) lets Claude Code read
  feedback, fetch annotated frames, post replies, **render the next version** and wait for new notes.

## Share it (install and updates)

**For the people you share it with** (Mac). They need read access to this GitHub repository and Git signed
in to GitHub once (`brew install gh && gh auth login && gh auth setup-git`). Then one command:

```bash
gh api -H "Accept: application/vnd.github.raw" "repos/avi-ashkenazi-deel/avideos-releases/contents/videditor/install.sh?ref=Videditor" | bash
```

The installer adds what is missing (Node 22+, ffmpeg, Chrome, Claude Code; it needs Homebrew), downloads the
newest release into `~/.videditor`, and creates a **Videditor** app in `~/Applications` (Spotlight finds it)
plus a `videditor` command. Their videos, renders and notes live in **`~/Videditor`**, which updates never
touch. Opening Videditor installs a newer release first (they can turn that off in the account menu); a
green **Update** button also appears in the top bar when a release comes out while it is open.

**For you: publishing an update.** Commit your work, then:

```bash
node videditor/tools/release.mjs 0.4.0 "What changed, in one line" "Another line" --push
```

That bumps the version, adds the notes to `CHANGELOG.md`, tags `videditor-v0.4.0` and pushes. Everyone gets
it the next time they open Videditor, with your notes in the update dialog. Only tagged releases ship;
day-to-day commits on the branch do not. To roll back, release the previous code under a newer number.

Your own checkout (with `data/` next to the code) is a developer copy: it never updates itself, and you
keep using `git pull`.

## Run it

Requirements: Node 22+, ffmpeg, Google Chrome (or Edge), Claude Code (`npm i -g @anthropic-ai/claude-code`).

```bash
cd videditor
npm install                 # once: playwright-core, which drives your installed Chrome
node server.mjs             # http://localhost:8787
```

The first start creates a demo project and renders it (a few seconds). Open it in **Studio**, drag the
title on the timeline, ask the agent to change something, press **Render**, then open **Review**.

Env: `VIDEDITOR_PORT`, `VIDEDITOR_DATA` (default `videditor/data`), `VIDEDITOR_NO_DEMO=1`,
`VIDEDITOR_CLAUDE_BIN` (path to the `claude` binary if it is not on PATH).

Optional, so the agent can also work from the Review side (answer notes, render):

```bash
claude mcp add videditor -- node /absolute/path/to/videditor/mcp.mjs
```

## The loop

1. **New video** → name + brief + format. A blank composition is created under `videditor/projects/`
   and Studio opens with your brief as the first message.
2. The agent writes `index.html` (and assets it builds with CSS/SVG). The preview reloads as it edits.
3. Adjust timing yourself on the timeline, or keep talking to the agent.
4. **Render** → v1 appears in Review.
5. In Review: talk, draw, point. **Copy prompt** (or let the agent use MCP). The agent edits the
   composition and renders v2. Compare. Repeat.

## Composition format (short)

```html
<div id="stage" data-composition-id="launch" data-duration="6" data-width="1280" data-height="720" data-fps="30">
  <div id="bg" class="clip" data-start="0" data-duration="6" data-track-index="0"></div>
  <h1 id="title" class="clip anim-rise" data-start="2.2" data-duration="3.8" data-track-index="2">Launch day</h1>
  <audio id="music" src="assets/music.wav" data-start="0" data-duration="6" data-volume="0.5"></audio>
</div>
```

Full rules in `skills/videditor/SKILL.md` (that file is also what the agent reads). Any folder with such an
`index.html` can be opened: **New video → Review an existing render → Composition folder**.

## Layout

```
videditor/
├── server.mjs          HTTP server: UI, JSON API, media, runtime injection, render + agent jobs (SSE)
├── engine/runtime.js   seekable composition runtime, injected into the composition page
├── lib/
│   ├── composition.mjs project detection, HTML → clips parser, clip edits, brand, project templates
│   ├── analyze.mjs     media analysis: probe, cuts, keyframes, contact sheet, tempo/beats, MEDIA.md
│   ├── render.mjs      Chrome + ffmpeg frame-exact renderer
│   ├── agent.mjs       Claude Code runner (stream-json) and the agent system prompt
│   ├── prompt.mjs      review brief for agents
│   ├── store.mjs       JSON-file store (projects, versions, feedback, chat)
│   └── media.mjs       ffprobe / ffmpeg helpers
├── mcp.mjs, cli.mjs    agent-side access (MCP tools; CLI for scripts)
├── skills/videditor/   the composition format as an agent skill
├── templates/          blank and teaser project templates (brand variables)
├── examples/launch/    demo composition
├── js/, css/, index.html   front end (vanilla ES modules, no build)
└── tests/              node --test unit tests; Playwright end-to-end
```

Data: `videditor/data/` (renders, frames, voice notes, `db.json`) and `videditor/projects/` (your
compositions). Both are git-ignored.

## Tests

```bash
node --test tests/unit.mjs
node server.mjs &  node tests/e2e.cjs
```

## Limits and next steps

- The agent is Claude Code only for now (your subscription). A direct Claude API mode would be a small
  addition in `lib/agent.mjs`.
- `<video>` clips need a Chrome build with H.264 (your installed Chrome has it; the bundled Playwright
  Chromium does not), which is why the renderer prefers Chrome.
- Nested compositions (`data-composition-src`) play through an iframe per scene; the nested file should
  match the host's size and use a transparent body.
- Tempo detection is an estimate (onset autocorrelation). It is solid on music with a clear pulse and says
  so when it is not; ambient tracks report "no clear beat".
