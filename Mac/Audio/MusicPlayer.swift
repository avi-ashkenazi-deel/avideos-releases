import Foundation
import AVFoundation
import os

struct MusicTrack: Identifiable, Codable, Hashable {
    let id: UUID
    var title: String
    var bookmark: Data?
    var path: String

    // Everything below is Optional rather than a defaulted `var`, deliberately.
    //
    // Swift's synthesized `init(from:)` emits `decode(_:forKey:)` for a
    // non-optional property *even when it has a default* — defaults are only
    // used by the memberwise init — so a missing key throws. Every settings
    // file written before this feature lacks these keys, and
    // `AudioSettingsStore.load()` turns any throw into blank settings, which
    // would cost the host their devices, faders, ducker, inserts and pads.
    // Optionals decode via `decodeIfPresent` and are simply absent.

    /// Where "play this track" begins. nil ⇒ 0.
    ///
    /// Separate from sections on purpose: it applies to tracks you never
    /// sectioned at all (skipping a 12-second intro), and it keeps the
    /// no-sections path one line in the engine.
    var startOffset: Double?
    var sections: [MusicSection]?
    /// Fire this section when the track loads. nil ⇒ plain playback, exactly
    /// as before this feature existed.
    var armedSectionID: UUID?

    init(url: URL) {
        self.id = UUID()
        self.title = url.deletingPathExtension().lastPathComponent
        self.bookmark = try? url.bookmarkData(options: [.withSecurityScope])
        self.path = url.path
    }

    /// Sections in play order. The open-end resolver and the pad row both
    /// depend on this ordering, so every write goes through it.
    var sortedSections: [MusicSection] {
        (sections ?? []).sorted { $0.start < $1.start }
    }

    var effectiveStartOffset: Double { startOffset ?? 0 }

    func section(withID id: UUID?) -> MusicSection? {
        guard let id else { return nil }
        return sections?.first { $0.id == id }
    }

