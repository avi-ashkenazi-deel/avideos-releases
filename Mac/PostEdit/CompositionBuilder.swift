import Foundation
import AVFoundation
import CoreImage
import CoreMedia
import os.log

/// Turns an `EditProject` (EDL + layout cues + captions) into playable /
/// exportable AVFoundation objects.
///
/// Timing model: for every *enabled* clip, the same source range is inserted
/// from every track at the same running cursor, so the composition timeline
/// == the edited timeline and all tracks stay in sync by construction
/// (tracks are pre-aligned to a common t = 0).
///
/// Micro-fades: a 15 ms fade-down/fade-up pair is applied to every audio
/// track around every join between segments (i.e. every cut boundary,
/// automated or manual — clicks don't care who made the cut). AVAudioMix
/// volume ramps are linear; two symmetric 7.5 ms ramps meeting at zero at the
/// join is the standard click-masking approximation of an equal-power
/// crossfade for butt-joined material on a single composition track.
/// AutoCleanup documents that it relies on this and adds no fades of its own.
final class CompositionBuilder {
    private static let logger = Logger(subsystem: "com.aviashkenazi.avideos", category: "CompositionBuilder")

    struct Options: Sendable {
        var includeVideo: Bool = true
        /// Only these track ids contribute video (nil = all video tracks).
        /// Audio tracks are always included.
        var enabledVideoTrackIDs: Set<String>? = nil
        /// Burn captions into the video composition (export; preview overlays
        /// captions in SwiftUI instead so style edits are instant).
        var burnCaptions: Bool = false
        /// nil → derived from the first layout cue (verticalStacked → 9:16).
        var renderSize: CGSize? = nil

        init() {}
    }

    struct Result {
        let composition: AVMutableComposition
        let audioMix: AVMutableAudioMix
        let videoComposition: AVMutableVideoComposition?
        /// Composition video track id → participant id (for the compositor
        /// and for debugging).
        let videoTrackParticipants: [CMPersistentTrackID: String]
    }

    static let crossfadeDuration: Double = 0.015
    static let timescale: CMTimeScale = 600

    private var assetCache: [URL: AVURLAsset] = [:]

    private func asset(for url: URL) -> AVURLAsset {
        if let cached = assetCache[url] { return cached }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        assetCache[url] = asset
        return asset
    }

    static func defaultRenderSize(for project: EditProject) -> CGSize {
        // Cues are source-time; edited t=0 may start mid-source (e.g. a
        // clip sub-project trimmed to a suggestion's range).
        let sourceStart = project.edl.mapTimelineToSource(0)
        if case .verticalStacked = project.layoutCues.layout(at: sourceStart) {
            return CGSize(width: 1080, height: 1920)
        }
        return CGSize(width: 1920, height: 1080)
    }

    // MARK: - Build

