import Foundation
import AVFoundation
import Accelerate
import Observation
import os

/// Downsampled peak arrays for timeline drawing, generated once per track
/// and cached as raw-Float sidecars (.peaks). ~50 peaks/second is plenty for
/// any zoom level the timeline draws.
@MainActor
@Observable
final class WaveformStore {
    static let peaksPerSecond = 50.0

    private(set) var peaks: [String: [Float]] = [:]   // EditTrack.id → peaks
    private var inFlight: Set<String> = []
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "waveform")

    func ensurePeaks(for track: EditTrack) {
        guard track.kind == .audio,
              peaks[track.id] == nil,
              !inFlight.contains(track.id) else { return }
        inFlight.insert(track.id)

        let url = track.url
        let id = track.id
        Task.detached(priority: .utility) { [weak self] in
            let computed = (try? await Self.computePeaks(url: url)) ?? []
            await MainActor.run {
                self?.peaks[id] = computed
                self?.inFlight.remove(id)
            }
        }
    }

    // nonisolated: a static member of a @MainActor class inherits MainActor
    // isolation, which would hop this whole PCM decode back onto the main
    // actor despite the detached task. It touches no shared state.
    private nonisolated static func computePeaks(url: URL) async throws -> [Float] {
        let sidecar = url.deletingPathExtension().appendingPathExtension("peaks")
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