    /// The section bound to a hotkey slot, if any.
    ///
    /// Resolution is by explicit binding, never by position: sections are kept
    /// sorted by start time, so a positional mapping would renumber every slot
    /// after any marker you added later — you rehearse "3 is the chorus", drop
    /// an intro marker, and 3 fires the verse on air.
    func section(forHotkeyIndex index: Int) -> MusicSection? {
        sections?.first { $0.hotkeyIndex == index }
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

/// Background-music playlist on the music strip, and live section playback.
///
/// Whole tracks stream from disk via `AVAudioFile` scheduling. Looped
/// *sections* are decoded to memory instead, because only a buffer can be
/// scheduled with `.loops` — which is what puts the wrap, and both switch
/// modes, inside AVFoundation's render loop rather than in our completion
/// handlers.
///
/// Two player nodes, both feeding `musicBus`. The second one is what makes a
/// crossfade possible (a node cannot fade with itself) and takes the
/// synchronous file open out of the playlist advance. An earlier comment here
/// claimed one node sufficed because the completion handler could schedule the
/// next file — that was wrong: the handler fires once the segment has already
/// been consumed, and the hop to main plus a disk read is an audible seam.
/// `@MainActor` because it already was one in practice: every scheduling
/// completion handler below hops to main before touching a single property,
/// and the position timer runs on the main queue. Saying so lets it hold
/// `MusicRegionCache` directly instead of threading a lock through state that
/// is only ever read from one thread anyway. The two places that genuinely
/// are off-main — the crossfade ramp, and the completion handlers themselves —
/// are marked at their call sites.
@MainActor
final class MusicPlayer {
    private weak var engine: AVAudioEngine?
    /// Two nodes, both attached at init and never created mid-session.
    ///
    /// `musicBus` is documented as a pre-mix bus that fans multiple players
    /// into one strip entry, so a second node costs nothing structurally — and
    /// it buys two things at once: a crossfade (a single node cannot fade with
    /// itself) and a genuinely gapless track advance, since the next file can
    /// be opened and scheduled on the idle node while this one still plays.
    private let playerA = AVAudioPlayerNode()
    private let playerB = AVAudioPlayerNode()
    private var usingB = false
    /// The node currently carrying the program.
    private var player: AVAudioPlayerNode { usingB ? playerB : playerA }
    /// The idle node, staged for the next thing.
    private var standby: AVAudioPlayerNode { usingB ? playerA : playerB }

    private var currentFile: AVAudioFile?
    /// Crossfade ramp. Its own timer on a userInitiated queue, explicitly not
    /// main: the ducker owns main at 60 Hz, and a starved fade would strand
    /// the music at −6 dB mid-show.
    private var fadeTimer: DispatchSourceTimer?

    private(set) var playlist: [MusicTrack] = []
    private(set) var currentTrackID: UUID?
    private(set) var isPlaying = false
    var loopMode: LoopMode = .off
    /// Sticky switch behaviour. Individual calls can override it, so a bound
    /// pad can mean "chorus, hard cut" without changing the global setting.
    var switchMode: SectionSwitchMode = .atLoopEnd

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

    // MARK: Section playback

    let regions = MusicRegionCache()

    /// The section sounding right now, and whether its loop is live.
    ///
    /// `isSectionLooping` is separate from `MusicSection.loops` on purpose:
    /// that is the authored default, this is what is happening — so mid-show
    /// you can let a song run out without editing your sections.
    private(set) var playingSectionID: UUID?
    private(set) var isSectionLooping = false

    /// A switch waiting for the loop boundary.
    ///
    /// Two phases, because there is no unschedule API: once an
    /// `.interruptsAtLoop` buffer is handed to AVFoundation it cannot be
    /// cancelled or replaced without `stop()`. Holding the target in `queued`
    /// until the commit window keeps cancel and change-your-mind available
    /// until the last moment, which is what a performer wants. Missing the
    /// window costs one extra pass — never a gap, never a click.
    enum PendingSwitch: Equatable {
        case none
        case queued(sectionID: UUID)
        case committed(sectionID: UUID, boundaryNodeSampleTime: AVAudioFramePosition)

        var sectionID: UUID? {
            switch self {
            case .none: nil
            case .queued(let id), .committed(let id, _): id
            }
        }
        var isCommitted: Bool { if case .committed = self { true } else { false } }
    }
    private(set) var pending: PendingSwitch = .none
    /// The committed target's region, held so the anchor can be rewritten the
    /// moment the swap actually takes effect.
    private var pendingRegion: LoopRegion?
    /// Frames until the current loop wraps, for the countdown readout.
    private(set) var framesToBoundary: AVAudioFramePosition?

    var onSectionFailure: ((String) -> Void)?

    var onStateChanged: (() -> Void)?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "music")

    init(engine: AVAudioEngine, musicMixer: AVAudioMixerNode) {
        self.engine = engine
        for node in [playerA, playerB] {
            engine.attach(node)
            // Both into musicBus, so their sum passes through the insert chain,
            // the fader, mute, the ducker and the meter. A node wired anywhere
            // else would silently bypass all five.
            engine.connect(node, to: musicMixer, format: CanonicalAudio.format)
            node.volume = 1
        }
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

    /// Replaces one track in place, keeping the player the source of truth for
    /// the array (`AudioEngineController.playlist` is only ever assigned from
    /// `syncMusicState()`).
    ///
    /// Deliberately does **not** re-open the file when the edited track is the
    /// one playing: `currentFile` is already open, and re-opening it would be a
    /// synchronous disk read on the main thread in the middle of a show.
    func update(track: MusicTrack) {
        guard let index = playlist.firstIndex(where: { $0.id == track.id }) else { return }
        playlist[index] = track
        onStateChanged?()
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
            cancelFade()
            playerA.stop()
            playerB.stop()
            currentFile = file
            currentTrackID = track.id
            duration = Double(file.length) / file.processingFormat.sampleRate
            releaseSectionState()
            // A track with no sections starts at frame 0 exactly as before;
            // `startOffset` is the only thing that can move it, and it defaults
            // to nil.
            let startFrame = AVAudioFramePosition(
                (track.effectiveStartOffset * file.processingFormat.sampleRate).rounded())
            schedule(file: file, from: max(0, min(startFrame, file.length - 1)))
            player.play()
            isPlaying = true
            startPositionTimer()
            onStateChanged?()
            // Open the next file now, while there is time — so the advance
            // doesn't hit the disk from a completion handler.
            prefetchNextTrack()
        } catch {
            log.error("Couldn't open \(track.title): \(error.localizedDescription)")
        }
    }

    func next() { step(by: 1) }

    /// Standard player semantics: a couple of seconds into a track,
    /// "previous" means restart it — stepping only from the very top. This
    /// also gives the button a purpose in a one-track playlist, where
    /// stepping had nowhere to go.
    func previous() {
        if currentFile != nil, position > 2 {
            seek(to: 0)
            return
        }
        step(by: -1)
    }

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
        let next = playlist[nextIndex]
        // Forward advance can use the already-open file; a manual jump
        // backwards or to an arbitrary track cannot.
        if delta == 1, let ready = prefetched, ready.trackID == next.id {
            playPrefetched(track: next, file: ready.file)
        } else {
            play(track: next)
        }
    }