    func build(project: EditProject, options: Options = Options()) async throws -> Result {
        let composition = AVMutableComposition()
        let segments = project.edl.enabledSegments()
        guard !segments.isEmpty else {
            return Result(composition: composition, audioMix: AVMutableAudioMix(), videoComposition: nil, videoTrackParticipants: [:])
        }

        var mixParameters: [AVMutableAudioMixInputParameters] = []
        var videoTrackParticipants: [CMPersistentTrackID: String] = [:]
        var joinTimes: [Double] = []   // timeline seconds of every internal join
        do {
            var acc = 0.0
            for (clip, _) in segments.dropLast() {
                acc += clip.duration
                joinTimes.append(acc)
            }
        }

        for track in project.tracks {
            let asset = asset(for: track.url)
            let mediaType: AVMediaType = track.kind == .audio ? .audio : .video
            if track.kind == .video {
                guard options.includeVideo else { continue }
                if let allow = options.enabledVideoTrackIDs, !allow.contains(track.id) { continue }
            }
            guard let sourceTrack = try await asset.loadTracks(withMediaType: mediaType).first else {
                Self.logger.warning("track \(track.id, privacy: .public) has no \(mediaType.rawValue, privacy: .public) media; skipping")
                continue
            }
            let assetDuration = try await asset.load(.duration).seconds
            guard let compTrack = composition.addMutableTrack(withMediaType: mediaType,
                                                              preferredTrackID: kCMPersistentTrackID_Invalid) else {
                throw BuildError.cannotAddTrack(track.id)
            }
            if track.kind == .video {
                compTrack.preferredTransform = try await sourceTrack.load(.preferredTransform)
                videoTrackParticipants[compTrack.trackID] = track.participantId
            }

            for (clip, timelineStart) in segments {
                let at = CMTime(seconds: timelineStart, preferredTimescale: Self.timescale)
                let clipStart = clip.sourceRange.lowerBound
                let clipEnd = clip.sourceRange.upperBound
                // Clamp to the media this file actually has; pad the rest
                // with empty time so all tracks keep identical durations.
                let availableEnd = min(clipEnd, assetDuration)
                if clipStart < availableEnd {
                    let range = CMTimeRange(
                        start: CMTime(seconds: clipStart, preferredTimescale: Self.timescale),
                        end: CMTime(seconds: availableEnd, preferredTimescale: Self.timescale))
                    try compTrack.insertTimeRange(range, of: sourceTrack, at: at)
                }
                if availableEnd < clipEnd {
                    let emptyStart = timelineStart + max(0, availableEnd - clipStart)
                    compTrack.insertEmptyTimeRange(CMTimeRange(
                        start: CMTime(seconds: emptyStart, preferredTimescale: Self.timescale),
                        end: CMTime(seconds: timelineStart + clip.duration, preferredTimescale: Self.timescale)))
                }
            }

            if track.kind == .audio {
                mixParameters.append(Self.audioParameters(for: compTrack, joins: joinTimes))
            }
        }

        let audioMix = AVMutableAudioMix()
        audioMix.inputParameters = mixParameters

        var videoComposition: AVMutableVideoComposition?
        if options.includeVideo, !videoTrackParticipants.isEmpty {
            videoComposition = Self.makeVideoComposition(
                project: project,
                videoTrackParticipants: videoTrackParticipants,
                renderSize: options.renderSize ?? Self.defaultRenderSize(for: project),
                burnCaptions: options.burnCaptions)
        }

        return Result(composition: composition,
                      audioMix: audioMix,
                      videoComposition: videoComposition,
                      videoTrackParticipants: videoTrackParticipants)
    }

    enum BuildError: Error, LocalizedError {
        case cannotAddTrack(String)
        var errorDescription: String? {
            switch self {
            case .cannotAddTrack(let id): return "Could not add composition track for \(id)"
            }
        }
    }

    // MARK: - Audio mix

    private static func audioParameters(for track: AVMutableCompositionTrack,
                                        joins: [Double]) -> AVMutableAudioMixInputParameters {
        let params = AVMutableAudioMixInputParameters(track: track)
        params.setVolume(1.0, at: .zero)
        let half = crossfadeDuration / 2
        for join in joins {
            let downRange = CMTimeRange(
                start: CMTime(seconds: max(0, join - half), preferredTimescale: timescale),
                end: CMTime(seconds: join, preferredTimescale: timescale))
            let upRange = CMTimeRange(
                start: CMTime(seconds: join, preferredTimescale: timescale),
                duration: CMTime(seconds: half, preferredTimescale: timescale))
            params.setVolumeRamp(fromStartVolume: 1.0, toEndVolume: 0.0, timeRange: downRange)
            params.setVolumeRamp(fromStartVolume: 0.0, toEndVolume: 1.0, timeRange: upRange)
        }
        return params
    }

    // MARK: - Video composition

    private static func makeVideoComposition(project: EditProject,
                                             videoTrackParticipants: [CMPersistentTrackID: String],
                                             renderSize: CGSize,
                                             burnCaptions: Bool) -> AVMutableVideoComposition {
        let videoComposition = AVMutableVideoComposition()
        videoComposition.customVideoCompositorClass = LayoutVideoCompositor.self
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)

