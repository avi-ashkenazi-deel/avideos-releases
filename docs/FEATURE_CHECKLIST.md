# AVideos Studio — full feature checklist

All 345 user-facing features, each with a stable ID so you can report
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

---

## A. Build & foundations

- [ ] **F-1** `xcodegen generate` produces a project with 3 new targets (AVideosStudio, CameraExtension, AVideosAudioDriver) + AVideosStudioTests, HearIt targets untouched. **[offline]**
- [ ] **F-2** Unit tests pass: Cmd-U or `xcodebuild test -scheme AVideosStudio` (no hardware needed). **[offline]**
- [ ] **F-3** App launches to the main window; app icon appears in Dock/Finder. **[offline]**
- [ ] **F-4** Window layout: scene list left, preview centre, inspector right, tabbed panel bottom. **[offline]**
- [ ] **F-5** fps HUD visible on the preview and reads ~30. **[offline]**
- [ ] **F-6** Quit and relaunch: the project reloads from `~/Library/Application Support/AVideos/Projects/`. **[offline]**

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
- [ ] **F-67** "AVideos Camera" appears in **Photo Booth** (pickiest consumer). **[cert]**
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
- [ ] **F-106** "AVideos Microphone" appears in System Settings → Sound and in Zoom's mic list. **[cert]**
- [ ] **F-107** Zoom hears the full program mix: mic + music + pads + movie. **[cert]**
- [ ] **F-108** "AVideos Guest Send" device exists (mix-minus feed for guests). **[cert]**
- [ ] **F-109** Driver status shows installed + version; re-install after a version bump. **[cert]**
- [ ] **F-110** Uninstall removes both devices cleanly. **[cert]**

## M. Recording

- [ ] **F-111** ⇧⌘R starts/stops recording; menu item mirrors the state. **[offline]**
- [ ] **F-112** REC indicator + elapsed timer while recording. **[offline]**
- [ ] **F-113** Output `.mov` (HEVC) lands in `~/Movies/AVideos` and plays. **[offline]**
- [ ] **F-114** H.264 codec option produces a playable file. **[offline]**
- [ ] **F-115** **Clap test**: audio and video are in sync in the recording. **[offline]**
- [ ] **F-116** Recording captures the composited program (scenes, elements, effects) — not the raw camera. **[offline]**
- [ ] **F-117** Force-quit mid-recording: the fragmented file (5s interval) is still playable. **[offline]**

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
- [ ] **F-329** Drag a cutaway to move it; select and remove it. **[offline]**
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
- [ ] **F-199** Exports land in `~/Movies/AVideos/Exports` and play correctly. **[offline]**

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

## Known gaps (don't waste time testing these)

1. **Watermark and intro/outro stingers are stored but never rendered.** The
   brand kit persists them and the Clip Studio panel says so, but
   `ExportService`/`CompositionBuilder` don't composite them yet.
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