    func seek(to seconds: Double) {
        guard let file = currentFile else { return }
        let frame = AVAudioFramePosition(seconds * file.processingFormat.sampleRate)
        scheduleGeneration += 1
        let wasPlaying = isPlaying
        // Scrubbing is an explicit operator action, so it releases the section
        // loop rather than snapping the playhead back — which would make the
        // scrubber feel broken.
        releaseSectionState()
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
        // Both nodes: stopping only the active one would leave the other
        // sounding if this lands mid-crossfade.
        cancelFade()
        playerA.stop()
        playerB.stop()
        prefetched = nil
        currentFile = nil
        currentTrackID = nil
        isPlaying = false
        position = 0
        duration = 0
        anchor = nil
        releaseSectionState()
        positionTimer?.cancel()
        positionTimer = nil
        onStateChanged?()
    }

    /// Clears live section state. Decoded regions stay cached, keyed by track
    /// and section, so re-engaging mid-show is instant.
    private func releaseSectionState() {
        playingSectionID = nil
        isSectionLooping = false
        pending = .none
        pendingRegion = nil
        framesToBoundary = nil
    }

    // MARK: - Scheduling

    /// Schedules the remainder of `file` from `frame` (a *file* frame) and
    /// re-anchors the position clock to it.
    private func schedule(file: AVAudioFile, from frame: AVAudioFramePosition) {
        let generation = scheduleGeneration
        let remaining = AVAudioFrameCount(max(0, file.length - frame))
        guard remaining > 0 else { return }
        player.scheduleSegment(file, startingFrame: frame, frameCount: remaining, at: nil) { [weak self] in
            Task { @MainActor [weak self] in
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

    // MARK: - Sections

    /// Plays a section, looping it if asked.
    ///
    /// `mode` decides *when*: `.hardCut` takes the next render slice,
    /// `.atLoopEnd` waits for the current loop to wrap (and falls back to an
    /// immediate start when nothing is looping — there is no boundary to wait
    /// for). `.crossfade` needs the second player node and is treated as a cut
    /// until that lands, rather than silently doing nothing.
    func playSection(_ section: MusicSection,
                     in track: MusicTrack,
                     mode: SectionSwitchMode? = nil,
                     loop: Bool? = nil) {
        let resolvedMode = mode ?? switchMode
        let shouldLoop = loop ?? section.loops

        guard let range = resolvedRange(for: section, in: track) else {
            onSectionFailure?(LoopRegion.Invalid.tooShort.reason)
            return
        }
        // The file has to be open before anything can be scheduled from it.
        guard track.id == currentTrackID, currentFile != nil else {
            loadThenPlay(section: section, in: track, mode: resolvedMode, loop: shouldLoop)
            return
        }
        guard let url = track.resolve() else {
            onSectionFailure?(MusicRegionCache.Failure.missingFile.reason)
            return
        }

        let key = MusicRegionCache.Key(trackID: track.id, sectionID: section.id)
        guard let resident = regions.buffer(for: key) else {
            // Not decoded yet. Ask for it, then land when it arrives — waiting
            // is always better than glitching, and under `.atLoopEnd` it just
            // means a later boundary.
            regions.prepare(key: key, url: url,
                            startSeconds: range.lowerBound,
                            endSeconds: range.upperBound) { [weak self] result in
                switch result {
                case .success:
                    self?.playSection(section, in: track, mode: resolvedMode, loop: shouldLoop)
                case .failure(let failure):
                    self?.onSectionFailure?(failure.reason)
                }
            }
            return
        }

        switch resolvedMode {
        case .atLoopEnd where isSectionLooping && playingSectionID != nil:
            pending = .queued(sectionID: section.id)
            onStateChanged?()
        case .crossfade where playingSectionID != nil:
            crossfade(to: section, buffer: resident.buffer,
                      region: resident.region, loop: shouldLoop)
        case .atLoopEnd, .hardCut, .crossfade:
            engage(section: section,
                   buffer: resident.buffer,
                   region: resident.region,
                   loop: shouldLoop,
                   interrupting: playingSectionID != nil)
        }
    }

    /// How long a crossfade takes. Long enough to be smooth, short enough that
    /// a section change still reads as deliberate.
    static let crossfadeDuration: Double = 0.3

    /// Starts the target on the idle node and rides the two volumes past each
    /// other.
    ///
    /// AVAudioEngine has no sample-accurate gain ramp — `volume` is a plain
    /// setter — so this is a timer-driven ramp at 120 Hz, which over 300 ms is
    /// 36 steps on an equal-power curve. Inaudible for a music crossfade; the
    /// same technique is rejected for declicking a hard cut, which would need
    /// ~5 ms resolution.
    private func crossfade(to section: MusicSection,
                           buffer: AVAudioPCMBuffer,
                           region: LoopRegion,
                           loop: Bool) {
        let incoming = standby
        let outgoing = player

        scheduleGeneration += 1
        let generation = scheduleGeneration
        var options: AVAudioPlayerNodeBufferOptions = []
        if loop { options.insert(.loops) }

        cancelFade()
        incoming.volume = 0
        incoming.scheduleBuffer(buffer, at: nil, options: options) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.scheduleGeneration == generation else { return }
                self.sectionBufferFinished()
            }
        }
        incoming.play()
        usingB.toggle()

        anchor = PlaybackAnchor(nodeSampleTime: currentNodeSampleTime(),
                                trackFrame: region.startFrame,
                                region: loop ? region : nil)
        playingSectionID = section.id
        isSectionLooping = loop
        pending = .none
        startPositionTimer()
        onStateChanged?()

        ride(outgoing: outgoing, incoming: incoming)
    }

    /// Ends any fade in progress and restores both nodes to unity, so a stop
    /// or a new switch never leaves one stranded part-way down.
    private func cancelFade() {
        fadeTimer?.cancel()
        fadeTimer = nil
        playerA.volume = 1
        playerB.volume = 1
    }

    private func ride(outgoing: AVAudioPlayerNode, incoming: AVAudioPlayerNode) {
        fadeTimer?.cancel()
        let steps = Int(Self.crossfadeDuration * 120)
        var step = 0

        let timer = DispatchSource.makeTimerSource(
            queue: DispatchQueue(label: "com.aviashkenazi.streamit.music-fade", qos: .userInitiated))
        timer.schedule(deadline: .now(), repeating: Self.crossfadeDuration / Double(steps))
        timer.setEventHandler { [weak self] in
            step += 1
            let (out, into) = Crossfade.gainPair(at: Double(step) / Double(steps))
            outgoing.volume = out
            incoming.volume = into
            guard step >= steps else { return }
            // verify on Mac: writing AVAudioMixing.volume off the main thread.
            outgoing.stop()
            outgoing.volume = 1
            incoming.volume = 1
            // The ramp itself must stay off main — that is the whole point of
            // this queue — but the timer handle is main-actor state, so only
            // that last bit hops.
            Task { @MainActor [weak self] in
                self?.fadeTimer?.cancel()
                self?.fadeTimer = nil
            }
        }
        fadeTimer = timer
        timer.resume()
    }

    /// Opens the track first, then engages — the only path that touches the
    /// disk, and never from a completion handler.
    private func loadThenPlay(section: MusicSection,
                              in track: MusicTrack,
                              mode: SectionSwitchMode,
                              loop: Bool) {
        play(track: track)
        guard currentTrackID == track.id else { return }
        playSection(section, in: track, mode: .hardCut, loop: loop)
    }

    private func engage(section: MusicSection,
                        buffer: AVAudioPCMBuffer,
                        region: LoopRegion,
                        loop: Bool,
                        interrupting: Bool) {
        scheduleGeneration += 1
        let generation = scheduleGeneration

        var options: AVAudioPlayerNodeBufferOptions = []
        if loop { options.insert(.loops) }
        if interrupting { options.insert(.interrupts) }

        player.scheduleBuffer(buffer, at: nil, options: options) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.scheduleGeneration == generation else { return }
                self.sectionBufferFinished()
            }
        }
        if !isPlaying {
            player.play()
            isPlaying = true
        }

