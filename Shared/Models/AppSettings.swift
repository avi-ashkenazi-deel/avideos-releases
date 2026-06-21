import Foundation
import Combine
import SwiftUI

/// How the app picks its light/dark appearance.
enum AppearanceMode: String, Codable, CaseIterable, Identifiable, Sendable {
    /// Follow the system setting — dark when the phone is in dark mode.
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    /// `nil` means "follow the system"; otherwise force the scheme.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// What the player does when it reaches an image while reading.
enum ImageBehavior: String, Codable, CaseIterable, Identifiable, Sendable {
    /// Stop on the image so the listener can look at it, then continue on Play.
    case pauseAndDigest
    /// Say "there's an image" and keep reading.
    case announceAndContinue
    /// Don't mention images at all — keep them on screen and read straight past.
    case skipSilently

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pauseAndDigest: return "Pause on images"
        case .announceAndContinue: return "Announce and continue"
        case .skipSilently: return "Skip images silently"
        }
    }

    var detail: String {
        switch self {
        case .pauseAndDigest:
            return "Stop when an image appears so you can look at it. Press play to continue."
        case .announceAndContinue:
            return "Just say there's an image and keep reading."
        case .skipSilently:
            return "Don't announce images — keep them on screen and read straight through."
        }
    }
}

/// Reading-view text size for the transcript, set globally in Settings.
enum ReadingTextSize: String, Codable, CaseIterable, Identifiable, Sendable {
    case small, medium, large, extraLarge

    var id: String { rawValue }

    var title: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        case .extraLarge: return "Extra Large"
        }
    }

    /// Point size for the body sentences.
    var bodyPointSize: CGFloat {
        switch self {
        case .small: return 18
        case .medium: return 22
        case .large: return 26
        case .extraLarge: return 31
        }
    }

    /// Point size for the subject heading.
    var titlePointSize: CGFloat { bodyPointSize + 6 }
}

/// User-tunable playback preferences, persisted in the shared app-group
/// defaults so the phone and watch stay in sync.
final class AppSettings: ObservableObject {

    static let shared = AppSettings()

    /// AVSpeechUtterance rate is 0.0...1.0 with a "normal" of ~0.5. We expose a
    /// friendlier 0.5x...2.5x multiplier on top of that. This is the default used
    /// for any language without its own override.
    @Published var speed: Double {
        didSet { defaults.set(speed, forKey: Key.speed) }
    }

    /// Per-language speed overrides (BCP-47 base code, e.g. "es", → multiplier).
    /// Some voices read certain languages less clearly, so the listener can set a
    /// slower/faster speed just for those; everything else uses `speed`.
    @Published var languageSpeeds: [String: Double] {
        didSet { defaults.set(languageSpeeds, forKey: Key.languageSpeeds) }
    }

    /// The speed to read a given language at: its override if set, else the default.
    func effectiveSpeed(forLanguageCode code: String?) -> Double {
        if let code, let s = languageSpeeds[code] { return Self.clampSpeed(s) }
        return speed
    }

    /// Adjust the speed for what's playing: if the current language already has an
    /// override (added in Settings), update that; otherwise change the default.
    /// New per-language overrides are created explicitly via `addLanguageSpeed`.
    func setSpeed(_ value: Double, forLanguageCode code: String?) {
        let v = Self.clampSpeed(value)
        if let code, languageSpeeds[code] != nil {
            languageSpeeds[code] = v
        } else {
            speed = v
        }
    }

    /// Start tracking a language's speed at the current default (shown in Settings).
    func addLanguageSpeed(_ code: String) {
        guard languageSpeeds[code] == nil else { return }
        languageSpeeds[code] = speed
    }

    func removeLanguageSpeed(_ code: String) {
        languageSpeeds[code] = nil
    }

    /// When an email finishes, automatically open the next unread one, announce
    /// its sender and subject, and keep reading.
    @Published var autoAdvance: Bool {
        didSet { defaults.set(autoAdvance, forKey: Key.autoAdvance) }
    }

