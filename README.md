# This repo: HearIt (iOS) + AVideos Studio (macOS)

Two products share this repository and one XcodeGen `project.yml`:

- **HearIt** — the shipped iPhone/iPad/Watch app that reads your inbox aloud
  (everything below this section).
- **AVideos Studio** — a macOS live-streaming studio (StreamYard/Riverside/
  Ecamm class): scenes with overlays/effects/blend modes, a virtual camera +
  virtual microphone for Zoom/Meet/Teams, an audio mixer with per-strip
  effect inserts and sidechain ducking, browser guests over LiveKit,
  Riverside-style local 4K recording with progressive upload, a teleprompter,
  and a Descript-style AI editor (transcription, best-take assembly, filler/
  silence cleanup, captions, clip suggestions, chapters, smart reframe,
  publishing). Sources in `Mac/`, `CameraExtension/`, `driver/`, `web/`,
  `infra/`; start at **[docs/DEV_SETUP.md](docs/DEV_SETUP.md)**.

## AVideos Studio — feature → code map

| Feature | Where |
| --- | --- |
| Scenes (camera / screen / movie / interview) + document model | `Mac/Model/`, `Mac/App/StudioController.swift` |
| Metal compositor, source framing (fit/fill/blurred backdrop), blend modes, animations, magic move | `Mac/Rendering/` |
| Camera effects (chroma key, virtual background, beautify, contrast, sharpen) | `Mac/Effects/` |
| Frame sources (camera, screen, movie, web overlays, guests, images) | `Mac/Sources/` |
| Virtual camera (CMIO extension + sink-stream writer) | `CameraExtension/`, `Mac/VirtualCamera/` |
| Virtual microphone + Guest Send loopback driver | `driver/`, `Mac/Audio/DriverInstaller.swift` |
| Audio mixer, insert effects, AU hosting, soundboard, music sections & loops, ducking | `Mac/Audio/` |
| MIDI control surface (learn mode, section + pad triggers) | `Mac/MIDI/` |
| Remote guests (LiveKit) + invite links | `Mac/Guests/`, `web/guest/`, `infra/worker/` |
| Program recording | `Mac/Recording/` |
| Podcast mode (local 4K recording, chunked upload, drift-aligned import) | `Mac/Podcast/`, `web/guest/recorder.js`, `infra/worker/` |
| Teleprompter (+ phone remote) | `Mac/Teleprompter/`, `web/guest/prompter.html` |
| AI editor (transcribe, take selection, cleanup, captions, clips, chapters) | `Mac/PostEdit/` |
| Clip Studio (clip suggestions, moment search, smart reframe, brand kit, B-roll, caption templates) | `Mac/ClipStudio/` |
| Publishing (YouTube/TikTok, scheduling) | `Mac/Publish/` |
| Studio UI | `Mac/UI/` |
| Unit tests (EDL, drift fit, ring buffer, alignment, Codable/manifest) | `Tests/AVideosStudioTests/` |

Testing: `docs/FEATURE_CHECKLIST.md` is the full 476-item feature inventory
(with prerequisites per item and known gaps); `TESTING.md` has the shorter
per-phase exit demos.

Keyboard shortcuts: global hotkeys (work from any app) live in
`Mac/App/GlobalShortcuts.swift` and are rebindable in Settings → Shortcuts;
menu shortcuts are in `StudioCommands` (`Mac/App/AVideosApp.swift`).

---

# HearIt

Listen to your email. HearIt is an iPhone / iPad app (with an Apple Watch
companion) that reads your inbox aloud. Tap any message, press play, and listen
— with full transport controls, image handling, and the ability to highlight
and annotate what you hear using the screen, your AirPods, or your watch.

> **Status:** First iteration. The app runs immediately against a bundled
> **demo inbox** (including emails with images) so every feature is usable
> without any setup. Real **Google / Gmail** sign-in is fully scaffolded and
> switches on as soon as you add OAuth credentials (see below).

---

## Getting started