        anchor = PlaybackAnchor(nodeSampleTime: currentNodeSampleTime(),
                                trackFrame: region.startFrame,
                                region: loop ? region : nil)
        playingSectionID = section.id
        isSectionLooping = loop
        pending = .none
        startPositionTimer()
        onStateChanged?()
    }

    /// Queues a section for the next loop boundary regardless of the sticky
    /// mode — the explicit "next" gesture.
    func queueSection(_ section: MusicSection, in track: MusicTrack) {
        playSection(section, in: track, mode: .atLoopEnd)
    }

    /// Cancels a queued switch. Legal only before it has been handed to
    /// AVFoundation; after that the UI stops offering it.
    @discardableResult
    func cancelQueuedSection() -> Bool {
        guard case .queued = pending else { return false }
        pending = .none
        onStateChanged?()
        return true
    }

    /// Stops looping without changing what is playing — the song runs on to
    /// its end from wherever it is.
    func setSectionLoopEnabled(_ enabled: Bool) {
        guard enabled != isSectionLooping else { return }
        guard let file = currentFile, let anchor else { return }

        if enabled {
            guard let track = playlist.first(where: { $0.id == currentTrackID }),
                  let id = playingSectionID,
                  let section = track.section(withID: id) else { return }
            playSection(section, in: track, mode: .hardCut, loop: true)
        } else {
            // Release: carry on linearly from where the playhead actually is.
            let resolved = MusicPositionMath.resolve(anchor: anchor,
                                                     nodeSampleTime: currentNodeSampleTime())
            isSectionLooping = false
            pending = .none
            let fileFrame = AVAudioFramePosition(
                (resolved.seconds * file.processingFormat.sampleRate).rounded())
            scheduleGeneration += 1
            player.stop()
            schedule(file: file, from: max(0, min(fileFrame, file.length - 1)))
            player.play()
            isPlaying = true
            startPositionTimer()
            onStateChanged?()
        }
    }

    /// Fires when a non-looping section's buffer runs out, or when a looping
    /// one is interrupted. Used only for bookkeeping — never to perform a
    /// switch, because this path hops to main and a late switch is a hole in
    /// the audio.
    private func sectionBufferFinished() {
        guard !isSectionLooping else { return }
        playingSectionID = nil
        anchor = nil
        trackFinished()
    }

    private func resolvedRange(for section: MusicSection,
                               in track: MusicTrack) -> ClosedRange<Double>? {
        let known = track.id == currentTrackID && duration > 0
            ? duration
            : (section.end ?? section.start + LoopRegion.maximumSeconds)
        return MusicSection.resolvedRanges(track.sortedSections, duration: known)[section.id]
    }

    private func currentNodeSampleTime() -> AVAudioFramePosition {
        guard let nodeTime = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: nodeTime) else { return 0 }
        return MusicClock.canonicalFrames(
            fromPlayerSampleTime: playerTime.sampleTime,
            fileSampleRate: currentFile?.processingFormat.sampleRate ?? CanonicalAudio.sampleRate)
    }

    // MARK: - Gapless advance

    /// The next playlist file, opened ahead of time.
    ///
    /// The advance path used to run: completion handler → main queue →
    /// `AVAudioFile(forReading:)` (a synchronous disk open, on main) →
    /// `stop()` → schedule → play. That is a stop/restart with a file open in
    /// the middle, which is why F-101's "gapless" claim was false. Opening the
    /// file while the current track still plays takes the disk out of the seam.
    private var prefetched: (trackID: UUID, file: AVAudioFile)?
    private let prefetchQueue = DispatchQueue(
        label: "com.aviashkenazi.streamit.music-prefetch", qos: .utility)

    private func prefetchNextTrack() {
        guard let index = playlist.firstIndex(where: { $0.id == currentTrackID }) else { return }
        var nextIndex = index + 1
        if loopMode == .all { nextIndex %= playlist.count }
        guard playlist.indices.contains(nextIndex) else { return }

        let next = playlist[nextIndex]
        guard prefetched?.trackID != next.id, let url = next.resolve() else { return }
        prefetchQueue.async { [weak self] in
            guard let file = try? AVAudioFile(forReading: url) else { return }
            Task { @MainActor in self?.prefetched = (next.id, file) }
        }
    }

    /// Starts a track whose file is already open, on the standby node, so the
    /// seam is a node swap rather than a stop-and-reopen.
    ///
    /// A main-queue hop still separates the completion handler from this call,
    /// so it is not sample-accurate — but the disk is out of the path, which
    /// was the audible part.
    private func playPrefetched(track: MusicTrack, file: AVAudioFile) {
        let outgoing = player
        let incoming = standby
        scheduleGeneration += 1
        let generation = scheduleGeneration

        currentFile = file
        currentTrackID = track.id
        duration = Double(file.length) / file.processingFormat.sampleRate
        releaseSectionState()

        let startFrame = AVAudioFramePosition(
            (track.effectiveStartOffset * file.processingFormat.sampleRate).rounded())
        let from = max(0, min(startFrame, file.length - 1))
        let remaining = AVAudioFrameCount(max(0, file.length - from))
        guard remaining > 0 else { return }

        incoming.volume = 1
        incoming.scheduleSegment(file, startingFrame: from, frameCount: remaining, at: nil) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.scheduleGeneration == generation else { return }
                self.trackFinished()
            }
        }
        incoming.play()
        usingB.toggle()
        outgoing.stop()

        anchor = PlaybackAnchor(
            nodeSampleTime: currentNodeSampleTime(),
            trackFrame: MusicClock.frames(fromSeconds: Double(from) / file.processingFormat.sampleRate),
            region: nil)
        isPlaying = true
        prefetched = nil
        startPositionTimer()
        onStateChanged?()
        prefetchNextTrack()
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
        timer.setEventHandler { [weak self] in
            // Already on the main queue (see the timer source above), so
            // assume the isolation rather than hopping: a Task here would put
            // every loop-boundary decision a run-loop turn late.
            MainActor.assumeIsolated { self?.tickPosition() }
        }
        positionTimer = timer
        timer.resume()
    }

    private func tickPosition() {
        guard currentFile != nil else { return }
        let nodeFrames = currentNodeSampleTime()
        // A committed switch may have taken over since the last tick; adopt it
        // before resolving, or the position would be read against the old
        // region for one frame.
        adoptCommittedSwitchIfReached(nodeSampleTime: nodeFrames)

        guard let anchor else { return }
        let resolved = MusicPositionMath.resolve(anchor: anchor, nodeSampleTime: nodeFrames)
        position = resolved.seconds
        framesToBoundary = resolved.framesToBoundary

        commitQueuedSwitchIfDue(anchor: anchor,
                                nodeSampleTime: nodeFrames,
                                framesToBoundary: resolved.framesToBoundary)
        onStateChanged?()
    }

    /// Hands a queued switch to AVFoundation once the boundary is close enough
    /// that it can no longer be changed anyway.
    ///
    /// `.interruptsAtLoop` makes the render thread perform the swap exactly at
    /// the wrap. Doing it from the completion handler instead would mean
    /// render thread → internal thread → main queue → schedule, which is low
    /// milliseconds at best and unbounded when main is busy; 20 ms is 960
    /// frames of silence mid-loop.
    private func commitQueuedSwitchIfDue(anchor: PlaybackAnchor,
                                         nodeSampleTime: AVAudioFramePosition,
                                         framesToBoundary: AVAudioFramePosition?) {
        guard case .queued(let targetID) = pending,
              let region = anchor.region,
              let toBoundary = framesToBoundary,
              let track = playlist.first(where: { $0.id == currentTrackID }),
              let section = track.section(withID: targetID) else { return }

        switch SwitchCommit.decide(framesToBoundary: toBoundary,
                                   regionLength: region.lengthFrames,
                                   nodeSampleTime: nodeSampleTime) {
        case .wait:
            return
        case .commitNow(let boundary):
            let key = MusicRegionCache.Key(trackID: track.id, sectionID: section.id)
            guard let resident = regions.buffer(for: key) else {
                // Still decoding — stay queued and try at the next boundary.
                return
            }
            scheduleGeneration += 1
            let generation = scheduleGeneration
            var options: AVAudioPlayerNodeBufferOptions = [.interruptsAtLoop]
            if section.loops { options.insert(.loops) }
            // verify on Mac: `.interruptsAtLoop` requires the *outgoing* buffer
            // to have been scheduled with `.loops` (it was), and swaps exactly
            // at its loop point.
            player.scheduleBuffer(resident.buffer, at: nil, options: options) { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self, self.scheduleGeneration == generation else { return }
                    self.sectionBufferFinished()
                }
            }
            pending = .committed(sectionID: section.id, boundaryNodeSampleTime: boundary)
            pendingRegion = resident.region
        }
    }

    /// Re-anchors once the committed switch has actually taken over.
    private func adoptCommittedSwitchIfReached(nodeSampleTime: AVAudioFramePosition) {
        guard case .committed(let sectionID, let boundary) = pending,
              nodeSampleTime >= boundary,
              let region = pendingRegion,
              let track = playlist.first(where: { $0.id == currentTrackID }),
              let section = track.section(withID: sectionID) else { return }

        anchor = PlaybackAnchor(nodeSampleTime: boundary,
                                trackFrame: region.startFrame,
                                region: section.loops ? region : nil)
        playingSectionID = sectionID
        isSectionLooping = section.loops
        pending = .none
        pendingRegion = nil
    }
}
