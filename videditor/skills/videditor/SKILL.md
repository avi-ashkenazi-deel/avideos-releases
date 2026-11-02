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

## Workflow

1. Read `BRIEF.md` (goal, audience, tone) and the current `index.html`.
2. Plan the sequence as a table: clip id, what it shows, start, duration, track. Keep total length to the brief.
3. Write or edit `index.html`. Keep ids stable when editing; change timing via `data-start`/`data-duration` rather than restructuring.
4. If assets are missing, build with CSS/SVG/gradients instead of placeholders. Never reference files that do not exist.
5. Reply with what changed, by clip id and seconds. Do not render; Videditor renders and the person reviews.

## When the request is review feedback

Each note has a timestamp, the clips on screen at that moment, and often a transcript or a drawing description. Address every note. For each one say what you changed (clip, attribute, from → to). If you chose not to change something, say why. Ask when a note is ambiguous instead of guessing.
