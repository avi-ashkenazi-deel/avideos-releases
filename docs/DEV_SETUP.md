# AVideos Studio — Mac Development Setup

The macOS live-streaming studio lives alongside HearIt in this repo. The
`.xcodeproj` is generated, never committed:

```bash
brew install xcodegen
xcodegen generate
open HearIt.xcodeproj        # contains the AVideosStudio scheme too
```

Target: macOS 14.0+, Swift 5.9. SPM resolves LiveKit, KeyboardShortcuts, and
WhisperKit on first build; libASPL backs the audio-driver target (if SPM
packaging fights XcodeGen, vendor it as a submodule under
`driver/vendor/libASPL` — see `driver/AVideosAudio/README.md`).

## First-build checklist (things the Linux authoring pass couldn't do)

1. **Signing**: set `DEVELOPMENT_TEAM` in project.yml. The camera extension
   and the app must be signed with the SAME team; free/personal teams cannot
   ship system extensions — use real Developer ID certs.
2. **Resource copies to add in project.yml** (flagged in code comments):
   - `driver/install/install-driver.sh` and `uninstall-driver.sh` → app
     Resources (DriverInstaller runs them).
   - An LGPL `ffmpeg` binary → `Contents/Helpers/ffmpeg` (WebM import;
     MediaImportService errors clearly when missing).
   - Verify XcodeGen embedded `CameraExtension` at
     `Contents/Library/SystemExtensions/` (add an explicit copyFiles phase
     if it landed in PlugIns).
3. **`// verify on Mac:` comments** mark every API assumption made without a
   compiler: LiveKit 2.x delegate/renderer signatures (`Mac/Guests/`),
   WhisperKit's transcribe API, CMIOExtension sink-property setters
   (`CameraExtension/`), libASPL hook names (`driver/`), voice-processing
   toggles. Grep for them on the first compile pass:
   `grep -rn "verify on Mac" Mac/ CameraExtension/ driver/`

## Mac-day runbook (recommended order)

The codebase was authored without a compiler, so the first Mac session is a
bring-up session. Cheapest-first:

1. `brew install xcodegen && xcodegen generate`.
2. **Run the unit tests before anything else** (Cmd-U, or
   `xcodebuild test -scheme AVideosStudio`). They need no hardware,
   entitlements, or network, so they are the fastest way to shake out
   compile errors in the model, EDL, alignment, ring buffer, and manifest
   decoding — the layers everything else sits on.
3. Build the app target and work through the compiler diagnostics; expect
   most of them where `// verify on Mac:` comments already flag an
   assumption (step 3 of the checklist above).
4. Run the app with no extension and no driver: scenes, elements, effects,
   preview, recording, editor, Clip Studio and Publish panels all work
   without either. This isolates plain app bugs from device bring-up.
5. Only then do the two spikes that need real certs — camera extension,
   then audio driver (sections below). Keep them frozen once they work.
6. Deploy the Worker + Pages and create the R2 bucket **with a CORS policy
   allowing PUT from the Pages origin** — browser uploads go straight to
   R2, so without it guest recording uploads fail while everything else
   looks healthy.
7. Add the ffmpeg helper before testing podcast import; add the Anthropic
   API key (Settings) before testing anything AI-driven.

## Camera extension dev loop

- Activation requires the app in `/Applications` **unless** developer mode:
  `systemextensionsctl developer on`
- Useful incantations:
  ```bash
  systemextensionsctl list
  systemextensionsctl uninstall <teamID> com.aviashkenazi.avideos.cameraextension
  log stream --predicate 'subsystem CONTAINS "com.aviashkenazi.avideos"' --level debug
  ```
- Every extension code change is a new version → re-approval in System
  Settings › General › Login Items & Extensions. When wedged: uninstall,
  kill the `cameraextension` process, reboot as last resort.
- Test clients in order of pickiness: Photo Booth (pickiest), Zoom, Chrome
  (meet.google.com).

## Audio driver dev loop

Manual spike install (before wiring the in-app installer):

```bash
sudo cp -R build/.../AVideosAudio.driver /Library/Audio/Plug-Ins/HAL/
sudo chown -R root:wheel /Library/Audio/Plug-Ins/HAL/AVideosAudio.driver
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod   # blips ALL audio
system_profiler SPAudioDataType | grep -A4 AVideos
log show --predicate 'process == "coreaudiod"' --last 5m
```

Verify: QuickTime records from "AVideos Microphone" while music plays into
it; Zoom lists it as a mic. Bump `CFBundleVersion` in
`driver/AVideosAudio/Info.plist` on every driver change — the in-app
installer uses it for update detection.

## Backend (guests + podcast uploads)

One Cloudflare Worker + R2 bucket + Pages site. Full steps in
`infra/worker/README.md`. Point the app at it in Settings → Session Server.
LiveKit Cloud free tier covers development.

## Publishing (optional)

YouTube/TikTok publishing needs per-platform app registrations (Google
Cloud project with YouTube Data API; TikTok developer app with
content.posting). Tokens are stored in the Keychain after the in-app OAuth
flow. Instagram's Graph API pulls from public URLs, so v1 documents the
manual flow.

## Release

`scripts/release-mac.sh` — Developer ID signing + notarization. The app is
NOT sandboxed (driver install, AU hosting); hardened runtime is on.
