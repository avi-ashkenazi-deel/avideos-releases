# streamit — full feature checklist

All 523 user-facing features, each with a stable ID so you can report
back precisely ("F-42 fails"). Ordered so you can work top to bottom: each
section only depends on the ones above it.

**Nothing here has ever been compiled.** Expect the first pass to be
bring-up, not QA. Work through `docs/DEV_SETUP.md` → "Mac-day runbook"
first.

## Prerequisite legend

| Tag | Meaning |
| --- | --- |
| **[offline]** | Works with just the app built. No certs, network, or accounts. |
| **[cert]** | Needs real Developer ID signing (system extension / driver). |
| **[net]** | Needs the Cloudflare Worker + Pages + R2 deployed. |
| **[key]** | Needs an Anthropic API key in Settings → AI. |
| **[ffmpeg]** | Needs the LGPL ffmpeg helper in `Contents/Helpers/`. |
| **[oauth]** | Needs a platform developer app + OAuth client. |
| **[2nd device]** | Needs a second machine, phone, or browser. |
| **[not built]** | The model and callback exist but nothing invokes them yet. Don't test it; it will fail. |
| **[midi]** | Needs a class-compliant USB MIDI controller. |

---

## A. Build & foundations

- [ ] **F-1** `xcodegen generate` produces a project with 3 new targets (Streamit, CameraExtension, StreamitAudioDriver) + StreamitTests, HearIt targets untouched. **[offline]**
- [ ] **F-2** Unit tests pass: Cmd-U or `xcodebuild test -scheme Streamit` (no hardware needed). **[offline]**
- [ ] **F-3** App launches to the main window; app icon appears in Dock/Finder. **[offline]**
- [ ] **F-4** Window layout: scene list left, preview centre, inspector right, tabbed panel bottom. **[offline]**
- [ ] **F-5** fps HUD visible on the preview and reads ~30. **[offline]**
- [ ] **F-6** Quit and relaunch: the project reloads from `~/Library/Application Support/Streamit/Projects/`. **[offline]**

## B. Scenes

- [ ] **F-7** Create a **Camera** scene; it appears in the sidebar. **[offline]**
- [ ] **F-8** Create a **Screen Share** scene; pick a display or window as its target. **[offline]**
- [ ] **F-9** Create a **Movie** scene; choose a file; it plays, with loop and volume options. **[offline]**
- [ ] **F-10** Create an **Interview** scene (guest grid; populated in section H). **[offline]**
- [ ] **F-11** Rename, reorder, duplicate, and delete scenes. **[offline]**
- [ ] **F-12** Switch scenes — the preview follows the active scene. **[offline]**
- [ ] **F-13** Per-scene transition style: **Cut** switches instantly. **[offline]**
- [ ] **F-14** **Dissolve** cross-fades between scenes. **[offline]**
- [ ] **F-15** **Magic Move**: elements present in both scenes glide/resize to their new positions instead of popping. **[offline]**
- [ ] **F-16** During magic move, elements only in the outgoing scene play their exit animation; only-incoming ones play entry. **[offline]**

## C. Sources

- [ ] **F-17** Camera source shows your webcam; pick a specific camera device. **[offline]**
- [ ] **F-18** Screen capture source (ScreenCaptureKit) shows a display. **[offline]**
- [ ] **F-19** Screen capture of a single **window**. **[offline]**
- [ ] **F-20** Cursor show/hide toggle on screen capture. **[offline]**
- [ ] **F-21** Movie source plays video with audio reaching the mixer. **[offline]**
- [ ] **F-22** Image source displays a still (PNG/JPEG). **[offline]**
- [ ] **F-23** Web overlay source renders a live page (~10–15fps; no page audio — documented limit). **[offline]**
- [ ] **F-24** Unplug/replug the camera mid-session: the app recovers rather than freezing. **[offline]**

### Framing a mismatched source (inspector → Scene → Framing)

The program canvas is 16:9 or 9:16, but shared windows rarely are. Test with a
deliberately awkward source: a 4:3 window, a portrait phone mirror, or a tall
code editor.

- [ ] **F-274** **Fit** (default): the whole source is visible, centred, undistorted, with empty space on the short axis. Nothing is stretched — check circles stay round and text isn't wide. **[offline]**
- [ ] **F-275** **Fill**: the source covers the frame with the overflow cropped, still undistorted. **[offline]**
- [ ] **F-276** **Fit + blurred background**: centred sharp copy with a blurred, slightly over-zoomed copy behind filling the sides — no hard bars. **[offline]**
- [ ] **F-277** Blur strength slider changes the backdrop; BG Zoom pushes its edges further out of frame. **[offline]**
- [ ] **F-278** **Stretch** distorts to fill (the escape hatch) — confirms the other modes really are aspect-correct. **[offline]**
- [ ] **F-279** **Zoom** slider pushes into the picture; zooming a Fit source far enough removes the empty space entirely. **[offline]**
- [ ] **F-280** **Pan X/Y** move the visible region once cropped; they're disabled (with an explanation) when nothing is cropped. **[offline]**
- [ ] **F-281** Framing applies to camera and movie scenes too, not just screen share. **[offline]**
- [ ] **F-282** Effects (chroma key, virtual background) apply to the sharp copy; the blurred backdrop is a plain frame and is not keyed into holes. **[offline]**
- [ ] **F-283** Framing is per scene: two screen scenes can frame the same display differently. **[offline]**
- [ ] **F-284** Framing survives save/reload, and a project saved before this feature still opens (defaults to Fit). **[offline]**
- [ ] **F-285** Magic-move between two scenes using blurred backdrop doesn't cross-match the backdrop to the sharp copy (no weird double-glide). **[offline]**
- [ ] **F-286** fps holds with blurred backdrop active — it adds a second full-canvas pass with 16 taps per pixel. **[offline]**
- [ ] **F-287** The framed result is what reaches the virtual camera and the recording, not just the preview. **[cert]**

## D. Elements & canvas

- [ ] **F-25** Add a **text** element; edit its string, font, size, alignment, line spacing. **[offline]**
- [ ] **F-26** Add a **shape**: rectangle, rounded rectangle, ellipse, line. **[offline]**
- [ ] **F-27** Add an **image** element. **[offline]**
- [ ] **F-28** Add a **video** element. **[offline]**
- [ ] **F-29** Add a **web page** element. **[offline]**
- [ ] **F-30** Add a **source inset** (camera PiP / guest tile / screen region). **[offline]**
- [ ] **F-31** Drag an element on the canvas to reposition. **[offline]**
- [ ] **F-32** Resize via corner handles. **[offline]**
- [ ] **F-33** Rotate via the rotation handle. **[offline]**
- [ ] **F-34** Per-element opacity slider. **[offline]**
- [ ] **F-35** Reorder layers (bottom → top) and confirm compositing order. **[offline]**
- [ ] **F-36** Lock an element: it stops responding to canvas gestures. **[offline]**
- [ ] **F-37** Hide/show an element. **[offline]**

## E. Fills, strokes, blend modes

