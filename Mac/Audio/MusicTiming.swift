import Foundation
import AVFoundation

/// Pure timing arithmetic for live music playback: where the playhead is, when
/// a looped region wraps, and when a queued section switch is allowed to
/// commit.
///
/// All of it is deliberately free of AVFoundation state so it can be tested
/// without a Mac — this codebase has never been compiled, and frame arithmetic
/// that is wrong by one buffer is invisible until you hear it drift.
///
/// **Units.** Internally everything is *canonical* frames — 48 kHz, the graph's
/// fixed rate (`CanonicalAudio.sampleRate`). Seconds are used at the
/// persistence and UI boundary, because a section boundary has to survive the
/// file being re-encoded and has to survive `CanonicalAudio.sampleRate` ever
/// changing. File frames appear only inside the decoder and are never stored.

// MARK: - Unit conversion

enum MusicClock {
    /// Seconds → canonical frames. Rounds rather than truncates so a boundary
    /// authored at 12.5s doesn't land a frame early.
    static func frames(fromSeconds seconds: Double) -> AVAudioFramePosition {
        AVAudioFramePosition((seconds * CanonicalAudio.sampleRate).rounded())
    }

    static func seconds(fromFrames frames: AVAudioFramePosition) -> Double {
        Double(frames) / CanonicalAudio.sampleRate
    }

    /// Converts a value read from `AVAudioPlayerNode.playerTime(forNodeTime:)`
    /// into canonical frames.
    ///
    /// **This is the one unverified assumption in the whole timing path.** A
    /// player node's timeline should be expressed in its *output* format, which
    /// here is the connection format — `CanonicalAudio.format`, 48 kHz — so the
    /// conversion is the identity. If it turns out to be the file's rate
    /// instead, this function is the only place that has to change and the
    /// arithmetic below is unaffected.
    ///
    /// Note the old position formula divided node frames by the *file's* rate,
    /// which — if the assumption below holds — made the progress bar run
    /// 48000/44100 ≈ 8.8% fast for every 44.1 kHz file.
    ///
    /// verify on Mac: play a known 44.1 kHz file, log `sampleTime` after 10
    /// wall-clock seconds. ≈480000 ⇒ node frames (assumed here). ≈441000 ⇒ file
    /// frames, in which case scale by `CanonicalAudio.sampleRate / fileSampleRate`.
    static func canonicalFrames(fromPlayerSampleTime sampleTime: AVAudioFramePosition,
                                fileSampleRate: Double) -> AVAudioFramePosition {
        _ = fileSampleRate
        return sampleTime
    }
}

// MARK: - Regions

/// A looped span of a track, in canonical frames.
struct LoopRegion: Equatable {
    let startFrame: AVAudioFramePosition
    let lengthFrames: AVAudioFramePosition

    var endFrame: AVAudioFramePosition { startFrame + lengthFrames }
}

extension LoopRegion {
    /// Shortest region worth looping. Below this the wrap is a buzz, not a loop.
    static let minimumSeconds: Double = 0.25
    /// Longest region we hold decoded in memory. Canonical Float32 stereo at
    /// 48 kHz is ~23 MB/minute, so this is ~69 MB — and a "section" longer than
    /// three minutes is a whole track, which doesn't need boundary-exact
    /// switching. Longer regions are refused rather than silently given worse
    /// switch behaviour.
    static let maximumSeconds: Double = 180

    enum Invalid: Error, Equatable {
        case tooShort
        case tooLong
        case outsideTrack

        /// Shown to the host, so it says what to do rather than just failing.
        var reason: String {
            switch self {
            case .tooShort:
                "That section is too short to loop — make it at least a quarter of a second."
            case .tooLong:
                "Sections can loop up to three minutes. Trim it, or play the track without a loop."
            case .outsideTrack:
                "That section falls outside the track."
            }
        }
    }

