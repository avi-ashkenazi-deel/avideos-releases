import Foundation
import AVFoundation
import Accelerate

/// Audio-syncs a second camera against the session: finds where an external
/// file's soundtrack lines up with a reference track by cross-correlating
/// their energy envelopes, and returns the file's `sourceOffset` (session
/// seconds at which the file's own t=0 sits — `MediaPlacement`'s convention).
///
/// Envelope correlation rather than raw-sample correlation on purpose: the
/// two recordings are different microphones in the same room, so their
/// waveforms differ wildly while their energy contours (who spoke when)
/// match — and at a 20 ms hop the search is thousands of points, not
/// millions. Accuracy is therefore ~±20 ms: right at the edge of lip-sync
/// perception, and the ±0.5 s nudge buttons remain for taste.
enum AudioAligner {
    /// 20 ms hop = 50 envelope samples per second.
    static let hopSeconds = 0.02
    private static let hopSamples = Int(48_000 * hopSeconds)
    /// Template: one minute of the external file's audio.
    private static let templateSeconds = 60.0

    struct Alignment {
        /// Session seconds at which the external file's t=0 sits. Negative
        /// means the external camera started rolling before the session.
        var sourceOffset: Double
        /// Peak-to-sidelobe score; higher is more certain. Below ~4 the match
        /// is reported as unreliable rather than applied silently.
        var confidence: Double
    }

    enum AlignError: LocalizedError {
        case unreadable(String)
        case tooShort
        case noConfidentMatch

        var errorDescription: String? {
            switch self {
            case .unreadable(let name): return "\(name) has no readable audio."
            case .tooShort: return "The recordings are too short to sync by audio."
            case .noConfidentMatch:
                return "No confident audio match — the recordings may not overlap. Use the offset nudge instead."
            }
        }
    }

    /// Aligns `externalURL` against `referenceURL` (a participant's audio).
    static func align(externalURL: URL, referenceURL: URL) async throws -> Alignment {
        async let externalEnvelope = envelope(url: externalURL)
        async let referenceEnvelope = envelope(url: referenceURL)
        let (external, reference) = try await (externalEnvelope, referenceEnvelope)
        return try alignEnvelopes(external: external, reference: reference)
    }

    /// Pure correlation core, unit-testable with synthetic envelopes.
    static func alignEnvelopes(external: [Float], reference: [Float]) throws -> Alignment {
        let templateLength = Int(templateSeconds / hopSeconds)
        guard external.count >= templateLength / 2, reference.count >= templateLength / 2 else {
            throw AlignError.tooShort
        }

        // Template: the most energetic stretch of the external file's first
        // five minutes — skipping a silent head, which correlates with
        // everything equally badly.
        let usableTemplate = min(templateLength, external.count)
        let searchHead = min(external.count - usableTemplate, Int(300 / hopSeconds))
        var templateStart = 0
        var bestEnergy: Float = -1
        var start = 0
        while start <= searchHead {
            var sum: Float = 0
            external.withUnsafeBufferPointer { buf in
                vDSP_sve(buf.baseAddress! + start, 1, &sum, vDSP_Length(usableTemplate))
            }
            if sum > bestEnergy {
                bestEnergy = sum
                templateStart = start
            }
            start += usableTemplate / 4
        }
        var template = Array(external[templateStart..<(templateStart + usableTemplate)])
        guard reference.count >= usableTemplate else { throw AlignError.tooShort }

        // Zero-mean both sides so loudness offsets don't bias the peak.
        var mean: Float = 0
        vDSP_meanv(template, 1, &mean, vDSP_Length(template.count))
        var negMean = -mean
        vDSP_vsadd(template, 1, &negMean, &template, 1, vDSP_Length(template.count))
        var signal = [Float](repeating: 0, count: reference.count)
        vDSP_meanv(reference, 1, &mean, vDSP_Length(reference.count))
        negMean = -mean
        vDSP_vsadd(reference, 1, &negMean, &signal, 1, vDSP_Length(reference.count))

        // Sliding correlation of the template over the reference.
        let lags = signal.count - template.count + 1
        var correlation = [Float](repeating: 0, count: lags)
        signal.withUnsafeBufferPointer { sig in
            template.withUnsafeBufferPointer { tmp in
                // vDSP_conv with a POSITIVE filter stride is correlation.
                vDSP_conv(sig.baseAddress!, 1,
                          tmp.baseAddress!, 1,
                          &correlation, 1,
                          vDSP_Length(lags), vDSP_Length(template.count))
            }
        }

        var peak: Float = 0
        var peakIndex: vDSP_Length = 0
        vDSP_maxvi(correlation, 1, &peak, &peakIndex, vDSP_Length(lags))

        // Peak-to-sidelobe: compare against the correlation's spread away
        // from the peak (±2 s excluded), the standard "is this a real lock"
        // test. A flat or multi-peaked surface means don't trust it.
        let exclusion = Int(2.0 / hopSeconds)
        var rest: [Float] = []
        rest.reserveCapacity(lags)
        for (i, value) in correlation.enumerated() where abs(i - Int(peakIndex)) > exclusion {
            rest.append(value)
        }
        guard !rest.isEmpty else { throw AlignError.tooShort }
        var restMean: Float = 0
        vDSP_meanv(rest, 1, &restMean, vDSP_Length(rest.count))
        var centered = [Float](repeating: 0, count: rest.count)
        var negRestMean = -restMean
        vDSP_vsadd(rest, 1, &negRestMean, &centered, 1, vDSP_Length(rest.count))
        var restRMS: Float = 0
        vDSP_rmsqv(centered, 1, &restRMS, vDSP_Length(centered.count))
        let confidence = restRMS > 0 ? Double((peak - restMean) / restRMS) : 0
        guard confidence >= 4 else { throw AlignError.noConfidentMatch }

        // Template start Te (file time) matched reference time Tr ⇒ the
        // file's t=0 sits at session time Tr − Te.
        let matchedReferenceTime = Double(peakIndex) * hopSeconds
        let templateFileTime = Double(templateStart) * hopSeconds
        return Alignment(sourceOffset: matchedReferenceTime - templateFileTime,
                         confidence: confidence)
    }

    /// RMS energy envelope at the hop rate — the same extraction
    /// SilenceSnapper uses (and it shares that file's `verify on Mac:` about
    /// AVAssetReaderTrackOutput sample-rate/mono conversion).
    private static func envelope(url: URL) async throws -> [Float] {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .audio).first else {
            throw AlignError.unreadable(url.lastPathComponent)
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
        guard !hops.isEmpty else { throw AlignError.unreadable(url.lastPathComponent) }
        return hops
    }
}
