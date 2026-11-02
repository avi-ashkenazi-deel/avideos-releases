# Videditor

Video review for people **and** their agents, built around [HyperFrames](https://github.com/heygen-com/hyperframes) projects.

Think [Flask](https://flask.do) (talk, draw and point at the frame; the agent reads the notes and uploads
the next version) joined to [HyperFrames Studio](https://hyperframes.studio) (the HTML-is-the-video
editor built for agents). You review a render, Videditor turns the notes into a brief that names the
exact clips on screen at each timestamp, your agent edits the HyperFrames project, renders, and posts
v2 back into the same review. Repeat until it is right.

## What it does

**Review (like Flask)**
- Frame-accurate player: space, `←` `→` per frame, `J` `K` `L`, speed, mute.
- Timestamped notes pinned to a moment or a range (`C` to comment, `I` / `O` to set a range).
- **Draw** on the frame (`D`): pen, arrow, rectangle, circle, five colors. Strokes carry the video time
  they were drawn at, so a drawing made while the video plays replays in sync.
- **Voice notes** (`R`): records audio, transcribes live in the browser, and logs *pointing phrases*
  ("this", "here", "that one") with the video time they were said, capturing a frame for each. Scrub and
  draw while you talk.
- Reference images, tags, open/done status, threaded replies, and markers on the timeline.
- **Versions**: upload a new render or render one straight from the linked HyperFrames project.
  **Compare** any two versions side by side or with a wipe, playback synced.
- Everything is local: a JSON file plus media under `videditor/data/`. Copy link shares the URL on your network.

**Agent loop (like Flask's MCP, aimed at HyperFrames)**
- **Copy prompt** builds a Markdown brief of all open feedback: timestamps, verbatim transcripts,
  pointing phrases, a plain-language description of each drawing, links to annotated frames, and, when a
  HyperFrames folder is linked, *which clips are on screen* at that moment (`#title (h1, 0:02.20–0:06.00;
  “Launch day”, track 2)`), plus the exact commands to render and register the next version.
- **MCP server** (`videditor/mcp.mjs`) for Claude Code, Cursor or Codex: `feedback_list`, `feedback_get`,
  `get_annotated_frame`, `get_frame`, `feedback_post`, `feedback_update`, `version_add`,
  `wait_for_feedback`, `composition_at`, `get_prompt`, `get_guide`. Zero dependencies.
- **CLI** (`videditor/cli.mjs`) for scripts and agents without MCP.
- **HyperFrames awareness**: the composition (`index.html` and nested `compositions/*.html`) is parsed
  into tracks and clips shown as lanes under the timeline; existing `renders/` are imported as versions;
  *Render vN* runs `npx hyperframes render` and registers the output.

## Run it

Requires Node 22+. ffmpeg is strongly recommended (thumbnails, frame extraction, the demo project).

```bash
node videditor/server.mjs          # http://localhost:8787
```

On first start, if ffmpeg is present, a demo project appears with two versions and a few notes so every
feature is clickable immediately. Set `VIDEDITOR_NO_DEMO=1` to skip it. Other env: `VIDEDITOR_PORT`,
`VIDEDITOR_DATA`.

Use Chrome or Edge for live voice transcription (Web Speech API). Other browsers record audio but do not
transcribe; you can still type the note.

### Connect your agent

```bash
# Claude Code
claude mcp add videditor -- node /absolute/path/to/videditor/mcp.mjs
# Cursor / Codex: add the same command as a stdio MCP server.
# Point at another server: VIDEDITOR_URL=http://host:8787
```

Then, in the agent, something like: *"Read the open feedback on project prj_… in Videditor, apply it to
the HyperFrames project, render, register the new version and reply to each note."* The agent calls
`get_guide` first (the server tells it to), then works through the loop.

Without MCP, click **Copy prompt** and paste. The brief tells the agent how to register its render:

```bash
node videditor/cli.mjs add-version <projectId> renders/v2.mp4 --notes "Title now enters at 1s"
node videditor/cli.mjs reply <feedbackId> "Moved the title to data-start=1" --done
```

### Review a HyperFrames project

1. **New project**, give it a name, paste the project folder path (the one with `index.html`, where you
   ran `npx hyperframes init`). Renders already in `renders/` become versions.
2. Or link later from **Context**. You can also just upload any MP4 and use Videditor as a plain review tool.
3. In **Versions**, *Render v2 with HyperFrames* runs the CLI in that folder and streams the log.

## Layout

```
videditor/
├── server.mjs        HTTP server: static UI, JSON API, media with range requests, render jobs, long-poll
├── mcp.mjs           MCP stdio server for agents (talks to the running server)
├── cli.mjs           Agent/script CLI
├── lib/
│   ├── store.mjs     JSON-file store (projects, versions, feedback)
│   ├── hyperframes.mjs  Project detection, composition parser, clips-at-time, CLI runner
│   ├── prompt.mjs    The agent brief
│   └── media.mjs     ffmpeg/ffprobe helpers and the demo video
├── js/, css/, index.html   Vanilla ES-module front end (no build step)
├── examples/launch/  Minimal HyperFrames project used by the demo
└── tests/            node --test unit tests, Playwright end-to-end
```

Data model: a **project** (optionally linked to a HyperFrames folder) has **versions** (video file,
notes, source: upload / render / agent) and **feedback** (time, timeEnd, body, kind text/voice/drawing,
transcript, visualReferences, drawing strokes in normalized coordinates, annotated frames, audio,
reference images, tags, status, replyTo, postedByAgent, clipContext).

## Tests

```bash
node --test videditor/tests/unit.mjs
node videditor/server.mjs & node videditor/tests/e2e.cjs      # needs Playwright + Chromium
```

## Known limits / next

- Drawings are burned into the captured frame at post time; they are also stored as vectors, so a future
  "render feedback overlay" export is possible.
- The composition lanes come from a regex parse of the HTML. Relative timing expressions
  (`data-start="after:intro"`) are shown but not resolved; the HyperFrames CLI's `timeline --json` would be
  the exact source.
- Live preview of the composition itself (via `<hyperframes-player>`) instead of the MP4 is the obvious
  next step; the server already serves the project folder at `/project-files/<projectId>/`.
- No accounts or permissions. Names are self-declared and stored in the browser.
