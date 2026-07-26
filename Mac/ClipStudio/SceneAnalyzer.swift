import Foundation
import AVFoundation
import Vision
import Accelerate
import os

/// Scene understanding over a session's tracks — the ground truth OpusClip
/// has to infer from a baked mix, we mostly already have:
///  (a) who's talking when — exact, from per-track audio RMS;
///  (b) faces/subject boxes per video track — Vision face detection sampled
///      at ~3fps;
///  (c) per-segment content classification (talking heads vs multi-person).
/// Produced once in the background; SmartReframer, clips, and B-roll read it.
struct SceneIndex: Codable {
    struct SpeakerSegment: Codable {
        var participantId: String
        var timeRange: ClosedRange<Double>
    }

    /// Normalized (0…1) face box at a sampled time, per video track.
    struct FaceSample: Codable {
        var time: Double
        var box: CGRect
    }

    var speakerTimeline: [SpeakerSegment]
    var faceSamples: [String: [FaceSample]]   // video EditTrack.id → samples
    var analyzedAt: Date
}

final class SceneAnalyzer {
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "sceneanalyzer")

    func analyze(tracks: [EditTrack],
                 onProgress: @escaping (Double) -> Void) async throws -> SceneIndex {
        // (a) Speaker timeline from per-track energy.
        var speakerTimeline: [SceneIndex.SpeakerSegment] = []
        let audioTracks = tracks.filter { $0.kind == .audio }
        var energies: [(participantId: String, energy: [Float])] = []
        for track in audioTracks {
            let snapper = SilenceSnapper()
            try await snapper.analyze(url: track.url)
            // Rebuild the energy series from the snapper's silence view:
            // active = not inside any silence.
            let silences = snapper.silences(minDuration: 0.25)
            let hop = 0.25
            var series: [Float] = []
            var t = 0.0
            while t < track.duration {
                let silent = silences.contains { $0.contains(t) }
                series.append(silent ? 0 : 1)
                t += hop
            }
            energies.append((track.participantId, series))
        }
        // Dominant speaker per hop → merged segments.
        if let maxLength = energies.map({ $0.energy.count }).max(), maxLength > 0 {
            var currentSpeaker: String?
            var segmentStart = 0.0
            let hop = 0.25
            for i in 0..<maxLength {
                let active = energies.filter { $0.energy.indices.contains(i) && $0.energy[i] > 0 }
                let speaker = active.count == 1 ? active[0].participantId : currentSpeaker
                if speaker != currentSpeaker {
                    if let current = currentSpeaker {
                        speakerTimeline.append(.init(participantId: current,
                                                     timeRange: segmentStart...(Double(i) * hop)))
                    }
                    currentSpeaker = speaker
                    segmentStart = Double(i) * hop
                }
            }
            if let current = currentSpeaker {
                speakerTimeline.append(.init(participantId: current,
                                             timeRange: segmentStart...(Double(maxLength) * hop)))
            }
        }
        onProgress(0.4)

        // (b) Face boxes per video track at ~3fps.
        var faceSamples: [String: [SceneIndex.FaceSample]] = [:]
        let videoTracks = tracks.filter { $0.kind == .video }
        for (index, track) in videoTracks.enumerated() {
            faceSamples[track.id] = try await sampleFaces(url: track.url, duration: track.duration)
            onProgress(0.4 + 0.6 * Double(index + 1) / Double(max(videoTracks.count, 1)))
        }

        return SceneIndex(speakerTimeline: speakerTimeline,
                          faceSamples: faceSamples,
                          analyzedAt: Date())
    }

    private func sampleFaces(url: URL, duration: Double) async throws -> [SceneIndex.FaceSample] {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 640, height: 640)   // detection needs no more
        generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)

        var samples: [SceneIndex.FaceSample] = []
        let step = 1.0 / 3.0
        var t = 0.0
        while t < duration {
            let time = CMTime(seconds: t, preferredTimescale: 600)
            if let cgImage = try? generator.copyCGImage(at: time, actualTime: nil) {
                let request = VNDetectFaceRectanglesRequest()
                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                try? handler.perform([request])
                // Track the LARGEST face (the subject); Vision boxes are
                // bottom-left normalized — flip to top-left canvas space.
                if let face = request.results?.max(by: { $0.boundingBox.area < $1.boundingBox.area }) {
                    var box = face.boundingBox
                    box.origin.y = 1 - box.origin.y - box.height
                    samples.append(.init(time: t, box: box))
                }
            }
            t += step
        }
        return samples
    }
}

private extension CGRect {
    var area: CGFloat { width * height }
}
