---
name: videditor
description: Make and edit videos as Videditor compositions (HTML that plays and renders as video). Use when asked to create, change or fix a video in a Videditor project folder.
---

# Videditor compositions

A video is a folder. `index.html` is the video. Videditor plays it in the browser and renders it frame by frame to MP4 with Chrome and ffmpeg, so **everything must be a pure function of time**: no `setTimeout`, no `requestAnimationFrame` loops, no autoplay. CSS keyframe animations and Web Animations are driven to the exact frame time by the runtime. Media elements are seeked by the runtime.

## Format

```html
<div id="stage" data-composition-id="launch" data-duration="8" data-width="1280" data-height="720" data-fps="30">
  <div id="bg" class="clip" data-start="0" data-duration="8" data-track-index="0"></div>
  <img id="logo" class="clip" src="assets/logo.png" data-start="0.5" data-duration="2" data-track-index="1">
  <h1 id="title" class="clip anim-rise" data-start="2" data-duration="4" data-track-index="2">Launch day</h1>
  <video id="broll" class="clip" src="assets/clip.mp4" data-start="3" data-duration="4" data-media-start="1.5" data-track-index="1" muted></video>
  <audio id="music" src="assets/music.mp3" data-start="0" data-duration="8" data-volume="0.4"></audio>
</div>
```

- **Root**: one element with `data-composition-id`, `data-duration` (seconds), `data-width`, `data-height`, `data-fps`. Give the stage `position: relative; width: <w>px; height: <h>px; overflow: hidden` and set the body background.
- **Clip**: any element with `data-start` (seconds). `data-duration` in seconds (images default 3s, media default to source length). `data-track-index` is the timeline lane (0 = bottom/background). Every clip needs a stable `id`; people point at ids in feedback. Clips are `position: absolute` inside the stage. Outside its time window a clip is hidden by the runtime.
- **Media**: `<video>`/`<audio>` with `src`. `data-media-start` = offset into the file. `data-volume` 0..1. A `<video>` contributes its audio unless it has the `muted` attribute.
- **Animation**: CSS `@keyframes` on a clip or its children. The animation's clock is the clip's local time (starts at 0 when the clip appears). Use `animation-fill-mode: both`. Example:
  ```css
  .anim-rise { animation: rise .8s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
  ```
  For an exit, add a second animation with a delay: `animation: rise .8s both, fade .5s 3.5s both;`
- **Custom JS**: optional `window.__seek = (t) => { … }` is called with the composition time on every frame. Draw canvases, counters, charts there. Never keep your own clock.
- **Assets** live in `assets/`. Reference them relatively (`assets/x.png`). Fonts: `@font-face` with files in `assets/`, or a Google Fonts `<link>`.
- **Text** is real HTML text. Prefer large type, strong contrast, generous margins (safe area 5%).

## Assets, analysis and the asset library

