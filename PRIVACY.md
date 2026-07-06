# HearIt Privacy Policy

Last updated: July 2, 2026

HearIt is an app that reads your email, RSS feeds, and saved articles aloud. It is designed so that your data stays on your device and in accounts you already own. HearIt operates no servers of its own, and the developer never receives, stores, or sells your data.

## The short version

- Your emails, feeds, articles, highlights, and notes are processed and stored on your device (and, for sync, in your own private iCloud).
- HearIt has no backend. Nothing you read or listen to is sent to the developer.
- There are no ads, no analytics or tracking SDKs, and no sale of data — to anyone.

## What the app accesses, and where it goes

### Your email (Gmail or Outlook)

When you connect an email account, you sign in directly with Google or Microsoft using their official sign-in (OAuth). HearIt receives an access token, which is stored in the iOS Keychain on your device. Your account password is never seen or stored by the app.

Email content is fetched directly from Google/Microsoft to your device, where it is converted to speech and shown on screen. A copy of recent messages is cached on your device so the app works offline. The only changes the app sends back to your mail provider are the ones you make — for example, marking a message read or unread.

**Google API Limited Use disclosure:** HearIt's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Gmail data is used only to provide the app's user-facing email reading features, is never transferred to third parties except as necessary to provide those features (or for security/legal compliance), is never used for advertising, and is never read by humans.

### RSS feeds and saved articles

Feeds and article pages are fetched directly from the publishers' own servers to your device, like a normal browser would. Fetched content is cached on your device for offline listening.

### Highlights, notes, and listening progress

Highlights you capture, notes you attach (typed or dictated), and how far you got in each item are stored on your device and — so your iPhone and iPad stay in sync and data survives reinstalling — in your private iCloud storage (iCloud Key-Value Store and, for saved-article lists, your private CloudKit database). This iCloud data lives in your Apple account; the developer cannot access it.

### Microphone and speech recognition

If you dictate a note onto a highlight (in the app, via a headphone gesture, or via Siri), the microphone is used only for that moment and the audio is transcribed using Apple's speech recognition, which may process audio on Apple's servers per Apple's own privacy terms. Only the resulting text is kept (attached to your highlight). Voice recordings are not stored by HearIt. Siri interactions are handled by Apple under Apple's privacy policy.

### Text-to-speech voices

By default, speech is generated on your device using Apple's built-in voices — the text being read never leaves your device.

Optionally, you can connect your own ElevenLabs account by entering your ElevenLabs API key. If you enable this, the text of the item being read is sent to ElevenLabs to generate audio, under your ElevenLabs account and [ElevenLabs' privacy policy](https://elevenlabs.io/privacy). This is off unless you turn it on, and you can turn it off at any time in Settings.

### Sender pictures and remote images

- To show a picture or logo next to a sender, the app may query public avatar/logo services (Gravatar, using a one-way hash of the sender's address; Clearbit and Google favicon services, using the sender's domain). These requests contain no content from your emails.
- Like most mail apps, displaying an email's images downloads them from the sender's server, which can reveal to that server that the message was viewed (your IP address). Images the app describes aloud are analyzed on your device using Apple's Vision framework.

### Notifications

New-article notifications for feeds you opt into are generated locally on your device. No push-notification service or server is involved.

## What HearIt does not do

- No developer servers: your content is never uploaded to, or processed by, infrastructure run by the developer.
- No analytics, tracking, or advertising SDKs. The "listening analytics" screen is computed and stored entirely on your device.
- No selling or sharing of personal data.
- No tracking across apps or websites (the app's privacy manifest declares no tracking).

## Data retention and deletion

Everything the app stores lives on your device and in your own accounts, so you are always in control:

- **On your device:** deleting the app deletes its local data (cached mail, feeds, articles, highlights, settings).
- **Mail access:** removing an account in Settings (or signing out of all) deletes its tokens from your device. You can also revoke HearIt's access at any time in your [Google account permissions](https://myaccount.google.com/permissions) or Microsoft account settings.
- **iCloud sync data:** stored in your personal iCloud; you can clear it by turning off sync-related data in iOS Settings > Apple ID > iCloud, or by removing the app's data there.

## Children

HearIt is not directed at children under 13 and does not knowingly collect information from them.

## Changes to this policy

If the app's data practices change, this policy will be updated and the "Last updated" date revised. Material changes will be noted in the App Store release notes.

## Contact

Questions about privacy in HearIt: **[YOUR CONTACT EMAIL]**
