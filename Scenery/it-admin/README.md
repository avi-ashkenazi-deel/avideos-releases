# Scenery for IT

Scenery replaces a locked desktop picture with a short list of approved
wallpapers that people can choose from. You decide what is on the list, and you
can override everyone's choice whenever you need to.

## What you control

| You want to… | How |
| --- | --- |
| Publish or change the approved list | Edit `manifest.json` on your web host. |
| Schedule a season or event in advance | Add a takeover to the manifest with start and end dates. |
| Change every Mac right now | Set `ForcedWallpaperID` in the management profile. |
| Hand the choice back | Remove the takeover or the `ForcedWallpaperID` key. |
| Turn video off fleet-wide | Set `DisableVideo` to true. |

Each Mac checks the manifest every 30 minutes by default
(`RefreshIntervalMinutes`), when it wakes, and at the exact start and end time
of every scheduled takeover. The check is a small conditional request that
normally returns nothing.

## 1. Host the catalog

Put the manifest and the wallpaper files on any static HTTPS host (a storage
bucket, an internal web server). Paths in the manifest may be relative to the
manifest itself.

```
https://wallpapers.example.com/scenery/manifest.json
https://wallpapers.example.com/scenery/images/value-01.jpg
https://wallpapers.example.com/scenery/videos/brand-loop.mp4
```

Start from [`manifest.example.json`](manifest.example.json).

### Wallpaper fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable identifier. People's choices are stored by id, so do not reuse an id for different artwork. |
| `url` | yes | The file. `https` only. Images: `.jpg` `.jpeg` `.png` `.heic`. Videos: `.mp4` `.mov` `.m4v`. |
| `title` | no | Name shown in the picker. |
| `posterURL` | no | Still image for a video. If missing, the first frame is used. |
| `sha256` | no | Checksum of the file. If present, a download that does not match is rejected. |
| `selectable` | no | `false` hides the wallpaper from the picker; use it for takeover-only artwork. Default `true`. |

At most 10 wallpapers are shown in the picker. Extra selectable entries are
hidden, in manifest order.

People with more than one display can choose to span a wallpaper across all of
them. Any wallpaper can be spanned; wide artwork (about 7680×2160 for images,
3840×1080 or larger for video) looks best. A takeover follows each person's
layout, so it spans for the people who have chosen spanning.

To replace artwork, publish it under a **new file name** and update the `url`.
Macs keep a downloaded file for as long as its URL stays the same.

### Takeover fields

| Field | Required | Meaning |
| --- | --- | --- |
| `wallpaperID` | yes | Which wallpaper to show on every display. |
| `startsAt` | no | When it begins. Missing means already started. |
| `endsAt` | no | When it ends (exclusive). Missing means until you remove it. |
| `message` | no | Short line shown in the picker, such as "Happy holidays". |

Dates are either a full timestamp (`2026-12-18T09:00:00Z`) or a bare date
(`2026-12-18`, meaning midnight UTC). If several takeovers overlap, the first
one in the list wins. A takeover with an unreadable date is ignored rather than
applied without limits.

## 2. Configure the Macs

Deploy a profile that sets preferences for the app's bundle identifier. Start
from [`scenery.mobileconfig.example`](scenery.mobileconfig.example).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ManifestURL` | String | none | Where the catalog lives. Without it the app shows its built-in demo collection. |
| `RefreshIntervalMinutes` | Integer | 30 | How often to check the manifest. Minimum 5. |
| `ForcedWallpaperID` | String | none | Pins this wallpaper on every display. Overrides takeovers and personal choices. |
| `PauseVideoOnBattery` | Boolean | true | Freeze videos on battery. Setting it locks the checkbox in the app. |
| `DisableVideo` | Boolean | false | Show videos as still images only. |

To make Macs pick up a change without waiting for the next check, run this as
the logged-in user from your management tool:

```bash
open "scenery://refresh"
```

## 3. Remove the existing wallpaper lock

If a profile currently locks the desktop picture, remove that restriction for
the Macs that get Scenery. While it is in place, macOS does not allow any app
to change the wallpaper.

## Things to know

- **It is not a hard lock.** A person can still change the wallpaper in System
  Settings. Scenery restores the approved one on the next Space change,
  refresh, wake or login, not instantly. If a hard guarantee matters more than
  choice for some group, keep the existing lock for that group.
- **Bad manifests are safe.** A manifest that cannot be read never replaces the
  last good one. Individual bad entries are skipped and written to the system
  log with the prefix `Scenery manifest:`.
- **Network use.** One small manifest request per interval, plus a one-time
  download of each wallpaper file. Files are stored in
  `~/Library/Application Support/Scenery` and removed when they leave the
  manifest.
- **Privacy.** The app sends nothing about the person or the Mac. It only
  downloads the manifest and the files it lists.
