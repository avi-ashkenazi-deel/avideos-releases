import Foundation
import AVFoundation
import Combine
import Observation
import os

/// The editor's preview transport: rebuilds the AVPlayer item from the
/// current EDL/layout (debounced — dragging a trim shouldn't rebuild per
/// pixel), preserves the playhead across rebuilds, and publishes the
/// playhead in edited-timeline seconds.
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
    private(set) var isPlaying = false
    private(set) var buildError: String?

    private let builder = CompositionBuilder()
    private var timeObserver: Any?
    private var rebuildTask: Task<Void, Never>?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "preview")

    init() {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 30),
            queue: .main
        ) { [weak self] time in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.playheadSeconds = max(0, time.seconds - self.programOffset)
                self.isPlaying = self.player.rate != 0
            }
        }
    }

    deinit {
        // deinit is nonisolated even in a @MainActor class. Swift 5.9 permits
        // reading stored properties here (exclusive access during teardown),
        // and removeTimeObserver is safe off the main thread.
        // verify on Mac: if a future compiler mode rejects touching the
        // MainActor-isolated `timeObserver` var from deinit, move observer
        // ownership into a small nonisolated holder object.
        if let observer = timeObserver {
            player.removeTimeObserver(observer)
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
}
