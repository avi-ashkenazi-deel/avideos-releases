import AVFoundation
import AppKit
import Observation
import os

/// Poster frames for the timeline's clip blocks — "every box has a preview".
///
/// Deliberately built like `WaveformStore`: an in-memory dictionary, an
/// in-flight set so a scrolling timeline can't queue the same frame twice, and
/// detached work that hops back to the main actor to publish. Requests are
/// cheap to make and idempotent, so views can ask on every redraw.
@MainActor
@Observable
final class ThumbnailStore {
    /// Small — these are drawn a few dozen points wide.
    static let maximumSize = CGSize(width: 240, height: 135)
    /// Frames are cached per track at this granularity, so scrubbing a block
    /// doesn't generate a new image for every pixel.
    static let quantum: Double = 5

    private(set) var images: [Key: NSImage] = [:]
    private var inFlight: Set<Key> = []
    private var generators: [String: AVAssetImageGenerator] = [:]
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "thumbnails")

    struct Key: Hashable, Sendable {
        let trackID: String
        /// Source seconds, quantised.
        let bucket: Int

        init(trackID: String, sourceTime: Double) {
            self.trackID = trackID
            self.bucket = Int((max(0, sourceTime) / ThumbnailStore.quantum).rounded(.down))
        }

        var sourceTime: Double { Double(bucket) * ThumbnailStore.quantum }
    }

    /// The poster frame for a moment, if it has been generated. Returns nil
    /// and starts the work when it hasn't — call it again on the next redraw.
    func image(for track: EditTrack, at sourceTime: Double) -> NSImage? {
        guard track.kind == .video else { return nil }
        let key = Key(trackID: track.id, sourceTime: sourceTime)
        if let existing = images[key] { return existing }
        request(key: key, url: track.url)
        return nil
    }

    private func request(key: Key, url: URL) {
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)

        let generator = generators[key.trackID] ?? {
            let asset = AVURLAsset(url: url)
            let made = AVAssetImageGenerator(asset: asset)
            made.appliesPreferredTrackTransform = true
            made.maximumSize = Self.maximumSize
            // Generous tolerance: a poster frame doesn't need to be the exact
            // frame, and demanding one forces a slow precise seek.
            made.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
            made.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
            generators[key.trackID] = made
            return made
        }()

        let time = CMTime(seconds: key.sourceTime, preferredTimescale: 600)
        Task { [weak self] in
            let image = await Self.generate(generator: generator, at: time)
            guard let self else { return }
            self.inFlight.remove(key)
            if let image { self.images[key] = image }
        }
    }

    private nonisolated static func generate(generator: AVAssetImageGenerator,
                                             at time: CMTime) async -> NSImage? {
        await withCheckedContinuation { continuation in
            generator.generateCGImageAsynchronously(for: time) { cgImage, _, _ in
                guard let cgImage else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: NSImage(cgImage: cgImage,
                                                       size: NSSize(width: cgImage.width,
                                                                    height: cgImage.height)))
            }
        }
    }

    /// Drops everything for a track — call when its media changes underneath.
    func invalidate(trackID: String) {
        images = images.filter { $0.key.trackID != trackID }
        generators[trackID] = nil
    }
}
