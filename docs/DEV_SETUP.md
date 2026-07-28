# streamit — Mac Development Setup

The macOS live-streaming studio lives alongside HearIt in this repo. The
`.xcodeproj` is generated, never committed:

```bash
brew install xcodegen
xcodegen generate
open Streamit.xcodeproj      # contains the HearIt iOS targets too
```

Target: macOS 14.0+, Swift 5.9. SPM resolves LiveKit, KeyboardShortcuts and
WhisperKit on first build.

## The dev loop that works today

Open the project in Xcode and run — verified end to end (launch, input, live
camera, mixer) on macOS 26.5 / Xcode 16:

```bash
./scripts/dev-app-only.sh      # generates Streamit.xcodeproj (no ext/driver)
open Streamit.xcodeproj        # scheme "Streamit", then Cmd-R
```

If Xcode asks about signing, pick your team on the Streamit target — the dev
entitlements carry nothing restricted, so any Apple Development identity
signs cleanly.

Do not start subsystems before `NSApplicationMain` (see
`StudioController.bootSubsystems`): capture/audio/MIDI/CMIO connections made
during App-struct construction race AppKit for the process's window-server
registration, and losing that race launches an app whose windows draw but
which cannot be activated — input dead on some launches and not others. This
cost a full day to diagnose on first bring-up; the WORKLOG entry for
2026-07-28 has the whole story.

## The command-line build (tests, CI)

Verified on macOS 26.5, Xcode 16, Apple M4 Pro: the app builds, launches, and
the 269-test suite passes.

```bash
brew install xcodegen
./scripts/dev-app-only.sh          # excludes the extension + driver; dev entitlements
xcodebuild test -scheme Streamit CODE_SIGNING_ALLOWED=NO
```

Two things that recipe deliberately avoids, and why:

- **`dev-app-only.sh`** comments the `CameraExtension` and `StreamitAudioDriver`
  dependencies out of the app target and swaps `Streamit.entitlements` for
  `Streamit-dev.entitlements`. Both are embedded build dependencies, so
  without this a plain build needs real Developer ID certs and a vendored
  libASPL before it will produce anything runnable. The dev entitlements file
  is the shipping one minus `com.apple.developer.system-extension.install`,
  which is *restricted* — only a provisioning profile can grant it, so leaving
  it in makes even a local test run demand development signing, and it is
  meaningless when there is no extension to install. Run
  `./scripts/dev-app-only.sh --restore` before anything you intend to ship.

  It applies those edits to a gitignored copy of the spec and points XcodeGen
  at that with `--spec`, so **`project.yml` itself is never modified**. An
  earlier version edited it in place, which made every `git pull` fail on a
  dirty tree and put the dev toggle one careless `git commit -a` away from
  shipping.
- **`CODE_SIGNING_ALLOWED=NO`** skips signing entirely for a local test run.
  The virtual camera and virtual microphone are unavailable in this
  configuration, which is expected.

### Launching it

```bash
open "$(xcodebuild -scheme Streamit -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ BUILT_PRODUCTS_DIR/{print $2; exit}')/streamit.app"
```

Use `open`, not the inner binary. Running the executable directly leaves the
process unregistered with LaunchServices; AppKit then treats it as a
background app, and the window draws and the render loop runs but the window
never becomes key, so every click is silently discarded. `AppDelegate` now
asserts `.regular` activation policy so a direct launch works too, but `open`
is the one that behaves like the shipped app.

To watch the logs while it runs under `open`, in another terminal:

```bash
log stream --level debug --predicate 'process == "streamit"'
```

Two log lines you can ignore in this configuration:

```
CMIOExtensionSession.m:1309 ... kCSIdentityInvalidPosixNameErr
[Connection] ... connection to service named com.apple.linkd.autoShortcut
```

The first is `VirtualCameraController` looking for the camera extension that
this build excludes. The second is Shortcuts indexing, unavailable to an
ad-hoc-signed app. Neither appears in a signed build with the extension in.

If SPM fails to clone a dependency with `curl 16 Error in the HTTP2 framing
layer`, that is git transport rather than anything in this repo:
`git config --global http.version HTTP/1.1` and retry.

**libASPL is not an SPM package** — it is a CMake C++ library with no
`Package.swift`, so listing it under `packages:` makes dependency resolution
fail for the *whole project*, app and tests included. It has to be vendored:
add it as a submodule under `driver/vendor/libASPL` and add its sources and
header path to the `StreamitAudioDriver` target. Until that is done that one
target does not build, and nothing else is affected.

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
   compiler. The `Mac/Guests/` ones are now resolved — the LiveKit integration
   was audited against the SDK version that actually resolves (2.15.3, from
   `from: "2.6.0"`) — but 33 remain, and getting the app to build settled
   almost none of them. They are runtime questions, and the test suite is pure
   logic that touches no hardware. Still open and load-bearing: whether
   `playerTime.sampleTime` is in node or file frames (`Mac/Audio/MusicTiming.swift`),
   `.interruptsAtLoop` boundary behaviour, CMIOExtension sink-property setters
   (`CameraExtension/`), libASPL hook names (`driver/`), overlapping
   `setVolumeRamp` ranges, and voice-processing toggles. Grep for them:
   `grep -rn "verify on Mac" Mac/ CameraExtension/ driver/`

## Mac-day runbook (recommended order)

The codebase was authored without a compiler, so the first Mac session is a
bring-up session. Cheapest-first:

1. `brew install xcodegen`, then **`./scripts/dev-app-only.sh`** (which
   regenerates for you). That excludes the camera extension and the audio
   driver from the app's dependencies — both are *embedded* deps, so without
   this the app cannot build until you have Developer ID certs and a vendored
   libASPL. It also swaps in `Streamit-dev.entitlements`, which omits
   `com.apple.developer.system-extension.install` — that entitlement is
   *restricted*, so only a provisioning profile can grant it, and its presence
   makes even a local test run demand development signing. `--restore` puts
   both back for a release build; `--status` says which mode you are in. It
   edits `project.yml`, so don't commit it.

   To skip signing entirely for a one-off test run:
   `xcodebuild test -scheme Streamit CODE_SIGNING_ALLOWED=NO`
2. **Run the unit tests before anything else** (Cmd-U, or
   `xcodebuild test -scheme Streamit`). They need no hardware,
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
  systemextensionsctl uninstall <teamID> com.aviashkenazi.streamit.cameraextension
  log stream --predicate 'subsystem CONTAINS "com.aviashkenazi.streamit"' --level debug
  ```
- Every extension code change is a new version → re-approval in System
  Settings › General › Login Items & Extensions. When wedged: uninstall,
  kill the `cameraextension` process, reboot as last resort.
- Test clients in order of pickiness: Photo Booth (pickiest), Zoom, Chrome
  (meet.google.com).

## Audio driver dev loop

Manual spike install (before wiring the in-app installer):

```bash
sudo cp -R build/.../StreamitAudio.driver /Library/Audio/Plug-Ins/HAL/
sudo chown -R root:wheel /Library/Audio/Plug-Ins/HAL/StreamitAudio.driver
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod   # blips ALL audio
system_profiler SPAudioDataType | grep -A4 streamit
log show --predicate 'process == "coreaudiod"' --last 5m
```

Verify: QuickTime records from "streamit Microphone" while music plays into
it; Zoom lists it as a mic. Bump `CFBundleVersion` in
`driver/StreamitAudio/Info.plist` on every driver change — the in-app
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
