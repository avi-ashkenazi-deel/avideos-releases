import Foundation
import os

/// Which canvas a destination receives.
enum StreamOrientation: String, Codable, CaseIterable, Sendable {
    case horizontal
    case vertical

    var displayName: String {
        switch self {
        case .horizontal: "Horizontal (16:9)"
        case .vertical: "Vertical (9:16)"
        }
    }

    var shortName: String {
        switch self {
        case .horizontal: "H"
        case .vertical: "V"
        }
    }
}

/// Encode quality. One encoder exists per (orientation, tier) in use, so
/// destinations that agree on a tier share an encode.
enum StreamQualityTier: String, Codable, CaseIterable, Sendable {
    case p720 = "720p"
    case p1080 = "1080p"
    case p1080High = "1080p-high"

    var displayName: String {
        switch self {
        case .p720: "720p · 4 Mbps"
        case .p1080: "1080p · 6 Mbps"
        case .p1080High: "1080p · 9 Mbps (YouTube)"
        }
    }

    /// The short side of the frame (height for horizontal, width for
    /// vertical).
    var shortSide: Int {
        switch self {
        case .p720: 720
        case .p1080, .p1080High: 1080
        }
    }

    var bitsPerSecond: Int {
        switch self {
        case .p720: 4_000_000
        case .p1080: 6_000_000
        case .p1080High: 9_000_000
        }
    }

    /// Frame size for a canvas of the given aspect (width / height), even
    /// dimensions as H.264 requires.
    func frameSize(canvasAspect aspect: Double) -> (width: Int, height: Int) {
        let short = Double(shortSide)
        func even(_ value: Double) -> Int { max(2, Int((value / 2).rounded()) * 2) }
        if aspect >= 1 {
            return (even(short * aspect), even(short))
        } else {
            return (even(short), even(short / max(aspect, 0.01)))
        }
    }
}

/// The platforms with presets. Every one streams over RTMP(S) by URL + key;
/// the preset only pre-fills the server and explains where the key lives.
enum StreamPlatform: String, Codable, CaseIterable, Sendable {
    case youtube
    case linkedin
    case x
    case twitch
    case instagram
    case tiktok
    case custom

    var displayName: String {
        switch self {
        case .youtube: "YouTube"
        case .linkedin: "LinkedIn"
        case .x: "X"
        case .twitch: "Twitch"
        case .instagram: "Instagram"
        case .tiktok: "TikTok"
        case .custom: "Custom RTMP"
        }
    }

    var symbol: String {
        switch self {
        case .youtube: "play.rectangle.fill"
        case .linkedin: "person.crop.square.fill"
        case .x: "xmark.square.fill"
        case .twitch: "gamecontroller.fill"
        case .instagram: "camera.fill"
        case .tiktok: "music.note"
        case .custom: "antenna.radiowaves.left.and.right"
        }
    }

    /// Brand-ish tint for badges.
    var tintHex: String {
        switch self {
        case .youtube: "#FF0033"
        case .linkedin: "#0A66C2"
        case .x: "#E7E9EA"
        case .twitch: "#9146FF"
        case .instagram: "#E1306C"
        case .tiktok: "#25F4EE"
        case .custom: "#8E8E93"
        }
    }

    /// Fixed ingest, where the platform has one. The rest hand out a
    /// per-event server URL alongside the key.
    var defaultServerURL: String {
        switch self {
        case .youtube: "rtmp://a.rtmp.youtube.com/live2"
        case .twitch: "rtmp://live.twitch.tv/app"
        default: ""
        }
    }

    var defaultOrientation: StreamOrientation {
        switch self {
        case .instagram, .tiktok: .vertical
        default: .horizontal
        }
    }

    var defaultTier: StreamQualityTier {
        switch self {
        case .instagram, .tiktok: .p720
        default: .p1080
        }
    }

    /// Where to find the URL + key, in one line for the settings form.
    var keyHelp: String {
        switch self {
        case .youtube:
            "YouTube Studio → Create → Go live → Stream. Copy the stream key (the server is pre-filled)."
        case .linkedin:
            "Create a LinkedIn Live event and pick “Stream with a custom stream key”. Copy both the Stream URL and the key. Your account must be Live-eligible."
        case .x:
            "X Media Studio → Producer → Sources: create a source, then copy its RTMP URL and key. Requires an eligible account."
        case .twitch:
            "Twitch Creator Dashboard → Settings → Stream → Primary Stream Key. Add your channel name below to read chat."
        case .instagram:
            "Instagram (web, professional account) → Create → Live video → copy the Stream URL and key. Vertical only."
        case .tiktok:
            "TikTok LIVE Center / LIVE Studio → stream key (LIVE-eligible accounts). Copy the server URL and key. Vertical."
        case .custom:
            "Any RTMP or RTMPS server: Restream, Kick, your own. Paste its server URL and key."
        }
    }

