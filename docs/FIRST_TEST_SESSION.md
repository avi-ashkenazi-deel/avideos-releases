# First streamit test session

Focus: recording → editing → guest call → cloud recovery → live output.
This is a focused acceptance test, not a claim that these workflows already pass.

## What is here

The macOS app lives in `Mac/`. It composites scenes, mixes audio, records a
program locally, receives LiveKit guests, and edits recordings. Browser guests
live in `web/guest/`; `infra/worker/` creates sessions and signs Cloudflare R2
uploads/downloads. HearIt is a separate iOS product in the same repository.

Important boundaries found in the source:

- Live output currently uses the virtual camera and microphone. No direct
  RTMP broadcaster or stream-key settings were found. Putting a guest “On Air”
  adds them to the program; it does not start a public broadcast.
- Guest media chunks upload to R2. Host camera/microphone recordings and the
  composite program remain local; full-project cloud backup is not implemented.
- The app-only development build excludes the virtual camera and audio driver.
  Guest calls fall back to the default microphone without the Guest Send driver;
  this does not test guests hearing music or the complete mix-minus feed.
- The host connection publishes microphone audio; no host camera publishing
  was found in `GuestSessionController`. Check the guest's view explicitly.
- Transcription uses WhisperKit locally, with model downloads on first use.
  AI take selection, chapters and clip suggestions call Claude using a separate
  API key. The configured model is `claude-opus-5`; availability for your account
  has not been verified.
- Guest WebM import requires ffmpeg inside the app's `Contents/Helpers/`
  (or Resources). A Homebrew installation alone is not discovered by the app.

## 1. Local recording and editing — start here

Use Xcode's Streamit scheme. The existing app-only development configuration is
sufficient for this stage. Build setup: [DEV_SETUP.md](DEV_SETUP.md).

1. Launch, allow camera/microphone access, use headphones and select a camera
   scene. Confirm the preview and microphone meter respond.
2. Record 90 seconds. Clap at the start and end, speak a repeated sentence with
   one deliberate mistake, say a few “um”s, and leave a five-second silence.
3. Stop; reveal and play the saved file outside streamit. Check picture, audio,
   duration and both claps. Default recordings go to `~/Movies/streamit`, unless
   the recording folder was changed in Preferences.
4. Open the recording in the editor, or use Sessions → **New Project from a File…**.
   Allow the initial transcription download to finish. Check actual words and
   word-click seeking, not just that a transcript appears.
5. Try **Remove Filler Words**, **Tighten Silences**, and undo each. Export a short
   1080p video and play it outside the app. Check cuts, lip sync and captions.
6. Add a Claude API key in Settings → General → AI. Request an AI edit of the
   repeated passage, inspect the proposal, apply it and export. Try a chapter or
   clip suggestion separately so failures can be attributed to one operation.
7. Close and reopen the project. Confirm media, edits and transcript survive.

Pass: a playable original, a playable edited export, correct undo and a project
that reopens. Record transcription/API errors verbatim, without secret keys.

## 2. Connect one real guest

Prerequisites: a deployed Worker, LiveKit project, HTTPS guest page and matching
Worker host key. The checked-in `wrangler.toml` contains placeholders, so it
does not establish that a backend has been deployed. See
[backend setup](../infra/worker/README.md).

1. In Settings → General → Session Server enter the Worker URL and Worker host
   key. The saved indicator confirms storage, not a successful connection.
2. In Interview, disable demo guests and click **Start Guest Session**.
3. Open the invite on a second device, preferably using headphones. Allow camera
   and microphone, enter a name and join.
4. Confirm the guest starts off air. **Put On Air**, switch to an Interview scene,
   and verify their picture and audio enter the program. Take them off air and
   confirm both disappear from the program while the call remains connected.
5. Talk in both directions. Check echo, host audio, the guest's view, mute and
   reconnect. Record which build/device/audio route was used.

Pass: a real guest can join, hear the host, be heard, and enter/leave the program.
With the driver installed, also check that music reaches the guest and their
own voice is not returned to them.

## 3. Prove cloud storage and recovery

Prerequisites: R2 bucket, signing credentials, browser PUT/GET CORS, and bundled
ffmpeg for import. Use **Record Take** in Interview for separate participant
tracks; the main program Record button is a different recording path.

1. Record a two-minute take with the guest. Clap at both ends. Stop the take and
   leave the guest page open until all uploads finish.
2. In R2 verify the session manifest and non-empty guest audio/video objects under
   `sessions/<sessionId>/`. The host's local files are not expected in R2.
3. In Sessions choose **Download & Import All**. Open the imported tracks, play
   beginning and end, and compare duration, audio and clap sync to the take.
   An upload percentage alone is not proof of recoverable media.
