import AVFoundation
import AppKit
import Observation
import UniformTypeIdentifiers
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
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "thumbnails")

    struct Key: Hashable, Sendable {
        /// Whatever the caller looks up by: a track id, a bin item's id, an
        /// overlay's media path.
        let mediaID: String
        /// Source seconds, quantised.
        let bucket: Int

        init(mediaID: String, sourceTime: Double) {
            self.mediaID = mediaID
            self.bucket = Int((max(0, sourceTime) / ThumbnailStore.quantum).rounded(.down))
        }

        var sourceTime: Double { Double(bucket) * ThumbnailStore.quantum }
    }

    /// The poster frame for a moment, if it has been generated. Returns nil
    /// and starts the work when it hasn't — call it again on the next redraw.
    func image(for track: EditTrack, at sourceTime: Double) -> NSImage? {
        guard track.kind == .video else { return nil }
        return image(forMediaID: track.id, url: track.url, at: sourceTime)
    }

    /// Poster frame for any media file — imported cutaways, bin items,
    /// bookends. Stills have no image generator, so they load directly.
    func image(forMediaID id: String, url: URL, at sourceTime: Double) -> NSImage? {
        let key = Key(mediaID: id, sourceTime: sourceTime)
        if let existing = images[key] { return existing }
        request(key: key, url: url)
        return nil
    }

    private func request(key: Key, url: URL) {
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)

        // A still has no image generator — asking one for a frame yields
        // nothing, which would show as a permanently blank poster. Stills are
        // a legal cutaway source, so load them directly.
        if Self.isStillImage(url) {
            Task { [weak self] in
                let image = await Self.loadStill(url: url)
                guard let self else { return }
                self.inFlight.remove(key)
                if let image { self.images[key] = image }
            }
            return
        }

        let generator = generators[key.mediaID] ?? {
            let asset = AVURLAsset(url: url)
            let made = AVAssetImageGenerator(asset: asset)
            made.appliesPreferredTrackTransform = true
            made.maximumSize = Self.maximumSize
            // Generous tolerance: a poster frame doesn't need to be the exact
            // frame, and demanding one forces a slow precise seek.
            made.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
            made.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
            generators[key.mediaID] = made
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

    private nonisolated static func isStillImage(_ url: URL) -> Bool {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return false }
        return type.conforms(to: .image)
    }

    private nonisolated static func loadStill(url: URL) async -> NSImage? {
        await Task.detached(priority: .utility) { NSImage(contentsOf: url) }.value
    }

    /// Drops everything for one source — call when its media changes
    /// underneath, or after a relink.
    func invalidate(mediaID: String) {
        images = images.filter { $0.key.mediaID != mediaID }
        generators[mediaID] = nil
    }
}
