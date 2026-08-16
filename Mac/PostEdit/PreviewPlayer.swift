import Foundation
import AVFoundation
import Combine
import Observation
import os

/// The editor's preview transport: rebuilds the AVPlayer item from the
/// current EDL/layout (debounced — dragging a trim shouldn't rebuild per
/// pixel), preserves the playhead across rebuilds, and publishes the
/// playhead in edited-timeline seconds.
/// Holds the periodic time observer and removes it on teardown.
///
/// This exists only so that removal happens somewhere nonisolated.
/// `AVPlayer.removeTimeObserver` is safe off the main thread; reaching a
/// `@MainActor` stored property from `deinit` is not, and is rejected outright.
/// `@unchecked Sendable` is honest here: `token` is written once during
/// `PreviewPlayer.init` and read once in `deinit`, with no overlap.
private final class TimeObserverBox: @unchecked Sendable {
    private let player: AVPlayer
    var token: Any?

    init(player: AVPlayer) { self.player = player }

    deinit {
        if let token { player.removeTimeObserver(token) }
    }
}

@MainActor
@Observable
final class PreviewPlayer {
    let player = AVPlayer()
    /// Always in **edited** time, never program time.
    ///
    /// The composition's clock includes the intro, but every consumer of this
    /// — the timeline scale, the transcript, split-at-playhead, the cutaway
    /// inspector — is authored in edited time. Converting here, once, is what
    /// keeps the fifteen-odd `mapSourceToTimeline` call sites from each needing
    /// to know about bookends.
    private(set) var playheadSeconds: Double = 0
    /// Intro length of the project this item was built from.
    private var programOffset: Double = 0
    /// Edited length of the project this item was built from (for detecting
    /// the outro phase).
    private var editedDuration: Double = 0
    private(set) var isPlaying = false
    private(set) var buildError: String?

    /// Which bookend the player is inside, if any. The playhead clock is in
    /// EDITED time, which pins at 0:00 through the whole intro — without this
    /// the transport looks frozen while an intro plays, which reads as
    /// "adding an intro did nothing" (first live test said exactly that).
    enum BookendPhase: Equatable {
        case intro(remaining: Double)
        case outro
    }
    private(set) var bookendPhase: BookendPhase?

    private let builder = CompositionBuilder()
    private let observer: TimeObserverBox
    private var rebuildTask: Task<Void, Never>?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "preview")

    init() {
        // The observer's lifetime is owned by a nonisolated box rather than by
        // this class. `deinit` is nonisolated even in a `@MainActor` type, so
        // it cannot read main-actor state to tear the observer down — but the
        // box's own deinit can, because nothing about it is isolated. Releasing
        // this object releases the box, which removes the observer.
        let box = TimeObserverBox(player: player)
        observer = box
        box.token = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 30),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let raw = time.seconds
                self.playheadSeconds = max(0, raw - self.programOffset)
                self.isPlaying = self.player.rate != 0
                if self.programOffset > 0.01, raw < self.programOffset {
                    self.bookendPhase = .intro(remaining: self.programOffset - raw)
                } else if self.editedDuration > 0,
                          raw > self.programOffset + self.editedDuration + 0.05 {
                    self.bookendPhase = .outro
                } else {
                    self.bookendPhase = nil
                }
            }
        }
    }

    /// Rebuilds the composition after 150ms of quiet.
    func scheduleRebuild(project: EditProject) {
        rebuildTask?.cancel()
        rebuildTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await self?.rebuild(project: project)
        }
    }

    func rebuild(project: EditProject) async {
        do {
            let result = try await builder.build(project: project)
            programOffset = project.programOffset
            editedDuration = project.editedDuration
            let item = AVPlayerItem(asset: result.composition)
            item.audioMix = result.audioMix
            item.videoComposition = result.videoComposition

            let wasPlaying = player.rate != 0
            let position = playheadSeconds
            player.replaceCurrentItem(with: item)
            if position > 0 {
                await player.seek(to: CMTime(seconds: position + programOffset, preferredTimescale: 600),
                                  toleranceBefore: .zero, toleranceAfter: .zero)
            }
            if wasPlaying { player.play() }
            buildError = nil
        } catch {
            buildError = error.localizedDescription
            log.error("Preview rebuild failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Transport

    func playPause() {
        if player.rate != 0 {
            player.pause()
        } else {
            player.play()
        }
    }

    /// Takes an **edited**-time second and adds the offset back on the way in.
    func seek(to seconds: Double) {
        let target = max(0, seconds) + programOffset
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        playheadSeconds = max(0, seconds)
    }

    func stepFrame(forward: Bool) {
        player.currentItem?.step(byCount: forward ? 1 : -1)
    }

    /// Jumps to PROGRAM zero — the top of the intro, before edited time
    /// begins. `seek(to: 0)` can't get here (it maps edited→program), and
    /// "watch my new intro" is the whole point of this call.
    func returnToProgramStart() {
        player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
        playheadSeconds = 0
    }
}
