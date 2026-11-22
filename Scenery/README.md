# Scenery

A tiny macOS menu bar app that lets people choose their desktop wallpaper from
a short, company-approved collection — images or looping videos, per monitor —
while IT keeps the ability to change or pin the wallpaper for everyone at any
time.

"Scenery" is a working name. This folder is self-contained and unrelated to the
HearIt app in the rest of this repository, so it can move to its own repository
unchanged.

> **Status:** first iteration, written without access to a Mac. The rules
> engine in `Core/` is unit-tested (`swift test`, 39 tests). The app layer in
> `App/` has only been syntax-checked, **not compiled or run** — expect a few
> small fixes on the first build in Xcode.

## What it does

- **Short approved list.** People pick from at most 10 wallpapers. Nothing else
  can be chosen.
- **Images and videos.** Videos loop silently behind the desktop icons.
- **Wallpapers that follow your day.** A third kind of wallpaper is drawn by
  the app from a palette of brand colours and shifts continuously with the
  real position of the Sun: night, dawn, day, dusk. A slider in the picker
  lets you drag through the whole day and watch the desktop change. It needs
  no file at all and is the lightest wallpaper there is.
- **Multi-monitor aware.** A miniature of the real desk layout shows every
  display. Three layouts: the same wallpaper on each display, a different one
  per display, or **one wallpaper spanning all of them** as a single picture.
  Spanning works for images and for video, and follows the arrangement set in
  System Settings, including displays of different sizes or stacked vertically.
- **IT stays in control.** IT publishes the list, can schedule takeovers for
  seasons and events ahead of time, and can pin a wallpaper on every Mac on
  demand. When a takeover ends, each person's own choice comes back.
- **Light.** No Dock icon and no window. It wakes up for events instead of
  polling, and pauses video on battery, in Low Power Mode, when the displays
  sleep, and whenever the desktop is covered.

## Run it

```bash
brew install xcodegen      # one time
cd Scenery
xcodegen generate
open Scenery.xcodeproj
```

In Xcode, choose your team under **Signing & Capabilities** and run. A picture
icon appears in the menu bar. With no configuration, the app uses the nine
placeholder wallpapers in `DemoCatalog/`: six images, two videos, and
"Daylight", which follows the day.

Requires macOS 14 or later.

## Put real artwork in

1. Export wallpapers at 3840×2400 or larger (`.jpg`, `.png`, `.heic`), and
   videos as short seamless loops (`.mp4` or `.mov`, H.264 or HEVC, no audio).
2. Drop them into `DemoCatalog/images` and `DemoCatalog/videos`.
3. List them in `DemoCatalog/manifest.json`.
4. Run `swift test` in `Core/` — it fails if the manifest has a mistake or
   points at a missing file.

## A wallpaper that follows the day

Add an entry with `"kind": "live"` and a `palette` to the manifest. Each of the
four moments is a vertical gradient, top to bottom, of two to four colours:

```json
{
  "id": "daylight", "title": "Daylight", "kind": "live",
  "palette": {
    "night": ["#080C24", "#161D4A", "#2A2C66"],
    "dawn":  ["#2E3A78", "#C46F96", "#FFB27A"],
    "day":   ["#2F6FDB", "#78AEEF", "#DCEBFF"],
    "dusk":  ["#26265E", "#A44E7C", "#FF8F57"]
  }
}
```

The app blends between them as the Sun moves: full night with the Sun 12°
below the horizon, dawn or dusk at its strongest on the horizon, full day 12°
above it. The Sun's position is calculated on the Mac; nothing is looked up
online and no location permission is requested.

- Without a configured location the app assumes the middle of the Mac's time
  zone, which gives sensible sunrise and sunset times but a twelve-hour day all
  year. Set `Latitude` and `Longitude` for real seasons:
  `defaults write com.aviashkenazi.scenery Latitude -float 32.08` (and the
  same for `Longitude`).
- Spanning is seamless by construction: every display draws its part of the
  same gradient, so there is nothing to keep in sync.

## Artwork that spans well

With two displays side by side the canvas is roughly twice as wide as it is
tall, and the wallpaper is scaled to fill it, cropping what does not fit.

- A normal 16:10 wallpaper works, but loses about a third of its height to
  cropping and is enlarged. Wide artwork looks far better: around 7680×2160
  for images and 3840×1080 or larger for video.
- Keep the important part of the picture away from the centre line, where the
  gap between two monitors falls.

## Demo the IT controls

With the app running (replace the bundle id if you changed it):

```bash
# Pin one wallpaper on every display, immediately.
defaults write com.aviashkenazi.scenery ForcedWallpaperID glow
open "scenery://refresh"

# Hand the choice back.
defaults delete com.aviashkenazi.scenery ForcedWallpaperID
open "scenery://refresh"
```

The picker shows a lock banner while the wallpaper is pinned. In production IT
does the same thing from their management console; see
[`it-admin/README.md`](it-admin/README.md).

## How it is built

| Folder | What is in it |
| --- | --- |
| `Core/` | Swift package with no Apple UI code: reads and validates the manifest, and decides which wallpaper each display gets. Fully unit-tested. |
| `App/` | The Mac app: menu bar picker, downloads and caching, the wallpaper engine, video windows, power handling. |
| `DemoCatalog/` | Placeholder wallpapers and their manifest, bundled into the app. |
| `it-admin/` | Example manifest, example management profile, and the guide for IT. |

Who decides the wallpaper, strongest first:

1. A wallpaper pinned through device management (`ForcedWallpaperID`).
2. An active takeover in the manifest.
3. The person's own choice.
4. The manifest's default.

## Known limits

- **The existing wallpaper lock has to be lifted.** While a management profile
  locks the desktop picture, macOS will not let any app change it. Rolling this
  out means IT replaces that lock with this app.
- **Enforcement is soft.** Someone can still change the wallpaper in System
  Settings; the app puts the approved one back on the next Space change,
  refresh, wake or launch, not instantly.
- **Video is a window, not a system wallpaper.** macOS has no public video
  wallpaper setting, so the lock screen and Mission Control show the video's
  still frame.
- **Spanned video sync is unproven on real hardware.** Each display has its
  own player; all of them follow one clock and start at the same instant, which
  should keep them frame-aligned, but this has not been watched on a real
  multi-monitor desk yet. If a seam is visible, that is the first place to look
  (`WallpaperEngine.startTogether`).
- **Spanning ignores bezels.** The picture continues from the edge of one panel
  to the edge of the next, as macOS itself does; the physical gap between
  monitors is not compensated for.
- **Live wallpapers are a first step.** They are smooth gradients only (no
  artwork, texture or motion yet), and large gradients can show faint banding
  on some displays. The still used for the lock screen and the picker preview
  is always the daytime colours.
- **Other Spaces update when visited.** macOS keeps one wallpaper per Space and
  only lets an app set the visible one.
- **Distribution.** For other people's Macs the app must be signed with a
  Developer ID and notarized; IT would then deploy it as a package.
