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
- **Timeline.** Lanes per track; drag a clip to move it, drag an edge to trim. Edits are written straight
  into `index.html` by element id. Layers panel and a numeric inspector for exact values. Files panel
  with an in-app editor for `index.html`, CSS and `BRIEF.md`.
- **Renderer.** `lib/render.mjs` drives Chrome through Playwright: seek, settle, screenshot, one frame at
  a time, piped into ffmpeg (H.264 + AAC, audio clips trimmed, delayed and mixed from the composition).
  No dropped frames, ever; a slow machine just takes longer.

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
- Render at composition size, 720p, 1080p or 4K (the composition is supersampled, text stays crisp), or
  **Render all sizes** in one go. Each render becomes a version in Review.

**Review** (`#/p/<project>`)
- Frame-accurate player, timestamped notes pinned to a moment or a range, **drawings** on the frame
  (pen, arrow, box, circle) that replay in sync, **voice notes** transcribed live with *pointing phrases*
  ("this", "here") logged against the video time and a captured frame each.
- Each note records which clips were on screen. Versions, side-by-side / wipe **compare**, open/done,
  threads, tags, reference images.
- **Live** toggles from the rendered MP4 to the composition itself, running in the page: you review the
  current state without rendering, click an element to name it in a note, and frames for your drawings are
  captured from the live composition.
- **Copy prompt** builds a brief for any agent. The **MCP server** (`mcp.mjs`) lets Claude Code read
  feedback, fetch annotated frames, post replies, **render the next version** and wait for new notes.

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
