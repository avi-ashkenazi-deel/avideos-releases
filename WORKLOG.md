# VoiceInbox — Work Log

A running log of what we've built and shipped.

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

### Next up
- Open TestFlight to more testers (Google OAuth consent screen: External +
  test users; restricted-scope verification before public launch).
- Re-add the Apple Watch app (with its own icon) in a later build.
