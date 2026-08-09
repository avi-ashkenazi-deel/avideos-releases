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

# streamit (macOS) — tester guide

Each phase's exit demo, as checkboxes. Requires a Mac (see docs/DEV_SETUP.md).

## Live studio
- [ ] Launch: camera scene shows your camera in the preview at 30fps (fps HUD top-left).
- [ ] Install the camera extension (Setup tab) → "streamit Camera" appears in Photo Booth, Zoom, and Google Meet; splash card shows when the app is closed.
- [ ] Add a text element → drag/resize/rotate on canvas; toggle Hide/Show and watch the slide-in/out animation reverse itself.
- [ ] Give a shape an animated fill + a video stroke; set blend mode to Multiply over the camera.
- [ ] Effects tab: chroma key removes a green screen; virtual background blurs/replaces without one; beautify smooths only the face.
- [ ] Switch Camera → Screen Share → Interview: magic move glides shared tiles, others animate in/out.

## Audio
- [ ] Music plays to headphones with a working fader; talking ducks the music (−12dB default) and it recovers smoothly.
- [ ] Sound pads fire instantly (⌥1…⌥9), retrigger steals oldest voice.
- [ ] Add a Compressor insert on the mic; macro knob audibly changes it; a third-party AU opens its own UI.
- [ ] Install the virtual mic (Setup) → Zoom hears mic+music+pads through "streamit Microphone".
- [ ] Record while live → .mov in ~/Movies/streamit plays with A/V in sync (clap test).
- [ ] Mid-take: clap, Pause (⌥⌘R), wait ~10s, Resume, clap again, Stop. The file is **gapless** — no ten-second freeze or silence — and both claps line up with their picture.

## Music sections
Full detail in docs/FEATURE_CHECKLIST.md, F-380…F-430.

Marking a track up (right-click a playlist row → Sections…):
- [ ] Play the track from inside the sheet and press **M** three times: three sections appear where you tapped, each contiguous with the next, each auto-assigned the next free hotkey slot.
- [ ] Drag a section's right edge to pin its end; drag the start flag so the track begins there.
- [ ] Type `1:23.480` into a start field — the marker moves. Type nonsense — the field reverts rather than clearing.
- [ ] Rename, recolour, set Loop and a hotkey slot; relaunch and they're all still there.

Playing live (music panel):
- [ ] Click a section pad: it loops seamlessly. Leave it looping five minutes and listen for drift or a tick at the wrap.
- [ ] With **Cut**, another pad switches immediately. With **At loop end**, it queues — the pad shows NEXT, the countdown runs, and it lands at the wrap.
- [ ] Cancel a queued switch; the cancel button greys out once it's been handed to the audio engine.
- [ ] ⌥-click a pad to cut regardless of the mode, without changing the mode.
- [ ] Talking still ducks the music while a section loops, and the fader, mute, inserts and meter all behave.
- [ ] Scrub outside the looping section: playback follows the scrubber and the loop releases.
- [ ] With Zoom frontmost: ⌃⌥3 fires section 3, ⌃⌥C flips the mode, ⌃⌥L toggles the loop, ⌃⌥0 cancels the queue, ⌃⌥K drops a marker.

Regression, on a track with **no** sections:
- [ ] Plays, seeks, skips and loops exactly as before; section controls are visible but disabled.
- [ ] A 44.1 kHz track's progress bar now reaches the end as the track ends (it ran ~8.8% fast).
- [ ] Dragging the scrubber is smooth and doesn't fight you.
- [ ] A settings file written before this feature loads with devices, gains, ducker, inserts and pads intact.

Crossfade and gapless:
- [ ] Set the mode to **Crossfade** and switch sections: the two overlap smoothly rather than cutting, with no dip in loudness through the middle.
- [ ] Let a playlist run from one track into the next: no gap where a file used to be opened at the seam.

Known gaps in this pass — do not report:
- Gapless advance is close but not sample-accurate — the disk is out of the seam, but a main-queue hop remains. Judge by ear.
- No beat-grid snapping; marker positions are set by ear and by typed timecode.

## MIDI control
Needs a class-compliant USB controller. Full detail at F-421…F-430.
- [ ] Settings → MIDI lists the controller with a green dot, and "Last message" updates when you press a pad even with nothing bound.
- [ ] Learn a control for Section 1, press a pad — it binds, and then fires that section live, including with Zoom frontmost.
- [ ] Unplug and replug: bindings still work.
- [ ] A controller sending clock or active sensing doesn't stutter the app.
- [ ] Deleting `midi-bindings.json` loses only the bindings, nothing else.

## Editor: external media
Full detail in docs/FEATURE_CHECKLIST.md, F-431…F-476.

