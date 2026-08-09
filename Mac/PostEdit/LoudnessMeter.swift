import Foundation
import AVFoundation
import CoreMedia

/// Integrated programme loudness (ITU-R BS.1770-4 / EBU R128) for the export
/// pipeline: K-weighted, 400 ms blocks with 75% overlap, absolute (−70 LUFS)
/// then relative (−10 LU) gating. Measured over the SAME rendering the export
/// performs — an `AVAssetReaderAudioMixOutput` over the composition with the
/// export's own audio mix — so the number describes exactly the file the user
/// gets.
///
/// Also reports the sample peak so normalization can cap its makeup gain.
/// Sample peak, not true peak: without 4× oversampling an inter-sample
/// overshoot of up to ~0.5 dB can slip through, which is why normalization
/// leaves a full 1 dB of headroom rather than driving to 0 dBFS.
enum LoudnessMeter {
    struct Measurement {
        /// Integrated loudness in LUFS, or nil for effectively silent audio
        /// (every block below the −70 LUFS absolute gate).
        var integratedLUFS: Double?
        /// Linear sample peak (0…), pre-normalization.
        var samplePeak: Double
    }

    enum MeterError: Error {
        case cannotRead(String)
    }

    private static let sampleRate = 48_000.0
    private static let hopFrames = 4_800          // 100 ms
    private static let hopsPerBlock = 4           // 400 ms blocks, 75% overlap

    /// One channel of the two-stage K-weighting filter (BS.1770-4 Table 1/2
    /// coefficients, valid for 48 kHz — the reader output is pinned to 48 kHz
    /// for exactly this reason).
    private struct KWeighting {
        // Stage 1: high-shelf (head-model).
        private var s1 = Biquad(b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
                                a1: -1.69065929318241, a2: 0.73248077421585)
        // Stage 2: RLB high-pass.
        private var s2 = Biquad(b0: 1.0, b1: -2.0, b2: 1.0,
                                a1: -1.99004745483398, a2: 0.99007225036621)

        mutating func process(_ x: Double) -> Double {
            s2.process(s1.process(x))
        }
    }

    private struct Biquad {
        let b0, b1, b2, a1, a2: Double
        private var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0

        init(b0: Double, b1: Double, b2: Double, a1: Double, a2: Double) {
            self.b0 = b0; self.b1 = b1; self.b2 = b2; self.a1 = a1; self.a2 = a2
        }

        mutating func process(_ x: Double) -> Double {
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x
            y2 = y1; y1 = y
            return y
        }
    }

    /// Reads the composition through the mix and measures. Blocking work runs
    /// on its own queue — the caller's task (often main-actor-inherited) must
    /// not stall behind `copyNextSampleBuffer`.
    static func measure(composition: AVComposition, audioMix: AVAudioMix) async throws -> Measurement {
        let queue = DispatchQueue(label: "com.aviashkenazi.streamit.loudness", qos: .userInitiated)
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    continuation.resume(returning: try measureBlocking(composition: composition,
                                                                       audioMix: audioMix))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func measureBlocking(composition: AVComposition,
                                        audioMix: AVAudioMix) throws -> Measurement {
        let reader = try AVAssetReader(asset: composition)
        let output = AVAssetReaderAudioMixOutput(
            audioTracks: composition.tracks(withMediaType: .audio),
            audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 2,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsNonInterleaved: false,
            ])
        output.audioMix = audioMix
        guard reader.canAdd(output) else { throw MeterError.cannotRead("mix output rejected") }
        reader.add(output)
        guard reader.startReading() else {
            throw MeterError.cannotRead(reader.error?.localizedDescription ?? "reader failed to start")
        }

        var filters = (left: KWeighting(), right: KWeighting())
        var peak = 0.0

        // Per-hop sums of squares of the K-weighted signal, per channel.
        // A block is the last `hopsPerBlock` hops; overlap falls out for free.
        var hopSums: [(l: Double, r: Double)] = []
        var currentHop = (l: 0.0, r: 0.0)
        var framesIntoHop = 0
        // Mean square per gating block, channels summed (G = 1 for L and R).
        var blockMeanSquares: [Double] = []

        func closeHop() {
            hopSums.append(currentHop)
            currentHop = (0, 0)
            framesIntoHop = 0
            if hopSums.count >= hopsPerBlock {
                let window = hopSums.suffix(hopsPerBlock)
                let frames = Double(hopFrames * hopsPerBlock)
                let ms = window.reduce(0.0) { $0 + $1.l + $1.r } / frames
                blockMeanSquares.append(ms)
            }
        }

        while let sample = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var data = Data(count: length)
            data.withUnsafeMutableBytes { raw in
                _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length,
                                               destination: raw.baseAddress!)
            }
            data.withUnsafeBytes { raw in
                let floats = raw.bindMemory(to: Float32.self)
                var i = 0
                while i + 1 < floats.count {
                    let l = Double(floats[i]), r = Double(floats[i + 1])
                    peak = max(peak, abs(l), abs(r))
                    let kl = filters.left.process(l)
                    let kr = filters.right.process(r)
                    currentHop.l += kl * kl
                    currentHop.r += kr * kr
                    framesIntoHop += 1
                    if framesIntoHop == hopFrames { closeHop() }
                    i += 2
                }
            }
        }
        if reader.status == .failed {
            throw MeterError.cannotRead(reader.error?.localizedDescription ?? "read failed")
        }

        return Measurement(integratedLUFS: integrate(blockMeanSquares: blockMeanSquares),
                           samplePeak: peak)
    }

    private static func loudness(ofMeanSquare ms: Double) -> Double {
        -0.691 + 10 * log10(max(ms, .leastNormalMagnitude))
    }

    /// BS.1770 two-stage gating, pure so it is unit-testable.
    static func integrate(blockMeanSquares: [Double]) -> Double? {
        // Absolute gate.
        let audible = blockMeanSquares.filter { loudness(ofMeanSquare: $0) > -70 }
        guard !audible.isEmpty else { return nil }
        // Relative gate: 10 LU under the mean of what survived the absolute.
        let relativeThreshold = loudness(ofMeanSquare: audible.reduce(0, +) / Double(audible.count)) - 10
        let gated = audible.filter { loudness(ofMeanSquare: $0) > relativeThreshold }
        guard !gated.isEmpty else { return nil }
        return loudness(ofMeanSquare: gated.reduce(0, +) / Double(gated.count))
    }
}
