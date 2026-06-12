import Foundation

/// The master output channel for *all* announcements — the quick context switch
/// between the gym (speak everything) and a conference talk (silent, vibrate
/// only). It overrides each milestone's own voice/haptic choice at fire time:
///
/// - `.both`        — honor each milestone's configured `AlertStyle`.
/// - `.voiceOnly`   — speak every milestone & the countdown; never vibrate.
/// - `.vibrationOnly` — vibrate every milestone & the countdown; never speak.
///
/// Per-milestone settings still matter within `.both` (and the *haptic pattern*
/// and *spoken label* always matter), but the mode is the one-tap override you
/// reach for when you walk on stage.
enum OutputMode: String, Codable, CaseIterable, Identifiable {
    case both
    case voiceOnly = "voice"
    case vibrationOnly = "vibration"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .both: return "Both"
        case .voiceOnly: return "Voice"
        case .vibrationOnly: return "Vibrate"
        }
    }

    var systemImage: String {
        switch self {
        case .both: return "speaker.wave.2.bubble.left.fill"
        case .voiceOnly: return "speaker.wave.2.fill"
        case .vibrationOnly: return "waveform"
        }
    }

    /// Whether a milestone should speak / vibrate, given its own alert style.
    /// In `.both` we defer to the milestone; otherwise the mode forces a single
    /// channel for *every* milestone (so a voice-only marker still buzzes in
    /// vibrate mode, and a haptic-only marker still speaks in voice mode — you
    /// never silently miss one).
    func channels(forMilestoneAlert alert: AlertStyle) -> (voice: Bool, haptic: Bool) {
        switch self {
        case .both: return (alert.includesVoice, alert.includesHaptic)
        case .voiceOnly: return (true, false)
        case .vibrationOnly: return (false, true)
        }
    }

    /// Whether the final countdown should speak each second / buzz each second.
    /// `hapticEnabled` is the preset's own "buzz each second" toggle, honored in
    /// `.both`.
    func countdownChannels(hapticEnabled: Bool) -> (speak: Bool, buzz: Bool) {
        switch self {
        case .both: return (true, hapticEnabled)
        case .voiceOnly: return (true, false)
        case .vibrationOnly: return (false, true)
        }
    }

    /// Start / completion cues speak unless we're in silent vibrate mode.
    var speaksAnnouncements: Bool { self != .vibrationOnly }
}