- [ ] **F-38** **Solid** fill with colour picker + alpha. **[offline]**
- [ ] **F-39** **Shader** fill — Linear Gradient Sweep (axis rotates over time). **[offline]**
- [ ] **F-40** Shader fill — **Plasma**. **[offline]**
- [ ] **F-41** Shader fill — **Waves**. **[offline]**
- [ ] **F-42** Shader fill — **Sparkle**. **[offline]**
- [ ] **F-43** Shader fill speed and scale parameters change the animation. **[offline]**
- [ ] **F-44** **Video** fill: a movie paints the inside of a shape or text. **[offline]**
- [ ] **F-45** Stroke with width + solid colour. **[offline]**
- [ ] **F-46** Stroke using a **shader** fill (animated stroke). **[offline]**
- [ ] **F-47** Stroke using a **video** fill. **[offline]**
- [ ] **F-48** Corner radius on rounded rectangles; ellipse masking. **[offline]**
- [ ] **F-49** Blend modes over the camera — verify each: Normal, Multiply, Screen, Overlay, Darken, Lighten, Colour Dodge, Colour Burn, Hard Light, Soft Light, Difference, Exclusion (12 total). **[offline]**
- [ ] **F-50** Soft/anti-aliased edges look clean, not doubly-darkened (this was a fixed premultiply bug — worth a careful look). **[offline]**

## F. Entry / exit animations

20 styles in 7 families, grouped in the Animate tab's picker. **Play Entry**
replays just the entrance, which is the quick way to compare them.

- [ ] **F-51** **Fade** — opacity only. **[offline]**
- [ ] **F-288** **Slide from Left / Right / Top / Bottom** — starts fully off-canvas and glides in (4). **[offline]**
- [ ] **F-289** **Drift from Left / Right** — a short offset plus a fade, never leaving the frame (2). **[offline]**
- [ ] **F-290** **Rise Up** — starts slightly low and rises to rest. The tasteful default for text over a face. **[offline]**
- [ ] **F-291** **Settle Down** — starts slightly high and settles. **[offline]**
- [ ] **F-292** **Scale Up** — grows from 60% with a fade. **[offline]**
- [ ] **F-293** **Scale Down** — arrives from 140%, reading as coming to rest. **[offline]**
- [ ] **F-294** **Pop** — small overshoot past 100% and settles. **[offline]**
- [ ] **F-295** **Spring Up** — rises, passes its mark, springs back. **[offline]**
- [ ] **F-296** **Bounce In** — visibly bounces more than once, then rests. **[offline]**
- [ ] **F-297** **Wipe Horizontal / Vertical** — one axis grows from zero at full opacity; made for lower-third bars (2). **[offline]**
- [ ] **F-298** **Flip Horizontal / Vertical** — one axis 0→1 with a slight overshoot, like a card turning (2). **[offline]**
- [ ] **F-299** **Rotate In** — a small tilt straightens out with scale and fade. **[offline]**
- [ ] **F-300** **Swing In** — the tilt oscillates and settles. **[offline]**
- [ ] **F-301** Every style ends **exactly** at the element's resting position — nothing is left nudged off-place after it plays. **[offline]**
- [ ] **F-302** Nothing flashes at full opacity on the first frame of any entry. **[offline]**
- [ ] **F-52** Exit is the reverse of entry, for all 20 (hide an element and watch it leave the way it came). **[offline]**
- [ ] **F-303** **Play Entry** replays the entrance without hiding the element first. **[offline]**
- [ ] **F-304** Picking a style adopts a duration that suits it (a Bounce is slower than a Fade) and the duration slider still overrides it. **[offline]**
- [ ] **F-305** The picker is grouped by family (Fade / Slide / Drift / Scale / Spring / Reveal / Rotate), not one flat list of 21. **[offline]**
- [ ] **F-53** Curves change the feel: Linear, Ease In, Ease Out, Ease In-Out. **[offline]**
- [ ] **F-306** Spring Up, Bounce In and Swing In ignore the curve (they *are* timing functions) and the inspector says so; every other style responds to it. **[offline]**
- [ ] **F-54** Duration and delay controls behave. **[offline]**
- [ ] **F-307** Animations run correctly on text, shapes, images, video and web overlays alike — including several layered over a screen share. **[offline]**
- [ ] **F-308** Overlay animations reach the virtual camera and the recording, not just the preview. **[cert]**

## G. Camera effects

- [ ] **F-55** **White Screen** replaces the background with white. **[offline]**
- [ ] **F-56** **Green Screen**. **[offline]**
- [ ] **F-57** **Black Screen**. **[offline]**
- [ ] **F-58** **Chroma Key** against a real green screen; tune hue/tolerance/softness/spill. **[offline]**
- [ ] **F-59** **Virtual Background** (Vision person segmentation) with no green screen — blur and image replacement. **[offline]**
- [ ] **F-60** **Contrast** slider. **[offline]**
- [ ] **F-61** **Sharpen** slider. **[offline]**
- [ ] **F-62** **Beautify** smooths skin without smearing the whole frame. **[offline]**
- [ ] **F-63** Stack several effects and confirm order matters (reorder the chain). **[offline]**
- [ ] **F-64** Toggle each effect on/off live without a stall. **[offline]**
- [ ] **F-65** fps stays at target with effects active (the HUD is the judge). **[offline]**

## H. Virtual camera

- [ ] **F-66** Setup tab installs/activates the camera system extension (macOS approval prompt appears). **[cert]**
- [ ] **F-67** "streamit Camera" appears in **Photo Booth** (pickiest consumer). **[cert]**
- [ ] **F-68** Appears and works in **Zoom**. **[cert]**
- [ ] **F-69** Appears and works in **Google Meet** (Chrome). **[cert]**
- [ ] **F-70** Appears and works in **Teams**. **[cert]**
- [ ] **F-71** Program output in the consumer app matches the preview (scenes, elements, effects). **[cert]**
- [ ] **F-72** With the app closed/not streaming, consumers show the branded "not live" splash card. **[cert]**
- [ ] **F-73** Scene switches and animations appear in the consumer app in real time. **[cert]**
- [ ] **F-74** Output keeps flowing when the studio window is occluded or minimised. **[cert]**

## I. Audio mixer

- [ ] **F-75** Mixer shows strips: Microphone, Sound FX, Music, Movie, + one per guest. **[offline]**
- [ ] **F-76** Per-strip volume faders work. **[offline]**
- [ ] **F-77** Per-strip mute works. **[offline]**
- [ ] **F-78** Level meters move with audio. **[offline]**
- [ ] **F-79** Choose the input device in Settings → Audio Devices. **[offline]**
- [ ] **F-80** Choose the monitor output device. **[offline]**
- [ ] **F-81** Apple voice-processing noise suppression toggle audibly works. **[offline]**
- [ ] **F-82** Movie audio reaches the mix and its fader controls it. **[offline]**

## J. Audio effects & ducking

- [ ] **F-83** Add a **Compressor** insert to a strip; bypass toggle works. **[offline]**
- [ ] **F-84** Add **Delay**. **[offline]**
- [ ] **F-85** Add **EQ**. **[offline]**
- [ ] **F-86** Add **Reverb**. **[offline]**
- [ ] **F-87** The one-knob macro audibly changes each built-in. **[offline]**
- [ ] **F-88** Advanced disclosure exposes full parameters. **[offline]**
- [ ] **F-89** Third-party Audio Units installed on the system are listed (anything in `/Library/Audio/Plug-Ins/Components`). **[offline]**
- [ ] **F-90** A third-party AU opens **its own plug-in UI**; generic parameter list is the fallback. **[offline]**
- [ ] **F-91** Insert chains persist across relaunch (including third-party plug-in state). **[offline]**
- [ ] **F-92** Reorder inserts within a strip. **[offline]**
- [ ] **F-93** **Auto-ducking**: talking into the mic ducks the music (−12dB default) and it recovers smoothly. **[offline]**
- [ ] **F-94** Ducking threshold / amount / attack / release controls behave. **[offline]**
- [ ] **F-95** Re-target ducking: a different strip as trigger, a different set as targets. **[offline]**

