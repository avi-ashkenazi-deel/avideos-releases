import Foundation
import AVFoundation
import Accelerate
import Observation
import os

/// Downsampled peak arrays for waveform drawing, generated once per source
/// and cached as raw-Float sidecars (.peaks). ~50 peaks/second is plenty for
/// any zoom level either timeline draws.
///
/// Used by the post-edit timeline (keyed by `EditTrack.id`) and by the live
/// music section editor (keyed by file path) — hence the URL-keyed entry
/// point beside the track-keyed one. The body is identical either way, so
/// there is one implementation rather than two that drift.
@MainActor
@Observable
final class WaveformStore {
    static let peaksPerSecond = 50.0

    private(set) var peaks: [String: [Float]] = [:]   // key → peaks
    private var inFlight: Set<String> = []
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "waveform")

    func ensurePeaks(for track: EditTrack) {
        guard track.kind == .audio else { return }
        ensurePeaks(url: track.url, key: track.id)
    }

    /// Peaks for any audio file. `key` is whatever the caller looks up by.
    ///
    /// `cacheURL` defaults to a sidecar beside the media, which is right for
    /// session recordings the app owns. The music editor passes a path in the
    /// app's caches directory instead — writing `.peaks` files into someone's
    /// music library or an iCloud folder is rude, and often silently fails,
    /// which shows up as recomputing on every launch.
    func ensurePeaks(url: URL, key: String, cacheURL: URL? = nil) {
        guard peaks[key] == nil, !inFlight.contains(key) else { return }
        inFlight.insert(key)

        let sidecar = cacheURL ?? url.deletingPathExtension().appendingPathExtension("peaks")
        Task.detached(priority: .utility) { [weak self] in
            let computed = (try? await Self.computePeaks(url: url, cacheURL: sidecar)) ?? []
            await MainActor.run {
                self?.peaks[key] = computed
                self?.inFlight.remove(key)
            }
        }
    }

    /// Cache location for media the app doesn't own.
    ///
    /// `nonisolated` for the same reason as `computePeaks` below: it is path
    /// arithmetic over no shared state, and pinning it to the main actor would
    /// only stop a background caller from asking where the sidecar lives.
    nonisolated static func cachedPeaksURL(for url: URL) -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Streamit/peaks", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        // Path hash rather than the filename: two "intro.mp3"s in different
        // folders must not share a cache entry.
        let digest = String(UInt64(bitPattern: Int64(url.path.hashValue)), radix: 36)
        return base.appendingPathComponent("\(digest).peaks")
    }

    // nonisolated: a static member of a @MainActor class inherits MainActor
    // isolation, which would hop this whole PCM decode back onto the main
    // actor despite the detached task. It touches no shared state.
    private nonisolated static func computePeaks(url: URL, cacheURL sidecar: URL) async throws -> [Float] {
        if let cached = try? Data(contentsOf: sidecar), !cached.isEmpty {
            return cached.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        }

        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return [] }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
        ])
        reader.add(output)
        reader.startReading()

        let hopSamples = Int(48_000 / peaksPerSecond)
        var result: [Float] = []
        var carry: [Float] = []

        while reader.status == .reading,
              let sampleBuffer = output.copyNextSampleBuffer(),
              let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) {
            var length = 0
            var dataPointer: UnsafeMutablePointer<CChar>?
            guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                              totalLengthOut: &length,
                                              dataPointerOut: &dataPointer) == noErr,
                  let dataPointer else { continue }
            let count = length / MemoryLayout<Float>.size
            dataPointer.withMemoryRebound(to: Float.self, capacity: count) { floats in
                carry.append(contentsOf: UnsafeBufferPointer(start: floats, count: count))
            }
            while carry.count >= hopSamples {
                var peak: Float = 0
                carry.withUnsafeBufferPointer { buf in
                    vDSP_maxmgv(buf.baseAddress!, 1, &peak, vDSP_Length(hopSamples))
                }
                result.append(peak)
                carry.removeFirst(hopSamples)
            }
        }

        let data = result.withUnsafeBufferPointer { Data(buffer: $0) }
        try? data.write(to: sidecar, options: .atomic)
        return result
    }
}
