import Foundation
import AVFoundation
import os

/// Generalized auto-ducking: a trigger strip's level pushes target strips'
/// gain down. An envelope follower on a 60Hz utility-queue timer — not AU
/// sidechain routing, which AVAudioEngine doesn't really have; for speech-
/// over-music this is equivalent and much simpler.
///
/// The duck gain COMPOSES with the user fader (effective = user × duck) so
/// moving a fader mid-duck never fights the automation — the graph facade
/// multiplies the two when writing `outputVolume`.
struct DuckerConfig: Codable, Equatable {
    var enabled: Bool = false
    var triggerStrip: MixerStripID = .mic
    var targetStrips: Set<MixerStripID> = [.music]
    /// Trigger level above which ducking engages (dBFS).
    var thresholdDB: Double = -45
    /// How far targets duck, in positive dB of attenuation.
    var amountDB: Double = 12
    var attackMs: Double = 50
    var releaseMs: Double = 800
}

/// Identifies one mixer strip everywhere (UI, settings, ducker).
enum MixerStripID: Codable, Hashable, Comparable {
    case mic
    case pads
    case music
    case movie
    case guest(String)

    var displayName: String {
        switch self {
        case .mic: "Microphone"
        case .pads: "Sound FX"
        case .music: "Music"
        case .movie: "Movie"
        case .guest(let identity): "Guest \(identity.prefix(8))"
        }
    }

    private var sortKey: String {
        switch self {
        case .mic: "0"
        case .pads: "1"
        case .music: "2"
        case .movie: "3"
        case .guest(let id): "4\(id)"
        }
    }

    static func < (lhs: MixerStripID, rhs: MixerStripID) -> Bool {
        lhs.sortKey < rhs.sortKey
    }
}

final class SidechainDucker {
    var config = DuckerConfig() {
        didSet {
            if !config.enabled {
                currentGain = 1
                applyGain?(1, config.targetStrips)
            }
        }
    }

    /// Current trigger level in linear RMS, provided by the graph facade.
    var triggerLevel: (() -> Float)?
    /// Writes the duck gain (0…1 linear) to the target strips (composed with
    /// user faders by the facade).
    var applyGain: ((Float, Set<MixerStripID>) -> Void)?

    private var currentGain: Float = 1
    private var timer: DispatchSourceTimer?

    func start() {
        stop()
        // Tick on the main queue: triggerLevel/applyGain are assigned by the
        // @MainActor AudioEngineController and touch its MainActor-isolated
        // state (graph strips, mic levels, config), so invoking them from a
        // background queue would be a data race (and a strict-concurrency
        // error). 60 Hz of envelope math is negligible on main.
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now(), repeating: 1.0 / 60.0)
        t.setEventHandler { [weak self] in
            self?.tick()
        }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        guard config.enabled,
              let level = triggerLevel?(),
              let applyGain else { return }

        let levelDB = 20 * log10(Double(max(level, 1e-6)))
        let target: Float = levelDB > config.thresholdDB
            ? Float(pow(10.0, -abs(config.amountDB) / 20.0))   // ducked
            : 1.0                                        // resting

        // One-pole smoothing with separate attack (down) and release (up)
        // time constants at 60Hz tick rate.
        let dt = 1.0 / 60.0
        let tau = target < currentGain ? config.attackMs / 1000 : config.releaseMs / 1000
        let alpha = Float(1 - exp(-dt / max(tau, 0.001)))
        currentGain += (target - currentGain) * alpha

        applyGain(currentGain, config.targetStrips)
    }
}
