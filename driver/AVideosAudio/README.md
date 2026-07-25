# AVideosAudio — CoreAudio HAL virtual-audio driver

A HAL `AudioServerPlugIn` (`.driver` bundle) built on
[libASPL](https://github.com/gavv/libASPL) (MIT, C++17). It publishes two
loopback devices:

| Device | UID | Default-input eligible |
|---|---|---|
| AVideos Microphone | `com.aviashkenazi.avideos.vmic` | yes |
| AVideos Guest Send | `com.aviashkenazi.avideos.gsend` | no |

Each device is fixed at 2 ch / 48 kHz / Float32 with one **output** stream and
one **input** stream.

## How the loopback works

BlackHole-style: an app plays program audio *into* the device (its output
stream); a conferencing app (Zoom/Meet/Teams) selects the same device as a
*microphone* and reads it back (its input stream).

- libASPL owns the AudioServerPlugIn boilerplate and clocks each device off
  host time (`mach_absolute_time`) at the fixed 48 kHz rate, generating the
  zero timestamps both IO directions share.
- `Driver.cpp` installs an `aspl::IORequestHandler` per device:
  `OnWriteMixedOutput` stores the mixed output buffer into a per-device
  `LoopbackRing` at its absolute device sample time; `OnReadClientInput`
  reads from the ring at the requesting client's sample time.
- Because both directions share one device clock, indexing the ring by
  absolute frame count modulo its size (65536 frames × 2 ch Float32) makes
  the loop sample-synchronous — no resampling, no drift correction. Underrun
  reads zero-fill (silence, never stale data).
- The render path is allocation-free and lock-free (one atomic write head);
  see `LoopbackRing.h` for the memory-ordering and torn-read notes.

Both devices report a *virtual* transport type, are never eligible as the
default **system** (sound-effects) device, and "Guest Send" is additionally
never eligible as a default device at all.

## How libASPL is pulled

The SPM package is declared in `project.yml` at the repo root:

```yaml
packages:
  libASPL:
    url: https://github.com/gavv/libASPL
    from: "3.1.0"
```

and the `AVideosAudioDriver` bundle target depends on it. `xcodegen generate`
wires it up; Xcode resolves the package on first build.

**Fallback (CMake / submodule)** — if SPM packaging fights XcodeGen on your
machine:

```sh
git submodule add https://github.com/gavv/libASPL driver/vendor/libASPL
cd driver/vendor/libASPL
mkdir build && cd build
cmake .. && make -j
# produces libASPL.a + headers under build/include
```

Then point the `AVideosAudioDriver` target at the built static lib instead of
the package: remove the `package: libASPL` dependency in `project.yml`, add
`HEADER_SEARCH_PATHS: driver/vendor/libASPL/build/include` and link
`libASPL.a` (or add libASPL's sources directly to the target — it compiles
cleanly as plain C++17).

## Versioning

`CFBundleVersion` in `Info.plist` is how the app's `DriverInstaller` detects
an out-of-date installed driver. **Bump it every time `Driver.cpp` (or
anything else in the bundle) changes**, otherwise already-installed machines
will never pick up the new build. `CFBundleShortVersionString` tracks the
marketing version and can move with the app.

Do **not** change the factory UUID (`7A9E4F52-3C81-4D6B-9E2A-51B0A6E24C11`)
or the bundle id (`com.aviashkenazi.avideos.audiodriver`) — both are baked
into `Info.plist` and matched by `Driver.cpp` / the installer.

## Manual install (spike / development)

Build the `AVideosAudioDriver` target, then:

```sh
sudo cp -R /path/to/Build/Products/Debug/AVideosAudio.driver \
    /Library/Audio/Plug-Ins/HAL/
sudo chown -R root:wheel /Library/Audio/Plug-Ins/HAL/AVideosAudio.driver
sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod
```

(Or use the scripts the app itself runs: `driver/install/install-driver.sh`
and `driver/install/uninstall-driver.sh`, both run as root.)

Restarting `coreaudiod` briefly interrupts all system audio — close audio
apps first.

## Verifying

1. Devices are published:

   ```sh
   system_profiler SPAudioDataType
   ```

   should list "AVideos Microphone" and "AVideos Guest Send" with input and
   output channels at 48 kHz.

2. Loopback works: play audio to "AVideos Microphone" (e.g. set it as an
   app's output device, or `ffplay`/`afplay` routed to it via Audio MIDI
   Setup), then open QuickTime Player → New Audio Recording → select
   "AVideos Microphone" as the source and record; the recording should
   contain the played audio.

3. If a device is missing, check coreaudiod's log for plug-in load errors:

   ```sh
   log show --predicate 'process == "coreaudiod"' --last 5m
   ```

   Typical failures: bundle not owned by `root:wheel`, bad permissions,
   unresolvable factory symbol, or a stale copy needing another
   `launchctl kickstart -kp system/com.apple.audio.coreaudiod`.

## Files

- `Driver.cpp` — factory entry point (`AVideosAudioDriverFactory`), device
  construction (`MakeLoopbackDevice`), loopback IO handler.
- `LoopbackRing.h` — lock-free sample-time-indexed ring buffer.
- `Info.plist` — bundle metadata + CFPlugIn factory table (see Versioning).