        let duration = project.editedDuration
        // Cues are source-anchored; the composition runs on the edited
        // timeline. Rather than mapping each cue forward — which is ambiguous
        // once a moment can play more than once — ask each *segment* which
        // layout was in force at its source position. Every segment then
        // carries the right layout at every occurrence, and a cue sitting
        // inside a cut simply never wins.
        let segments = project.edl.enabledSegments()
        var mappedCues: [LayoutCue] = []
        var previousLayout: ProgramLayout?
        for (clip, timelineStart) in segments {
            let layout = project.layoutCues.layout(at: clip.sourceRange.lowerBound, fallback: .grid)
            if layout != previousLayout {
                mappedCues.append(LayoutCue(atTime: timelineStart, layout: layout))
                previousLayout = layout
            }
        }

        // Layout boundaries, in edited time. A segment boundary only matters
        // here when the layout actually changes across it.
        var boundaries: [Double] = [0]
        for cue in mappedCues where cue.atTime > 0 && cue.atTime < duration {
            boundaries.append(cue.atTime)
        }
        boundaries.append(max(duration, 1.0 / 30.0))

        let speakerTimeline = Self.speakerTimeline(project: project)
        // Stable participant ordering for deterministic tiling.
        let orderedParticipants = project.videoTracks.map(\.participantId)

        var captionContext: CaptionRenderContext?
        if burnCaptions, let style = project.captions, let transcript = project.transcript {
            captionContext = CaptionRenderContext(
                words: transcript.enabledWords(edl: project.edl).map {
                    CaptionRenderContext.TimedWord(text: $0.word.text,
                                                   start: $0.timelineStart,
                                                   end: $0.timelineStart + $0.word.duration,
                                                   trackId: $0.word.trackId)
                },
                style: style)
        }

        var instructions: [LayoutCompositionInstruction] = []
        for i in 0..<(boundaries.count - 1) {
            let start = boundaries[i]
            let end = boundaries[i + 1]
            guard end > start else { continue }
            let instruction = LayoutCompositionInstruction(
                timeRange: CMTimeRange(
                    start: CMTime(seconds: start, preferredTimescale: timescale),
                    end: CMTime(seconds: end, preferredTimescale: timescale)),
                layout: mappedCues.layout(at: start, fallback: .grid),
                participantByTrackID: videoTrackParticipants,
                participantOrder: orderedParticipants,
                speakerTimeline: speakerTimeline,
                captionContext: captionContext,
                cropPaths: project.cropPaths ?? [:])
            instructions.append(instruction)
        }
        videoComposition.instructions = instructions
        return videoComposition
    }

    /// (timelineTime, participantId) change-points derived from the enabled
    /// transcript words — the compositor's data source for `.activeSpeaker`.
    private static func speakerTimeline(project: EditProject) -> [(time: Double, participantId: String)] {
        guard let transcript = project.transcript else { return [] }
        let trackToParticipant = Dictionary(uniqueKeysWithValues: project.tracks.map { ($0.id, $0.participantId) })
        var out: [(Double, String)] = []
        var current: String?
        for entry in transcript.enabledWords(edl: project.edl) {
            guard let pid = trackToParticipant[entry.word.trackId] else { continue }
            if pid != current {
                out.append((entry.timelineStart, pid))
                current = pid
            }
        }
        return out
    }
}

// MARK: - Instruction

/// One layout span of the edited timeline. Immutable after creation, safe to
/// hand to the compositor's queues.
final class LayoutCompositionInstruction: NSObject, AVVideoCompositionInstructionProtocol, @unchecked Sendable {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = false
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid

    let layout: ProgramLayout
    let participantByTrackID: [CMPersistentTrackID: String]
    /// Deterministic tiling order (import order of video tracks).
    let participantOrder: [String]
    let speakerTimeline: [(time: Double, participantId: String)]
    let captionContext: CaptionRenderContext?
    /// Smart-reframe crop paths per participant (normalized, y-down source
    /// space). Empty means center-crop, which is what every tile did before
    /// Clip Studio could compute paths.
    let cropPaths: [String: [CropKeyframe]]