    /// Whether the app can read this platform's live comments in v1, and if
    /// not, the plain reason the Comments window shows.
    var commentsUnavailableReason: String? {
        switch self {
        case .youtube: nil
        case .twitch: nil
        case .linkedin: "LinkedIn only offers live comments to approved partner apps."
        case .x: "Reading X replies needs a paid X API plan."
        case .instagram: "Instagram live comments need a Meta-reviewed app."
        case .tiktok: "TikTok has no public live-comments API."
        case .custom: "A custom server has no comments to read."
        }
    }
}

/// One place to send the show. Persisted as JSON (no secrets); the stream
/// key lives in the Keychain under the destination's id.
///
/// New fields MUST be Optional: synthesized Decodable throws keyNotFound for
/// a missing non-optional even with a default, and the store would fall back
/// to an empty list.
struct StreamDestination: Codable, Identifiable, Hashable, Sendable {
    var id: UUID
    var name: String
    var platform: StreamPlatform
    var orientation: StreamOrientation
    var tier: StreamQualityTier
    var serverURL: String
    /// Ticked by default in the Go Live sheet.
    var isEnabled: Bool
    /// Twitch: the channel whose chat to read (comments only — no login).
    var twitchChannel: String?
    /// YouTube: create the broadcast through the connected account instead
    /// of using a pasted key (and read its live chat).
    var usesLinkedYouTubeAccount: Bool?
    /// YouTube account mode: broadcast title / privacy.
    var broadcastTitle: String?
    var broadcastPrivacy: String?

    init(platform: StreamPlatform, name: String? = nil) {
        self.id = UUID()
        self.name = name ?? platform.displayName
        self.platform = platform
        self.orientation = platform.defaultOrientation
        self.tier = platform.defaultTier
        self.serverURL = platform.defaultServerURL
        self.isEnabled = true
    }

    var linkedYouTube: Bool { platform == .youtube && (usesLinkedYouTubeAccount ?? false) }

    // MARK: Stream key (Keychain)

    static let keychainService = "com.aviashkenazi.streamit.streamkey"

    private var keychain: KeychainStore {
        KeychainStore(service: Self.keychainService, account: id.uuidString)
    }

    var streamKey: String? {
        guard let key = try? keychain.readString(), !key.isEmpty else { return nil }
        return key
    }

    func saveStreamKey(_ key: String) {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            try? keychain.delete()
        } else {
            try? keychain.writeString(trimmed)
        }
    }

    func deleteStreamKey() {
        try? keychain.delete()
    }

    /// Why this destination can't go live yet, or nil when it can.
    var configurationProblem: String? {
        if linkedYouTube { return nil }   // URL + key come from the API at go-live
        if serverURL.trimmingCharacters(in: .whitespaces).isEmpty {
            return "Add the server URL."
        }
        do {
            _ = try StreamURL.parse(server: serverURL, key: streamKey ?? "")
            return nil
        } catch StreamURL.ParseError.missingKey {
            return "Add the stream key."
        } catch StreamURL.ParseError.missingApp where streamKey == nil {
            return "Add the stream key."
        } catch {
            return "The server URL should look like rtmp://host/app or rtmps://host/app."
        }
    }
}

/// Destinations on disk: Application Support/streamit/streaming-destinations.json,
/// the same folder and quarantine-on-corruption policy as the audio settings.
struct StreamDestinationStore {
    private let url: URL
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "destinations")

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent("streamit", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("streaming-destinations.json")
    }

    func load() -> [StreamDestination] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONDecoder().decode([StreamDestination].self, from: data)
        } catch {
            log.error("streaming-destinations.json unreadable: \(error.localizedDescription, privacy: .public)")
            let backup = url.deletingLastPathComponent()
                .appendingPathComponent("streaming-destinations-corrupt-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: url, to: backup)
            return []
        }
    }

    func save(_ destinations: [StreamDestination]) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(destinations) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
