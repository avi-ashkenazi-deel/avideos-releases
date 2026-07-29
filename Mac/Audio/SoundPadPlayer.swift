import Foundation
import AVFoundation
import os

/// One soundboard pad: name, color, source file (bookmark), optional hotkey.
struct SoundPad: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var colorHex: String
    var bookmark: Data?
    var path: String
    var hotkeyIndex: Int?
    /// In/out points in seconds; nil = full file. Optional on purpose:
    /// AudioSettingsStore.load() swallows decode errors and returns blank
    /// settings, so a non-optional field here would silently wipe the user's
    /// whole audio configuration when an old settings file is read.
    var trimStart: Double?
    var trimEnd: Double?
    /// User folder in the sound-effects list ("FX", "Beds"…); nil = top
    /// level. Same Optional-for-decode-compat rule as the trim fields.
    var folder: String?

    init(url: URL, hotkeyIndex: Int? = nil) {
        self.id = UUID()
        self.name = url.deletingPathExtension().lastPathComponent
        self.colorHex = Self.palette[abs(url.lastPathComponent.hashValue) % Self.palette.count]
        self.bookmark = try? url.bookmarkData(options: [.withSecurityScope])
        self.path = url.path
        self.hotkeyIndex = hotkeyIndex
    }

    func resolve() -> URL? {
        if let bookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope],
                                  relativeTo: nil, bookmarkDataIsStale: &stale) {
                return url
            }
        }
        let url = URL(fileURLWithPath: path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Shared with music sections so the two performance surfaces match.
    /// Same array, same order — the hash-derived colours above must not move.
    static let palette = AudioPalette.colors
}

/// Soundboard playback: samples are fully pre-decoded to canonical-format
/// PCM buffers at add time so pads fire in <10ms — one-shots are never
/// streamed. A pool of player nodes on the pads strip; retrigger steals the
/// oldest voice.
final class SoundPadPlayer {
    private struct Voice {
        let node: AVAudioPlayerNode
        var startedAt: Date = .distantPast
        var padID: UUID?
    }