- `MEDIA.md` in the project lists every media file Videditor knows about: duration, size, **cut times**, a **contact sheet** and **keyframes** under `.analysis/`, and for anything with sound the **tempo (BPM), first beat and beat times** plus loud moments. Read it first when the request mentions footage, music, pace or "the clips".
- **Look before you cut.** Open the contact sheet (`Read .analysis/<file>/sheet.jpg`) and the keyframes to judge content: which segments show UI, which show text or people, where the action is. Choose segments by what you see, not by filename. Say in your reply which frames you looked at.
- Files under `library/…` live in a folder the person linked; reference them exactly as `library/<name>` in `src`. Files under `assets/` are in the project.
- Use `data-media-start` + `data-duration` to use a segment of a source clip. Several `<video>` elements can use the same file.
- **Cut to the beat**: start clips on beat times from `MEDIA.md` (or multiples: every 2nd/4th beat for calmer pacing), and let the music's loud moments land on the biggest visual change. Set the composition `data-duration` to end on a beat.
- "Only UI, no text" style requests: skip keyframes that show on-screen text, lower thirds, slides; prefer product UI, motion, hands-on footage. When unsure, ask or offer two variants.
- **Motion**: `MOTION.md` is the law for how things move (timing, easing, zoom limits, transitions). Read it before animating; when a request conflicts with it, say so and follow the person. `dugma-motion.css` ships the named effects as classes (`fx-rise`, `fx-lines` (wrap each line in a child element), `fx-fade`, `fx-reveal`, `fx-pop`, `fx-count`, `fx-draw`, `fx-out`) and stagger helpers (`fx-d1`…`fx-d9`); prefer them over hand-written keyframes.
- Brand: `brand.json` → `brand.css` exposes `--brand-primary`, `--brand-background`, `--brand-text`, `--brand-muted`, `--brand-accent`, `--brand-font`, `--brand-logo`. Link `brand.css` and use the variables instead of hard-coded colors so the person can rebrand without editing the composition.
- Nested scenes: a clip with `data-composition-id="x" data-composition-src="compositions/x.html" data-start data-duration` plays another composition file inside it (same format, transparent body, same size). Use them for reusable scenes or long videos.

## Several videos from one project
- "Make me 4 one-minute videos" → make four **variants** (`variants/<name>.html`, each its own composition with `data-duration="60"`), then write `render.json` listing them so one click renders all:
  ```json
  { "outputs": [
    { "name": "intro",   "entry": "variants/intro.html",   "format": "mp4-h264", "scale": 1 },
    { "name": "feature", "entry": "variants/feature.html", "format": "mp4-h264", "scale": 1 }
  ] }
  ```
- A long timeline can also be cut into several files without copying anything: outputs with `start` / `end` (seconds) render that range of the given entry, audio trimmed to match:
  `{ "name": "teaser-1", "entry": "index.html", "start": 0, "end": 60 }`.
- Render preferences the person states in chat ("render without sound", "always 1080p", "AV1") go into the project's
  `videditor.json` under `"render"`, e.g. `{ "format": "videditor-composition", "version": 1, "render": { "audio": false, "scale": 1.5 } }`.
  Videditor's automatic render after your edit uses them (keys: `audio`, `format`, `scale`, `quality`, `crf`, `fps`, `alpha`).
  Do not strip a composition's audio clips to make a silent render; the setting does it.
- Allowed keys per output: `name`, `entry`, `start`, `end`, `format` (mp4-h264, mp4-hevc, mp4-av1, webm-av1, webm-vp9, mov-prores, gif, png-seq), `scale`, `quality` (draft|looks|high), `crf`, `fps`, `alpha`, `audio`, `notes`.
- Tell the person: "Press Render → Outputs from render.json". You do not render.

## Variants and history
- "Make another version / an alternative / a vertical one" means a **variant**: copy the active composition to `variants/<short-name>.html` (keep the original untouched), change it there, and say which file you made. A variant one folder down references `../assets/…`, `../brand.css`, `../dugma-motion.css`. Videditor lists variants in Studio and the person switches between them.
- Every edit is snapshotted under `.history/` (restorable from Studio → History). Never write into `.history/`.

## Workflow

1. Read `BRIEF.md` (goal, audience, tone) and the current `index.html`.
2. Plan the sequence as a table: clip id, what it shows, start, duration, track. Keep total length to the brief.
3. Write or edit `index.html`. Keep ids stable when editing; change timing via `data-start`/`data-duration` rather than restructuring.
4. If assets are missing, build with CSS/SVG/gradients instead of placeholders. Never reference files that do not exist.
5. Reply with what changed, by clip id and seconds. Do not render; Videditor renders and the person reviews.

## When the request is review feedback

Each note has a timestamp, the clips on screen at that moment, and often a transcript or a drawing description. Address every note. For each one say what you changed (clip, attribute, from → to). If you chose not to change something, say why. Ask when a note is ambiguous instead of guessing.