Bringing files in:
- [ ] Tracks pane → Media → Add Media… imports a clip; a playable file arrives instantly, a WebM offers conversion.
- [ ] Drag a video from Finder onto the B-roll lane: the lane highlights, a chip names the outcome and time, and it lands as a cutaway.
- [ ] Dropping on the sequence column is refused, pointing at the B-roll lane.
- [ ] Move a file on disk and reopen: a missing-media banner appears; relinking one file fixes its siblings from the same folder.

Cutaways:
- [ ] Select one → the inspector appears under the preview. Scrub "start inside clip", change mode, corner and opacity.
- [ ] Turn on its audio: you hear it and the conversation ducks, already down as the clip begins rather than fading during it.
- [ ] A cutaway whose file is missing produces no duck at all.
- [ ] Drag a cutaway to move it; drag its ends to retime it. One ⌘Z undoes each whole gesture.
- [ ] Stem exports contain no cutaway audio and no ducking.

Extra angles and bookends:
- [ ] Add a clip as an Extra Track: it gets its own tracks-pane row with an offset nudge, its own timeline column, and a Layout menu entry.
- [ ] Its mute/solo/dB behave like a participant's; soloing it silences the people.
- [ ] A portrait clip renders upright, not sideways.
- [ ] Set an intro: the export starts with it — and check that no chapter or cutaway moved.
- [ ] Exported chapters, SRT and VTT line up with the file once an intro is set, and the preview playhead still matches the timeline.

Standalone:
- [ ] Sessions → New Project from a File… opens the editor over one clip, with waveform, thumbnails and mixer working.
- [ ] Clip Studio says "transcribe this clip", not "the session"; transcribing enables the AI features.

Known gaps in this pass — do not report:
- Intro and outro are set per project; the brand kit's stinger fields still don't feed them.
- No freeform draggable inset rectangle — corner presets only.
- No stock-footage search.

## Guests & podcast mode
- [ ] Start a guest session → invite link/QR joins from a Chromium browser; guest appears in the Interview grid and the mixer.
- [ ] With headphones off on both ends: no echo (guest never hears themselves — mix-minus).
- [ ] Record Take → guest's tab shows REC + upload %; kill the guest tab mid-take, reopen → recording resumes, at most ~5s lost.
- [ ] Call-in gate: a joining caller shows "waiting" in the Guests palette and is absent from the program and inaudible, but hears the show; Put On Air adds them to the tiles and unmutes them, and their page flips "off air" → ON AIR; clicking again pulls them back without disconnecting.

## Editor: delivery polish and multicam
Full detail in docs/FEATURE_CHECKLIST.md, F-488…F-499.
- [ ] Export a video with a brand-kit watermark set: logo top-right at the kit's opacity, above the captions; the preview shows no watermark.
- [ ] Export an audio master and check it in a LUFS meter: ≈−16 integrated; a video export ≈−14; toggle off in Preferences → Audio and the level stays raw.
- [ ] Add a music bed, transcribe, play: music fades in, sits under speech, swells in pauses, fades out at the end. ⌘Z removes it.
- [ ] Film a minute on a second camera (phone) while recording, import it, **Sync by Audio** → clap lines up; the Cut to strip switches angles at the playhead.
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

## Editor: sequencing, levels, B-roll, vertical timeline
Full detail in docs/FEATURE_CHECKLIST.md, F-309…F-345.

Sequencing (the episode is now an ordered list of segments, not a fixed tiling of the source):
- [ ] Drag a segment to a new position → the episode plays in the new order, all participants still in sync, total length unchanged.
- [ ] Drag a segment's edge inward to trim it, then outward to extend back into material a cut had taken.
- [ ] Duplicate a segment → the moment plays twice and appears twice in the transcript.
- [ ] Cut a word that occurs twice → every occurrence goes; S splits the occurrence under the playhead, not an earlier copy.
- [ ] Chapters, captions and layout still land correctly after a reorder.
- [ ] A project saved before this change opens and behaves identically (no migration).
- [ ] One ⌘Z undoes a whole move, trim or duplicate.

Per-track levels:
- [ ] Each audio participant row has a dB slider, M and S; −6 dB is audibly quieter in the preview *and* the export.
- [ ] Solo silences everyone else; several tracks can be soloed at once; muted rows dim.
- [ ] No click or level jump at a cut boundary on a track that isn't at 0 dB (the 15 ms fades scale with gain).
- [ ] Stem exports carry each track's gain but deliberately ignore mute/solo.
- [ ] Levels persist across save/reload and undo like any other edit.