    private weak var engine: AVAudioEngine?
    private weak var padsMixer: AVAudioMixerNode?
    private var voices: [Voice] = []
    private var buffers: [UUID: AVAudioPCMBuffer] = [:]
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "pads")

    /// Playback progress per pad (0…1), for the UI ring. Main-thread updated.
    private(set) var progress: [UUID: Double] = [:]
    /// Full (untrimmed) duration in seconds per decoded pad, for the UI row
    /// and the trim editor's slider range. Set at load, cleared at unload.
    private(set) var durations: [UUID: Double] = [:]
    var onProgressChanged: (() -> Void)?
    private var progressTimer: Timer?

    init(engine: AVAudioEngine, padsMixer: AVAudioMixerNode, voiceCount: Int = 8) {
        self.engine = engine
        self.padsMixer = padsMixer
        for _ in 0..<voiceCount {
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: padsMixer, format: CanonicalAudio.format)
            voices.append(Voice(node: node))
        }
    }

    // MARK: - Library

    /// Decodes the file fully into a canonical-format buffer.
    func load(pad: SoundPad) throws {
        guard let url = pad.resolve() else {
            throw NSError(domain: "SoundPadPlayer", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "File not found for \(pad.name)"])
        }
        let file = try AVAudioFile(forReading: url)
        let canonical = CanonicalAudio.format
        guard let fileBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                                frameCapacity: AVAudioFrameCount(file.length)) else {
            throw NSError(domain: "SoundPadPlayer", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Sample too large"])
        }
        try file.read(into: fileBuffer)

        if file.processingFormat == canonical {
            buffers[pad.id] = fileBuffer
            durations[pad.id] = Double(fileBuffer.frameLength) / canonical.sampleRate
            return
        }
        guard let converter = AVAudioConverter(from: file.processingFormat, to: canonical) else {
            throw NSError(domain: "SoundPadPlayer", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Unsupported sample format"])
        }
        let ratio = canonical.sampleRate / file.processingFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(file.length) * ratio) + 4096
        guard let converted = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: outCapacity) else {
            throw NSError(domain: "SoundPadPlayer", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Sample too large"])
        }
        var fed = false
        converter.convert(to: converted, error: nil, withInputFrom: { _, outStatus in
            if fed {
                outStatus.pointee = .endOfStream
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return fileBuffer
        })
        buffers[pad.id] = converted
        durations[pad.id] = Double(converted.frameLength) / canonical.sampleRate
    }

    func unload(padID: UUID) {
        buffers.removeValue(forKey: padID)
        progress.removeValue(forKey: padID)
        durations.removeValue(forKey: padID)
    }

    // MARK: - Playback

    func play(_ pad: SoundPad) {
        guard let full = buffers[pad.id] else {
            log.warning("Pad \(pad.name) has no decoded buffer")
            return
        }
        // Steal the oldest voice.
        guard var voice = voices.min(by: { $0.startedAt < $1.startedAt }) else { return }
        guard let index = voices.firstIndex(where: { $0.node === voice.node }) else { return }

        voice.node.stop()
        voice.startedAt = Date()
        voice.padID = pad.id
        voices[index] = voice

        // In/out points slice the pre-decoded buffer at fire time — a memcpy
        // of at most a few MB, well inside the <10ms pad budget.
        let buffer = trimmed(full, start: pad.trimStart, end: pad.trimEnd) ?? full
        let duration = Double(buffer.frameLength) / buffer.format.sampleRate
        voice.node.scheduleBuffer(buffer, at: nil) { [weak self] in
            DispatchQueue.main.async {
                self?.progress.removeValue(forKey: pad.id)
                self?.onProgressChanged?()
            }
        }
        voice.node.play()

        startProgressTracking(padID: pad.id, duration: duration)
    }

    /// Whether this pad is sounding right now. Progress is set at fire and
    /// cleared at completion or stop, so it doubles as the playing set.
    func isPlaying(_ padID: UUID) -> Bool {
        progress[padID] != nil
    }

    /// Stops just this pad's voice(s), leaving the rest of the board alone.
    /// The stopped voice is marked oldest so the next fire steals it first.
    func stop(padID: UUID) {
        for index in voices.indices where voices[index].padID == padID {
            voices[index].node.stop()
            voices[index].startedAt = .distantPast
            voices[index].padID = nil
        }
        progress.removeValue(forKey: padID)
        onProgressChanged?()
    }

    func stopAll() {
        voices.forEach { $0.node.stop() }
        progress.removeAll()
        onProgressChanged?()
    }

    /// Copies the [start, end) window of a decoded buffer into a fresh buffer.
    /// Returns nil when the pad has no trim (or the trim is degenerate), so
    /// the caller falls back to the original with no copy at all.
    private func trimmed(_ buffer: AVAudioPCMBuffer, start: Double?, end: Double?) -> AVAudioPCMBuffer? {
        guard start != nil || end != nil else { return nil }
        let rate = buffer.format.sampleRate
        let fullFrames = AVAudioFramePosition(buffer.frameLength)
        let startFrame = AVAudioFramePosition(max(start ?? 0, 0) * rate)
        // No sentinel arithmetic here: converting a huge Double through
        // AVAudioFramePosition traps (it crashed the first pad ever played).
        let endFrame = end.map { min(AVAudioFramePosition($0 * rate), fullFrames) } ?? fullFrames
        guard startFrame > 0 || endFrame < fullFrames else { return nil }
        guard endFrame > startFrame, startFrame < fullFrames else { return nil }

        let frames = AVAudioFrameCount(endFrame - startFrame)
        guard let out = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: frames),
              let src = buffer.floatChannelData,
              let dst = out.floatChannelData else { return nil }
        out.frameLength = frames
        for channel in 0..<Int(buffer.format.channelCount) {
            dst[channel].update(from: src[channel] + Int(startFrame), count: Int(frames))
        }
        return out
    }

    private func startProgressTracking(padID: UUID, duration: TimeInterval) {
        let started = Date()
        progress[padID] = 0
        progressTimer?.invalidate()
        progressTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            var anyActive = false
            for (pid, _) in self.progress {
                if pid == padID {
                    let p = min(1, Date().timeIntervalSince(started) / max(duration, 0.01))
                    self.progress[pid] = p
                    if p < 1 { anyActive = true }
                } else {
                    anyActive = true
                }
            }
            self.onProgressChanged?()
            if !anyActive { timer.invalidate() }
        }
    }
}