    /// Builds a region from authored seconds, clamped to the track.
    /// Returns the reason on failure so the UI can say why rather than
    /// silently doing nothing.
    static func make(startSeconds: Double,
                     endSeconds: Double,
                     trackDurationSeconds: Double) -> Result<LoopRegion, Invalid> {
        guard trackDurationSeconds > 0 else { return .failure(.outsideTrack) }
        let lower = max(0, min(startSeconds, trackDurationSeconds))
        let upper = max(0, min(endSeconds, trackDurationSeconds))
        guard upper > lower else { return .failure(.tooShort) }

        let span = upper - lower
        if span < minimumSeconds { return .failure(.tooShort) }
        if span > maximumSeconds { return .failure(.tooLong) }

        let start = MusicClock.frames(fromSeconds: lower)
        let length = MusicClock.frames(fromSeconds: upper) - start
        guard length > 0 else { return .failure(.tooShort) }
        return .success(LoopRegion(startFrame: start, lengthFrames: length))
    }
}

// MARK: - Position

/// Where the current content started, in both clocks.
///
/// Replaces the old `scheduledFromFrame + playerTime.sampleTime` formula, which
/// only worked because `player.stop()` zeroed the node's sample clock before
/// every reschedule. A looping buffer is never stopped, so under that formula
/// `sampleTime` would keep accumulating past the loop end and the reported
/// position would run off the end of the region.
///
/// A new anchor is written on exactly five events: play, seek, engaging a
/// section, a hard cut, and observing a queued switch. Nothing else touches it.
struct PlaybackAnchor: Equatable {
    /// Node clock value at the instant this content began.
    let nodeSampleTime: AVAudioFramePosition
    /// Canonical frame within the *track* at that same instant.
    let trackFrame: AVAudioFramePosition
    /// The region being looped, or nil for linear whole-track playback.
    let region: LoopRegion?
}

struct PlaybackPosition: Equatable {
    /// Canonical frame within the track.
    let trackFrame: AVAudioFramePosition
    /// Completed loop passes since the anchor. Always 0 when not looping.
    let iteration: Int
    /// Frames until the region wraps, or nil when not looping.
    let framesToBoundary: AVAudioFramePosition?

    var seconds: Double { MusicClock.seconds(fromFrames: trackFrame) }
}

enum MusicPositionMath {
    /// Resolves the playhead from an anchor and a current node clock reading.
    ///
    /// The modulus is what makes this correct at pass 0 and at pass 7000 alike,
    /// and it needs no per-pass bookkeeping because the wrap happens inside
    /// AVFoundation.
    static func resolve(anchor: PlaybackAnchor,
                        nodeSampleTime: AVAudioFramePosition) -> PlaybackPosition {
        // A clock reading before the anchor means we read across the schedule;
        // clamp rather than report a negative position.
        let elapsed = max(0, nodeSampleTime - anchor.nodeSampleTime)

        guard let region = anchor.region, region.lengthFrames > 0 else {
            return PlaybackPosition(trackFrame: anchor.trackFrame + elapsed,
                                    iteration: 0,
                                    framesToBoundary: nil)
        }

        let iteration = elapsed / region.lengthFrames
        let intoRegion = elapsed % region.lengthFrames
        return PlaybackPosition(trackFrame: region.startFrame + intoRegion,
                                iteration: Int(iteration),
                                framesToBoundary: region.lengthFrames - intoRegion)
    }

    /// The node clock value at which pass `iteration` of the anchored region
    /// ends. Exact arithmetic — a queued switch boundary needs no clock read.
    static func boundaryNodeSampleTime(anchor: PlaybackAnchor,
                                       iteration: Int) -> AVAudioFramePosition? {
        guard let region = anchor.region, region.lengthFrames > 0 else { return nil }
        return anchor.nodeSampleTime + AVAudioFramePosition(iteration + 1) * region.lengthFrames
    }
}

// MARK: - Queued switch commit

/// How a switch between sections is performed. Selectable at performance time,
/// and overridable per press, because which one you want depends on the moment.
enum SectionSwitchMode: String, Codable, CaseIterable, Sendable {
    /// Lands at the loop boundary, so the music stays in time.
    case atLoopEnd
    /// Lands on the next render slice. Genuinely abrupt — a waveform
    /// discontinuity at arbitrary phase. That is what "hard cut" means.
    case hardCut
    /// Lands now, under a short equal-power crossfade.
    case crossfade

    var displayName: String {
        switch self {
        case .atLoopEnd: "At loop end"
        case .hardCut: "Cut"
        case .crossfade: "Crossfade"
        }
    }

