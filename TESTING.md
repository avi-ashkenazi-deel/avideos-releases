# HearIt — TestFlight tester guide

Thanks for testing HearIt! It reads your email (and saved web articles)
aloud, like a podcast. Please try the things below and note anything that
feels broken, confusing, or slow.

> **Heads-up on sign-in:** the app is in beta, so when you connect Google you'll
> see a *"Google hasn't verified this app"* screen. Tap **Advanced → Go to
> HearIt (unsafe)** to continue — this is normal for a test build. You must
> use a **Google account** (Gmail or Workspace), and your address has to have
> been added to the tester list first.

## 1. Sign in
- [ ] Tap **Continue with Google**, sign in, grant the permissions.
- [ ] Confirm your real inbox loads with senders, subjects, and dates.

## 2. The inbox list
- [ ] Do you see **sender logos / icons** next to most emails (company logos,
      or a colored initial as fallback)?
- [ ] Each row shows an estimated **"X min read"** — does it appear for all
      emails after a few seconds (not just ones you've opened)?
- [ ] Swipe a row left/right to **mark read / unread**.

## 3. Listening to an email
- [ ] Tap an email, press **play**. The current sentence highlights and scrolls.
- [ ] Drag the **speed slider** (0.5×–2.5×) — does the pace change?
- [ ] Use **skip back / forward** and tap a sentence to jump to it.
- [ ] Let one **finish** — it should mark as read. **Check Gmail** to confirm it
      shows read there too.

## 4. The mini-player (keep-playing)
- [ ] While something's playing, switch to the **Saved** tab and back — audio
      should **keep playing**.
- [ ] The floating **mini-player** bar should stay at the bottom; tap it to
      expand, swipe/collapse to shrink it, ✕ to stop.
- [ ] While one email is playing, open a **different** email — the first should
      **keep playing**, and the new one shows a **"Play this email"** button.

## 5. Lock screen & AirPods
- [ ] Lock your phone while playing — controls + artwork should appear on the
      **lock screen / Control Center**, and audio keeps going.
- [ ] Artwork shows the **sender's logo**, switching to the **email's image**
      when one is being read.
- [ ] With **AirPods/headphones**, try play/pause and skip from the buds.

## 6. Auto-play next (optional)
- [ ] In **Settings**, turn on **Auto-play next unread**.
- [ ] Finish an email — it should automatically open the next unread one,
      **announce the sender and subject**, and keep reading.

## 7. Saved web articles
- [ ] In **Safari** (or Feedly), open an article → **Share → HearIt**.
- [ ] Open the app's **Saved** tab — the article should appear, then become
      playable. Try playing it (works offline once saved).

## 8. Highlights
- [ ] While listening, tap the **highlighter** button to save the last ~10s.
- [ ] Open **Highlights** (toolbar), add a note, and use **"Listen in…"** to
      jump back to that spot.

## 9. Analytics
- [ ] Tap the **chart** icon in the inbox. Check it shows emails listened,
      words, time, and **who you listen to most**.

## 10. Settings
- [ ] Try a different **system voice**.
- [ ] (If you have an ElevenLabs API key) enable **ElevenLabs voice** and pick a
      voice — playback should use it.
- [ ] Set the **image behavior** (pause on images vs. announce).

## What to report
For anything wrong, please include:
- **What you did** (which screen, which steps).
- **What happened** vs. what you expected.
- A **screenshot or screen recording** if possible.
- (TestFlight already sends your device + iOS version.)

Especially useful: **crashes**, **audio that stops when it shouldn't**, emails
that read **garbled text / lots of junk**, wrong or missing **sender logos**,
and anything **slow** or **draining battery**.

## Known beta rough edges (no need to report)
- The Google "unverified app" warning on sign-in (expected for beta).
- A few senders may show a generic globe instead of a logo.
- The Apple Watch app isn't in this build yet.
- Article text extraction is heuristic — odd pages may include some clutter.

---

# AVideos Studio (macOS) — tester guide

Each phase's exit demo, as checkboxes. Requires a Mac (see docs/DEV_SETUP.md).

## Live studio
- [ ] Launch: camera scene shows your camera in the preview at 30fps (fps HUD top-left).
- [ ] Install the camera extension (Setup tab) → "AVideos Camera" appears in Photo Booth, Zoom, and Google Meet; splash card shows when the app is closed.
- [ ] Add a text element → drag/resize/rotate on canvas; toggle Hide/Show and watch the slide-in/out animation reverse itself.
- [ ] Give a shape an animated fill + a video stroke; set blend mode to Multiply over the camera.
- [ ] Effects tab: chroma key removes a green screen; virtual background blurs/replaces without one; beautify smooths only the face.
- [ ] Switch Camera → Screen Share → Interview: magic move glides shared tiles, others animate in/out.

## Audio
- [ ] Music plays to headphones with a working fader; talking ducks the music (−12dB default) and it recovers smoothly.
- [ ] Sound pads fire instantly (⌥1…⌥9), retrigger steals oldest voice.
- [ ] Add a Compressor insert on the mic; macro knob audibly changes it; a third-party AU opens its own UI.
- [ ] Install the virtual mic (Setup) → Zoom hears mic+music+pads through "AVideos Microphone".
- [ ] Record while live → .mov in ~/Movies/AVideos plays with A/V in sync (clap test).

## Guests & podcast mode
- [ ] Start a guest session → invite link/QR joins from a Chromium browser; guest appears in the Interview grid and the mixer.
- [ ] With headphones off on both ends: no echo (guest never hears themselves — mix-minus).
- [ ] Record Take → guest's tab shows REC + upload %; kill the guest tab mid-take, reopen → recording resumes, at most ~5s lost.
- [ ] Sessions library: Download & Import All → aligned .movs; two-device clap within ~30ms at minute 0 and minute 30.

## Teleprompter
- [ ] Toggle prompter (⇧⌘T): floats above everything, scrolls at set WPM, mirrors, click-through works.
- [ ] Share your screen in Zoom: the prompter is NOT visible in the share, and never in the program.
- [ ] Open prompter.html on a phone → play/pause/speed/jump control the panel.

## Edit mode
- [ ] Open a session in the editor → tracks left, transcript center, preview right, timeline bottom.
- [ ] Transcribe → click a word seeks; select words + Delete cuts them cleanly (snapped to silence); click struck text recovers.
- [ ] Clean Up removes fillers and tightens pauses; cuts are inaudible (micro-fades).
- [ ] Record 3 takes of a scripted intro with flubs → AI Edit proposes the best take; Apply, then recover a rejected take.
- [ ] Suggest Clips → ranked list; Export Vertical produces 9:16 with word-by-word captions.
- [ ] Chapters → YouTube-format list lands on the clipboard and exports as a sidecar.
