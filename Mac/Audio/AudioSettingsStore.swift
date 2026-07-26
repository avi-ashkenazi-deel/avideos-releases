import Foundation

/// Persisted audio state: devices by UID (never AudioDeviceID — those change
/// per boot), strip gains, ducker, insert chains, pads, playlist.
struct AudioSettings: Codable {
    var monitorDeviceUID: String?
    var micDeviceUID: String?
    var voiceProcessingEnabled: Bool = false
    var monitorMuted: Bool = false

    var stripVolumes: [String: Float] = [:]     // StripID JSON key → volume
    var stripMutes: [String: Bool] = [:]
    var duckerConfig = DuckerConfig()
    var insertChains: [String: [InsertEffect]] = [:]

    var pads: [SoundPad] = []
    var playlist: [MusicTrack] = []
    var loopMode: LoopMode = .off

    /// JSON-safe StripID key (guest strips aren't persisted — session-scoped).
    static func key(for strip: MixerStripID) -> String {
        switch strip {
        case .mic: "mic"
        case .pads: "pads"
        case .music: "music"
        case .movie: "movie"
        case .guest(let identity): "guest:\(identity)"
        }
    }
}

final class AudioSettingsStore {
    private let url: URL
    private var pendingSave: DispatchWorkItem?
    private let queue = DispatchQueue(label: "com.aviashkenazi.avideos.audiosettings", qos: .utility)

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("AVideos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("audio-settings.json")
    }

    func load() -> AudioSettings {
        guard let data = try? Data(contentsOf: url),
              let settings = try? JSONDecoder().decode(AudioSettings.self, from: data) else {
            return AudioSettings()
        }
        return settings
    }

    func saveDebounced(_ settings: AudioSettings, delay: TimeInterval = 0.5) {
        pendingSave?.cancel()
        let work = DispatchWorkItem { [url] in
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            if let data = try? encoder.encode(settings) {
                try? data.write(to: url, options: .atomic)
            }
        }
        pendingSave = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
