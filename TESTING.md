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