    init(timeRange: CMTimeRange,
         layout: ProgramLayout,
         participantByTrackID: [CMPersistentTrackID: String],
         participantOrder: [String],
         speakerTimeline: [(time: Double, participantId: String)],
         captionContext: CaptionRenderContext?,
         cropPaths: [String: [CropKeyframe]] = [:]) {
        self.timeRange = timeRange
        self.layout = layout
        self.participantByTrackID = participantByTrackID
        self.participantOrder = participantOrder
        self.speakerTimeline = speakerTimeline
        self.captionContext = captionContext
        self.cropPaths = cropPaths
        self.requiredSourceTrackIDs = participantByTrackID.keys.map { NSNumber(value: $0) }
        super.init()
    }

    func participantId(at timelineTime: Double, fallback: String?) -> String? {
        var current: String? = fallback
        for (t, pid) in speakerTimeline {
            if t <= timelineTime { current = pid } else { break }
        }
        return current
    }
}

// MARK: - Compositor

/// Self-contained CoreImage compositor for the post-edit preview and export.
/// Deliberately has no dependency on the live-recording Metal engine: it only
/// needs CoreImage + the instruction above, so it can run inside
/// AVAssetExportSession and AVPlayer alike.
final class LayoutVideoCompositor: NSObject, AVVideoCompositing {
    private static let logger = Logger(subsystem: "com.aviashkenazi.avideos", category: "LayoutVideoCompositor")

    private let renderQueue = DispatchQueue(label: "com.aviashkenazi.avideos.postedit.compositor")
    private let ciContext = CIContext(options: [.cacheIntermediates: false,
                                                .name: "PostEditCompositor"])
    private var renderContext: AVVideoCompositionRenderContext?
    private var shouldCancel = false

