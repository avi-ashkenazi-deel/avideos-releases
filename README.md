# VoiceInbox

Listen to your email. VoiceInbox is an iPhone / iPad app (with an Apple Watch
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
xcodegen generate          # creates VoiceInbox.xcodeproj from project.yml
open VoiceInbox.xcodeproj
```

Then in Xcode:

1. Select the `VoiceInbox` target → **Signing & Capabilities** → choose your team.
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
secret is stored on device. (Tokens are kept in shared `UserDefaults` for now —
move them to the Keychain before shipping.)

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
| AirPods press to highlight | `Shared/Services/RemoteCommandController.swift` |
| Apple Watch app to do the same | `Watch/` + `Shared/Services/WatchConnectivityBridge.swift` |

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
- **`SpeechReader`** wraps `AVSpeechSynthesizer`, speaking one block at a time
  and reporting the live word range for on-screen highlighting. The audio
  session is configured for spoken playback so it keeps going with the screen
  locked and routes through AirPods.
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
- **Image content:** images are shown and announced ("there's an image", plus
  alt text when present). We don't yet describe image *contents*.
- **Watch backend:** the watch currently reads the bundled demo inbox. Syncing a
  live Gmail session (token relay over `WatchConnectivity`) is a follow-up.
- This project was authored in a Linux container and **has not been compiled in
  Xcode**. Generate the project and build on a Mac; expect to fix minor issues
  (signing, app-group provisioning) on first run.

## Possible next steps

- Keychain-backed token storage and silent token refresh on launch.
- Relay the Gmail session to the watch so it reads real mail.
- On-device image description (Vision / VisionKit) for richer image stops.
- Per-email playback resume and a global "play my whole inbox" queue.
