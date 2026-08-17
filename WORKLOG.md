# HearIt — Work Log

A running log of what we've built and shipped.

## Conventions

- **No emojis in TestFlight notes, release notes, or any App Store Connect text.**
  Write "What to Test" and release notes in plain text only — those store-facing
  fields don't accept emojis. (Chat replies may still use them; this rule is
  specifically about text pasted into TestFlight / App Store Connect.)

## 2026-07-28 — streamit: floating-palette shell, first-use bug batch

Avi shared reference screenshots (Ecamm Live) of the interface he's
imagining: everything sits on the recording itself. Rebuilt the live-mode
shell to match — the preview now fills the window and every control surface
is a draggable floating palette on top of it (`Mac/UI/FloatingPalettes.swift`):
Scenes, Overlays, Sound Effects, Sound Levels, Music, Interview, Inspector,
Setup, toggled from an icon strip on the right edge, with positions and the
open set persisted in UserDefaults. On-video chrome: scene switcher top-left,
Record bottom-center. The NavigationSplitView + bottom-tab layout is gone.

Two new palettes replace old panels outright. **Overlays** is the layers
panel that didn't exist: one row per element with an eye (show/hide through
the entry/exit animation), kind icon, drag-to-reorder z-order (topmost
first), gear to the inspector, and the add-element row shared with the
inspector (element factories moved to `StudioController`). **Sound Effects**
replaces the pad grid with rows — play/stop toggle, name, hotkey badge,
trimmed length, a progress fill sweeping the row, and a gear popover editing
in/out points (`SoundPad.trimStart/trimEnd`, Optional for settings-decode
compatibility; `SoundPadPlayer` slices the pre-decoded buffer at fire time).

Eighteenth pass — the editor's delivery gaps, in four moves, per "Ok let's
fix these" plus multicam. (1) **Brand kit finished**: the watermark is now
actually rendered — `CompositionBuilder.WatermarkContext` decodes the kit's
image once and `LayoutVideoCompositor` draws it topmost (above captions) on
every video export, previews staying clean; and a brand-new project seeds
its intro/outro from the kit's stingers on first open only (reopened
projects keep the user's word). The smart-reframe 16:9 assumption is gone —
per-track aspects are probed during scene analysis — and exports render at
the fastest source's frame rate instead of a hardcoded 30. (2) **Loudness
normalization**: a self-contained BS.1770 meter (`LoudnessMeter`,
K-weighting biquads + 400 ms gated blocks, measured through the export's own
AVAssetReaderAudioMixOutput so the number describes the actual file) drives
a measure-then-rebuild in ExportService — audio masters land at −16 LUFS,
video at −14, gain applied multiplicatively to every source so the mix
balance is untouched, capped so the sample peak stays under −1 dBFS (it is
normalization, not a limiter). Off-switch in Preferences → Audio; stems are
never touched. (3) **Music bed**: `EditProject.musicBed` (Optional — the
settings-decode rule) loops a file under the conversation, fades at both
edges (`VolumeAutomation.fadedAtEdges`, pointwise multiply so ducks
survive), and ducks under speech using merged transcript word spans as
anticipatory duck windows — no transcript, no ducking, and the row says so.
(4) **Multicam**: `AudioAligner` cross-correlates energy envelopes
(vDSP_conv, zero-mean, 20 ms hop, template = the external file's most
energetic minute) to set a second camera's `sourceOffset` from one "Sync by
Audio" click, refusing with a peak-to-sidelobe confidence gate rather than
guessing; and a "Cut to" angle strip above the timeline drops
full-screen-this-camera layout cues at the playhead, replacing a cue within
50 ms instead of stacking. New pure-logic tests: loudness gating, edge
fades, and offset recovery from synthetic envelopes (`EditorAudioTests`).
F-488…F-499.

Twenty-fourth pass — the editor grows up a level, plus rehearsal feeds.
**Auto-transcription, two-speed**: opening a session with no transcript
starts transcription on its own — a quick `base`-model pass lands a usable
transcript in seconds, the turbo model then replaces it wholesale (safe:
cuts live in the EDL as source times, not in the transcript), and with a
Claude key stored a **punctuation polish** runs last — Claude gets numbered
words and returns index+replacement corrections, validated so letters can
never change, only case and attached punctuation; timings untouched by
construction (`PunctuationPolisher`, sonnet-tier, structured output).
**Cuts are visible and movable**: every join between timeline blocks draws
a dark seam with a scissors mark, and a selected block moves with plain
↑/↓ — iMovie's swap-places, routed through `edl.move` + performEdit so one
⌘Z per press. **Intro playback**: the cap's ▶ now PLAYS from program zero
(it only seeked — "doesn't do anything"); the black-intro render got the
full treatment — every silent skip in `insertBookends` now logs why
(unresolvable media, no video track, insert failure), bookends carry their
`preferredTransform` like cutaways, and the compositor reports once per
lane when a required track never delivers a frame, so the next black intro
names its cause in Console. **Music clips, plural**: dropping an AUDIO file
on the timeline now creates a music clip on the lane (green, ♪) — audible
at −12 dB, dipping under speech via the music bed's exact duck engine
(`ExternalAudio.duckUnderSpeechDB`, Optional per the settings-decode rule),
faded at its edges, trimmed/moved/removed like any block, as many as the
edit wants; the bed stays for whole-episode underscore. The overlay
inspector gained the "Dip under speech (music)" toggle (mutually exclusive
with "Duck the conversation"). **Rehearse Layouts** (Interview palette):
1–3 `DemoGuestSource` test cards — tinted, named, animated so a frozen
feed is obvious — registered under real `.guest(identity:)` keys, so
interview grids, tiles and magic move run the exact multi-person paths
with nobody on the call. F-511…F-518.