    // verify on Mac: recent SDKs type these as [String: any Sendable]; older
    // SDKs use [String: Any] — adjust the two property signatures if the
    // compiler disagrees.
    var sourcePixelBufferAttributes: [String: any Sendable]? {
        [kCVPixelBufferPixelFormatTypeKey as String: [
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelFormatType_32BGRA,
        ]]
    }

    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] {
        [kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA]]
    }

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {
        renderQueue.sync { self.renderContext = newRenderContext }
    }

    func cancelAllPendingVideoCompositionRequests() {
        renderQueue.sync { shouldCancel = true }
        renderQueue.async { self.shouldCancel = false }
    }

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        renderQueue.async { [weak self] in
            guard let self else { return }
            if self.shouldCancel {
                request.finishCancelledRequest()
                return
            }
            autoreleasepool {
                do {
                    let buffer = try self.render(request: request)
                    request.finish(withComposedVideoFrame: buffer)
                } catch {
                    Self.logger.error("compose failed: \(error.localizedDescription, privacy: .public)")
                    request.finish(with: error)
                }
            }
        }
    }

    enum CompositorError: Error {
        case missingInstruction
        case cannotAllocateBuffer
    }

    private func render(request: AVAsynchronousVideoCompositionRequest) throws -> CVPixelBuffer {
        guard let instruction = request.videoCompositionInstruction as? LayoutCompositionInstruction else {
            throw CompositorError.missingInstruction
        }
        guard let output = request.renderContext.newPixelBuffer() else {
            throw CompositorError.cannotAllocateBuffer
        }
        let size = request.renderContext.size
        let canvas = CGRect(origin: .zero, size: size)
        let time = request.compositionTime.seconds

        // Collect the current frame per participant.
        var frames: [String: CIImage] = [:]
        for (trackID, participantId) in instruction.participantByTrackID {
            guard let pixelBuffer = request.sourceFrame(byTrackID: trackID) else { continue }
            frames[participantId] = CIImage(cvPixelBuffer: pixelBuffer)
        }

        var image = CIImage(color: CIColor.black).cropped(to: canvas)

        let tiles = Self.tiles(for: instruction, at: time, participants: instruction.participantOrder.filter { frames[$0] != nil }, canvas: canvas)
        for (participantId, rect) in tiles {
            guard let frame = frames[participantId] else { continue }
            let crop = instruction.cropPaths[participantId].map {
                SmartReframer.rect(at: time, in: $0)
            }
            image = Self.focusFill(frame, into: rect, normalizedCrop: crop).composited(over: image)
        }

        if let captions = instruction.captionContext,
           let overlay = CaptionRenderer.image(at: time,
                                               words: captions.words,
                                               style: captions.style,
                                               canvasSize: size) {
            image = overlay.composited(over: image)
        }

        ciContext.render(image, to: output, bounds: canvas, colorSpace: CGColorSpaceCreateDeviceRGB())
        return output
    }

    // MARK: Layout math (pure; unit-testable)

    /// Ordered (participant, rect) tiles for a layout at a timeline time.
    static func tiles(for instruction: LayoutCompositionInstruction,
                      at time: Double,
                      participants: [String],
                      canvas: CGRect) -> [(String, CGRect)] {
        guard !participants.isEmpty else { return [] }
        switch instruction.layout {
        case .fullScreen(let pid):
            let chosen = pid.flatMap { participants.contains($0) ? $0 : nil } ?? participants[0]
            return [(chosen, canvas)]

        case .activeSpeaker:
            let speaker = instruction.participantId(at: time, fallback: participants.first)
            let chosen = speaker.flatMap { participants.contains($0) ? $0 : nil } ?? participants[0]
            return [(chosen, canvas)]

        case .sideBySide:
            let shown = Array(participants.prefix(2))
            let w = canvas.width / CGFloat(max(shown.count, 1))
            return shown.enumerated().map { i, p in
                (p, CGRect(x: canvas.minX + CGFloat(i) * w, y: canvas.minY, width: w, height: canvas.height))
            }

        case .verticalStacked:
            let shown = Array(participants.prefix(2))
            let h = canvas.height / CGFloat(max(shown.count, 1))
            // Row 0 at the top of the frame. CoreImage origin is bottom-left.
            return shown.enumerated().map { i, p in
                (p, CGRect(x: canvas.minX,
                           y: canvas.maxY - CGFloat(i + 1) * h,
                           width: canvas.width,
                           height: h))
            }

        case .grid:
            let n = participants.count
            let columns = Int(ceil(sqrt(Double(n))))
            let rows = Int(ceil(Double(n) / Double(columns)))
            let w = canvas.width / CGFloat(columns)
            let h = canvas.height / CGFloat(rows)
            return participants.enumerated().map { i, p in
                let col = i % columns
                let row = i / columns
                return (p, CGRect(x: canvas.minX + CGFloat(col) * w,
                                  y: canvas.maxY - CGFloat(row + 1) * h,
                                  width: w,
                                  height: h))
            }
        }
    }

    /// Scale-to-fill with center crop, clamped to the destination rect.
    /// Aspect-fill, but first narrow the source to a smart-reframe crop
    /// window when one exists for this participant. `normalizedCrop` is
    /// y-DOWN (SceneAnalyzer flips Vision's boxes), while CoreImage's extent
    /// is y-up, hence the vertical flip.
    static func focusFill(_ image: CIImage, into rect: CGRect, normalizedCrop: CGRect?) -> CIImage {
        guard let crop = normalizedCrop else { return aspectFill(image, into: rect) }
        let extent = image.extent
        guard extent.width > 0, extent.height > 0,
              crop.width > 0, crop.height > 0 else {
            return aspectFill(image, into: rect)
        }
        let window = CGRect(x: extent.minX + crop.minX * extent.width,
                            y: extent.minY + (1 - crop.maxY) * extent.height,
                            width: crop.width * extent.width,
                            height: crop.height * extent.height)
        let cropped = image.cropped(to: window.intersection(extent))
        guard !cropped.extent.isEmpty else { return aspectFill(image, into: rect) }
        return aspectFill(cropped, into: rect)
    }

    static func aspectFill(_ image: CIImage, into rect: CGRect) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0, rect.width > 0, rect.height > 0 else {
            return image.cropped(to: rect)
        }
        let scale = max(rect.width / extent.width, rect.height / extent.height)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let dx = rect.midX - scaled.extent.midX
        let dy = rect.midY - scaled.extent.midY
        return scaled
            .transformed(by: CGAffineTransform(translationX: dx, y: dy))
            .cropped(to: rect)
    }
}
