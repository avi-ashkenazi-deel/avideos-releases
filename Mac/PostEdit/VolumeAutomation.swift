import Foundation
import AVFoundation

/// How much the conversation dips under an external clip's own audio.
struct DuckSettings: Codable, Sendable, Equatable {
    /// Positive attenuation applied to the conversation, in dB.
    var amountDB: Double
    /// Seconds. The ramp *ends* at the clip start, so the conversation is
    /// already down when the audio arrives — an anticipatory duck, which is
    /// precisely what the live envelope follower cannot do because it can't
    /// see the boundary coming.
    var attack: Double
    var release: Double

    /// 12 dB matches `DuckerConfig.amountDB`, so the app ducks by the same
    /// amount live and offline. Attack and release deliberately differ from the
    /// live 50/800 ms, for the reason above.
    static let standard = DuckSettings(amountDB: 12, attack: 0.15, release: 0.4)
}

/// Audio settings for a piece of external media laid over the conversation.
struct ExternalAudio: Codable, Sendable, Equatable {
    var isEnabled: Bool
    var gainDB: Double
    /// nil ⇒ play it without touching the conversation.
    var ducking: DuckSettings?

    static let silent = ExternalAudio(isEnabled: false, gainDB: 0, ducking: nil)

    /// Mirrors `TrackMix.linearGain` so the two read the same way.
    var linearGain: Float {
        isEnabled ? Float(pow(10, gainDB / 20)) : 0
    }
}

/// Builds a single volume envelope per track, then emits it as non-overlapping
/// ramps.
///
/// This exists because the two things that want to move a track's volume —
/// the 15 ms micro-fades at every cut, and a duck lasting hundreds of
/// milliseconds — *will* overlap in time. Overlapping `setVolumeRamp` ranges on
/// one `AVMutableAudioMixInputParameters` are not a defined composition, so
/// building them independently produces intermittent, silent wrongness.
/// Combining first and emitting once makes that impossible by construction.
enum VolumeAutomation {

    struct Point: Equatable {
        var time: Double
        var volume: Float
    }

    /// A span during which the conversation should duck, in composition time.
    struct DuckWindow: Equatable {
        var start: Double
        var end: Double
        var settings: DuckSettings
    }

    /// Piecewise-linear envelope: strictly increasing in time, no duplicates.
    ///
    /// - `base`: the track's own level, after gain and mute/solo. Every
    ///   breakpoint is a multiple of it, which is what makes a muted track stay
    ///   silent — ducking can only ever attenuate further, never restore.
    /// - `joins`: cut boundaries, each getting the existing notch.
    static func envelope(base: Float,
                         joins: [Double],
                         ducks: [DuckWindow],
                         crossfadeDuration: Double,
                         duration: Double) -> [Point] {
        guard base > 0 else { return [Point(time: 0, volume: 0)] }

        var candidates: [Double] = [0]
        let half = crossfadeDuration / 2

        for join in joins {
            candidates.append(contentsOf: [max(0, join - half), join, join + half])
        }
        for window in merged(ducks) {
            candidates.append(contentsOf: [
                max(0, window.start - window.settings.attack),
                window.start, window.end,
                window.end + window.settings.release,
            ])
        }
        candidates.append(duration)

        let times = Array(Set(candidates.map { min(max($0, 0), duration) })).sorted()
        return times.map { time in
            Point(time: time,
                  volume: level(at: time, base: base, joins: joins,
                                ducks: merged(ducks), half: half))
        }
    }

