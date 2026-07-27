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

    /// Lenient decode, deliberately.
    ///
    /// A raw-value enum throws on an unknown string, and `AudioSettingsStore`
    /// swallows any throw and returns blank settings — so one stale or
    /// hand-edited `loopMode` value would silently discard the host's devices,
    /// faders, mutes, ducker config, insert chains, pads and playlist. Falling
    /// back to a sane value costs nothing and cannot lose data.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .off
    }
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
    /// `DispatchSourceTimer` rather than `Timer`, because
    /// `Timer.scheduledTimer` runs in the default run-loop mode and stalls
    /// during SwiftUI scroll and drag tracking. Tolerable for a coarse progress
    /// bar; not tolerable once this same tick drives loop-boundary decisions.
    private var positionTimer: DispatchSourceTimer?
    /// Where the current content started, in both clocks. See `PlaybackAnchor`.
    private var anchor: PlaybackAnchor?
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
            positionTimer?.cancel()
            positionTimer = nil
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
        anchor = nil
        positionTimer?.cancel()
        positionTimer = nil
        onStateChanged?()
    }

    // MARK: - Scheduling

    /// Schedules the remainder of `file` from `frame` (a *file* frame) and
    /// re-anchors the position clock to it.
    private func schedule(file: AVAudioFile, from frame: AVAudioFramePosition) {
        let generation = scheduleGeneration
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        guard remaining > 0 else { return }
        player.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil) { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.scheduleGeneration == generation else { return }
                self.trackFinished()
            }
        }
        // The seek/play path stops the node first, so its sample clock restarts
        // at zero. Anchor the track position in canonical frames.
        // verify on Mac: `stop()` zeroes `playerTime.sampleTime` — the previous
        // position formula silently depended on this too.
        let seconds = Double(frame) / file.processingFormat.sampleRate
        anchor = PlaybackAnchor(nodeSampleTime: 0,
                                trackFrame: MusicClock.frames(fromSeconds: seconds),
                                region: nil)
    }

    private func trackFinished() {
        // Precedence between whole-track loop modes and a looped section lives
        // in one pure function so the two concepts stay distinct.
        switch advanceDecision(loopMode: loopMode,
                               hasActiveSectionLoop: anchor?.region != nil) {
        case .stayLooping:
            break
        case .repeatTrack:
            if let id = currentTrackID, let track = playlist.first(where: { $0.id == id }) {
                play(track: track)
            }
        case .advance:
            step(by: 1)
        }
    }

    /// 4 Hz is plenty for a whole-track progress bar. A looped section needs
    /// 15 Hz (matching `SoundPadPlayer`'s progress tick) so the loop position
    /// doesn't staircase and a countdown to the next switch reads smoothly —
    /// but a track with no sections must not pay for that, so the rate follows
    /// whether a region is engaged.
    private var positionTickInterval: Double {
        anchor?.region == nil ? 0.25 : 1.0 / 15.0
    }

    private func startPositionTimer() {
        positionTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + positionTickInterval,
                       repeating: positionTickInterval)
        timer.setEventHandler { [weak self] in self?.tickPosition() }
        positionTimer = timer
        timer.resume()
    }

    private func tickPosition() {
        guard let file = currentFile,
              let anchor,
              let nodeTime = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: nodeTime) else { return }
        let nodeFrames = MusicClock.canonicalFrames(
            fromPlayerSampleTime: playerTime.sampleTime,
            fileSampleRate: file.processingFormat.sampleRate)
        let resolved = MusicPositionMath.resolve(anchor: anchor, nodeSampleTime: nodeFrames)
        position = resolved.seconds
        onStateChanged?()
    }
}