B-roll lane:
- [ ] Clip Studio → B-Roll → Insert on B-Roll Lane puts a cutaway on the timeline; the picture changes and the conversation's audio keeps playing underneath.
- [ ] Scrub across its start and end — the picture switches cleanly at both boundaries.
- [ ] Captions stay readable over a full-frame cutaway; inset mode shows it as a corner picture.
- [ ] Drag a cutaway to move it, and drag its ends to retime it; select and remove it; two overlapping cutaways don't fight.
- [ ] A cutaway whose moment has since been cut refuses to insert, with a clear message.

Vertical timeline:
- [ ] The timeline is a column beside the transcript, time running top to bottom, drawn in program order.
- [ ] Text mode: a segment's block sits beside the words it contains; a long silence still gets a block sized by its duration; a short gap does not.
- [ ] Time mode: constant points per second; zoom in and out.
- [ ] Switching modes keeps the playhead and selection on the same moment; clicking the timeline seeks the preview exactly in both.
- [ ] Each block shows a poster frame; they fill in as you scroll and don't re-fetch.
- [ ] Waveform columns run vertically, one per participant, follow the *edited* program, and dim when muted or not soloed.
- [ ] The captions lane shows the lines that will actually be burned in.
- [ ] Cut segments show as thin collapsed strips at their sequence position and can be restored from there.
- [ ] Before transcription (no measured text) the timeline still renders usefully rather than blank.

Known gaps in this pass — do not report:
- Scrolling one pane does not scroll the other; the two views are aligned but not yet linked.
- Neither pane follows the playhead during playback; you scroll yourself.

## Clip Studio
- [ ] Clip Studio opens from the editor toolbar; without a transcript the AI buttons are disabled and the footer says why.
- [ ] Find Clips → ranked suggestions with score badges; Preview seeks the program preview to that moment.
- [ ] Search "the part about <topic>" → results jump the preview to each match.
- [ ] B-Roll → suggestions list cutaway windows and match the session's own video files by name.
- [ ] Look tab: pick a caption template, tweak size/position, Save as a new template → it reappears after relaunch.
- [ ] Apply Brand Colors → caption swatches change; Save Brand Kit persists across relaunch.
- [ ] Reframe tab: Analyze Session reports speaker segments and per-track face counts.
- [ ] Compute Crop Paths, then export a 9:16 clip → the speaker stays framed (no center-cropped foreheads), and the crop cuts rather than pans when the speaker changes.
- [ ] Turn Smart reframe off and export the same clip → visibly center-cropped, confirming the path is doing the work.

## Publishing
- [ ] Publish opens from the editor toolbar and pre-fills the most recent export.
- [ ] With nothing connected, each platform row says how to connect; publishing a YouTube item fails with a clear "sign in" message rather than silently.
- [ ] YouTube form: Append Chapters drops the generated chapter list into the description.
- [ ] Queue an item → row shows progress, then Published with an Open link (upload lands as private on YouTube).
- [ ] Schedule for 2 minutes out → row shows the time, fires while the app is running.
- [ ] A failed upload shows the error and Retry re-runs it; Remove clears the row.
- [ ] Instagram: publishing reveals the file in Finder and explains the public-URL limitation.

## Keyboard shortcuts
- [ ] With Zoom frontmost (studio behind it): ⌥1…⌥9 fire sound pads, ⌃⌥M mutes the mic, ⌃⌥→/⌃⌥← change scene, ⌃⌥R records.
- [ ] No accessibility-permission prompt was required for the global hotkeys.
- [ ] Studio menu lists every command with its combo; pressing one while focused toggles once, not twice.
- [ ] ⌘1…⌘9 jump to scenes by sidebar position.
- [ ] Settings → Shortcuts: rebind a pad; the new key works, the old one stops, and the pad badge updates.
- [ ] An empty pad slot shows no hotkey badge.
- [ ] Editor: Space plays, ←/→ step frames, S splits, Delete cuts the selected clip, ⌘Z / ⇧⌘Z undo and redo.
- [ ] One ⌘Z reverts a whole Clean Up or applied AI edit, not one clip at a time.

## Unit tests (no hardware needed)
- [x] `./scripts/dev-app-only.sh`, then
      `xcodebuild test -scheme Streamit CODE_SIGNING_ALLOWED=NO` →
      **269 tests, 0 failures** (first verified 2026-07-27, macOS 26.5 / Xcode 16).
      Cmd-U works too once the project is generated.

These cover pure logic only — EDL arithmetic, volume envelopes, music timing,
placement, framing geometry, Codable round-trips. Passing them says nothing
about whether a camera renders, audio flows, or a loop wraps cleanly; those are
the checklists above, and they still need a person and hardware.