    /// Pointwise minimum of every curve in force: deepest attenuation wins.
    ///
    /// That is the standard mixing convention, and it is what makes the two
    /// compose instead of fight — a cut notch inside a duck survives, because
    /// it can only go quieter, and so does a duck inside a notch.
    private static func level(at time: Double,
                              base: Float,
                              joins: [Double],
                              ducks: [DuckWindow],
                              half: Double) -> Float {
        var value = base

        for join in joins {
            let distance = abs(time - join)
            guard distance < half, half > 0 else { continue }
            // Linear V down to silence exactly at the join.
            value = min(value, base * Float(distance / half))
        }

        for window in ducks {
            let ducked = base * Float(pow(10, -window.settings.amountDB / 20))
            if time >= window.start, time <= window.end {
                value = min(value, ducked)
            } else if time < window.start, time >= window.start - window.settings.attack,
                      window.settings.attack > 0 {
                let progress = (time - (window.start - window.settings.attack)) / window.settings.attack
                value = min(value, base + (ducked - base) * Float(progress))
            } else if time > window.end, time <= window.end + window.settings.release,
                      window.settings.release > 0 {
                let progress = (time - window.end) / window.settings.release
                value = min(value, ducked + (base - ducked) * Float(progress))
            }
        }
        return value
    }

    /// Merges windows whose gap is shorter than the release plus the next
    /// attack — otherwise two cutaways a couple of hundred milliseconds apart
    /// make the conversation pump up and back down between them.
    static func merged(_ windows: [DuckWindow]) -> [DuckWindow] {
        let sorted = windows.sorted { $0.start < $1.start }
        var result: [DuckWindow] = []
        for window in sorted {
            guard var last = result.last else {
                result.append(window)
                continue
            }
            let gap = window.start - last.end
            if gap <= last.settings.release + window.settings.attack {
                last.end = max(last.end, window.end)
                result[result.count - 1] = last
            } else {
                result.append(window)
            }
        }
        return result
    }

    /// Multiplies an envelope by a fade-from/to-silence at a span's edges —
    /// how the music bed enters and leaves. Pointwise multiplication keeps
    /// every duck in the envelope intact; new breakpoints are interpolated at
    /// the fade corners so the ramps stay piecewise-linear.
    static func fadedAtEdges(_ points: [Point],
                             spanStart: Double,
                             spanEnd: Double,
                             fade: Double) -> [Point] {
        guard fade > 0, spanEnd > spanStart else { return points }
        let fadeInEnd = min(spanStart + fade, spanEnd)
        let fadeOutStart = max(spanEnd - fade, spanStart)

        func value(at time: Double) -> Float {
            // Linear interpolation over the existing envelope.
            guard let first = points.first else { return 0 }
            if time <= first.time { return first.volume }
            for (a, b) in zip(points, points.dropFirst()) where time <= b.time {
                guard b.time > a.time else { continue }
                let f = Float((time - a.time) / (b.time - a.time))
                return a.volume + (b.volume - a.volume) * f
            }
            return points.last?.volume ?? 0
        }

        func factor(at time: Double) -> Float {
            if time <= spanStart || time >= spanEnd { return 0 }
            let inF = fade > 0 ? (time - spanStart) / fade : 1
            let outF = fade > 0 ? (spanEnd - time) / fade : 1
            return Float(min(1, max(0, min(inF, outF))))
        }

        var times = Set(points.map(\.time))
        times.formUnion([spanStart, fadeInEnd, fadeOutStart, spanEnd])
        return times.sorted().map { Point(time: $0, volume: value(at: $0) * factor(at: $0)) }
    }

    /// Emits the envelope as ramps. Non-overlapping by construction, because
    /// every ramp spans one gap between consecutive breakpoints.
    static func apply(_ points: [Point],
                      to parameters: AVMutableAudioMixInputParameters,
                      timescale: CMTimeScale) {
        guard let first = points.first else { return }
        parameters.setVolume(first.volume, at: .zero)

        for (previous, next) in zip(points, points.dropFirst()) {
            guard next.time > previous.time else { continue }
            parameters.setVolumeRamp(
                fromStartVolume: previous.volume,
                toEndVolume: next.volume,
                timeRange: CMTimeRange(
                    start: CMTime(seconds: previous.time, preferredTimescale: timescale),
                    end: CMTime(seconds: next.time, preferredTimescale: timescale)))
        }
    }
}
