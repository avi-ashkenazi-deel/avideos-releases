import Foundation
import Combine

/// What the player does when it reaches an image while reading.
enum ImageBehavior: String, Codable, CaseIterable, Identifiable, Sendable {
    /// Stop on the image so the listener can look at it, then continue on Play.
    case pauseAndDigest
    /// Say "there's an image" and keep reading.
    case announceAndContinue

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pauseAndDigest: return "Pause on images"
        case .announceAndContinue: return "Announce and continue"
        }
    }

    var detail: String {
        switch self {
        case .pauseAndDigest:
            return "Stop when an image appears so you can look at it. Press play to continue."
        case .announceAndContinue:
            return "Just say there's an image and keep reading."
        }
    }
}

/// User-tunable playback preferences, persisted in the shared app-group
/// defaults so the phone and watch stay in sync.
final class AppSettings: ObservableObject {

    static let shared = AppSettings()

    /// AVSpeechUtterance rate is 0.0...1.0 with a "normal" of ~0.5. We expose a
    /// friendlier 0.5x...2.5x multiplier on top of that.
    @Published var speed: Double {
        didSet { defaults.set(speed, forKey: Key.speed) }
    }

    /// When an email finishes, automatically open the next unread one, announce
    /// its sender and subject, and keep reading.
    @Published var autoAdvance: Bool {
        didSet { defaults.set(autoAdvance, forKey: Key.autoAdvance) }
    }

    @Published var imageBehavior: ImageBehavior {
        didSet { defaults.set(imageBehavior.rawValue, forKey: Key.imageBehavior) }
    }

    /// Identifier of the preferred `AVSpeechSynthesisVoice`; empty = system default.
    @Published var voiceIdentifier: String {
        didSet { defaults.set(voiceIdentifier, forKey: Key.voiceIdentifier) }
    }

    /// Whether an AirPods press should capture a highlight (vs. play/pause).
    @Published var airPodsHighlightEnabled: Bool {
        didSet { defaults.set(airPodsHighlightEnabled, forKey: Key.airPodsHighlight) }
    }

    // MARK: ElevenLabs

    /// Use ElevenLabs cloud voices instead of the on-device system voice.
    @Published var useElevenLabs: Bool {
        didSet { defaults.set(useElevenLabs, forKey: Key.useElevenLabs) }
    }

    @Published var elevenLabsAPIKey: String {
        didSet { KeychainStore.set(elevenLabsAPIKey, account: KeychainStore.Account.elevenLabsAPIKey) }
    }

    @Published var elevenLabsVoiceID: String {
        didSet { defaults.set(elevenLabsVoiceID, forKey: Key.elevenLabsVoiceID) }
    }

    /// Display name for the chosen voice (so settings can show it without a fetch).
    @Published var elevenLabsVoiceName: String {
        didSet { defaults.set(elevenLabsVoiceName, forKey: Key.elevenLabsVoiceName) }
    }

    /// True only when ElevenLabs is enabled *and* usable (key + voice present).
    var elevenLabsActive: Bool {
        useElevenLabs && !elevenLabsAPIKey.isEmpty && !elevenLabsVoiceID.isEmpty
    }

    private let defaults: UserDefaults

    private enum Key {
        static let speed = "settings.speed"
        static let autoAdvance = "settings.autoAdvance"
        static let imageBehavior = "settings.imageBehavior"
        static let voiceIdentifier = "settings.voiceIdentifier"
        static let airPodsHighlight = "settings.airPodsHighlight"
        static let useElevenLabs = "settings.useElevenLabs"
        static let elevenLabsVoiceID = "settings.elevenLabsVoiceID"
        static let elevenLabsVoiceName = "settings.elevenLabsVoiceName"
    }

    init(defaults: UserDefaults = .voiceInbox) {
        self.defaults = defaults
        self.speed = defaults.object(forKey: Key.speed) as? Double ?? 1.0
        self.autoAdvance = defaults.object(forKey: Key.autoAdvance) as? Bool ?? false
        self.imageBehavior = ImageBehavior(rawValue: defaults.string(forKey: Key.imageBehavior) ?? "")
            ?? .pauseAndDigest
        self.voiceIdentifier = defaults.string(forKey: Key.voiceIdentifier) ?? ""
        self.airPodsHighlightEnabled = defaults.object(forKey: Key.airPodsHighlight) as? Bool ?? true
        self.useElevenLabs = defaults.object(forKey: Key.useElevenLabs) as? Bool ?? false
        self.elevenLabsAPIKey = KeychainStore.get(account: KeychainStore.Account.elevenLabsAPIKey) ?? ""
        self.elevenLabsVoiceID = defaults.string(forKey: Key.elevenLabsVoiceID) ?? ""
        self.elevenLabsVoiceName = defaults.string(forKey: Key.elevenLabsVoiceName) ?? ""
    }

    /// Clamp a friendly multiplier into the supported range.
    static func clampSpeed(_ value: Double) -> Double {
        min(max(value, 0.5), 2.5)
    }
}

extension UserDefaults {
    /// Shared defaults backed by the app group so phone + watch agree on settings.
    /// Falls back to `.standard` if the app group isn't configured (e.g. in previews).
    static let voiceInbox: UserDefaults = {
        AppGroup.sharedDefaults
    }()
}