    /// Which Gmail label/folder to listen to (default the whole inbox).
    @Published var mailLabelId: String {
        didSet { defaults.set(mailLabelId, forKey: Key.mailLabelId) }
    }

    /// Display name of the chosen label, so the UI can show it without a fetch.
    @Published var mailLabelName: String {
        didSet { defaults.set(mailLabelName, forKey: Key.mailLabelName) }
    }

    @Published var imageBehavior: ImageBehavior {
        didSet { defaults.set(imageBehavior.rawValue, forKey: Key.imageBehavior) }
    }

    /// Text size for the email/article reading view.
    @Published var readingTextSize: ReadingTextSize {
        didSet { defaults.set(readingTextSize.rawValue, forKey: Key.readingTextSize) }
    }

    /// Light / dark / follow-the-system appearance for the whole app.
    @Published var appearance: AppearanceMode {
        didSet { defaults.set(appearance.rawValue, forKey: Key.appearance) }
    }

    /// Keep the screen on while the reading view is open and playing — treat it
    /// like watching a video, so it doesn't auto-lock mid-email.
    @Published var keepScreenAwake: Bool {
        didSet { defaults.set(keepScreenAwake, forKey: Key.keepScreenAwake) }
    }

    /// Float a Picture-in-Picture window (what's being read) when you leave the
    /// app mid-email, like a video player.
    @Published var pictureInPicture: Bool {
        didSet { defaults.set(pictureInPicture, forKey: Key.pictureInPicture) }
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
        static let languageSpeeds = "settings.languageSpeeds"
        static let autoAdvance = "settings.autoAdvance"
        static let mailLabelId = "settings.mailLabelId"
        static let mailLabelName = "settings.mailLabelName"
        static let imageBehavior = "settings.imageBehavior"
        static let readingTextSize = "settings.readingTextSize"
        static let appearance = "settings.appearance"
        static let keepScreenAwake = "settings.keepScreenAwake"
        static let pictureInPicture = "settings.pictureInPicture"
        static let voiceIdentifier = "settings.voiceIdentifier"
        static let airPodsHighlight = "settings.airPodsHighlight"
        static let useElevenLabs = "settings.useElevenLabs"
        static let elevenLabsVoiceID = "settings.elevenLabsVoiceID"
        static let elevenLabsVoiceName = "settings.elevenLabsVoiceName"
    }

    init(defaults: UserDefaults = .voiceInbox) {
        self.defaults = defaults
        self.speed = defaults.object(forKey: Key.speed) as? Double ?? 1.0
        self.languageSpeeds = (defaults.dictionary(forKey: Key.languageSpeeds) as? [String: Double]) ?? [:]
        self.autoAdvance = defaults.object(forKey: Key.autoAdvance) as? Bool ?? false
        self.mailLabelId = defaults.string(forKey: Key.mailLabelId) ?? "INBOX"
        self.mailLabelName = defaults.string(forKey: Key.mailLabelName) ?? "Inbox"
        self.imageBehavior = ImageBehavior(rawValue: defaults.string(forKey: Key.imageBehavior) ?? "")
            ?? .pauseAndDigest
        self.readingTextSize = ReadingTextSize(rawValue: defaults.string(forKey: Key.readingTextSize) ?? "")
            ?? .medium
        self.appearance = AppearanceMode(rawValue: defaults.string(forKey: Key.appearance) ?? "")
            ?? .system
        // Default on: while you're watching it read, keep the screen awake.
        self.keepScreenAwake = defaults.object(forKey: Key.keepScreenAwake) as? Bool ?? true
        // Default off: PiP is opt-in.
        self.pictureInPicture = defaults.object(forKey: Key.pictureInPicture) as? Bool ?? false
        self.voiceIdentifier = defaults.string(forKey: Key.voiceIdentifier) ?? ""
        // Default off so the next button skips a sentence (expected). Turn on to
        // make an AirPods/lock-screen next-press capture a highlight + voice note.
        self.airPodsHighlightEnabled = defaults.object(forKey: Key.airPodsHighlight) as? Bool ?? false
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
