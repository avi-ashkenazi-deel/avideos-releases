# VoiceInbox — Work Log

A running log of what we've built and shipped.

## Conventions

- **No emojis in TestFlight notes, release notes, or any App Store Connect text.**
  Write "What to Test" and release notes in plain text only — those store-facing
  fields don't accept emojis. (Chat replies may still use them; this rule is
  specifically about text pasted into TestFlight / App Store Connect.)

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

Got VoiceInbox from a working app to a **build accepted by App Store Connect**,
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