4. Make a second take. Disconnect the guest's network for 20 seconds while
   recording; reconnect, stop and wait for uploads. Download and play again.
5. Separately test a page reload after stopping while uploads remain queued.
   Reopen the same origin in the same browser profile; verify pending chunks
   resume, the manifest is complete and the recovered media imports. Do not
   clear browser storage. Upload grants expire after 24 hours, so begin with
   same-day recovery.
6. Once short tests pass, record 30 minutes and compare clap alignment at both
   ends; target approximately 30 ms or better, as in the existing test guide.

Pass: independently downloaded, playable guest media, complete track metadata,
and successful interrupted-upload recovery. Preserve originals until checked.

## 4. Test the real live destination

First destination: **YouTube**, using a private rehearsal. YouTube's Webcam
mode accepts a selected camera and microphone, so the intended initial route
is streamit → virtual camera/microphone → YouTube Studio → Webcam. Verify both
devices appear before creating the test. See [YouTube's webcam instructions](https://support.google.com/youtube/answer/9228389?hl=en).
First-time live activation can take up to 24 hours, according to
[YouTube's setup guide](https://support.google.com/youtube/answer/2907883?hl=en).

Local readiness checked 2026-10-03:

- No saved `workerBaseURL` in streamit's preferences.
- Worker configuration still has LiveKit/account placeholders; a historical
  work-log entry explicitly says nothing was deployed at that point.
- Cloudflare and LiveKit dashboards both opened at sign-in screens. Account
  inventories remain unverified; local evidence alone cannot exclude an
  existing remote deployment.
- No streamit camera in the system extension inventory, and no streamit audio
  driver in `/Library/Audio/Plug-Ins/HAL`. Install/configure these before trying
  the intended YouTube route.
- Solo YouTube output does not require Cloudflare/LiveKit. Real guest calls and
  online guest recording tests do.

Cloudflare setup progress, 2026-10-03:

- Account verified; dashboard confirmed there were no existing Workers/Pages projects.
- R2 activated by the user. Created `streamit-recordings` in Western Europe,
  Standard storage, public access disabled.
- Guest site deployed to https://streamit-guest-avi-04d.pages.dev and verified HTTP 200.
- Backend deployment is not complete: Wrangler needs additional R2-related
  authorization. Its initial account/user read + script/Pages write scopes
  authenticated successfully but could not inspect the bucket.
- A 30-day Object Read & Write credential restricted to `streamit-recordings`
  is prepared in the dashboard, awaiting approval; it has not been created.
- LiveKit credentials, bucket CORS, backend secrets and end-to-end uploads remain
  to be configured/tested. A live guest page alone does not mean calls work.
- On this Mac, Wrangler requires `NODE_OPTIONS=--use-system-ca` for the corporate
  certificate chain. TLS verification stays enabled.

For the current virtual-device route, follow
[virtual device setup](DEV_SETUP.md#testing-the-virtual-camera-and-virtual-microphone).
The app-only test build cannot verify this stage.

1. Confirm the destination can receive **streamit Camera** and **streamit
   Microphone**, directly or through its broadcasting software.
2. Use a private rehearsal where the destination supports it. Have a second
   device watch the destination output, not just the studio preview.
3. Run ten minutes: host speaking, real guest on/off air, music, scene changes,
   screen share and simultaneous local recording.
4. Verify viewer audio/video, sync, no doubled guest audio, and successful stop.
   Compare the local recording with what the viewer received.

Pass: the actual destination receives the complete program. A working preview
or an “On Air” guest badge is not sufficient.

## Record results

For each stage note: date/build, devices/browser, steps, expected versus actual,
error text, local file/session ID and pass/fail. Do not include keys, tokens,
presigned URLs or private invite links in shared reports.

| Stage | Status | Evidence / blocker |
| --- | --- | --- |
| Mac build + existing unit tests | Passed 2026-10-03 | 280 tests, zero failures; repeated after the host-key Settings fix. Logic tests do not validate capture or cloud services |
| Worker type check | Passed 2026-10-03 | Locked dependencies installed in a temporary folder; no cloud deployment exercised |
| Guest browser script syntax | Passed 2026-10-03 | guest.js, recorder.js and uploader.js parse; browser behavior still untested |
| Local recording + edited export | Not run | Needs an interactive recording |
| Real guest | Not run | Deployment/configuration not yet confirmed |
| R2 upload + download + recovery | Not run | Requires real storage and browser test |
| AI proposal + export | Not run | Requires transcription and configured API access |
| Live destination | Not run | Destination and virtual-device setup required |