    /// Lenient, for the same reason as `LoopMode`: this is persisted inside
    /// `AudioSettings`, and a throw anywhere in that file costs the host their
    /// whole mixer rather than just this setting.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .atLoopEnd
    }
}

enum CommitDecision: Equatable {
    /// Too early — keep the target cancellable and check again next tick.
    case wait
    /// Schedule the interrupting buffer now; it will take over at this boundary.
    case commitNow(boundaryNodeSampleTime: AVAudioFramePosition)
}

enum SwitchCommit {
    /// How close to the boundary we schedule the interrupting buffer.
    ///
    /// Deliberately not "on the button press": there is no unschedule API, so a
    /// scheduled `.interruptsAtLoop` buffer cannot be cancelled or replaced
    /// without `stop()`. Holding the target uncommitted until this window keeps
    /// cancel and change-your-mind available until the last moment, which is
    /// what a performer wants. Missing the window costs one extra loop pass —
    /// never a gap, never a click.
    static let windowSeconds: Double = 0.5

    static var windowFrames: AVAudioFramePosition {
        MusicClock.frames(fromSeconds: windowSeconds)
    }

    /// Decides whether it is time to hand the switch to AVFoundation.
    ///
    /// A region shorter than two windows has no room to wait, so it commits
    /// immediately and lands a pass or two later — stated rather than hidden.
    static func decide(framesToBoundary: AVAudioFramePosition,
                       regionLength: AVAudioFramePosition,
                       nodeSampleTime: AVAudioFramePosition,
                       window: AVAudioFramePosition = windowFrames) -> CommitDecision {
        guard regionLength > 0 else { return .wait }
        let boundary = nodeSampleTime + framesToBoundary
        if regionLength < 2 * window {
            return .commitNow(boundaryNodeSampleTime: boundary)
        }
        return framesToBoundary <= window
            ? .commitNow(boundaryNodeSampleTime: boundary)
            : .wait
    }

    /// Corrects a predicted boundary against the node time actually observed
    /// when the outgoing buffer reported it had finished.
    ///
    /// The prediction can only ever be wrong by whole passes (we know the
    /// region length exactly), so this snaps to the nearest pass rather than
    /// trusting a latency-smeared observation directly.
    static func reconcile(predicted: AVAudioFramePosition,
                          observed: AVAudioFramePosition,
                          regionLength: AVAudioFramePosition,
                          tolerance: AVAudioFramePosition) -> AVAudioFramePosition {
        guard regionLength > 0 else { return predicted }
        let drift = observed - predicted
        if abs(drift) <= tolerance { return predicted }
        let passes = (Double(drift) / Double(regionLength)).rounded()
        return predicted + AVAudioFramePosition(passes) * regionLength
    }
}

// MARK: - Playlist advance vs section loop

/// What should happen when the *track* reaches its end.
///
/// `LoopMode` keeps its exact existing whole-track / whole-playlist meaning;
/// section looping is an orthogonal axis. This function exists so the
/// precedence is written down in one place and nobody later "unifies" the two
/// concepts — while a section loop is engaged the buffer never ends, so track
/// completion cannot fire at all and playlist advance is naturally suspended.
enum TrackEndAction: Equatable {
    case repeatTrack
    case advance
    case stayLooping
}

func advanceDecision(loopMode: LoopMode, hasActiveSectionLoop: Bool) -> TrackEndAction {
    if hasActiveSectionLoop { return .stayLooping }
    switch loopMode {
    case .one: return .repeatTrack
    case .all, .off: return .advance
    }
}

// MARK: - Crossfade curve

enum Crossfade {
    /// Equal-power (constant-energy) gain pair at progress `t` in 0…1.
    ///
    /// Sine/cosine rather than linear so the sum of squares stays at 1 and the
    /// fade doesn't dip in perceived loudness through the middle.
    static func gainPair(at t: Double) -> (outgoing: Float, incoming: Float) {
        let clamped = min(max(t, 0), 1)
        let angle = clamped * .pi / 2
        return (outgoing: Float(cos(angle)), incoming: Float(sin(angle)))
    }
}