This repo contains the Swift sources and an [XcodeGen](https://github.com/yonaskolb/XcodeGen)
project definition (`project.yml`) instead of a committed `.xcodeproj` (which is
fragile to hand-edit). On a Mac:

```bash
brew install xcodegen      # one time
xcodegen generate          # creates HearIt.xcodeproj from project.yml
open HearIt.xcodeproj
```

Then in Xcode:

1. Select the `HearIt` target → **Signing & Capabilities** → choose your team.
2. Do the same for the `VoiceInboxWatch` target.
3. Run on a device or simulator. Choose **"Try the demo inbox"** on the first screen.

Minimum targets: **iOS 17**, **watchOS 10**.

### Enabling real Gmail

1. In the [Google Cloud console](https://console.cloud.google.com/), create an
   **OAuth client ID** of type **iOS**. Enable the **Gmail API**.
2. Fill in `GoogleOAuthConfig.placeholder` in
   `Shared/Services/GoogleAuth.swift` with your `clientID` and reversed-client-id
   `redirectScheme`.
3. Put the same reversed client id into the URL scheme placeholder in
   `iOS/Info.plist` (`CFBundleURLTypes`).

Once configured, **"Continue with Google"** runs a real PKCE OAuth flow and the
app reads, displays, plays, and marks-as-read your actual Gmail inbox. No client
secret is stored on device, and the OAuth tokens are kept in the **Keychain**.

### Saving web pages to listen offline (Share Extension)

The app ships a **Share Extension** so you can send articles from Safari,
Feedly, or any app: tap **Share → HearIt**, and the link is saved to the
**Saved** tab. The app then fetches the page, extracts the readable text, and
**caches it for offline listening** — like Pocket, but read aloud.

This uses an **App Group** (`group.com.voiceinbox.shared`, see `AppGroup.swift`)
to hand the link from the extension to the app, which **requires a paid Apple
Developer account**:

1. In the Apple Developer portal, register the App Group id for your team.
2. In Xcode, add the **App Groups** capability to both the `HearIt` and
   `ShareExtension` targets and tick that group (the entitlement files already
   declare it).
3. Build & run. The extension appears in the system share sheet.

Article text is cached and plays fully offline; inline **images** still load
over the network. Extraction is a dependency-free, heuristic reader mode — it
works for the large majority of articles but can include some page chrome on
unusual layouts.

---

## How the requested features map to the code

| Feature | Where |
|---|---|
| Onboarding → connect email (Google first) | `iOS/OnboardingView.swift`, `Shared/ViewModels/AppState.swift`, `Shared/Services/GoogleAuthSession.swift` |
| List of all emails, tap to open | `iOS/InboxView.swift`, `Shared/ViewModels/InboxViewModel.swift` |
| Sentences on screen + player underneath | `iOS/EmailPlayerView.swift`, `iOS/PlayerControlsView.swift` |
| Play / pause / speed / remove silence | `iOS/PlayerControlsView.swift`, `Shared/Services/SpeechReader.swift`, `Shared/Models/AppSettings.swift` |
| Read aloud, sentence highlights & auto-scroll | `Shared/Services/SpeechReader.swift`, `Shared/ViewModels/EmailPlayerViewModel.swift` |
| Finish → marked as read | `EmailPlayerViewModel.complete()` → `MailService.markRead` |
| Next button to skip sentences | `EmailPlayerViewModel.nextSentence()` |
| Images appear on screen + "there's an image" | `Shared/Services/EmailParser.swift`, `ImageBlockView` in `EmailPlayerView.swift` |
| Setting: pause on images vs. announce & continue | `ImageBehavior` in `AppSettings.swift`, handled in `EmailPlayerViewModel` |
| Highlight last 10s + write a note | `EmailPlayerViewModel.captureHighlight()`, `iOS/HighlightComposerView.swift`, `Shared/Services/HighlightStore.swift` |
| Notes section that links back to the email | `iOS/HighlightsListView.swift` → `iOS/HighlightDetailView.swift` (`EmailFromHighlightView` reopens the email and `seek`s to the captured block) |
| AirPods press to highlight | `Shared/Services/RemoteCommandController.swift` |
| Apple Watch app to do the same | `Watch/` + `Shared/Services/WatchConnectivityBridge.swift` |
| Email image on the lock screen | `RemoteCommandController.updateNowPlaying(...imageURL:)` |
| Skip the image from the lock-screen player | `EmailPlayerViewModel.skipImage()` (next-track is context-aware) |
| ElevenLabs voice option | `Shared/Services/ElevenLabsClient.swift`, `Shared/Services/ElevenLabsSpeechEngine.swift`, `SettingsView` |
| Pluggable speech backend (system vs cloud) | `SpeechEngine` protocol in `Shared/Services/SpeechReader.swift` |
| Mark read without listening | `iOS/InboxView.swift` swipe action → `InboxViewModel.markRead(_:)` |
| Save web pages from other apps to listen offline | `ShareExtension/`, `Shared/Services/SavedArticleStore.swift`, `ArticleExtractor.swift`, `iOS/SavedArticlesView.swift` |
| Per-email listening progress (% in the inbox) + resume where you left off | `Shared/Services/ListeningProgressStore.swift`, `EmailPlayerViewModel.resumeIfAvailable()` |
| Speed slider up to 2.5× | `iOS/PlayerControlsView.swift`, `AppSettings.clampSpeed` |
| Auto-play next unread (announces sender + subject, keeps reading) | `AppSettings.autoAdvance`, `EmailPlayerViewModel.advanceToNextUnread()`, `InboxViewModel.nextUnread(after:)` |
| Listening analytics: emails/words/time, top senders, ElevenLabs usage + cost | `Shared/Services/AnalyticsStore.swift`, `iOS/AnalyticsView.swift` (chart button in the inbox) |

---

## Architecture

```
Shared/            (compiled into both the iOS and watch targets)
  Models/          Email, ContentBlock (sentence|image), Highlight, AppSettings
  Services/        MailService protocol + MockMailService + GoogleMailService
                   EmailParser, SpeechReader, HighlightStore,
                   RemoteCommandController, WatchConnectivityBridge, GoogleAuth*
  ViewModels/      AppState, InboxViewModel, EmailPlayerViewModel
iOS/               SwiftUI screens for iPhone/iPad
Watch/             SwiftUI screens for watchOS
```

- **`MailService`** is a protocol so the UI never knows whether it's talking to
  the demo data or real Gmail. `AppState` chooses the backend.
- **`EmailParser`** flattens an email body (HTML or plain text) into an ordered
  list of `ContentBlock`s — sentences interleaved with the images encountered,
  preserving position so images show up at the right moment.
- **`SpeechEngine`** is a protocol with two implementations: `SystemSpeechEngine`
  (on-device `AVSpeechSynthesizer`, with live word-range highlighting) and
  `ElevenLabsSpeechEngine` (fetches MP3 from the ElevenLabs API and plays it via
  `AVAudioPlayer`, with speed applied as a playback-rate multiplier). The player
  swaps engines based on Settings. The audio session is configured for spoken
  playback so it keeps going with the screen locked and routes through AirPods.
- **Lock screen:** when the player reaches an image, that image is loaded and set
  as Now Playing artwork, so it shows on the lock screen. The next-track control
  is context-aware — while an image is showing it *skips the image*.
- **`EmailPlayerViewModel`** is the brain: it drives playback block by block,
  applies the image behavior, tracks elapsed time for the 10-second highlight
  lookback, and marks the message read on completion.

---

## Notes & limitations (first iteration)

- **AirPods → highlight:** iOS does not allow binding an arbitrary action to an
  AirPods press; presses arrive as standard transport commands. So when
  *"Highlight with AirPods"* is on (Settings), the **next-track** press captures
  a highlight instead of skipping. Use the on-screen **Next** button to skip
  sentences in that mode. Toggle it off to make AirPods skip as usual.
- **"Remove silence"** with synthesized speech means *no pause between
  sentences* (vs. a short natural pause). It is not waveform silence-trimming.
- **ElevenLabs** synthesizes one sentence per request, so expect a short network
  gap between sentences and per-character billing on your ElevenLabs account.
  The API key is stored in the **Keychain** (`KeychainStore`). Because that's
  per-app, the phone relays the cloud-voice config (key, voice, on/off) to the
  watch over the encrypted WatchConnectivity channel so the watch can use the
  same voice. There's no per-word highlight with ElevenLabs (the whole active
  sentence highlights instead).
- **Image content:** images are shown and announced ("there's an image", plus
  alt text when present). We don't yet describe image *contents*.
- **Watch backend:** the watch currently reads the bundled demo inbox, but it
  has the full player — play/pause, skip, highlight, system *and* ElevenLabs
  voices, and an image view with a skip-image button. Syncing a live Gmail
  session (token relay over `WatchConnectivity`) is a follow-up.
- This project was authored in a Linux container and **has not been compiled in
  Xcode**. Generate the project and build on a Mac; expect to fix minor issues
  (signing, app-group provisioning) on first run.

## Possible next steps

- Silent Google token refresh on launch (tokens already live in the Keychain).
- Relay the Gmail session to the watch so it reads real mail.
- On-device image description (Vision / VisionKit) for richer image stops.
- Per-email playback resume and a global "play my whole inbox" queue.
