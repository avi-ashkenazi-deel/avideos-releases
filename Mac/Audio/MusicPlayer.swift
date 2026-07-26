import Foundation
import AVFoundation
import os

struct MusicTrack: Identifiable, Codable, Hashable {
    let id: UUID
    var title: String
    var bookmark: Data?
    var path: String

    init(url: URL) {
        self.id = UUID()
        self.title = url.deletingPathExtension().lastPathComponent
        self.bookmark = try? url.bookmarkData(options: [.withSecurityScope])
        self.path = url.path
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
}

enum LoopMode: String, Codable, CaseIterable {
    case off, one, all
}

/// Background-music playlist on the music strip. Songs stream from disk via
/// AVAudioFile scheduling (never fully preloaded); a single player node is
/// enough because "gapless" for background music means scheduling the next
/// file in the completion handler — the file read-ahead hides the seam.
final class MusicPlayer {
    private weak var engine: AVAudioEngine?
    private let player = AVAudioPlayerNode()
    private var currentFile: AVAudioFile?

    private(set) var playlist: [MusicTrack] = []
    private(set) var currentTrackID: UUID?
    private(set) var isPlaying = false
    var loopMode: LoopMode = .off

    /// Seconds into the current track / its duration, for the transport UI.
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    private var positionTimer: Timer?
    /// Frame offset of the current schedule (for position math after seeks).
    private var scheduledFromFrame: AVAudioFramePosition = 0
    /// Generation token: invalidates stale completion handlers after stop/seek.
    private var scheduleGeneration = 0

    var onStateChanged: (() -> Void)?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "music")

    init(engine: AVAudioEngine, musicMixer: AVAudioMixerNode) {
        self.engine = engine
        engine.attach(player)
        engine.connect(player, to: musicMixer, format: CanonicalAudio.format)
    }

    // MARK: - Playlist

    func add(urls: [URL]) {
        playlist.append(contentsOf: urls.map(MusicTrack.init))
        onStateChanged?()
    }

    func remove(id: UUID) {
        playlist.removeAll { $0.id == id }
        if currentTrackID == id { stop() }
        onStateChanged?()
    }

    func move(from offsets: IndexSet, to destination: Int) {
        playlist.move(fromOffsets: offsets, toOffset: destination)
        onStateChanged?()
    }

    func setPlaylist(_ tracks: [MusicTrack]) {
        playlist = tracks
    }

    // MARK: - Transport

    func playPause() {
        if isPlaying {
            player.pause()
            isPlaying = false
            positionTimer?.invalidate()
        } else if currentFile != nil {
            player.play()
            isPlaying = true
            startPositionTimer()
        } else if let first = currentTrackID.flatMap({ id in playlist.first { $0.id == id } }) ?? playlist.first {
            play(track: first)
        }
        onStateChanged?()
    }

    func play(track: MusicTrack) {
        guard let url = track.resolve() else {
            log.warning("Missing music file: \(track.title)")
            return
        }
        do {
            let file = try AVAudioFile(forReading: url)
            scheduleGeneration += 1
            player.stop()
            currentFile = file
            currentTrackID = track.id
            duration = Double(file.length) / file.processingFormat.sampleRate
            schedule(file: file, from: 0)
            player.play()
            isPlaying = true
            startPositionTimer()
            onStateChanged?()
        } catch {
            log.error("Couldn't open \(track.title): \(error.localizedDescription)")
        }
    }

    func next() { step(by: 1) }
    func previous() { step(by: -1) }

    private func step(by delta: Int) {
        guard !playlist.isEmpty else { return }
        let currentIndex = playlist.firstIndex { $0.id == currentTrackID } ?? -delta
        var nextIndex = currentIndex + delta
        if loopMode == .all {
            nextIndex = (nextIndex + playlist.count) % playlist.count
        }
        guard playlist.indices.contains(nextIndex) else {
            stop()
            return
        }
        play(track: playlist[nextIndex])
    }

    func seek(to seconds: Double) {
        guard let file = currentFile else { return }
        let frame = AVAudioFramePosition(seconds * file.processingFormat.sampleRate)
        scheduleGeneration += 1
        let wasPlaying = isPlaying
        player.stop()
        schedule(file: file, from: max(0, min(frame, file.length - 1)))
        if wasPlaying {
            player.play()
        }
        position = seconds
        onStateChanged?()
    }

    func stop() {
        scheduleGeneration += 1
        player.stop()
        currentFile = nil
        currentTrackID = nil
        isPlaying = false
        position = 0
        duration = 0
        positionTimer?.invalidate()
        onStateChanged?()
    }

    // MARK: - Scheduling

    private func schedule(file: AVAudioFile, from frame: AVAudioFramePosition) {
        let generation = scheduleGeneration
        scheduledFromFrame = frame
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        guard remaining > 0 else { return }
        player.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil) { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.scheduleGeneration == generation else { return }
                self.trackFinished()
            }
        }
    }

    private func trackFinished() {
        switch loopMode {
        case .one:
            if let id = currentTrackID, let track = playlist.first(where: { $0.id == id }) {
                play(track: track)
            }
        case .all, .off:
            step(by: 1)
        }
    }

    private func startPositionTimer() {
        positionTimer?.invalidate()
        positionTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, let file = self.currentFile,
                  let nodeTime = self.player.lastRenderTime,
                  let playerTime = self.player.playerTime(forNodeTime: nodeTime) else { return }
            let frames = self.scheduledFromFrame + playerTime.sampleTime
            self.position = Double(frames) / file.processingFormat.sampleRate
            self.onStateChanged?()
        }
    }
}