## K. Soundboard & music

- [ ] **F-96** Drag audio files onto the soundboard to create pads. **[offline]**
- [ ] **F-97** Clicking a pad fires the sound with no perceptible delay. **[offline]**
- [ ] **F-98** Retrigger while playing behaves (voice stealing, progress ring). **[offline]**
- [ ] **F-99** Pads persist across relaunch (security-scoped bookmarks). **[offline]**
- [ ] **F-100** Music playlist: add tracks, play/pause, skip. **[offline]**
- [ ] **F-101** Gapless transition between consecutive tracks. **[offline]**
- [ ] **F-102** Loop modes (off / one / all). **[offline]**
- [ ] **F-103** Seek within a track. **[offline]**
- [ ] **F-104** Global soundboard hotkeys: ⌥1…⌥9 fire pads **while another app is frontmost** (test with Zoom focused). **[offline]**

## L. Virtual microphone (driver)

- [ ] **F-105** Setup tab installs the audio driver (one admin prompt). **[cert]**
- [ ] **F-106** "streamit Microphone" appears in System Settings → Sound and in Zoom's mic list. **[cert]**
- [ ] **F-107** Zoom hears the full program mix: mic + music + pads + movie. **[cert]**
- [ ] **F-108** "streamit Guest Send" device exists (mix-minus feed for guests). **[cert]**
- [ ] **F-109** Driver status shows installed + version; re-install after a version bump. **[cert]**
- [ ] **F-110** Uninstall removes both devices cleanly. **[cert]**

## M. Recording

- [ ] **F-111** ⇧⌘R starts/stops recording; menu item mirrors the state. **[offline]**
- [ ] **F-112** REC indicator + elapsed timer while recording. **[offline]**
- [ ] **F-113** Output `.mov` (HEVC) lands in `~/Movies/streamit` and plays. **[offline]**
- [ ] **F-114** H.264 codec option produces a playable file. **[offline]**
- [ ] **F-115** **Clap test**: audio and video are in sync in the recording. **[offline]**
- [ ] **F-116** Recording captures the composited program (scenes, elements, effects) — not the raw camera. **[offline]**
- [ ] **F-117** Force-quit mid-recording: the fragmented file (5s interval) is still playable. **[offline]**

### Pause mid-take

- [ ] **F-477** A Pause button appears beside Record while recording, and nowhere else. **[offline]**
- [ ] **F-478** Pause turns the HUD amber ("PAUSED"), and the elapsed clock stops counting. **[offline]**
- [ ] **F-479** Resume, stop, and play the file: it is **gapless** — the paused span is absent, not silent/frozen. **[offline]**
- [ ] **F-480** Audio stays in sync with video across a pause (clap before and after one). **[offline]**
- [ ] **F-481** ⌥⌘R pauses/resumes from the menu; ⌃⌥. does it with another app frontmost. **[offline]**

### Call-ins (green room)

- [ ] **F-482** A joining caller lands OFF AIR: not in interview tiles, inaudible, listed in the Guests palette with an orange "waiting" state. **[net] [2nd device]**
- [ ] **F-483** The waiting caller hears the show (mix-minus) while off air. **[net] [2nd device]**
- [ ] **F-484** Put On Air adds them to the program and unmutes them; their page flips "off air" → red ON AIR. **[net] [2nd device]**
- [ ] **F-485** Clicking again pulls them off air without disconnecting them; the badge follows. **[net] [2nd device]**
- [ ] **F-486** "New callers wait off air" toggled off restores walk-right-in guests. **[net] [2nd device]**
- [ ] **F-487** The palette's Mute is disabled for waiting callers (off air is already silent) and works normally on air. **[net] [2nd device]**

## AB. Editor: delivery polish (brand, loudness, music bed)

- [ ] **F-488** The brand kit's watermark is burned into every video export at its kit position/size/opacity, above captions; the preview stays clean. **[offline]**
- [ ] **F-489** A brand-new project opens with the kit's intro/outro stingers as its bookends; reopened projects keep whatever you did, including deleting them. **[offline]**
- [ ] **F-490** A portrait phone master reframes with correct crop geometry after scene analysis (the 16:9 assumption is gone). **[offline]**
- [ ] **F-491** Exports render at the fastest source's frame rate (60 fps program recording → 60 fps export; 24 stays 24), clamped 24–60. **[offline]**
- [ ] **F-492** Exports measure and normalize loudness: an audio master lands at ≈−16 LUFS, a video at ≈−14 (check with any LUFS meter); Preferences → Audio can turn it off; a peaky-but-quiet mix stops short of clipping instead of distorting. **[offline]**
- [ ] **F-493** Add a music bed (tracks pane): it loops under the whole conversation, fades in/out at the edges, plays in the preview and the export, and ⌘Z removes it. **[offline]**
- [ ] **F-494** With a transcript, the bed ducks under speech and comes back up in pauses; without one, the row explains ducking needs a transcript. **[offline]**
- [ ] **F-495** Stems contain no music bed and are not loudness-normalized. **[offline]**

## AC. Editor: multicam

- [ ] **F-496** Import a second camera's file → **Sync by Audio** sets its offset from the soundtracks; a clap or speech overlap lines up frame-close (±20 ms class). **[offline]**
- [ ] **F-497** Sync against non-overlapping audio reports "no confident match" instead of silently guessing. **[offline]**
- [ ] **F-498** With 2+ cameras, a **Cut to** strip appears above the timeline; clicking an angle cuts the program to it at the playhead. **[offline]**
- [ ] **F-499** Re-cutting at the same playhead replaces the cue instead of stacking cues. **[offline]**

## AD. Guest screen share

