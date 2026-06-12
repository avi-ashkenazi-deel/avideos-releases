# Time It

A solo **iPhone + Apple Watch** timer app for running **several countdown timers
at once**, each announcing its milestones by **voice** and/or **haptic buzz**.

Built for two situations:

- **Gym** — start a 60-second interval (or several at once). It speaks your
  cadence ("Halfway", "20 seconds") and counts down the last 10 seconds out loud,
  ducking your music instead of stopping it.
- **Conference talk** — start a 20-minute timer on the watch with the phone in
  your pocket. The watch buzzes with **distinct** patterns at halftime, the
  five-minute warning, and "wrap up" — silent feedback you can feel without
  looking, kept alive for the whole talk by a workout session.

## How it works

- **Per-timer milestones** can be defined as a **percentage** of the total
  (every 50%, at 30% remaining…) or as an **absolute time remaining** (30s left).
  Each milestone independently picks **voice**, **haptic**, or **both**, and which
  haptic pattern to use.
- A **final spoken countdown** (last N seconds, configurable) reads "10, 9 … 1".
- **Multiple timers run concurrently**, driven by one shared clock. Overlapping
  spoken announcements are queued so they never garble; haptics fire in parallel.
- iPhone and Watch each run their **own** timer engine (independent), and share
  the **same preset library** via an App Group + WatchConnectivity sync — so the
  watch keeps working even when the phone is unreachable.

## Project layout

```
Shared/        compiled into both the iOS and watchOS targets
  Models/      TimerPreset, TimerMilestone, AlertStyle, HapticPattern, RunningTimerState
  Engine/      TimerEngine (the multi-timer clock) + MilestoneScheduler (pure logic)
  Services/    AudioSession, SpeechAnnouncer, HapticPlayer, PresetStore, ConnectivityBridge, AppGroup
iOS/           iPhone app + views
Watch/         watchOS app + views + WorkoutKeepAlive (HKWorkoutSession)
Tests/         unit tests for the pure scheduling logic
project.yml    XcodeGen project definition (the .xcodeproj is generated, not committed)
```

## Building (on a Mac)

The Xcode project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
so it isn't committed. To build:

```sh
brew install xcodegen        # one time
xcodegen generate
open TimeIt.xcodeproj
```

Then in Xcode:

1. Set your **Apple Developer team** on both the `TimeIt` and `TimeItWatch`
   targets (Signing & Capabilities). The bundle id prefix is
   `com.aviashkenazi.*` — change it in `project.yml` if you use your own.
2. The App Group `group.com.aviashkenazi.timeit` and the watch's **HealthKit**
   capability are declared in the entitlements; make sure they're enabled for
   your team's provisioning.
3. Build & run the `TimeIt` scheme on your iPhone, and the `TimeItWatch` scheme
   on the paired watch.

## Running the tests

```sh
xcodegen generate
xcodebuild test -scheme TimeIt \
  -destination 'platform=iOS Simulator,name=iPhone 15'
```

The tests cover the pure logic (milestone resolution, due-milestone detection,
the countdown sequencer, and the running-timer time math) — see
`Tests/MilestoneSchedulerTests.swift`.

## Status

First cut: core engine, both apps, preset editor, voice + haptics, watch workout
keep-alive, and library sync. App icons and richer per-milestone haptic tuning
are TODO. See `TESTING.md` for the manual end-to-end checklist.