Twenty-third pass — third live round: the 3D pad tilted only after
mouse-up. The model, plan and Metal render were all live — MTKView's own
pacing is what stalls while the main run loop sits in event-tracking mode,
i.e. for the whole length of any SwiftUI drag, so the preview froze
mid-gesture (Zoom would have shown the tilt moving). The preview now paces
itself from a main-queue DispatchSourceTimer (GCD main-queue drains run in
the common run-loop modes, tracking included — the ducker's trick) with
`isPaused` + `enableSetNeedsDisplay`. The White/Green/Black effect buttons
gained a "Test Screens" title and a caption saying what they're for (green
= keying setup, white/black = lighting checks) — they read as mystery color
swatches. Inspector rework per "it needs to hover close to the object":
a persistent header always names the selected element (icon + name), the
add-element icon bar is gone (creating a new overlay while inspecting an
existing one made no sense; adding lives in the Overlays palette), and the
palette now PARKS ITSELF beside the selected element — the canvas overlay
reports the selection's screen rect, and the window repositions on
selection change or an explicit pencil/gear summon, top-aligned, right of
the element (left when there's no room), never chasing a drag.

Twenty-second pass — second live test round, seven reports in one batch.
**Palette windows stole every in-content drag**:
`isMovableByWindowBackground = true` meant any drag not on a native control
moved the window — the inspector's 3D tilt pad dragged the palette instead
of tilting, and the Overlays list couldn't drag-reorder. Off; the title bar
still drags. **Virtual Background finally has per-mode controls**: Color
mode was hard-coded near-black with no picker ("no way to select the
background color") — now a ColorPicker, Blur gets a radius slider, and a
chosen image/video shows its filename with a Choose… button so picking one
visibly lands. **Settings fields save as you type**: the guest Worker URL
only persisted on Return — the one key nobody presses in a URL field — so
"I can't edit anything in settings"; both it and the Claude key now save
onChange with a green checkmark confirming the stored value. **Editor
timeline: zoom and filmstrips.** ⌘= / ⌘− zoom in strict-time mode
(pointsPerSecond clamped 4–400), and segment blocks now draw
Premiere-style filmstrips — 58 pt tiles, each sampling `ThumbnailStore` at
its own source time — instead of a single stretched poster. **Bookends are
now a thing on the timeline**: fixed orange cap rows above/below the
timeline body show "Intro — <file> · 0:07" with play-from-top and Clear;
previously a set intro was invisible outside the transport label ("I see
it when I add it but then… I don't see it as a thing").

Twenty-first pass — first editor test round, and the build-staleness trap.
Avi's screenshots showed no Pause button and no REC timer — both shipped
that afternoon — and no Music Bed section: **the binary was v0.3.0 (19),
compiled before four pushed commits**. The build stamp did its job
(compile time visible), but a version that never changes can't distinguish
commits — bumped to 0.4.0 (21) and it will move every push from now on.
Real bugs found regardless of staleness: **transcription could never have
worked** — the WhisperKit model was requested as "large-v3-turbo", a name
that does not exist in argmaxinc/whisperkit-coreml (the turbo release is
"large-v3-v20240930_turbo"); fixed, with a fallback chain (632 MB
compressed turbo, then base) so a failed download degrades instead of
dying. **The Layout menu was a coin flip on a fresh project**: it appended
a cue at the playhead's source time, and two cues with equal atTime
resolve by unstable sort order — a fresh project already has a cue at 0,
so clicking a layout at the top of the video randomly won or lost against
it. Now it replaces any cue within 50 ms and routes through performEdit
(it also bypassed undo). **The editor rendered as a centered band** — the
AppKit-backed HSplitView settled on its children's ideal height on its
first real render; explicit max-frame fill on the split view and each
pane. Bookend refusals now say why (codec vs DRM vs empty) instead of a
generic "can't".

Twentieth pass — **the shared screen records on the guest's machine too**,
clarifying "record the video on the person's computer" → the guest video
share. `LocalRecorder` grew a third, *dynamic* lane: `setScreenTrack(...)`
hands it the live share track, and mid-take that starts/finalizes a
"screen" MediaRecorder on the spot — shares start and stop mid-take, so
unlike audio/video this lane records its own anchor per start and rides
the same IndexedDB → R2 chunk pipeline (`stop()` now iterates whatever
lanes exist, and the meta.json emission collapsed into one `_finishKind`).
guest.js feeds the track from the same `refreshScreenButton` that tracks
the browser's real publish state, and posts the screen lane's manifest
patches on the new "screen-started"/"screen-stopped" recorder events. Mac
side: `TrackKind.screen`; import encodes it exactly like video, and the
mid-take start needs nothing new — the aligner's anchor-vs-take-start
offset already becomes the `-itsoffset` head delay. The imported track
lands as a video lane with a synthetic participant ("<name>'s Screen"), so
tiles, waveform-less rows, and the multicam "Cut to" strip all work
without the editor learning a third media kind. F-507…F-510.

Nineteenth pass — **guest screen share**. The guest page gets a Share
screen button (`setScreenShareEnabled`; the button reflects the real
publish state via LocalTrackPublished/Unpublished, because the browser's
own "Stop sharing" bar can end a share without us). Host side, the fix
that makes it work is per-source keying: a guest's camera and screen are
two independent feeds — `SourceKey.guestScreen(identity:)` +
`SourceBinding.guestScreen`, a second receiver map in
GuestSessionController (routing on `publication.source`, with a `verify on
Mac:` on the pinned SDK's spellings), and the registry skips both guest
key kinds when reaping. When an on-air guest shares, the interview scene
recomposes itself: spotlight arrangement with the screen as the stage —
letterboxed, never cropped, unlike every face tile — and host + all faces
in the strip. The screen is also placeable anywhere: right-click the guest
row → "Add <name>'s Screen as Tile" (a new element factory that starts
large and centered), and the inspector's source picker lists "<name>'s
Screen". The green-room gate applies unchanged — an off-air caller's
screen stays off the program. Deliberately not in v1: screen-share tab
audio (the guest strip carries one ring, the mic's; flagged F-506).
F-500…F-506.

Seventeenth pass — **call-ins**, per "i want to get calls in". The guest
system could already take a browser caller (any device, invite link, no
app), but anyone opening the link landed straight on the program. Now
there's a gate: a joining caller starts **off air** in a green room —
connected, hearing the mix-minus, visible in the Guests palette with an
orange "waiting" state — and joins the program only when the host clicks
**Put On Air** (which unmutes their strip, adds them to the interview
tiles, recompiles the plan, and flips a red ON AIR badge on their page via
a new `on-air` data message; clicking again pulls them back without
disconnecting). Plan compilation reads `onAirDescriptors` instead of all
guests; the strip attaches muted for waiting callers; the palette's Mute is
disabled off-air (already silent). "New callers wait off air" in the
palette (AppPreferences.guestsStartOnAir, default screening ON) restores
walk-right-in for planned interviews. DEV_SETUP gained a "Taking call-ins"
runbook — browser call-ins work as soon as the Worker + LiveKit backend is
deployed — and documents the designed-but-unbuilt PSTN path (LiveKit SIP
trunk; a phone caller would arrive as a normal audio-only participant and
flow through this same gate). F-482…F-487.

Sixteenth pass — a maintainability review (run at Avi's request against an
extremely strict external rubric), then its fixes, all behavior-preserving.
The two files past the 1000-line boundary were split by moving text, not
redesigning: StudioController's element factories now live in
`StudioControllerElements.swift` (1096 → 972 lines) and EditWorkspaceView's
async AI actions + undo system in `EditWorkspaceActions.swift` (1202 → 940);
members those extensions touch dropped `private` (it is file-scoped), noted
at the declarations. The camera id had two spellings — `SourceKey` used
`nil` for "system default", `SourceBinding` used `""`, translated at three
scattered sites — replaced by one `CameraID` struct (Primitives.swift) that
encodes as the same bare string documents already store, so nothing
re-persists. The `-1` ellipse-mask sentinel is now produced by a named
`MaskShape` enum in RenderPlan (and `SourceTileShape.circle` no longer
smuggles the shader constant through the model). The six copy-pasted
active-scene `firstIndex` guards collapsed into `withActiveScene(_:)`. Five
drifted per-view timecode formatters became `Timecode.clock/tenths`
(Mac/Model/Timecode.swift) — YouTube chapter stamps deliberately stay their
own format. And guest-track chunk downloads now run six-wide through a
throwing task group instead of one at a time — these are the multi-GB 4K
masters, and the single connection was the import bottleneck; order never
mattered because chunks land as named files and are concatenated by key.
Left alone on purpose: AudioEngineController's pass-throughs (that facade is
the design), the Optional-everywhere settings convention (load-bearing — a
non-optional new field silently wipes user config), and MusicPlayer's state
variables (deliberate, untested on hardware, and under the line limit).

Fifteenth pass — **pause mid-recording**. `AVAssetWriter` has no pause API,
so this works by compacting the writer's timeline: while paused nothing is
appended, and every timestamp appended afterwards has the accumulated paused
span subtracted from it (`ProgramRecorder.pause()/resume()`, host-clock
deltas). The resulting file is therefore **gapless** — the paused span is
absent rather than a frozen frame or a stretch of silence — and A/V sync
survives because video and audio are stamped against the same host clock and
get the same offset. Two details that would otherwise bite: a frame or audio
buffer stamped *inside* the pause window can still be delivered after the
resume, and compacting it would move the timeline backwards, so both paths
drop anything older than the resume instant; and audio needs a retimed copy
(`CMSampleBufferCreateCopyWithNewTiming`) whose timing entry keeps the
buffer's **per-sample** duration — `CMSampleBufferGetDuration` returns the
total and would have been wrong. Surfaced as a Pause button beside Record
(only while recording), ⌥⌘R on the Studio menu, ⌃⌥. globally, and a HUD that
turns amber and stops its clock. The elapsed readout is new too, and counts
*written* media, so it always matches the length of the file you get.

Fourteenth pass — a build stamp, because "am I running what I just pulled?"
had no answer. `Mac/App/BuildInfo.swift` reads `CFBundleShortVersionString` /
`CFBundleVersion` and derives the build *time* from the executable's own
modification date — deliberately runtime-only, so there is no generated
source or build script to dirty the tree or invalidate a signature. It shows
next to the frame rate in the HUD (`v0.3.0 (19) · 17:57`, long form on
hover), leads the streamit menu as a disabled line, and fills the standard
About panel. Version bumped to 0.3.0 (19).

Thirteenth pass — the music section editor, rebuilt around the pointer and
the keyboard. It opened zoomed to a fixed 12 pt/s (so a 3:39 track ran off
the window), sections could only be made from the transport, and the End
column showed the literal word "End" for the common open-ended case. Now:
the waveform **fits the whole track by default** (Fit clears the explicit
zoom rather than restoring a magic number), **dragging across the waveform
draws a new section** with a live band and its length in the middle, a short
click seeks instead, dragging a band's middle **slides it** while keeping
its length, edges still resize, clicking selects (white ring + highlighted
row), and the End field shows the **derived** end time greyed out. Keyboard,
which is how marking up actually goes: Space play/pause, M mark at the
playhead, I/O trim the selected section's in/out to the playhead, ←→ nudge,
L loop, ⌫ delete, Esc deselect — with the legend in the footer where the
⌥-click tip used to be.

Twelfth pass — a 3D-ish transform layer, and a chrome sweep. **Skew, gimbal
tilt and fake extrusion**: `ElementTransform` gains tiltX/tiltY/skew/depth/
perspective (all Optional, so old projects decode unchanged, with
non-optional accessors for the UI and full lerp support so magic move can
tilt a flat tile into perspective across a switch). The renderer needed
almost nothing new — `quadToNDC` already returned a 3×3 on homogeneous 2D
coords, which can carry a full projective transform, so skew + two-axis
rotation + weak perspective compose into ONE homography; the vertex shader
now hands the third component to the rasterizer as `w`, which buys both the
divide and perspective-correct uv interpolation for free. Flat elements keep
the plain affine path (third row stays (0,0,1)). Extrusion is the same quad
drawn as a receding stack of darkened copies (new `tint` uniform) offset
along the element's projected 3D normal — with no tilt it falls back to a
down-right offset, the classic extruded-title look. The inspector gets a
gimbal pad (drag to tilt both axes, drawn horizon, double-click to reset)
plus Lens, Depth and skew sliders.

Also: **copy/paste elements between scenes** (⇧⌘C/⇧⌘X/⇧⌘V and the layer
row's context menu — an in-app clipboard, so the user's real pasteboard is
untouched); canvas Delete now **deselects** as it hides, so no selection box
lingers around an invisible element; **camera scenes cover the canvas**
(`SourcePresentation.camera`, migrated on load for never-configured scenes —
letterboxing a camera in a square show is never wanted, while shared screens
keep `.fit`); the **window adopts the program's aspect** and locks to it on
a shape change, so a square or vertical show fills its window; the palette
strip drops the Setup icon (virtual-device install lives in Settings with
every other preference) and puts FX (a text icon) next to Music (notes);
and a new `StudioButtonStyles` gives the studio's icon buttons, picture
tiles and list rows real **hover states** — `.plain` and `.borderless` drew
nothing, so most of the chrome never looked clickable.

Eleventh pass — magic move made SMART, not just possible. Identity-only
matching still faded Avi's photo out and in ("that's not smart"). Two
changes. Content now beats identity where content IS identity:
`Element.transitionKey` keys images/videos by media path and web overlays
by URL, so the same picture in two scenes glides between its positions no
matter how the scenes were made. And the engine gained a second matching
pass: leftover items of the same content class (text↔text, shape↔shape,
image↔image) pair with the nearest unclaimed sibling by center distance —
so a lower-third that exists in both scenes stays put and swaps its words
in place instead of fading through black. Live sources are excluded from
proximity pairing on purpose (two different cameras must never morph); the
key pass already matched those.

Tenth pass — magic move made real, and the Scenes palette got its previews.
The transition engine was always capable of gliding matched items; nothing
ever MATCHED, because scene primaries carried a private "primary:…"
transition key while camera/guest tiles use "camera:<uid>"/"guest:<id>".
Primaries now share that namespace, so a full-screen camera glides into its
PiP tile (or interview tile) in the next scene — position, size and corner
radius interpolate, which is exactly the full-screen → half-screen → little
circle ask. `duplicateScene` keeps element ids for the same reason: the id
is the fallback transition key, so a title moved in the copy glides instead
of fading out and in. Scenes: every row/tile shows the scene's last program
look (3 s refresh of the active scene + a capture on every switch-away,
CIContext downscale off-main from the preview's pixel buffer), with Ecamm's
list/grid display toggle and the ⌘N badge in both modes. And the on-video
scene popup shows exactly one chevron (`menuIndicator(.hidden)` — the menu
style was drawing a second one).

Ninth pass — Ecamm-style Preferences, planned against a real trace of how
canvas size and frame rate propagate. The enabler:
`RenderEngine.reconfigure` (pool.configure + the long-unused `flush()` hook
+ clock restart) — everything downstream already sizes off the target
texture, so the program reshapes live. `StudioController.applyCanvasSettings`
guards recording (an in-flight writer is pinned to its start dims), pushes
fps into the source registry (which was hardcoding 30 for screen sources),
and rebuilds screen sources on fps changes. The extension's advertised
format list grows to cover every preset (`verify on Mac:` non-16:9 in Zoom).

The panes: **Shape & Size** (per-project: Wide/Classic/Square/Tall ×
4K/1080/720/540 × 24-60 FPS, aspect changes confirm because unit transforms
stretch existing overlays, disabled while recording); **Recording** (codec
picker finally wiring the recorder's unreachable HEVC/H.264 param, a
recordings-folder chooser, a 3-second countdown with press-again-to-cancel);
**Video** (default source mode — the scene-list plus button gained a
primary click — default transition + duration, Auto-Play Video Files via a
paused-start MovieSource); **Audio** (devices + echo cancellation + mic
self-monitor moved in, plus Mute Movie Sound On Speakers — a movie gate on
the monitor bus, same pattern as the mic gate); **General** (Show Camera
Switcher, Keep Utility Windows In Front — palette `hidesOnDeactivate`
follows the pref live). All app-level toggles live in a new UserDefaults-
backed `AppPreferences` (@Observable) on StudioController.

Eighth pass. **The web overlay's box is its browser viewport**: every
recompile pushes the element's pixel size into the WKWebView (window +
frame), so resizing the box relayouts the page like a browser window —
before, the page rendered at a fixed internal size and letterboxed into
whatever shape the box was. Web items render `.fill` so mid-resize frames
crop browser-style; a resize arriving while the interactive window is open
applies when it closes. **The camera strip got its Ecamm polish**: every
tile is a live preview (per-tile low-res capture session — macOS shares a
device between in-process sessions; `verify on Mac:` for virtual cameras
that refuse a second client), tiles sort by device name so they never
shuffle on click, and switching dissolves program over 0.25s with both
cameras running through the fade (reusing the scene-transition engine)
instead of hard-cutting to a device that's still spinning up.

Seventh pass, rapid-fire from live use. **Camera switching**: an Ecamm-style
strip above Record (one tile per device, click to switch the active camera
scene live) plus `setActiveCamera` — you were stuck with the scene's
starting camera. **Web overlays are browsers now**: the URL commits on Enter
and actually navigates the running page (`WebSource` captured its content at
init and never reloaded — the edit only changed the document), "airbnb.com"
gets https:// prepended, and "Open Browser…" puts the live WKWebView in a
floating window to click/scroll/log in — closing hands it back to the
offscreen host, snapshots flowing throughout. **Border radius for
everything**: `Element.cornerRadius` overrides every kind's default in the
plan compiler (circle masks stay circles), one Radius slider in the
transform editor. **Four new shader fills** (aurora, stripes, radial pulse,
smoke) end-to-end: enum + dispatch indices + Metal; the style picker now
derives from CaseIterable so new kinds can't be forgotten. **Scenes**: ⌘D
duplicates (fresh scene+element ids, name + " Copy"); scene rows show their
live ⌘N badge; the badge is reassignable per scene (context menu → Shortcut)
with explicit picks winning and the rest numbering by position
(`Project.sceneShortcuts`); the on-video popup and Studio menu read the same
map. **Close buttons**: the teleprompter's close leads its control strip as
a red circle (was buried at the far end), and the script editor and podcast
Sessions sheets got Mac-style top-left closes (Esc still works).

Sixth pass — device presentation and multi-input. Plugged-in iPhones and
iPads can be presented: `CameraSource` opts the process into CoreMediaIO's
screen-capture devices (the QuickTime/Ecamm flag, wireless included) and
discovery now also sweeps MUXED external devices, which is how iOS screens
present; Android phones acting as UVC webcams were already covered by
`.external`. Muxed devices reject the .high preset, so it's now conditional.
Multiple microphones: new `.input(uid)` mixer strips — each extra input runs
its own `MicCapture` engine feeding a ring into the mix hub, joins program
and mix-minus but not the monitor (a second mic echoes exactly like the
first), persists in `AudioSettings.extraInputUIDs` (Optional, decode-safe),
and appears as a normal mixer row with fader/mute/FX. "Add Input" menu in
Sound Levels; right-click an input row to remove it.

Fifth pass — Ecamm parity round, from Avi's side-by-side screenshots. The
scene popup matches theirs: "Show Scenes Window" (⌘\, also a real menu-bar
command) above the scene list with ⌘1…⌘9 badges. The overlay add-row now
reads like Ecamm's: text, **text box** (new: `TextContent.boxFill` — the
plan compiles a background shape item under the glyph item, same transform
and animation, stroke moves to the box), shape, image, video, **countdown
timer** (new `ElementKind.timer`: renders as text the studio re-ticks at
1 Hz via a `timerTexts` map into the plan compiler; the count restarts when
the element is shown; duration/size/restart in the inspector), browser, and
camera. The inspector got kind-aware sections: shape picker + radius for
shapes, box controls for text, countdown controls for timers, and a **tile
shape** picker for camera/guest insets (Wide/Classic/Square/Circle/Squircle/
Tall — aspect preset rewrites the transform, circle uses the existing
ellipse-mask sentinel, and source tiles now render `.fill`). Audio effects
load the Ecamm way: the insert Add menu lists the full AU catalog grouped
by manufacturer (Apple's AUGraphicEQ/AUDistortion included), every insert
row opens its native plug-in window, and units without a custom view get
CoreAudioKit's generic parameter editor instead of a shrug label.

Fourth pass, live-testing fallout. **Playing any pad crashed**: the trim
slice computed its end frame as `(end ?? .greatestFiniteMagnitude) × rate`
converted to `AVAudioFramePosition` — out of Int64 range for every
untrimmed pad, so the very first play trapped. Mapped the optional instead;
committed the moment it was diagnosed. **The pad trim editor became the
soundtrack itself**: peaks computed straight off the already-decoded PCM
buffer (`SoundPadPlayer.peaks`, vDSP, cached), drawn time-proportionally
with draggable in/out handles on the waveform, a dimmed outside-window
region and a playhead sweeping while it sounds — replacing the two abstract
sliders. **The music transport was half missing**: its single HStack
overflowed the palette width and clipped the scrubber, time readout and
Sections/Add buttons; split into two rows, gave the playlist-loop button a
visible on-state chip, and gave "previous" standard semantics (restart the
track when more than 2s in — it also had nothing to do in a one-track
playlist). **Dragging elements was jittery**: move/resize gestures measured
translation in the moving view's own coordinate space, which re-measures
against the moved view every tick and oscillates; both now measure in the
stable "canvas" space, like the rotation grip always did.

Third pass, from running it live. **You heard your own mic** — the program
bus (which must contain the mic, for recording and the virtual devices) was
also the monitor. The graph now has a dedicated `monitorMixer`: every strip
except the mic feeds it, the program bus reaches the output only through a
silencer (so its tap keeps firing), and the mic can rejoin the monitor
through a gate node — a "Hear my own mic" toggle in Settings, off by
default. **Recording looked broken** because `isRecording` was computed off
the non-observable ProgramRecorder — SwiftUI never updated the Record
button; the state is now mirrored observably, and stopping presents a
what-now dialog: Open in Editor / Show in Finder / Delete (bad take) / Keep.
**The mixer got the Ecamm treatment**: horizontal rows — name, MUTE, one
slider whose groove doubles as the live green meter — replacing the rough
vertical strips. **Selection got a pencil** that opens the Inspector window
on the element. **New image/video elements start at the media's real size**
(1:1 canvas pixels when they fit, scaled at their own aspect when not; EXIF
rotation respected). **Camera and guest tiles are addable as elements** from
the overlays palette, for host-small-over-screen-share. And **Delete on the
canvas now hides** (exit animation, recoverable via the eye) — only the
Overlays palette's remove genuinely deletes.

Second pass after Avi ran it: the palettes must be *independent windows* you
can move anywhere (that's what Ecamm does), not views drawn inside the studio
window. Rebuilt on `WindowGroup(id: "palette", for: PaletteKind.self)` — the
icon strip calls `openWindow(value: kind)`, which refocuses rather than
duplicates; `PaletteWindowConfigurator` (an NSViewRepresentable) makes each
window a real palette: `.floating` level, hides on deactivate, movable by
background, minimize/zoom hidden, frame autosaved per palette. The in-window
drag/position/persistence machinery from the first pass is deleted.

The EQ insert stopped pretending to be a volume knob: `.eq` rows now show a
six-band graphic editor (80 Hz low shelf … 12 kHz high shelf, ±12 dB bipolar
faders, double-click to zero) instead of the macro slider. Gains live on
`InsertEffect.eqBandGains` (Optional — same settings-decode rule) and apply
through `InsertChain.setEQBandGains`; an untouched EQ keeps the legacy
"presence" macro curve. The sound list also gained user folders
(`SoundPad.folder`, move-to-folder via context menu, DisclosureGroups in the
palette) — background tracks and FX can be organized the way Ecamm's Songs
folder is. The Music palette stays separate for now: the playlist carries
the section-loop/performance machinery, which doesn't collapse into a row.

First-use bug batch, from Avi's punch list after the first real session:
text elements were invisible (TextRasterizer scaled the 1080p-reference font
size by the element's height instead of the canvas's — a 64pt title rendered
at ~8px); mixer faders froze mid-drag (reads went to the non-observable
AudioGraph strip, so SwiftUI never saw changes); a fired pad couldn't be
stopped (playPad now toggles); Delete removes the selected canvas element
(onDeleteCommand + a ⌘⌫ menu twin); web elements gained a URL field; the
script editor sheet gained a Close button; beautify did nothing (CIMix amount
was inverted — max strength gave the weakest smoothing — and the r8 Vision
mask sampled as red-only, so CIBlendWithMask read a full-person pixel as ~21%
grey; both fixed, `verify on Mac:` on the wrap assumption); and the Setup
cards now detect a dev-app-only build and explain that there is nothing to
install instead of failing raw.

## 2026-07-28 — streamit: first interactive run, and the dead-input hunt

The app built, launched, rendered at 30 fps and played audio — and responded
to nothing. No clicks, no menus, no Cmd-Q, across hours and eleven rounds of
instrumentation. Today it works. The root cause was ours, subtle, and worth
recording in detail because every symptom pointed somewhere else first.

**Root cause: subsystems started before `NSApplicationMain`.**
`StudioController` is a SwiftUI `@State` default value, so its init ran while
the App struct was being built — before AppKit registered the process as a GUI
application. That init started everything: the render clock, the first plan
compile (which starts the camera), three audio engines, CoreMIDI, the CMIO
sink connection; `TeleprompterController`'s init installed NSEvent global key
monitors equally early. Connections that early race AppKit for the process's
window-server registration. Lose the race and the app comes up
half-registered: windows draw, the render loop runs, but activation is
refused — clicks are consumed by failed activation attempts and delivered to
no one. Win the race and everything works, which is why the symptom came and
went between identical launches. Forensics that finally pinned it: forced
`activate(ignoringOtherApps:)` returning inactive, `procRole: Background` in a
crash report, LaunchServices `StatusLabel=[NULL]`, and clicks that produced
neither a local monitor hit in-process nor a global monitor hit in any other
process — events destroyed, not misrouted. The fix is structural: `init` only
constructs and wires; a new idempotent `bootSubsystems()` performs all
ignition from `onAppear`, after launch completes.

**The instrument that cracked it** was built up over rounds inside
AppDelegate (now removed): a file-teed event probe (`log stream` needs admin),
window/screen/Space inventories, a 30-second activation heartbeat, a global
monitor distinguishing "delivered elsewhere" from "vanished", a title-bar
counter showing the window's own view of its input, and a live
pointer-vs-frame readout that exonerated both the user's aim and the window's
geometry in one gesture. `scripts/list-event-taps.swift` — which enumerates
every filtering event tap in the session — stays, because it answers a class
of question nothing else does.

**Red herrings, so nobody chases them again:** the Handy dictation utility's
filtering event tap (quit it, no change); ad-hoc signing vs the linker stub
(properly signed, no change — though signing did surface that the dev
entitlements file had been unparseable XML all along: a double hyphen inside a
comment); a Claude-desktop overlay stealing clicks (one genuinely stolen
in-window click remains on record from one run — most plausibly a transient
screenshot-capture surface — but it was not the standing cause); and window
geometry (the autosaved frame at (2998, -42) was legitimate all along).

**Real fixes that fell out of the hunt:** the mix-minus bus reaching the
speakers (heard as doubled audio — `AVAudioMixerNode.volume` does not silence
a source-side node; a dedicated silencer mixer does), the preview drawing at
60 fps against a 30 fps engine (44% of main-thread time waiting in
`currentDrawable`), `.contentSize` window resizability (window could not be
resized at all), the activation policy for terminal launches, dev-app-only.sh
no longer editing project.yml in place, the test bundle's TEST_HOST following
the lowercase product name, and the generated project renamed to
Streamit.xcodeproj. The recommended dev loop is now Xcode itself: open
Streamit.xcodeproj, scheme Streamit, Cmd-R.

## 2026-07-27 — Renamed: AVideos Studio is now streamit

Every occurrence, in one pass, before anything ships and while there is no
saved data to migrate.

The convention is **`streamit` lowercase wherever the product name is
displayed** — the app bundle, the menu bar, the window title, the virtual
devices Zoom lists ("streamit Camera", "streamit Microphone", "streamit Guest
Send"), the splash wordmark — and **`Streamit` wherever it is an identifier**:
the Xcode target, the Swift module, symbols, and paths under Application
Support. `PRODUCT_NAME: streamit` with `PRODUCT_MODULE_NAME: Streamit` is what
holds those apart; without the second, the module would silently become
`streamit` and the tests would import it that way.

Bundle identifiers moved to `com.aviashkenazi.streamit`, which drags three
contracts with it that have to stay consistent or the product half-works in
ways that are hard to see: the camera extension's bundle id must sit under the
app's, its `trustedSigningIDPrefix` must match the app's id or the extension
refuses the host's frames, and the two loopback device UIDs
(`…streamit.vmic`, `…streamit.gsend`) are agreed between `Driver.cpp` and
three Swift files. All verified after the fact rather than assumed.

Backend identifiers moved too — the IndexedDB name, the upload-grant HMAC
context, the R2 bucket and Worker names in the docs. The grant context never
crosses the wire (it only derives a key inside the Worker), so web and worker
cannot disagree, and nothing is deployed yet.

Not renamed, deliberately: the `Mac/`, `CameraExtension/` and `web/`
directories, which describe what they hold rather than the product; and the
Xcode *project*, which is still `HearIt.xcodeproj` because HearIt is the
shipped iOS app that lives alongside this one and is untouched.

**The one thing that changes day to day:** the scheme is now `Streamit`, so
`xcodebuild ... -scheme Streamit`, and the built bundle is `streamit.app`.

## 2026-07-27 — streamit: first compile, first run, green suite

streamit had never been compiled. Roughly 25k lines of Swift, Metal and
C++ were written on Linux against documentation and reasoning, and this is the
session where a Mac finally read them. The app now builds, launches, and its
269 unit tests pass.

**Getting to a build took four environment fixes before a single line of our
own code was compiled.** libASPL was declared as a Swift package, but it is a
CMake C++ library with no `Package.swift`, so SPM resolution failed for the
whole project — including the tests, which have nothing to do with the audio
driver. It has to be vendored instead. Then the camera extension and driver
are embedded build dependencies, so a plain build demanded Developer ID certs;
`scripts/dev-app-only.sh` now comments that block out and swaps in
`Streamit-dev.entitlements`, which is the shipping file minus
`com.apple.developer.system-extension.install` — a restricted entitlement only
a provisioning profile can grant, and meaningless in a build with no extension
to install. A `curl 16` HTTP/2 failure fetching swift-collections was git
transport, not us.

**Nine of our own compile errors, in seven rounds.** The instructive part is
the distribution. Only three were ordinary mistakes: a `...` range split across
a newline (whitespace before but not after makes `...` lex as the *prefix*
operator, so the parser closed the expression and wanted a comma),
`Dictionary.Keys + Dictionary.Keys` where no `+` overload exists, and an
implicit-member closure inside a `+` chain that the type checker could not
anchor. Two were audited-API drift: `MTAudioProcessingTapCreate`'s `tapOut` is
now `UnsafeMutablePointer<MTAudioProcessingTap?>` rather than `Unmanaged`, and
`AVAudioUnit.audioUnit` is not Optional. One was a missing import —
`requestViewController` is a CoreAudioKit category on `AUAudioUnit`, not part
of AudioToolbox.

**The remaining four were all actor isolation, and that is the lesson.**
Isolation is the one property that cannot be checked while writing a file in
isolation — it is a whole-module question, and every `@MainActor` boundary in
25k lines got checked at once, for the first time, in the same minute. Each
wanted a different answer. `TranscriptEditorView.Coordinator` needed two
methods annotated rather than the class, because `dismantleNSView` is a
nonisolated static requirement. `PreviewPlayer` needed its time observer moved
into a nonisolated box, because `deinit` is nonisolated even in a `@MainActor`
class — a `verify on Mac:` note had predicted exactly this and named the fix.
`MusicPlayer` became `@MainActor`, which it already was in practice: all five
of its scheduling completion handlers opened with `DispatchQueue.main.async`.
And `EditProjectStore`'s path statics needed `nonisolated`, because a static
member inherits the class's isolation and `write(_:)` runs detached.

**LiveKit had moved three APIs.** `from: "2.6.0"` resolves to 2.15.3.
Rather than guess one build at a time, the resolved SDK source was read and
every call site audited against it. That found two things the compiler could
not: `GuestVideoReceiver` was a plain Swift class, but `VideoRenderer` is an
`@objc` protocol whose `render` requirements are *optional* and reached via
ObjC optional dispatch — it would have type-checked and never received a
frame. And the SDK's adapter calls both `render(frame:)` and
`render(frame:captureDevice:captureOptions:)` for every frame, so implementing
both meant converting and ingesting each guest frame twice.

**Then the suite found two real bugs.** `ScriptAligner` returned, when it found
no anchors at all, a single span covering the entire script and the entire
transcript — asserting the opposite of what "nothing matched" means.
Downstream, `TakeDetector` would manufacture a take from it and
`ClaudeTakeSelector` could discard it as the loser, silently cutting material
that was never in the script. The design says ad-libs are never cut; this was
the path that broke it. Separately, the overshoot easing never overshot:
`p + amount * sin(p * .pi)` humps above the linear *ramp*, not the target, and
the sine vanishes at p = 1, so pop and both flips were eases wearing an
overshoot's name.

**What this does not establish.** The suite is pure logic by design — EDL
arithmetic, envelopes, timing math, Codable round-trips. It touches no
hardware and no AVFoundation runtime. 33 `verify on Mac:` markers remain and
this run settled none of the runtime ones, only the compile-time question of
how the current SDK types `sourcePixelBufferAttributes`. The eight on the music
path are still open, chief among them whether `playerTime.sampleTime` is in
node frames or file frames. Nothing here has yet proved that a camera renders,
that audio flows, or that a loop wraps without a click.

## 2026-07-27 — streamit: external media in the editor

Avi asked whether external videos could be brought into the edit. They
couldn't, really: the B-roll lane could hold any file, but the only door
to it was inside a Claude-generated suggestion, there was no drag-and-drop
anywhere in the editor, cutaway audio was discarded by design, and an
external file couldn't be a track at all. `BrandKit`'s intro/outro fields
had existed all along with nothing consuming them.

**Two pure extractions first**, so the rest was changing tested arithmetic
rather than inventing it inline. `MediaPlacement` pulls the insert-and-pad
loop out of `build()`, gaining a source offset (head padding then falls
out of the same code as the existing tail padding) and a timeline offset.
`VolumeAutomation` combines the cut micro-fades and any ducking into one
envelope by pointwise minimum — necessary because their ramps overlap in
time, and overlapping `setVolumeRamp` ranges on one parameters object are
not a defined composition.

**Ducking is derived from what was actually inserted**, never from the
authored range. A cutaway whose media is missing then produces no duck,
and a short one ducks only for as long as it sounds. The offline attack
ramp *ends* at the clip start, so the conversation is already down when
the audio arrives — the anticipatory duck a realtime follower can't do,
which is why reusing `SidechainDucker` offline was never on the table.

**External tracks are `EditTrack`s with a side table**, the shape
`trackMix` already uses. The track carries a synthetic participant id, and
that one choice makes layouts, tiling, crop paths and the compositor
address an imported angle exactly as they address a person — no enum
change, no parallel path. One file becomes two tracks, video and audio, so
every store and loop keeps working untouched.

**Bookends are an offset, not a prepend.** Prepending would renumber every
chapter and cutaway each time you trimmed the intro. Program time exists
only inside `CompositionBuilder`, the sidecar writers, and one seam in
`PreviewPlayer`, which publishes the playhead as always-edited time — four
lines that keep fifteen `mapSourceToTimeline` call sites from having to
know bookends exist.

Two bugs fixed on the way: `preferredTransform` was set on composition
tracks but never applied by the compositor, which reads raw buffers, so a
portrait clip would have rendered sideways; and the trim/move callbacks
had been declared and wired to the model since the timeline was built with
nothing invoking them.

**Still open:** the brand kit's stinger fields don't yet default the
per-project intro and outro, there's no freeform inset rectangle (corner
presets only), and no stock-footage search.

## 2026-07-27 — streamit: live music sections

Avi wanted the background-music player to be performance-controllable:
choose where a track starts, loop a chosen part, and switch between parts
mid-show — choosing how the switch happens, with a hard cut available.

**The mechanism.** `AVAudioPlayerNodeBufferOptions` decides the whole
design. Scheduling a decoded region with `.loops` gives a bit-exact wrap
inside AVFoundation's render loop, and the same options set gives both
switch modes: `.interrupts` for a cut, `.interruptsAtLoop` for a switch
the render thread performs at the boundary. Re-scheduling file segments
was the alternative and it cannot do "wait for the loop" — there is no
partial-flush API, so staying seamless means always having the next pass
queued, and a request then lands a full pass late. Detecting the boundary
ourselves is worse: render thread, internal thread, main queue (where the
ducker already runs at 60 Hz), then schedule. 20 ms is 960 frames of
silence mid-loop. So the switch is always pre-scheduled.

**Queued switching is two-phase** because there is no unschedule API. The
target stays cancellable until a 500 ms commit window before the boundary,
so you can change your mind almost until it fires; missing the window
costs one extra pass, never a gap.

**Position was rebuilt** around an anchor plus a modulus. The old formula
assumed exactly one segment and a `stop()` before each schedule, which a
loop cannot honour — and it divided node frames by the *file's* sample
rate while the graph runs at 48 kHz, so a 44.1 kHz track's progress bar
ran ~8.8% fast. That assumption is now behind one function with the test
to settle it on the Mac.

**Two persistence traps closed.** `AudioSettingsStore.load()` swallowed
every decode error and returned blank settings, so the next debounced save
overwrote the file half a second later — one unknown enum string was
enough to destroy the host's devices, faders, ducker, inserts and pads. It
now quarantines the file and logs why, and the enums decode leniently. New
`MusicTrack` fields are Optional rather than defaulted vars, because
synthesized `Decodable` throws `keyNotFound` for a non-optional even when
it has a default.

**Decisions worth remembering.** Hotkeys resolve by explicit per-section
binding, never by position: sections stay sorted by start time, so a
positional map would renumber every slot after any marker added later.
Sections have *open* ends by default, which is what makes tap-to-mark
produce contiguous parts without mutating earlier ones. And zero-crossing
snapping was rejected — at a loop seam the discontinuity is between the
last sample and the first, so aligning one edge cannot remove it.

**Still open:** crossfade falls back to a hard cut, and gapless playlist
advance (F-101) remains false — both need a second player node, which
`musicBus` is already designed to take. Beat-grid snapping and MIDI out
for controller LEDs are the natural follow-ups.

## 2026-07-26 — streamit: podcast editor rework

Avi reviewed the editor and flagged two gaps as critical, correctly: the
tracks pane was read-only (nothing to do about a guest who recorded hot),
and B-roll suggestions had nowhere to land — the suggester was built, the
lane in the original plan never was. Alongside those: cut/drag-to-extend,
moving segments, captions on the timeline, per-clip previews, and turning
the timeline vertical so it reads beside the transcript.

**The EDL became a real sequence.** It used to document that clips are
sorted by source time and tile the source exactly, which forbids reordering
outright. Now array order *is* timeline order; ranges may repeat and appear
in any order. An EDL written under the old rules is already valid under the
new ones, so nothing migrates. New ops: trim (can extend back into material
a cut took), move, duplicate, and one hard remove for duplicates.

The consequence worth remembering: **a source time can now map to zero, one
or many timeline positions.** `mapSourceToTimeline` answers with the first;
`timelinePositions(ofSource:)` answers with all. `Transcript.enabledWords`
and the transcript rebuild were inverted to walk segments rather than words,
which is what makes a duplicated moment appear twice, keeps the output
monotonic (captions and the speaker timeline both assume it), and turns an
O(words × clips) scan into a binary-searched pass.

**Per-track levels**: gain, mute and solo per participant, kept on the
project rather than on `EditTrack` (that type describes what was recorded).
The subtle part is that the 15 ms micro-fades had to scale with gain —
ramping to a hardcoded 1.0 would jump any trimmed track to full level for
7.5 ms at every cut. Stems carry gain but ignore mute/solo.

**B-roll lane**: `OverlayClip`, video-only, positioned in edited time. Each
cutaway gets its own composition track; instruction boundaries now split at
overlay edges too, or a cutaway starting mid-instruction would never appear.
Drawn above the tiles and below the captions. Clip Studio can finally insert
one.

**Vertical timeline**, replacing the horizontal strip. A `TimelineScale`
protocol supplies "how far down is this second", with a strict-time scale
and a text-aligned one where a word's block sits beside its own text —
hybrid on purpose, since silences keep duration-proportional height so a
long pause is still visible and trimmable. Drawn in program order (a
source-positioned strip cannot render a reordered edit at all), with poster
frames per block, vertical waveform columns, a captions lane, and cut
segments as collapsed strips. `TranscriptEditorView` measures word rectangles
through the TextKit layout manager to feed the aligned scale.

Still open: bidirectional scroll-position sync between the two panes, and
following the playhead during playback — the latter needs the playhead
highlight moved out of the attributed-string rebuild first, or it would
rebuild the whole transcript every tick.

## 2026-07-26 — streamit: 20 entry animations for overlay layers

Overlay text/shape/image layers had 7 entry animations. Expanded to 20,
chosen to cover the *feels* broadcast overlays need rather than 20 variants
of one idea, and grouped into families in the inspector (a flat list of 21
is a wall):

- Fade; Slide from Left/Right/Top/Bottom (fully off-canvas).
- **Drift** from Left/Right, Rise Up, Settle Down — a short offset plus a
  fade, never leaving the frame. The restrained family, and the one to use
  for text over a face.
- Scale Up, Scale Down (arrives from 140%), Pop (small overshoot).
- Spring Up (soft overshoot on position), Bounce In (decaying bounce).
- **Reveal**: Wipe Horizontal/Vertical grow one axis from zero at full
  opacity — made for lower-third bars; Flip Horizontal/Vertical add a slight
  overshoot for a card-turn read.
- Rotate In (small tilt straightens), Swing In (tilt oscillates and settles).

Deliberately excluded: multi-turn spins, elastic rubber-banding, diagonal
fly-ins. Also excluded because they need shader/text work rather than a
curve, and faking them would be worse than not having them: blur reveals,
mask wipes, per-glyph typewriter.

Contract enforced by tests, since a violation is subtle on screen and
permanent in the document: every style lands **exactly** on the resting
transform at progress 1, draws nothing at 0, never dips in opacity mid-entry,
and never produces negative or non-finite geometry. Exit stays "entry
reversed", which is why those two endpoints are the whole contract.

Springs/bounces/oscillations now declare `definesOwnTiming` and run on linear
progress — easing a bounce muddies it — and the inspector says so. Picking a
style adopts a duration that flatters it (a bounce is slower than a fade).
Added `replayEntryAnimation` behind a **Play Entry** button, since comparing
twenty styles by hiding and showing an element is unusable.

## 2026-07-26 — streamit: source framing (fit / fill / blurred backdrop)

The program canvas is 16:9 (or 9:16), but a shared window rarely is. Found
that the compositor did **no** aspect handling at all: source textures were
mapped straight onto the item quad, so a 4:3 window or a portrait capture was
silently *stretched* — distorted faces and wide text, which is worse than the
black bars you'd expect.

- `SourceFit`: **fit** (contain, centred — now the default), **fill** (cover,
  crop), **blurredBackdrop** (contained sharp copy over a blurred over-zoomed
  copy, so no bars), **stretch** (the old behaviour, kept as an escape hatch).
- `SourcePresentation` adds manual **zoom** and **pan** on top of the fit rule,
  so a small shared window can be pushed in to fill more of the frame.
  Per scene, in the inspector when nothing is selected.
- Shader: `framedUV` computes the sampling window from the source's real
  texture dimensions vs the quad's aspect; contain mode discards fragments
  outside the content so the background shows through instead of a smeared
  edge. `blurredSample` gives the backdrop a 16-tap wash (cheap — the backdrop
  is out of focus by design, so sparse taps read as smooth).
- Blurred backdrop is expressed at *plan* level as an extra cover-fitted item
  behind the sharp one, so the compositor needs no special case. The backdrop
  gets a derived stable id, carries no effects (a chroma key must not punch
  holes in it) and ignores the foreground's pan.
- ItemUniforms grew five fields; Swift and MSL layouts documented offset by
  offset (both 160 bytes) since that ABI is where this pipeline breaks.
- `SourceFramingTests` pins the window arithmetic as the specification (MSL
  can't be unit-tested) plus the plan expansion; `SceneModel` gained a
  tolerant decoder so pre-framing projects still load.

## 2026-07-26 — streamit: gap closure (Clip Studio + Publish UI, tests)

Audited the tree against the plan and closed what was genuinely missing.
The finding that mattered: the ClipStudio and Publish *engines* were all
written but **unreachable from any UI** — `MomentSearch`, `BRollSuggester`,
`SmartReframer`, `SceneAnalyzer`, `BrandKit`, `CaptionStyle.presets`,
`PublishQueue` and the three publishers had no call sites outside their own
files. Dead code, not missing code.

- **Clip Studio panel** (`Mac/ClipStudio/ClipStudioView.swift`), opened from
  the editor toolbar: ranked clip suggestions, plain-language moment search
  that seeks the preview, B-roll cutaway suggestions, per-clip
  aspect/layout/caption/reframe export settings, and a brand-kit editor.
- **Caption template gallery**: the built-in presets plus user-saved
  templates (persisted beside the brand kit), with live swatches.
- **Smart reframe now reaches output.** `SmartReframer` computed crop paths
  that nothing consumed; `EditProject` carries them,
  `LayoutCompositionInstruction` passes them through, and the compositor's
  new `focusFill()` narrows each tile to the subject window before
  aspect-filling — so a 9:16 export keeps the speaker framed instead of
  center-cropping their forehead.
- **Publish panel**: queue with progress/retry/remove, per-platform metadata
  form, Keychain-backed connection status. Scoped strictly to what the
  publishers actually send (YouTube title/description/tags, TikTok title
  only, Instagram documented as manual) rather than showing controls that
  do nothing.
- **First tests in the Mac target**: 94 cases over the EDL, drift fit, ring
  buffer, script alignment, and Codable/manifest contracts, plus an
  `StreamitTests` target and a test action on the scheme. Run these
  first on the Mac — no hardware needed, and they cover the layers
  everything else sits on.
- App icon asset catalog (placeholder mark), README/TESTING/DEV_SETUP
  updates including a Mac-day bring-up runbook.

Layout-cue timebase note: `LayoutCue.atTime` is now documented and tested as
*source* time throughout.

## 2026-07-26 — streamit: six-cluster review & consistency pass

Parallel reviewer agents swept the uncompiled codebase, one per seam-heavy
cluster (rendering/sources/effects, audio, guests/podcast/backend,
post-edit, app/UI wiring, extension/driver/web). Clear-cut defects were
fixed; platform-dependent assumptions got "verify on Mac" comments. The
worker passes `tsc --noEmit`; all guest JS passes `node --check`.

Highlights of what was caught before ever reaching a compiler:

- **Manifest contract**: the Mac decoder expected takes' tracks as a map;
  the worker writes an array — every session decode would have failed.
  Several fields made optional to match what guests actually send.
- **GPU lifetimes**: CVMetalTexture wrappers were dropped while the GPU
  still read their textures (pixel-buffer pool, segmentation mask, all
  converter-based sources) — now retained per the texture-cache contract.
- **Compositor**: content textures arrive premultiplied; the fragment
  shader premultiplied again, darkening every soft edge. Un-premultiply
  added. Reserved MSL word `half` used as a local; renamed.
- **Concurrency**: sidechain ducker's envelope timer ran off-main while
  mutating MainActor state; device-list facade returned tuples that
  `ForEach(id:)` can't key-path. Ten files used `@Observable` without
  importing Observation.
- **Layout cues**: model treated `atTime` as edited-timeline seconds while
  every writer and the timeline UI used source seconds — cues are now
  canonically source-anchored and mapped through the EDL at composition
  time (cues inside cuts snap forward to the next enabled clip).
- **Podcast recording**: the browser recorder nulled its take id before
  the final chunk flushed, orphaning the last ~5s of every take.

Known deploy note: the R2 bucket needs a CORS policy allowing PUTs from
the guest-page origin (Cloudflare dashboard, not in-repo).

## 2026-07-26 — streamit: full v1 codebase (macOS live-streaming studio)

New product in this repo (HearIt untouched): a macOS 14+ studio app in the
StreamYard/Riverside/Ecamm class, authored end-to-end in one pass (~25k
lines across Swift, Metal, C++, TypeScript, and JS). Not yet compiled on a
Mac — first build pass should start from docs/DEV_SETUP.md and grep for
"verify on Mac" comments marking API assumptions.

- **Live core**: timer-driven render loop (keeps feeding Zoom while
  occluded), Metal compositor with AE-style blend modes via ping-pong
  passes, unit-coordinate document model, entry/exit animations (exit =
  reversed entry), magic-move scene transitions matching the same
  camera/guest/screen across layouts.
- **Sources**: camera, ScreenCaptureKit, movie playback, offscreen
  WKWebView overlays, LiveKit guest frames (NV12→BGRA kernel), images.
- **Effects**: parametric chroma key, Vision virtual background, beautify,
  contrast/sharpen — texture-in/texture-out, composable with blends.
- **Virtual devices**: CMIO camera extension (sink-stream transport,
  branded splash when idle) + our own libASPL loopback driver publishing
  "streamit Microphone" and "streamit Guest Send" (mix-minus), installed
  with one admin prompt.
- **Audio**: three-engine graph (capture / mix hub / device feeders) over
  lock-free rings; per-strip insert chains (Apple AUs with one-knob
  macros + third-party AU hosting with their own UIs); soundboard with
  hotkeys; gapless music; configurable sidechain ducking.
- **Guests**: LiveKit room wiring with structural mix-minus (guest strips
  never feed the guest bus), invite links + QR, data-channel mux for
  recording control, upload health, and the teleprompter phone remote.
- **Podcast mode**: dual MediaRecorders in the guest's browser (audio
  always, video up to the camera's max ≤4K), IndexedDB-durable chunked
  uploads to R2 through one Cloudflare Worker (also the LiveKit token
  service), NTP-style session clock, host ProRes local recording,
  least-squares drift-fit alignment applied in the ffmpeg import pass.
- **Teleprompter**: floating sharingType-none panel (structurally can't
  reach the program), WPM scroll engine, per-scene script binding,
  phone/producer remote page.
- **AI editor**: WhisperKit transcription, silence-snapped text-based
  cutting, script alignment + take detection + Claude best-take assembly
  (word-index contract, review-then-apply, everything recoverable),
  filler/silence cleanup with micro-fades, word-by-word caption styles,
  clip suggestions with virality ranking, moment search, auto-chapters,
  exports (audio master, stems, video to 4K, vertical 9:16 with burned
  captions + SRT/VTT).
- **Clip studio + publish**: per-track scene analysis, smart reframe with
  deadband/spring subject tracking and hard cuts on speaker change, brand
  kit, B-roll suggestions, YouTube/TikTok upload with local scheduling.
- **Build note**: five build subagents were killed mid-write by an org
  spend limit partway through; all their modules were finished by hand in
  the same session and contract-reconciled (ring-buffer API, mixer facade,
  manifest patch shapes).

## 2026-06-08 — Paste-to-listen + RSS feeds tab

- **Paste text → listen** (Saved): clipboard button in Saved opens a composer
  (title optional + text); saved as a ready, offline-playable item via
  `SavedArticleStore.addPastedText` (text wrapped in minimal HTML paragraphs).
- **RSS feeds** (third tab + iPad sidebar entry, like a mini Feedly):
  `FeedParser` (dependency-free RSS 2.0/Atom on `XMLParser`), `FeedStore`
  (app-group persistence, refresh/merge with per-feed cap, unread state),
  `FeedsView` (aggregated timeline, add/manage sheets, **search across all
  feeds**, per-feed **"Notify on new articles"** toggle). Items play through the
  existing email pipeline; full article fetched via `ArticleExtractor` when the
  feed only carries a summary.
- **Background refresh**: BGAppRefreshTask (`…voiceinbox.feedrefresh`, fetch
  background mode) refreshes feeds when iOS allows and posts local notifications
  for feeds with notifications on. iOS controls timing — not real-time push.

## 2026-06-08 — Launch splash, smoother audio, footer trim v2, row tap, PiP button

- **Splash screen / no sign-in flash**: added a `.launching` phase (now the
  initial state) showing an animated splash while `AppState` checks stored
  accounts, so a logged-in user never flashes the sign-in screen — offline or on.
- **Smoother skip audio**: `SpeechAudioSession` now sets the category once instead
  of on every sentence; re-running `setCategory` was renegotiating the route and
  causing the drop when skipping/tapping between sentences.
- **Substack footer v2**: `EmailParser` now cuts from the first strong footer
  anchor in the email's tail (Like/Comment/Restack/Upgrade to paid/"Read … in the
  app"/copyright), clearing the whole footer block even with stray lines between
  anchors — not just a contiguous trailing run.
- **Whole inbox row tappable**: `EmailRow` fills width + `contentShape`, so taps
  anywhere on the row open the email (not only on the text).
- **PiP**: added a manual "enter PiP" button in the reader (auto-start on
  background is unreliable) plus start/stop on the controller. Still device-only.



## 2026-06-08 — Keep-awake while reading + offline read receipts

- **Keep screen awake**: while the reading view is open and playing, the screen
  no longer auto-locks (like watching a video). New "Keep screen awake" setting
  (Reading section), default on; releases the lock on pause / leaving the view.
- **Offline read receipts**: marking read/unread offline (incl. auto-mark on
  finishing an email) no longer errors — it's queued in `PendingReceiptStore`
  and replayed automatically once back online. Genuine non-network errors (e.g.
  missing Gmail scope) still surface; network blips are queued silently.
- **Picture in Picture** (`ReaderPiP`): renders what's being read (sender +
  current sentence + progress) into an `AVSampleBufferDisplayLayer` and drives
  `AVPictureInPictureController`, so leaving the app mid-email floats a PiP
  window. New "Picture in Picture" setting (Reading section), default off; PiP's
  play/pause + skip drive the shared player. PiP only runs on a real device
  (not the Simulator) and needs on-device iteration.

## 2026-06-08 — Offline support + Substack footer trim

- **Offline mailbox cache** (`MailCache` + `CachingMailService`): the folder
  listing, the most recent ~120 full message bodies, labels, and the account
  profile are cached per account in the app group. Offline (detected instantly
  via `NetworkMonitor`/NWPathMonitor) the inbox still lists, opens, and
  auto-advances to the next email. Bodies are cached whenever fetched online
  (opening + the reading-time prefetch), so browsing online warms the cache.
- **No more offline "logged out" lockout:** `AppState.activate` now reaches
  `.ready` immediately from the stored account identity and refreshes the live
  profile in the background, instead of blocking launch on a network call that
  hangs ~60s offline. Legacy-token migration is skipped offline.
- **Substack footer trim:** `EmailParser` now drops the trailing
  share/comment/restack/subscribe/copyright lines (text rows; the icons were
  already stripped). Trims from the end only, stops at real content.

## 2026-06-08 — Watch is now a live remote for the phone

Reworked the watch app from a disconnected, demo-inbox local player into a
**remote that mirrors and controls the phone's playback** (the original gripe:
"it doesn't reflect what's playing on the phone, and I can't control it").

- New `NowPlayingState` snapshot (sender, subject, artwork address, isPlaying,
  progress, time left, speed) pushed phone → watch over WatchConnectivity on
  every state change and on reconnect.
- Watch transport (play/pause, skip, speed, highlight) sends commands back; the
  phone runs them against the single shared player.
- Redesigned watch layout (podcast-remote style): progress + "time left" on top,
  artwork + show/subject, transport buttons, then a speed row. Volume isn't
  controllable on the phone from the watch via Apple APIs, so the bottom row is
  playback speed instead.
- Removed the watch's local inbox + local player (`WatchInboxView`,
  `WatchPlayerView`); the watch no longer plays its own audio.

## 2026-06-08 — iPad split layout + watch re-embedded

- **iPad layout** — on regular width the app now uses a three-column
  `NavigationSplitView`, like Mail: a source sidebar (Inbox / Saved), the
  selected list in the middle, and the reading view + player permanently on the
  right (no mini-player / full-screen cover on iPad). iPhone keeps its tabs +
  mini-player unchanged. Enabled `TARGETED_DEVICE_FAMILY` for iPad and allowed
  iPad landscape. Refactors: extracted `PlayerDetailContent` (chrome-free
  reading/player surface, reused by `NowPlayingView` and the iPad detail pane),
  `InboxList`, and `SavedArticlesList` (the lists without their own
  `NavigationStack`, used as the split-view columns). Analytics/Highlights/
  Settings live in the sidebar toolbar on iPad.
- **App icon** added (neon envelope), watch re-embedded and reusing the same
  icon via a symlink.

## 2026-06-06 — 🚀 First TestFlight build uploaded to Apple

Got HearIt from a working app to a **build accepted by App Store Connect**,
ready for TestFlight. Major features built and shipped along the way:

### Listening experience
- **Single app-wide player** with a **floating mini-player** (Apple Podcasts
  style) that keeps playing across tab switches and navigation.
- **Open without interrupting:** opening a second email while one plays shows it
  as a preview with a "Play this email" button; current playback continues.
- **Speed slider** 0.5×–2.5×, replacing the old fixed menu.
- **Resume** where you left off, per email/article.
- **Auto-play next unread** setting — announces sender + subject, then reads on.
- Bigger transcript text; black highlight button.

### Inbox
- **Sender thumbnails** (Gravatar → Clearbit → Google favicon → initial) wrapped
  in a **listening-progress ring**.
- **Estimated read time** per row (backfilled in the background, cached), shown
  in place of the snippet.

### Lock screen / hardware
- Now Playing artwork shows the **sender logo**, transitioning to the **email's
  image** while reading one, falling back to the app logo.
- Fixed playback not claiming the lock screen (was ducking instead of
  interrupting); AirPods + Control Center transport work.

### Content beyond email
- **Share Extension**: save web articles from Safari/Feedly to a **Saved** tab,
  fetched + extracted + cached for **offline** listening (App Group).
- **Highlights** with notes and "listen from this spot".
- **Listening analytics**: emails/words/time, top senders, ElevenLabs usage +
  estimated cost.

### Reliability & fixes
- Fixed crash fetching Gmail messages with duplicate header names.
- Fixed **429 rate-limiting** on cold inbox load (bounded concurrency + retry
  with backoff).
- Surface Gmail mark-read failures instead of swallowing them; mark read in
  Gmail on completion.

### Release plumbing
- App **icon** asset catalog + the icon export wired in.
- **Privacy manifest** (UserDefaults reason) for app/extension.
- `ITSAppUsesNonExemptEncryption=false` (skip export compliance prompt).
- `CFBundleIconName` + `ASSETCATALOG_COMPILER_APPICON_NAME` so the icon
  compiles and the App Store upload accepts it.
- Declared schemes in `project.yml` so the app scheme survives regeneration.
- Shipped **iPhone-only** for the first build (watch temporarily not embedded).
- App Group re-enabled on a paid team.

### Key lesson learned
The reliable archive workflow: **quit Xcode → `xcodegen generate` → delete
DerivedData → reopen → reselect Team → clean → archive.** Quitting Xcode before
regenerating was essential (otherwise it archives a stale project).

### Post-upload tweaks (same day)
- **Locked to portrait** orientation.
- **Folder/label picker**: choose which Gmail label, category (Promotions/
  Updates/…), or custom folder to listen to — e.g. only a "Newsletters" folder.
  Inbox title reflects the folder; choice persists.

### Hands-free voice notes (AirPods)
- With AirPods highlighting on, an AirPods press captures a highlight, then the
  app **speaks "Add a note?"**, **listens for yes/no**, and if yes **records and
  transcribes a spoken note** (on-device) onto the highlight — then resumes.
- Added microphone + speech-recognition usage strings.

### Languages, search, and loading everything
- **Multilingual reading**: detect each sentence's language and read it with a
  matching system voice; **right-to-left (Hebrew/Arabic) text displays
  correctly** in the reading view.
- **Search** the mailbox by sender or subject (Gmail `q` search), with a search
  bar in the inbox.
- **Load all emails**: the inbox now **paginates** (infinite scroll) instead of
  stopping at 50 — scroll and it keeps loading the folder/search results.

### Audio cues + image option
- **Success chime** when an email finishes; **transition chime** before the
  spoken "From … / subject" announcement when auto-advancing to the next email.
- New image setting **"Skip images silently"**: don't announce images, just keep
  them on screen and read straight through.

### Image descriptions + Outlook
- **On-device image descriptions**: reaching an image, classify it with Vision
  and speak e.g. "Image of beach, ocean and sky" (falls back to alt text /
  "there's an image here" offline).
- **Outlook / Microsoft sign-in**: new Microsoft Graph backend + OAuth (PKCE),
  a "Continue with Outlook" button, folder picker via Graph mail folders, and
  search via Graph $search. Needs an Azure app client id (see README/below).

## 2026-06-07 — Multi-account, onboarding, sync, and a round of polish

### Multiple mailboxes
- **Connect several accounts** (Gmail + Outlook mix) and **switch between them**
  from Settings (tap to switch, swipe to remove, "Sign out of all"). Tokens are
  stored **per-account** in the Keychain; settings, saved links, and highlights
  stay shared. Existing single sign-ins are **migrated** automatically.
- "Add another account" opens a **sheet** (Google / Outlook).
- **Outlook is live**: wired in the real Azure **client id**; "Continue with
  Outlook" does a real Microsoft sign-in (Graph). Removed the demo inbox option.

### First-run onboarding
- **Animated splash** (logo + tagline) then a swipeable **feature tour** (listen
  to email · marks read in your real inbox · AirPods bookmark/notes · save to
  listen offline) → Get Started → sign-in. Splash is built to drop in a **Rive**
  file later. Fixed bootstrap so first launch actually shows onboarding (it was
  auto-entering the demo and skipping it).

### Saved links follow your account
- Saved links now **back up to private iCloud (CloudKit)**, keyed by the
  signed-in email, so they survive uninstall/reinstall. Metadata only — no email
  messages, and article content is re-extracted on the new device.

### Hebrew / voice fixes
- **Hebrew now reads correctly**: use the email's **dominant language** to pick
  the voice (per-sentence detection mis-tagged Hebrew as Yiddish/English → silent
  English fallback). Map Yiddish → Hebrew (no Yiddish voice exists).

### Images
- **Load lazy-loaded images** (prefer `data-src`/`srcset`, fix protocol-relative
  URLs) so newsletter images actually show.
- **Stop announcing junk images**: skip hidden elements, 1×1 tracking pixels, and
  small/footer social icons (by size and by alt text) — fixes the Substack
  "there's an image" spam.
- Lock screen **keeps the last image** until the next one (time to glance at it).

### Reliability
- **Fixed playback wedging** when switching emails (AVSpeechSynthesizer dropped a
  `speak` issued in the same turn as `stop`; now staged via `didCancel`).
- AirPods highlight: **haptic confirmation** + cleaner audio-session handoff.

### UI polish
- Inbox title is a **tappable folder switcher** showing **"Inbox (44)"** with a
  chevron (replaced the cramped, dropped funnel icon and the "44 unread" label).
- **Removed dividers** between inbox rows for a cleaner look.
- Swipe **left = read, right = unread**, each shown only when it applies.
- **AirPods controls help screen** (detects your AirPods, shows the gestures).
- **Version row** in Settings; build bumped so installs are identifiable.
- **Separate Debug app icon** (`AppIcon-Dev`) so local builds are easy to spot.

### Next up
- Add the actual **Rive** splash animation once the file is ready.
- Open TestFlight to more testers (Google OAuth consent: External + test users;
  restricted-scope verification before public launch).
- Optional: **merged "all inboxes"** view; per-account settings; CloudKit schema
  deploy to Production before TestFlight relies on saved-link sync.
- Re-add the Apple Watch app (with its own icon) in a later build.

## 2026-07-05 — Feeds titles-only, reader polish, auth recovery, backup visibility

### Feeds
- **Read titles only** preference (Settings → Feeds): reads just each item's
  headline and moves on, skipping the article fetch/body. Opens with the spoken
  "From <feed>" intro off (the body already is the title) and carries that
  through auto-advance. Reader suppresses the duplicate body sentence so the
  headline isn't shown twice.
- **Feed reader**: shows the item **date/time** under the headline (display
  only — never spoken) and a **Safari button** (top-right) to open the full
  article on the web.

### Reader
- **Lighter read-along cue**: dropped the full accent-color paragraph wash on the
  sentence being read; the spoken word just changes color (no bold, so text
  doesn't reflow word to word).

### Auth / sync reliability
- **Root cause of "it stops syncing, I delete the app to fix it"**: the Google
  OAuth consent screen was **External + Testing**, where refresh tokens expire
  after 7 days. **Decision: publish to Production (unverified)** — kills the
  7-day expiry and supports up to 100 users. Full verification (needed for >100
  users / no warning screen) requires a paid annual **CASA** assessment because
  Gmail scopes are *restricted*; read-only wouldn't avoid it (still restricted).
  Revisit CASA only when crossing ~100 users. **Keep the app Published — do not
  revert to Testing.**
- **In-app recovery**: on a 401 the inbox now shows a one-tap **Reconnect**
  (re-runs OAuth for the active account in place — notes, saves, progress
  untouched) instead of a dead error. Deleting the app is never required.

### Backup visibility
- Settings **Backup** row shows whether the device is signed into iCloud and how
  many notes / saved links are backed up (with guidance to turn iCloud on if
  off). Highlights/notes + saves already back up to iCloud (KVS + CloudKit) and
  restore on reinstall; this makes it verifiable.

### Follow-ups
- Host `docs/privacy.html` + a simple homepage on `superavi.com` (needed for the
  consent screen); fill the `[YOUR CONTACT EMAIL]` placeholder.
