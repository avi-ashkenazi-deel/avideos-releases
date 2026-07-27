# HearIt — Work Log

A running log of what we've built and shipped.

## Conventions

- **No emojis in TestFlight notes, release notes, or any App Store Connect text.**
  Write "What to Test" and release notes in plain text only — those store-facing
  fields don't accept emojis. (Chat replies may still use them; this rule is
  specifically about text pasted into TestFlight / App Store Connect.)

## 2026-07-26 — AVideos Studio: podcast editor rework

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

## 2026-07-26 — AVideos Studio: 20 entry animations for overlay layers

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

## 2026-07-26 — AVideos Studio: source framing (fit / fill / blurred backdrop)

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

## 2026-07-26 — AVideos Studio: gap closure (Clip Studio + Publish UI, tests)

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
  `AVideosStudioTests` target and a test action on the scheme. Run these
  first on the Mac — no hardware needed, and they cover the layers
  everything else sits on.
- App icon asset catalog (placeholder mark), README/TESTING/DEV_SETUP
  updates including a Mac-day bring-up runbook.

Layout-cue timebase note: `LayoutCue.atTime` is now documented and tested as
*source* time throughout.

## 2026-07-26 — AVideos Studio: six-cluster review & consistency pass

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

## 2026-07-26 — AVideos Studio: full v1 codebase (macOS live-streaming studio)

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
  "AVideos Microphone" and "AVideos Guest Send" (mix-minus), installed
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