- [ ] **F-500** The guest page has **Share screen**; picking a screen/window/tab publishes it, and the button turns red ("Stop sharing"). **[net] [2nd device]**
- [ ] **F-501** With the sharer ON AIR, the interview scene switches itself to screen-on-stage: the screen big and letterboxed (never cropped), every face — host included — in the strip below. **[net] [2nd device]**
- [ ] **F-502** Stopping the share (button OR the browser's own "Stop sharing" bar) returns the interview scene to its grid, and the page button resets either way. **[net] [2nd device]**
- [ ] **F-503** The guest's camera tile keeps working while they share — two independent feeds. **[net] [2nd device]**
- [ ] **F-504** Right-click the guest in the palette → "Add <name>'s Screen as Tile" places the screen on any scene; the inspector's source picker also lists "<name>'s Screen". **[net] [2nd device]**
- [ ] **F-505** An off-air caller's screen never reaches the program (same gate as their camera). **[net] [2nd device]**
- [ ] **F-506** Known gap, don't report: screen-share TAB AUDIO is not mixed in v1 — the guest's mic carries the sound. **[not built]**

### Local recording of the shared screen (podcast mode)

- [ ] **F-507** Sharing during a take records the screen LOCALLY at full quality: a third chunk lane ("screen") uploads alongside audio/video in the guest's upload strip. **[net] [2nd device]**
- [ ] **F-508** Starting/stopping the share mid-take yields a partial screen track whose own anchor aligns it — the import places it at the right session time, not at zero. **[net] [2nd device] [ffmpeg]**
- [ ] **F-509** After import, "<name>'s Screen" appears as its own video lane in the editor and in the multicam **Cut to** strip, in sync with everyone. **[net] [2nd device] [ffmpeg]**
- [ ] **F-510** Stopping the take while a share is running finalizes the screen track with the others (chunk count matches, meta.json present). **[net] [2nd device]**

### Round-4 additions (editor + rehearsal)

- [ ] **F-511** Opening a session with no transcript auto-starts transcription; a quick-pass transcript appears in seconds, then improves in place ("Improving quality…"), no button needed.
- [ ] **F-512** With a Claude key stored, punctuation/capitalization is polished after the quality pass — word timings and word letters never change.
- [ ] **F-513** Timeline joins between blocks draw a dark seam with a scissors mark — every cut is visible.
- [ ] **F-514** Select a timeline block, press up/down arrow: it swaps places with its neighbour (iMovie-style), one ⌘Z per move.
- [ ] **F-515** The intro/outro cap's play button plays from the very top (intro included) — not just seeks.
- [ ] **F-516** Dropping an AUDIO file on the timeline creates a green ♪ music clip: audible, −12 dB, dipping under speech; several can coexist, trim/move like any block.
- [ ] **F-517** The overlay inspector's "Dip under speech (music)" toggle works on any clip with audio, opposite of "Duck the conversation".
- [ ] **F-518** Interview palette → Rehearse Layouts: 1–3 animated demo feeds fill interview grids/tiles with nobody on the call; Off removes them.
- [ ] **F-519** The transcript breaks into paragraphs (speaker changes and real pauses); multi-speaker sessions label paragraphs with the speaker's name.
- [ ] **F-520** During playback the spoken word highlights in the transcript and the text scrolls to follow it.
- [ ] **F-521** Highlighting words in the transcript seeks the video to that moment.
- [ ] **F-522** Alternating faint washes in the transcript mark where one clip ends and the next begins (matching the timeline's scissors seams).
- [ ] **F-523** Media shelf rows have visible buttons: insert at playhead (cutaway/music) and add as extra angle; Text/Time toggle carries an explanatory caption.

## N. Remote guests

- [ ] **F-118** Set the Worker URL in Settings → Session Server. **[net]**
- [ ] **F-119** Start a guest session; an invite link is generated. **[net]**
- [ ] **F-120** Invite QR code displays (for joining from a phone). **[net]**
- [ ] **F-121** A guest joins from a Chromium browser via the link. **[net] [2nd device]**
- [ ] **F-122** Guest pre-join device check (camera/mic preview) works before joining. **[net] [2nd device]**
- [ ] **F-123** Guest video appears as a source and can be placed in the Interview scene. **[net] [2nd device]**
- [ ] **F-124** Guest audio appears as its own mixer strip with fader/mute. **[net] [2nd device]**
- [ ] **F-125** Interview grid layouts arrange multiple guests. **[net] [2nd device]**
- [ ] **F-126** **Mix-minus / echo test**: with headphones OFF on both ends, the guest does not hear themselves. **[net] [2nd device]**
- [ ] **F-127** Guest hears the host mix (music, pads, other guests). **[net] [2nd device]**
- [ ] **F-128** A guest leaving mid-session tears down cleanly (tile and strip disappear). **[net] [2nd device]**
- [ ] **F-129** Guest list shows connection state per participant. **[net] [2nd device]**

## O. Podcast mode (local high-quality recording)

- [ ] **F-130** Start a take: record-start broadcasts to guests over the data channel. **[net] [2nd device]**
- [ ] **F-131** Guest browser shows a REC indicator during the take. **[net] [2nd device]**
- [ ] **F-132** Host records its own raw camera master (ProRes 422 LT default) + pre-mix mic. **[net]**
- [ ] **F-133** Guest records locally at up to 4K, independent of call quality. **[net] [2nd device]**
- [ ] **F-134** Guest disk-space preflight warns before a long recording. **[net] [2nd device]**
- [ ] **F-135** Upload progress per guest is visible live in the host UI. **[net] [2nd device]**
- [ ] **F-136** **Durability test**: kill the guest tab mid-take, reopen — the recording resumes and at most ~5s is lost. **[net] [2nd device]**
- [ ] **F-137** Uploads keep draining after the call ends (a slow uplink doesn't lose the master). **[net] [2nd device]**
- [ ] **F-138** Stop take: record-stop broadcasts; manifest is patched. **[net] [2nd device]**
- [ ] **F-139** Session library lists sessions → participants → takes. **[net]**
- [ ] **F-140** "Download & Import All" fetches guest chunks and concatenates them. **[net] [ffmpeg]**
- [ ] **F-141** Imported tracks are `.mov` and open in the editor. **[net] [ffmpeg]**
- [ ] **F-142** **Sync torture test**: two devices, shared clap, 30-minute take — within ~30ms at both minute 0 and minute 30. **[net] [2nd device] [ffmpeg]**

## P. Teleprompter

- [ ] **F-143** ⇧⌘T toggles the prompter panel. **[offline]**
- [ ] **F-144** It floats above other apps, across Spaces. **[offline]**
- [ ] **F-145** Paste or import a script (txt/md). **[offline]**
- [ ] **F-146** Scrolls at a set WPM (80–220); space bar pauses/resumes. **[offline]**
- [ ] **F-147** Speed nudge up/down while scrolling. **[offline]**
- [ ] **F-148** Mirror mode. **[offline]**
- [ ] **F-149** Click-through mode while live. **[offline]**
- [ ] **F-150** "Park under camera" snap position. **[offline]**
- [ ] **F-151** **Leak test**: share your screen in Zoom — the prompter is NOT in the share, and never in the program output. **[offline]**
- [ ] **F-152** Per-scene script binding: switching scenes jumps the prompter to that section. **[offline]**
- [ ] **F-153** Scripts persist and can be managed (create/rename/delete). **[offline]**
- [ ] **F-154** Phone remote: open `prompter.html` on a phone → play/pause/speed/jump drive the panel. **[net] [2nd device]**

## Q. Edit mode — workspace

- [ ] **F-155** Open a session in the editor: tracks LEFT, transcript CENTRE, preview RIGHT, timeline BOTTOM. **[offline]**
- [ ] **F-156** Preview plays the edited program; space bar play/pause. **[offline]**
- [ ] **F-157** Frame-step forward/back. **[offline]**
- [ ] **F-158** Timeline shows a lane per track with waveforms. **[offline]**
- [ ] **F-159** Scrub the timeline; the playhead and preview follow. **[offline]**
- [ ] **F-160** Zoom the timeline in/out. **[offline]**
- [ ] **F-161** Split at the playhead (`S`). **[offline]**
- [ ] **F-162** Delete a range; the program shortens. **[offline]**
- [ ] **F-163** Re-enable ("recover") a cut clip; the program lengthens again. **[offline]**
- [ ] **F-164** Undo/redo across edits. **[offline]**
- [ ] **F-165** Edits persist: close and reopen the project. **[offline]**

### Sequence editing (reorder, trim, duplicate)

- [ ] **F-309** Drag a segment to a new position — the episode plays in the new order. **[offline]**
- [ ] **F-310** Drag a segment's edge to trim it shorter. **[offline]**
- [ ] **F-311** Drag an edge *outward* to extend back into material a cut had taken. **[offline]**
- [ ] **F-312** Duplicate a segment — the moment plays twice, and appears twice in the transcript. **[offline]**
- [ ] **F-313** Cut a word that appears twice: **every** occurrence goes, not just the first. **[offline]**
- [ ] **F-314** Split (S) lands in the occurrence under the playhead, not an earlier copy. **[offline]**
- [ ] **F-315** Reordering keeps the program length unchanged, and audio stays in sync across participants. **[offline]**
- [ ] **F-316** Chapters, captions and layout still land correctly after a reorder. **[offline]**
- [ ] **F-317** A project saved before sequencing opens and behaves exactly as it did. **[offline]**
- [ ] **F-318** One ⌘Z undoes a whole move, trim or duplicate. **[offline]**

### Per-track levels

- [ ] **F-319** Each audio participant has a gain slider; −6 dB is audibly quieter in the preview and the export. **[offline]**
- [ ] **F-320** **M** mutes a participant; the row dims. **[offline]**
- [ ] **F-321** **S** solos — everyone else goes silent; several tracks can be soloed together. **[offline]**
- [ ] **F-322** No click or level jump at cut boundaries on a track that isn't at 0 dB (the fades scale with gain). **[offline]**
- [ ] **F-323** Stem exports carry each track's gain but ignore mute/solo. **[offline]**
- [ ] **F-324** Levels persist across save/reload and undo like any other edit. **[offline]**

### B-roll lane

- [ ] **F-325** Clip Studio → B-Roll → **Insert on B-Roll Lane** puts a cutaway on the timeline. **[key]**
- [ ] **F-326** The cutaway replaces the picture and the conversation's audio keeps playing underneath. **[offline]**
- [ ] **F-327** Scrub across its start and end — the picture switches cleanly at both. **[offline]**
- [ ] **F-328** Captions stay readable **over** a full-frame cutaway. **[offline]**
- [ ] **F-329** Drag a cutaway to move it, and drag its ends to retime it; select and remove it. **[offline]**
- [ ] **F-330** Inset mode shows the cutaway as a corner picture over the conversation. **[offline]**
- [ ] **F-331** Two overlapping cutaways don't fight each other. **[offline]**
- [ ] **F-332** A cutaway whose moment was since cut refuses to insert, with a clear message. **[key]**

### Vertical timeline

- [ ] **F-333** The timeline is a column beside the transcript, time running top to bottom. **[offline]**
- [ ] **F-334** **Text** mode: a segment's block sits beside the words it contains. **[offline]**
- [ ] **F-335** In text mode a long silence still gets a block sized by its duration — visible and grabbable. **[offline]**
- [ ] **F-336** A short gap between words does *not* become a block. **[offline]**
- [ ] **F-337** **Time** mode: constant points per second, zoom in/out works. **[offline]**
- [ ] **F-338** Switching modes keeps the playhead and selection on the same moment. **[offline]**
- [ ] **F-339** Clicking anywhere on the timeline seeks the preview to that exact moment in both modes. **[offline]**
- [ ] **F-340** Each segment block shows a poster frame; they appear as you scroll and don't re-fetch. **[offline]**
- [ ] **F-341** Waveform columns run vertically, one per participant, and follow the *edited* program. **[offline]**
- [ ] **F-342** A muted or non-soloed track's column visibly dims. **[offline]**
- [ ] **F-343** The captions lane shows the lines that will actually be burned in. **[offline]**
- [ ] **F-344** Cut segments show as thin collapsed strips at their sequence position and can be restored. **[offline]**
- [ ] **F-345** Before transcription (no measured text) the timeline still renders usefully rather than blank. **[offline]**

## R. Edit mode — transcript & AI editing

- [ ] **F-166** Transcribe the session (WhisperKit, on-device); progress is reported. **[offline]**
- [ ] **F-167** Transcript shows word-level text per speaker (speaker = track, so no diarisation needed). **[offline]**
- [ ] **F-168** Click a word → the preview seeks there. **[offline]**
- [ ] **F-169** Select words + Delete → they're cut, and shown struck-through/grey. **[offline]**
- [ ] **F-170** Click struck-through text → the material is recovered. **[offline]**
- [ ] **F-171** Cuts land in silence, not clipping speech (SilenceSnapper). **[offline]**
- [ ] **F-172** **Remove filler words** — "um/uh/like" disappear in one pass. **[offline]**
- [ ] **F-173** **Tighten silences** — long pauses shorten to the target. **[offline]**
- [ ] **F-174** Automated cuts are inaudible (≈15ms micro-fades at each join). **[offline]**
- [ ] **F-175** Undo filler removal / undo silence tightening independently (each keeps its own label). **[offline]**
- [ ] **F-176** **AI Edit** (best-take assembly): record 3 takes of a scripted intro with flubs → proposals list the best take per section with confidence. **[key]**
- [ ] **F-177** Low-confidence sections are flagged for review. **[key]**
- [ ] **F-178** Apply the AI edit → the EDL changes; rejected takes are recoverable. **[key]**
- [ ] **F-179** **AI chapters** → YouTube-format list (`00:00 Intro`) on the clipboard. **[key]**
- [ ] **F-180** Chapters lane on the timeline; titles/positions editable. **[key]**
- [ ] **F-181** Chapter timestamps stay correct after further cuts. **[key]**

## S. Edit mode — layout & captions

- [ ] **F-182** Layout cue lane: change the program layout over time. **[offline]**
- [ ] **F-183** Each layout renders: Full Screen, Side by Side, Grid, Vertical (stacked), Active Speaker. **[offline]**
- [ ] **F-184** Auto-follow active speaker places cues automatically from per-track audio. **[offline]**
- [ ] **F-185** Manual cues override auto-follow. **[offline]**
- [ ] **F-186** A layout cue stays attached to its content after you cut elsewhere in the timeline (this was a fixed timebase bug — worth checking deliberately). **[offline]**
- [ ] **F-187** Captions render from word timings with karaoke word-by-word highlight. **[offline]**
- [ ] **F-188** Caption style controls: font, size, fill colour, highlight colour, position, background (none/pill/band), all-caps. **[offline]**
- [ ] **F-189** Emphasis words render in the highlight colour. **[offline]**
- [ ] **F-190** Captions burn into video exports. **[offline]**
- [ ] **F-191** SRT/VTT sidecar export. **[offline]**

## T. Edit mode — export

- [ ] **F-192** Audio master export — WAV. **[offline]**
- [ ] **F-193** Audio master export — AAC. **[offline]**
- [ ] **F-194** Per-participant stems export. **[offline]**
- [ ] **F-195** Video export 1080p. **[offline]**
- [ ] **F-196** Video export 4K. **[offline]**
- [ ] **F-197** Vertical 9:16 export with burned captions. **[offline]**
- [ ] **F-198** Export progress per job; cancel works. **[offline]**
- [ ] **F-199** Exports land in `~/Movies/Streamit/Exports` and play correctly. **[offline]**

## U. Clip Studio

- [ ] **F-200** Clip Studio opens from the editor toolbar. **[offline]**
- [ ] **F-201** Without a transcript, AI buttons are disabled and the footer explains why. **[offline]**
- [ ] **F-202** **Find Clips** → ranked suggestions with virality score badges and reasons. **[key]**
- [ ] **F-203** Each suggestion shows its hook line and suggested emphasis keywords. **[key]**
- [ ] **F-204** Alternate title options are listed per clip. **[key]**
- [ ] **F-205** **Preview** on a suggestion seeks the program preview to that moment. **[key]**
- [ ] **F-206** **Moment search** in plain language ("the part about pricing") returns ranked hits with summaries. **[key]**
- [ ] **F-207** **Jump** on a search hit seeks the preview. **[key]**
- [ ] **F-208** **B-Roll** suggestions list cutaway windows with search terms. **[key]**
- [ ] **F-209** B-roll matches the session's own video files by name where possible. **[key]**
- [ ] **F-210** Caption template gallery shows built-ins (Karaoke, Boxed, Minimal) with live swatches. **[offline]**
- [ ] **F-211** Selecting a template updates the swatch/preview; AI-picked emphasis words survive the change. **[offline]**
- [ ] **F-212** Per-look overrides: size, highlight mode, position, background, all-caps. **[offline]**
- [ ] **F-213** **Save** a custom template → it reappears after relaunch; delete works; built-ins can't be deleted. **[offline]**
- [ ] **F-214** Brand kit editor: font, primary/accent colours with chips. **[offline]**
- [ ] **F-215** Choose a watermark image; clear it; opacity slider. **[offline]**
- [ ] **F-216** "Apply Brand Colours to Captions" updates the caption style. **[offline]**
- [ ] **F-217** "Save Brand Kit" persists across relaunch. **[offline]**
- [ ] **F-218** **Analyze Session** reports speaker-segment count and per-track face-sample counts. **[offline]**
- [ ] **F-219** **Compute Crop Paths** stores paths on the project; Clear removes them. **[offline]**
- [ ] **F-220** Export settings: aspect (9:16 / 1:1 / 16:9) changes the default layout to match. **[offline]**
- [ ] **F-221** Layout picker per clip (Vertical / Active Speaker / Side by Side / Full Screen / Grid). **[offline]**
- [ ] **F-222** **Smart reframe ON** → exported 9:16 keeps the speaker framed with headroom. **[key]**
- [ ] **F-223** **Smart reframe OFF** → same clip is visibly centre-cropped. *(A/B this pair — it's the proof the crop path reaches the renderer.)* **[key]**
- [ ] **F-224** The crop **cuts** rather than pans when the active speaker changes. **[key]**
- [ ] **F-225** Export a clip → it lands as its own file, trimmed to the clip range, with captions if enabled. **[key]**

## V. Publishing

- [ ] **F-226** Publish panel opens from the editor toolbar and pre-fills the most recent export. **[offline]**
- [ ] **F-227** Choose a different file manually. **[offline]**
- [ ] **F-228** Connections section shows per-platform state, with guidance when not signed in. **[offline]**
- [ ] **F-229** Publishing while unauthorised fails with a clear "sign in" message (not silently). **[offline]**
- [ ] **F-230** YouTube form: title, description, tags. **[oauth]**
- [ ] **F-231** **Append Chapters** drops the generated chapter list into the description. **[oauth] [key]**
- [ ] **F-232** YouTube upload succeeds and lands as **private**; Open link works. **[oauth]**
- [ ] **F-233** Upload progress shows in the queue row. **[oauth]**
- [ ] **F-234** TikTok: title-only form, matching what the API accepts; post arrives at SELF_ONLY. **[oauth]**
- [ ] **F-235** Instagram: publishing reveals the file in Finder and explains the public-URL limitation. **[oauth]**
- [ ] **F-236** **Schedule** for a couple of minutes out → the row shows the time and fires while the app runs. **[oauth]**
- [ ] **F-237** A failed upload shows the error; **Retry** re-runs it. **[oauth]**
- [ ] **F-238** **Remove** clears a queue row. **[offline]**
- [ ] **F-239** Sign Out clears a stored token and the row updates. **[oauth]**

## W. Settings & housekeeping

- [ ] **F-240** Settings → Session Server accepts and persists the Worker URL. **[offline]**
- [ ] **F-241** Settings → AI stores the Claude key in the **Keychain** (not in any file). **[offline]**
- [ ] **F-242** Settings → Audio Devices pickers list real devices and persist by UID across relaunch and reboot. **[offline]**
- [ ] **F-243** Settings → Virtual Devices shows driver status and install/uninstall. **[cert]**
- [ ] **F-244** HearIt (the iOS app in this repo) still builds and is untouched. **[offline]**

---

## X. Keyboard shortcuts

Two layers, deliberately on different combos so a keypress can never fire
both and toggle twice: **menu** shortcuts (⇧⌘/⌘-based) need the studio
focused; **global** hotkeys (⌥ and ⌃⌥-based) work from any app.

### Global — test these with another app frontmost

- [ ] **F-245** ⌥1…⌥9 fire sound pads. **[offline]**
- [ ] **F-246** ⌃⌥R starts/stops recording. **[offline]**
- [ ] **F-247** ⌃⌥M mutes/unmutes the microphone. **[offline]**
- [ ] **F-248** ⌃⌥→ / ⌃⌥← step to the next/previous scene (wrapping at both ends). **[offline]**
- [ ] **F-249** ⌃⌥T shows/hides the teleprompter. **[offline]**
- [ ] **F-250** ⌃⌥Space plays/pauses the prompter scroll. **[offline]**
- [ ] **F-251** ⌃⌥P plays/pauses music. **[offline]**
- [ ] **F-252** No macOS accessibility-permission prompt is needed for any of these. **[offline]**

### Menu — studio focused, and visible in the Studio menu

- [ ] **F-253** The Studio menu lists every command with its key combo. **[offline]**
- [ ] **F-254** ⇧⌘R record, ⇧⌘M mute, ⇧⌘T prompter. **[offline]**
- [ ] **F-255** ⌘] / ⌘[ next/previous scene. **[offline]**
- [ ] **F-256** ⌘1…⌘9 jump to a scene by sidebar position; the submenu lists real scene names. **[offline]**
- [ ] **F-257** ⌥⌘T prompter play/pause; ⇧⌘P music play/pause; ⇧⌘] / ⇧⌘[ next/previous track. **[offline]**
- [ ] **F-258** Pressing a menu combo while the studio is frontmost toggles **once**, not twice (the global/menu split is doing its job). **[offline]**

### Rebinding & discoverability

- [ ] **F-259** Settings → Shortcuts lists every global hotkey with a recorder. **[offline]**
- [ ] **F-260** Rebind a pad (say to ⌘⌥7); the new combo fires the pad and the old one stops. **[offline]**
- [ ] **F-261** The pad's on-screen badge updates to the newly assigned combo. **[offline]**
- [ ] **F-262** An unassigned pad slot shows **no** badge (rather than advertising a dead key). **[offline]**
- [ ] **F-263** Rebindings survive relaunch. **[offline]**
- [ ] **F-264** Settings → Shortcuts also lists the fixed menu and editor shortcuts for reference. **[offline]**

### Editor shortcuts

- [ ] **F-265** Space plays/pauses the preview. **[offline]**
- [ ] **F-266** ← / → step one frame back/forward. **Also check they don't fight the transcript caret** when the transcript has focus (the transcript is an NSTextView; this interaction is the one I'd expect to need a tweak). **[offline]**
- [ ] **F-267** `S` splits at the playhead — from the timeline itself, not only while a context menu is open. **[offline]**
- [ ] **F-268** Delete cuts the selected timeline clip; the button is disabled with nothing selected. **[offline]**
- [ ] **F-269** Delete with words selected in the transcript cuts those words (transcript wins while it has focus). **[offline]**
- [ ] **F-270** ⌘Z undoes the last edit; ⇧⌘Z redoes it. **[offline]**
- [ ] **F-271** One ⌘Z reverts one *gesture* — including a whole Clean Up or applied AI edit — not one clip at a time. **[offline]**
- [ ] **F-272** Undo/redo buttons disable correctly at the ends of the stack. **[offline]**
- [ ] **F-273** Undo covers layout-cue additions and chapter changes, not just cuts. **[offline]**

## Y. Music sections (live performance)

Mark a track up before the show, then drive it live. Everything here is
offline; a MIDI controller is only needed for section Z.

### Marking a track up (playlist → Sections…)

- [ ] **F-380** "Sections…" on a playlist row, or the transport button, opens the editor with the waveform drawn. **[offline]**
- [ ] **F-381** The title is editable in the sheet, and the rename sticks in the playlist. **[offline]**
- [ ] **F-382** A track whose file has moved says "File missing" instead of drawing an empty strip. **[offline]**
- [ ] **F-383** Drag the start flag to 0:12, then play that track — it begins at 0:12, not 0:00. **[offline]**
- [ ] **F-384** Play from inside the sheet: the playhead moves over the waveform. **[offline]**
- [ ] **F-385** Press **M** three times while it plays — three sections appear at those points. **[offline]**
- [ ] **F-386** Each new section auto-takes the lowest free hotkey slot, so it's immediately firable. **[offline]**
- [ ] **F-387** Those three are contiguous: each open section runs to the next one's start, and the last to the end of the file. **[offline]**
- [ ] **F-388** Drag a section's right edge — that end becomes explicit and stops following the next section. **[offline]**
- [ ] **F-389** Type `1:23.480` into a start field and press Return: the marker moves. Type nonsense: the field reverts rather than clearing. **[offline]**
- [ ] **F-390** Rename, recolour, toggle Loop, and set a hotkey slot per section; all persist across relaunch. **[offline]**
- [ ] **F-391** The star marks a section to fire when the track loads. **[offline]**
- [ ] **F-392** Zoom in and out; it stops at 50pt/s (past that the waveform data repeats). **[offline]**
- [ ] **F-393** A section shorter than a quarter second is refused with a reason, not silently dropped. **[offline]**
- [ ] **F-394** A section longer than three minutes is refused with a reason. **[offline]**

### Playing live (music panel)

- [ ] **F-395** With sections defined, a now/next line and a row of section pads appear above the transport. **[offline]**
- [ ] **F-396** Click a pad: that section plays and loops seamlessly — leave it looping for five minutes and listen for drift or a tick at the wrap. **[offline]**
- [ ] **F-397** The playing pad fills with its colour; the position readout stays correct after hundreds of loop passes. **[offline]**
- [ ] **F-398** With mode **Cut**, clicking another pad switches immediately. **[offline]**
- [ ] **F-399** With mode **At loop end**, it queues: the pad shows NEXT, the readout counts down, and the switch lands at the wrap. **[offline]**
- [ ] **F-400** Cancel a queued switch before it fires; the cancel button disables once it's been handed to the audio engine. **[offline]**
- [ ] **F-401** ⌥-click a pad to cut regardless of the mode, without changing the mode. **[offline]**
- [ ] **F-402** The Loop button stops the loop and lets the song run on from where it is. **[offline]**
- [ ] **F-403** Drag the scrubber outside the looping section: playback follows the scrubber and the loop releases (it does not snap back). **[offline]**
- [ ] **F-404** Talking still ducks the music while a section loops. **[offline]**
- [ ] **F-405** Insert effects, the music fader, mute and the meter all behave exactly as before on a looping section. **[offline]**
- [ ] **F-406** A section whose file has gone says why instead of failing silently. **[offline]**
- [ ] **F-407** Drop audio files onto the music panel to add them (it used to be picker-only). **[offline]**
- [ ] **F-408** The transport shows elapsed **and** total duration. **[offline]**

### Section hotkeys

- [ ] **F-409** With Zoom frontmost, ⌃⌥3 fires the section bound to slot 3 of the loaded track. **[offline]**
- [ ] **F-410** A slot with nothing bound does nothing at all — it never stops the music or fires the wrong section. **[offline]**
- [ ] **F-411** Add a marker *earlier* than an existing one: the existing section keeps its slot (bindings are explicit, not positional). **[offline]**
- [ ] **F-412** ⌃⌥C flips the switch mode; ⌃⌥L toggles the loop; ⌃⌥0 cancels a queued switch. **[offline]**
- [ ] **F-413** ⌃⌥K drops a marker at the playhead while another app is frontmost. **[offline]**
- [ ] **F-414** Pads show the real bound combo; rebinding in Settings → Shortcuts updates the badge, and an unbound slot shows none. **[offline]**
- [ ] **F-415** Settings → Shortcuts lists each slot with its section's name, "(empty)", or "(no track loaded)". **[offline]**

### Regression — a track with no sections

- [ ] **F-416** Plays, seeks, skips and loops exactly as it did before this feature existed. **[offline]**
- [ ] **F-417** The section controls are visible but disabled, not hidden. **[offline]**
- [ ] **F-418** An `audio-settings.json` written before this feature loads with devices, gains, ducker, inserts, pads and playlist intact. **[offline]**
- [ ] **F-419** A 44.1 kHz track's progress bar reaches the end exactly as the track ends (it used to run ~8.8% fast). **[offline]**
- [ ] **F-420** Dragging the scrubber is smooth and doesn't fight you; it seeks once, on release. **[offline]**

## Z. MIDI control

- [ ] **F-421** Connect a USB controller: Settings → MIDI lists it with a green dot. **[midi]**
- [ ] **F-422** Press any pad — "Last message" updates even with nothing bound. **[midi]**
- [ ] **F-423** Learn a control for Section 1, press a pad, and the binding appears. **[midi]**
- [ ] **F-424** That pad now fires section 1 live, including while another app is frontmost. **[midi]**
- [ ] **F-425** Learning a control that's already bound replaces the old binding rather than double-firing. **[midi]**
- [ ] **F-426** Bind switch mode, loop, cancel-queued and play/pause; all behave like their hotkeys. **[midi]**
- [ ] **F-427** Soundboard pads can be bound too. **[midi]**
- [ ] **F-428** Unplug and replug the controller: bindings still work (they match the message, not the device). **[midi]**
- [ ] **F-429** A controller sending clock or active sensing doesn't flood or stutter the app. **[midi]**
- [ ] **F-430** Bindings survive relaunch, and live in `midi-bindings.json` — deleting that file loses only bindings, nothing else. **[midi]**

## AA. External media in the editor

Bringing files that were never part of the session into the edit.

### Media bin

- [ ] **F-431** Tracks pane → Media → **Add Media…** imports a file; the row shows its length and whether it has picture or sound. **[offline]**
- [ ] **F-432** A natively playable file imports instantly, with no conversion step and no copy. **[offline]**
- [ ] **F-433** A WebM or MKV offers conversion, and the result lands marked "Converted" and survives relaunch. **[ffmpeg]**
- [ ] **F-434** With no ffmpeg helper present, conversion fails with the "add it to Contents/Helpers" message rather than silently. **[offline]**
- [ ] **F-435** A copy-protected file is refused by name, and never enters the bin. **[offline]**
- [ ] **F-436** One bin item can be used for several cutaways. **[offline]**
- [ ] **F-437** Move a file on disk and reopen: a "files missing" banner appears and the affected rows say Missing. **[offline]**
- [ ] **F-438** **Relink…** one missing file and its siblings from the same old folder relink too, with a count reported. **[offline]**
- [ ] **F-439** Blocks for missing media still draw at their timeline positions — only the picture is gone. **[offline]**
- [ ] **F-440** B-Roll suggestions now consider imported clips, not just the session's own recordings. **[key]**

### Cutaways by hand

- [ ] **F-441** Drag a video from Finder onto the B-roll lane: it becomes a cutaway there, with no AI suggestion involved. **[offline]**
- [ ] **F-442** During the drag the lane highlights and a chip names the outcome and the time. **[offline]**
- [ ] **F-443** Dropping on the sequence column is refused, pointing at the B-roll lane. **[offline]**
- [ ] **F-444** A dropped file also appears in Media, so it can be reused. **[offline]**
- [ ] **F-445** An audio-only file lands in Media with an explanation, not as an invisible cutaway. **[offline]**
- [ ] **F-446** A file longer than the room left is trimmed to fit, with a note saying how much was used. **[offline]**
- [ ] **F-447** Dropping at the very end refuses and suggests using it as an outro. **[offline]**
- [ ] **F-448** Select a cutaway → the inspector appears under the preview with its poster, name, and the AI's reason if it had one. **[offline]**
- [ ] **F-449** **Start inside clip** scrubs the media's own in-point, bounded by its real length. **[offline]**
- [ ] **F-450** Full-frame vs inset, the corner presets and opacity all take effect in the preview. **[offline]**
- [ ] **F-451** Turn on the cutaway's audio: you hear it, and the conversation ducks. **[offline]**
- [ ] **F-452** Adjust the duck amount; the conversation is already down when the clip starts, not fading as it begins. **[offline]**
- [ ] **F-453** A cutaway whose media is missing produces **no** duck, rather than ducking under silence. **[offline]**
- [ ] **F-454** Stem exports contain no cutaway audio and no ducking. **[offline]**
- [ ] **F-455** One ⌘Z undoes a whole inspector slider drag, a whole cutaway move, and a whole trim. **[offline]**
- [ ] **F-456** **B** inserts a cutaway at the playhead from a file picker. **[offline]**

### Extra tracks

- [ ] **F-457** Media → right-click → **Add as Extra Track** puts a clip in its own "Extra Media" section. **[offline]**
- [ ] **F-458** The row shows the file's name, never a participant name. **[offline]**
- [ ] **F-459** Offset nudges shift it against the conversation; picture and sound move together. **[offline]**
- [ ] **F-460** Its M/S/dB behave exactly like a participant's; soloing it silences the people. **[offline]**
- [ ] **F-461** It gets its own timeline column, tinted distinctly, and the overlay and caption lanes stay correctly positioned. **[offline]**
- [ ] **F-462** The Layout menu offers "Full Screen — <file>", and switching to it works. **[offline]**
- [ ] **F-463** A **portrait** clip renders upright rather than sideways (this was a latent bug — participant cameras are always landscape). **[offline]**

### Intro / outro

- [ ] **F-464** Set an intro: the exported file starts with it and the conversation follows. **[offline]**
- [ ] **F-465** Setting or trimming an intro does **not** move a single chapter or cutaway. **[offline]**
- [ ] **F-466** Exported chapters, SRT and VTT are all offset by the intro, so they line up with the file. **[offline]**
- [ ] **F-467** The preview playhead still matches the timeline exactly with an intro set. **[offline]**
- [ ] **F-468** Set an outro: it plays after the conversation ends. **[offline]**
- [ ] **F-469** No participant leaks into the intro or outro picture. **[offline]**

### Standalone projects

- [ ] **F-470** Sessions → **New Project from a File…** opens the editor over one clip. **[offline]**
- [ ] **F-471** Waveform, thumbnails, the mixer and the timeline all work in it. **[offline]**
- [ ] **F-472** Clip Studio says "transcribe this clip", not "the session". **[offline]**
- [ ] **F-473** Transcribe it, and the AI features enable. **[offline]**
- [ ] **F-474** An unreadable file reports why instead of opening an empty editor. **[offline]**

### Regression

- [ ] **F-475** A project with no external media of any kind exports byte-comparably to before. **[offline]**
- [ ] **F-476** A project saved before any of this opens with cuts, levels, cutaways and chapters intact. **[offline]**

## Known gaps (don't waste time testing these)

1. **The brand kit's watermark is stored but never rendered.** Intro and outro
   are real now (F-464+), but they are set per project in the editor rather
   than pulled from the brand kit — wiring the kit's stingers to default them
   is the remaining half.
1b. **Gapless playlist advance (F-101) is close but not sample-accurate.** The
   next file is now opened ahead of time and started on the second player
   node, so the disk is out of the seam; a main-queue hop between the
   completion handler and the swap remains. Judge it by ear.
1d. **Beat-grid snapping** for section edges is not implemented; marker
   positions are set by ear and by typed timecode. Zero-crossing snapping was
   considered and rejected — at a loop seam the discontinuity is between the
   last sample and the first, so aligning one edge cannot remove it.
2. **Instagram publishing cannot work end-to-end** by design in v1 — the
   Graph API pulls from a public URL the app doesn't host. It deliberately
   reveals the file in Finder instead.
3. **Waveform cross-correlation alignment** is the designed v1.1 refinement;
   v1 aligns on clock anchors + drift fit only (the `TrackAligner` protocol
   is the seam).
4. **Speech-follow prompter scrolling** was assessed and deferred to v1.1;
   v1 ships timed scrolling.
5. **Source aspect for smart reframe is assumed 16:9.** A per-track probe is
   the refinement; 4:3 or portrait masters will reframe with slightly wrong
   crop geometry.
6. **29 `verify on Mac:` markers** across 22 files flag API assumptions made
   without a compiler. `grep -rn "verify on Mac" Mac/ CameraExtension/ driver/`

## Suggested testing order

1. **A** (build + tests) — cheapest signal, and the tests cover the layers everything else sits on.
2. **B–G** (scenes, sources, elements, fills, animations, effects) — all offline, no certs. This is most of the app.
3. **I–K, M** (audio, effects, soundboard, recording) — still offline.
4. **H, L** (virtual camera, virtual mic) — needs certs; keep frozen once working.
5. **Q–U** (editor, AI editing, Clip Studio) — needs the API key; use any recording, guests not required.
6. **N–O** (guests, podcast mode) — needs the backend deployed and a second device.
7. **V** (publishing) — needs platform app registrations; do last.

Section **X** (keyboard shortcuts) is offline and can be tested any time after the app builds — do the global hotkeys with Zoom frontmost.

Section **Y** (music sections) is offline and belongs with step 3. Section **Z**
(MIDI) needs a controller and can go last with the other hardware-dependent
work.
