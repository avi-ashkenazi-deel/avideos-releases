import Foundation
import os

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
    /// How a live section switch behaves. Global rather than per-track: it
    /// describes how the host performs, not a property of the music. Per-track
    /// storage would silently change the segmented control when the track
    /// changed — a hard cut when you wanted a bar-aligned one, mid-show.
    ///
    /// Optional for the same decode reason as `MusicTrack`'s new fields.
    var sectionSwitchMode: SectionSwitchMode?

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
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "audiosettings")

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("AVideos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("audio-settings.json")
    }

    func load() -> AudioSettings {
        guard let data = try? Data(contentsOf: url) else { return AudioSettings() }
        do {
            return try JSONDecoder().decode(AudioSettings.self, from: data)
        } catch {
            // Returning defaults here means the next debounced save — 0.5s
            // later — overwrites the file, so the host's devices, faders,
            // ducker, insert chains, pads and playlist are gone with no way
            // back. Quarantine the original first so the loss is recoverable
            // and diagnosable, and say so in the log rather than failing mute.
            log.error("audio-settings.json could not be decoded: \(error.localizedDescription, privacy: .public)")
            quarantineCorruptFile()
            return AudioSettings()
        }
    }

    private func quarantineCorruptFile() {
        let stamp = Int(Date().timeIntervalSince1970)
        let backup = url.deletingLastPathComponent()
            .appendingPathComponent("audio-settings-corrupt-\(stamp).json")
        do {
            try FileManager.default.moveItem(at: url, to: backup)
            log.notice("moved the unreadable settings aside to \(backup.lastPathComponent, privacy: .public)")
        } catch {
            log.error("couldn't quarantine the unreadable settings: \(error.localizedDescription, privacy: .public)")
        }
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
