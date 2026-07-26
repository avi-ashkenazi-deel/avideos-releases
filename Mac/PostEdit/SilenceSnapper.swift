import Foundation
import AVFoundation
import Accelerate
import os

/// Energy analysis of an audio file that makes text-based cuts sound clean:
/// Whisper word timestamps are ±50–150ms at boundaries, so every cut point
/// snaps to the nearest real silence instead of Whisper's word edge.
///
/// The RMS energy map (10ms hops) is computed once per file and cached as a
/// raw-Float sidecar (.energy) next to the media.
final class SilenceSnapper {
    /// Seconds per analysis hop.
    static let hopSeconds = 0.01
    /// Below this linear RMS a hop counts as silent (≈ -46dBFS).
    static let silenceThreshold: Float = 0.005

    private var energy: [Float] = []
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "silence")

    private(set) var duration: Double = 0

    // MARK: - Analysis

    /// Loads (or computes + caches) the energy map for an audio file.
    func analyze(url: URL) async throws {
        let sidecar = url.deletingPathExtension().appendingPathExtension("energy")
        if let cached = try? Data(contentsOf: sidecar), !cached.isEmpty {
            energy = cached.withUnsafeBytes { raw in
                Array(raw.bindMemory(to: Float.self))
            }
            duration = Double(energy.count) * Self.hopSeconds
            return
        }

        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw NSError(domain: "SilenceSnapper", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No audio track in \(url.lastPathComponent)"])
        }

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

        let hopSamples = Int(48_000 * Self.hopSeconds)
        var hops: [Float] = []
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

            let sampleCount = length / MemoryLayout<Float>.size
            dataPointer.withMemoryRebound(to: Float.self, capacity: sampleCount) { floats in
                carry.append(contentsOf: UnsafeBufferPointer(start: floats, count: sampleCount))
            }

            while carry.count >= hopSamples {
                var rms: Float = 0
                carry.withUnsafeBufferPointer { buf in
                    vDSP_rmsqv(buf.baseAddress!, 1, &rms, vDSP_Length(hopSamples))
                }
                hops.append(rms)
                carry.removeFirst(hopSamples)
            }
        }

        energy = hops
        duration = Double(hops.count) * Self.hopSeconds
        let data = hops.withUnsafeBufferPointer { Data(buffer: $0) }
        try? data.write(to: sidecar, options: .atomic)
    }

    // MARK: - Queries

    /// All silences of at least `minDuration` seconds.
    func silences(minDuration: Double = 0.12) -> [ClosedRange<Double>] {
        var result: [ClosedRange<Double>] = []
        var runStart: Int?
        for (index, rms) in energy.enumerated() {
            if rms < Self.silenceThreshold {
                if runStart == nil { runStart = index }
            } else if let start = runStart {
                let startTime = Double(start) * Self.hopSeconds
                let endTime = Double(index) * Self.hopSeconds
                if endTime - startTime >= minDuration {
                    result.append(startTime...endTime)
                }
                runStart = nil
            }
        }
        if let start = runStart {
            let startTime = Double(start) * Self.hopSeconds
            if duration - startTime >= minDuration {
                result.append(startTime...duration)
            }
        }
        return result
    }

    /// Snaps a cut point to the center of the nearest ≥120ms silence within
    /// ±`within` seconds; returns the input unchanged when none exists.
    func snap(_ time: Double, within: Double = 0.4) -> Double {
        let candidates = silences(minDuration: 0.12)
        var best: (center: Double, distance: Double)?
        for silence in candidates {
            let center = (silence.lowerBound + silence.upperBound) / 2
            // Prefer a silence the time already falls inside.
            if silence.contains(time) { return max(silence.lowerBound + 0.02, min(time, silence.upperBound - 0.02)) }
            let distance = abs(center - time)
            if distance <= within, distance < (best?.distance ?? .infinity) {
                best = (center, distance)
            }
        }
        return best?.center ?? time
    }

    /// Pauses longer than `longerThan` seconds — the tighten-silence targets.
    func pauses(longerThan threshold: Double) -> [ClosedRange<Double>] {
        silences(minDuration: threshold)
    }
}
