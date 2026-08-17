import Foundation
import AVFoundation
import CoreImage
import CoreMedia
import ImageIO   // watermark decode (WatermarkContext)
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
    private static let logger = Logger(subsystem: "com.aviashkenazi.streamit", category: "CompositionBuilder")

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
        /// Apply each track's gain but ignore mute/solo. Set for stem exports:
        /// soloing a co-host to check a passage shouldn't silence everyone
        /// else's stem file.
        var ignoresMuteAndSolo: Bool = false
        /// Include cutaways — their picture, their audio, and the ducking they
        /// cause. Set false for stem exports: a stem is raw material, and
        /// ducking is a mix decision, so the same reasoning as the flag above.
        /// Without this, a stem would silently acquire cutaway audio, because
        /// the stems path copies the whole project.
        var includesExternalMedia: Bool = true
        /// Brand-kit watermark, drawn topmost (above captions). Export-only:
        /// ExportService resolves the kit's image; the preview stays clean.
        var watermark: WatermarkContext? = nil
        /// Loudness-normalization makeup gain, applied multiplicatively to
        /// EVERY audio source (participants, cutaways, bookends) so the mix
        /// balance is untouched. ExportService measures a first build with
        /// `LoudnessMeter`, then rebuilds with this set. 1 = off.
        var masterGainLinear: Float = 1

        init() {}
    }

    /// A resolved watermark, ready for the compositor: the decoded image plus
    /// the kit's placement. `@unchecked Sendable` is safe — CGImage is
    /// immutable and every field is a value.
    struct WatermarkContext: @unchecked Sendable {
        let image: CGImage
        /// Unit position of the watermark's CENTER, y-down like the document.
        let position: CGPoint
        let opacity: Double
        /// Fraction of the output width.
        let width: Double

        /// Builds from the brand kit, decoding the image; nil when the kit
        /// has no watermark or the file can't be read.
        init?(kit: BrandKit) {
            guard let url = kit.watermark.media?.resolve(),
                  let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
            self.image = image
            self.position = kit.watermark.position
            self.opacity = kit.watermark.opacity
            self.width = kit.watermark.width
        }
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
        var transforms: [CMPersistentTrackID: CGAffineTransform] = [:]
        var bookendTrackIDs: [CMPersistentTrackID: ProgramBookendSlot] = [:]
        var maxSourceFrameRate = 0.0
        var joinTimes: [Double] = []   // timeline seconds of every internal join
        do {
            var acc = 0.0
            for (clip, _) in segments.dropLast() {
                acc += clip.duration
                joinTimes.append(acc)
            }
        }

        // Cutaways go in first, because their inserted ranges are what the
        // participants' duck windows are derived from. Each gets its own
        // composition video track so overlapping cutaways can't collide.
        //
        // Stems skip them entirely: a stem is raw material, and ducking is a
        // mix decision — the same reasoning as ignoring mute and solo there.
        var inserted: [InsertedOverlay] = []
        if options.includesExternalMedia {
            inserted = try await Self.insertOverlayMedia(project.sortedOverlays,
                                                         into: composition,
                                                         includeVideo: options.includeVideo,
                                                         timelineOffset: options.includesExternalMedia
                                                            ? project.programOffset : 0,
                                                         masterGain: options.masterGainLinear,
                                                         speechDucks: { Self.speechDuckWindows(project: project, amountDB: $0) })
        }
        let ducks = options.includesExternalMedia
            ? Self.duckWindows(for: project.sortedOverlays, inserted: inserted)
            : []
        mixParameters.append(contentsOf: inserted.compactMap(\.audioParameters))
        let overlayTrackIDs = Dictionary(uniqueKeysWithValues:
            inserted.filter { $0.videoTrackID != kCMPersistentTrackID_Invalid }
                .map { ($0.videoTrackID, $0.overlayID) })

        if options.includesExternalMedia, project.hasBookends {
            let placed = try await Self.insertBookends(project, into: composition,
                                                       includeVideo: options.includeVideo,
                                                       masterGain: options.masterGainLinear)
            mixParameters.append(contentsOf: placed.audioParameters)
            bookendTrackIDs = placed.videoTrackIDs
            transforms.merge(placed.videoTransforms) { current, _ in current }
        }

        // The music bed sits under the conversation (not the bookends — an
        // intro stinger is usually music already). A mix decision, so stems
        // skip it with the cutaways.
        if options.includesExternalMedia, let bed = project.musicBed,
           let bedParameters = try await Self.insertMusicBed(bed,
                                                             project: project,
                                                             into: composition,
                                                             masterGain: options.masterGainLinear) {
            mixParameters.append(bedParameters)
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
                let transform = try await sourceTrack.load(.preferredTransform)
                compTrack.preferredTransform = transform
                videoTrackParticipants[compTrack.trackID] = track.participantId
                // The composition renders at the fastest source's rate (was
                // pinned to 30 fps, silently resampling 60 fps program
                // recordings and 24 fps film-look clips).
                if let fps = try? await sourceTrack.load(.nominalFrameRate), fps > 0 {
                    maxSourceFrameRate = max(maxSourceFrameRate, Double(fps))
                }
                // Carried to the compositor because it reads raw buffers via
                // `sourceFrame(byTrackID:)` and AVFoundation does not pre-apply
                // the transform for a custom compositor. Participant cameras
                // are always landscape so this never showed; a portrait phone
                // clip would render sideways.
                // verify on Mac: that AVFoundation really doesn't apply it here.
                if !transform.isIdentity { transforms[compTrack.trackID] = transform }
            }

            // Clamp to the media this file actually has and pad the rest with
            // empty time, so every track keeps an identical duration. An
            // external file's own t=0 may not be the session's, hence the
            // offset — zero for participant recordings, which start together.
            try MediaPlacement.apply(
                MediaPlacement.placements(
                    segments: segments,
                    sourceOffset: project.externalSettings(for: track.id)?.sourceOffset ?? 0,
                    assetDuration: assetDuration,
                    timelineOffset: options.includesExternalMedia ? project.programOffset : 0),
                of: sourceTrack, to: compTrack, timescale: Self.timescale)

            if track.kind == .audio {
                // Stems deliberately ignore mute/solo — a stem of a muted
                // track is still a stem you asked for — but do carry its gain.
                let gain = options.ignoresMuteAndSolo
                    ? project.mix(for: track.id).linearGain
                    : project.linearGain(for: track.id)
                mixParameters.append(Self.audioParameters(for: compTrack,
                                                          joins: joinTimes,
                                                          gain: gain * options.masterGainLinear,
                                                          ducks: ducks,
                                                          duration: project.editedDuration))
            }
        }

        let audioMix = AVMutableAudioMix()
        audioMix.inputParameters = mixParameters

        var videoComposition: AVMutableVideoComposition?
        if options.includeVideo, !videoTrackParticipants.isEmpty || !overlayTrackIDs.isEmpty {
            videoComposition = Self.makeVideoComposition(
                project: project,
                videoTrackParticipants: videoTrackParticipants,
                overlayTrackIDs: overlayTrackIDs,
                transforms: transforms,
                bookendTrackIDs: bookendTrackIDs,
                renderSize: options.renderSize ?? Self.defaultRenderSize(for: project),
                frameRate: maxSourceFrameRate,
                burnCaptions: options.burnCaptions,
                watermark: options.watermark)
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

    // MARK: - Bookends

    enum ProgramBookendSlot: String, Sendable { case intro, outro }

    private struct PlacedBookends {
        var videoTrackIDs: [CMPersistentTrackID: ProgramBookendSlot] = [:]
        /// Non-identity preferredTransforms — a phone-shot portrait intro must
        /// rotate upright exactly like a portrait cutaway does.
        var videoTransforms: [CMPersistentTrackID: CGAffineTransform] = [:]
        var audioParameters: [AVMutableAudioMixInputParameters] = []
    }

    /// Puts the intro at composition zero and the outro after the
    /// conversation. Each gets its own tracks, so neither can interfere with
    /// the participants' placement.
    private static func insertBookends(_ project: EditProject,
                                       into composition: AVMutableComposition,
                                       includeVideo: Bool,
                                       masterGain: Float = 1) async throws -> PlacedBookends {
        var placed = PlacedBookends()
        let slots: [(ProgramBookendSlot, BookendClip?, Double)] = [
            (.intro, project.bookends?.intro, 0),
            (.outro, project.bookends?.outro, project.programOffset + project.editedDuration),
        ]

        for (slot, clip, at) in slots {
            guard let clip else { continue }
            // Every skip is LOUD: a silently missing intro renders the whole
            // span black with nothing to explain why.
            guard let url = clip.media.resolve() else {
                logger.error("bookend \(slot.rawValue, privacy: .public) skipped: media does not resolve (\(clip.media.displayName, privacy: .public))")
                continue
            }
            let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            let assetDuration = try await asset.load(.duration).seconds
            let take = min(clip.duration, max(0, assetDuration - clip.sourceRange.lowerBound))
            guard take > 0 else {
                logger.error("bookend \(slot.rawValue, privacy: .public) skipped: zero playable duration")
                continue
            }

            let sourceRange = CMTimeRange(
                start: CMTime(seconds: clip.sourceRange.lowerBound, preferredTimescale: timescale),
                duration: CMTime(seconds: take, preferredTimescale: timescale))
            let start = CMTime(seconds: at, preferredTimescale: timescale)

            if includeVideo {
                if let sourceVideo = try await asset.loadTracks(withMediaType: .video).first,
                   let compTrack = composition.addMutableTrack(
                       withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
                    let transform = (try? await sourceVideo.load(.preferredTransform)) ?? .identity
                    compTrack.preferredTransform = transform
                    do {
                        try compTrack.insertTimeRange(sourceRange, of: sourceVideo, at: start)
                        placed.videoTrackIDs[compTrack.trackID] = slot
                        if !transform.isIdentity {
                            placed.videoTransforms[compTrack.trackID] = transform
                        }
                    } catch {
                        logger.error("bookend \(slot.rawValue, privacy: .public) video insert failed: \(error.localizedDescription, privacy: .public)")
                    }
                } else {
                    logger.error("bookend \(slot.rawValue, privacy: .public): file has no video track (\(url.lastPathComponent, privacy: .public))")
                }
            }
            if clip.audio.isEnabled,
               let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first,
               let compTrack = composition.addMutableTrack(
                   withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                do {
                    try compTrack.insertTimeRange(sourceRange, of: sourceAudio, at: start)
                    let params = AVMutableAudioMixInputParameters(track: compTrack)
                    params.setVolume(clip.audio.linearGain * masterGain, at: .zero)
                    placed.audioParameters.append(params)
                } catch {
                    logger.error("bookend \(slot.rawValue, privacy: .public) audio insert failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        return placed
    }

    // MARK: - Music bed

    /// Lays the bed's audio under the conversation: looped (or ended early)
    /// across the edited duration, faded at both edges, ducked under speech.
    private static func insertMusicBed(_ bed: MusicBed,
                                       project: EditProject,
                                       into composition: AVMutableComposition,
                                       masterGain: Float) async throws -> AVMutableAudioMixInputParameters? {
        guard let url = bed.media.resolve() else {
            logger.warning("Music bed missing: \(bed.media.displayName, privacy: .public)")
            return nil
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let sourceTrack = try await asset.loadTracks(withMediaType: .audio).first else {
            logger.warning("Music bed has no audio track: \(bed.media.displayName, privacy: .public)")
            return nil
        }
        let fileDuration = try await asset.load(.duration).seconds
        guard fileDuration > 0 else { return nil }

        let bedStart = project.programOffset
        let bedLength = project.editedDuration
        guard bedLength > 0,
              let compTrack = composition.addMutableTrack(withMediaType: .audio,
                                                          preferredTrackID: kCMPersistentTrackID_Invalid)
        else { return nil }

        // Tile the file across the span; a non-looping bed just ends early.
        var cursor = 0.0
        repeat {
            let take = min(fileDuration, bedLength - cursor)
            guard take > 0.05 else { break }
            try compTrack.insertTimeRange(
                CMTimeRange(start: .zero,
                            duration: CMTime(seconds: take, preferredTimescale: timescale)),
                of: sourceTrack,
                at: CMTime(seconds: bedStart + cursor, preferredTimescale: timescale))
            cursor += take
        } while bed.loops && cursor < bedLength

        // Ducks come from the transcript's word spans — anticipatory, like
        // cutaway ducking. No transcript means no ducking, just the bed level.
        let ducks = speechDuckWindows(project: project, amountDB: bed.duckAmountDB)
        let base = bed.linearGain * masterGain
        var points = VolumeAutomation.envelope(base: base,
                                               joins: [],
                                               ducks: ducks,
                                               crossfadeDuration: 0,
                                               duration: bedStart + bedLength)
        points = VolumeAutomation.fadedAtEdges(points,
                                               spanStart: bedStart,
                                               spanEnd: bedStart + min(cursor, bedLength),
                                               fade: bed.fadeSeconds)
        let params = AVMutableAudioMixInputParameters(track: compTrack)
        VolumeAutomation.apply(points, to: params, timescale: timescale)
        return params
    }

    /// Merged speech spans (program time) as duck windows for the music bed.
    /// Gaps under 0.8 s stay ducked — pumping between sentences is worse than
    /// staying down through a breath.
    static func speechDuckWindows(project: EditProject,
                                  amountDB: Double) -> [VolumeAutomation.DuckWindow] {
        guard amountDB > 0, let transcript = project.transcript else { return [] }
        let offset = project.programOffset
        let settings = DuckSettings(amountDB: amountDB, attack: 0.35, release: 0.7)

        var spans: [(start: Double, end: Double)] = []
        for entry in transcript.enabledWords(edl: project.edl) {
            let start = entry.timelineStart + offset
            let end = start + entry.word.duration
            if let last = spans.last, start - last.end < 0.8 {
                spans[spans.count - 1].end = max(last.end, end)
            } else {
                spans.append((start, end))
            }
        }
        return spans.map {
            VolumeAutomation.DuckWindow(start: $0.start, end: $0.end, settings: settings)
        }
    }

    // MARK: - Overlays (B-roll)

    /// What one cutaway actually got, once its media had its say.
    struct InsertedOverlay {
        var overlayID: UUID
        var videoTrackID: CMPersistentTrackID
        var audioParameters: AVMutableAudioMixInputParameters?
        /// The range that really made it into the composition — shorter than
        /// the authored one when the file ran out.
        var programRange: ClosedRange<Double>
    }

    /// Inserts each cutaway's video, and its audio when asked for, returning
    /// what was actually placed.
    ///
    /// Returning the *inserted* range rather than the authored one is what
    /// keeps ducking honest: a cutaway whose media is missing produces no duck
    /// at all, and one whose file is short ducks only for as long as it sounds.
    /// Deriving windows from `timelineRange` would leave the conversation
    /// ducked under silence.
    ///
    /// `includeVideo` is false for an audio master, which still wants the
    /// cutaway's sound and the ducking it causes but has no use for its picture.
    private static func insertOverlayMedia(_ overlays: [OverlayClip],
                                           into composition: AVMutableComposition,
                                           includeVideo: Bool,
                                           timelineOffset: Double,
                                           masterGain: Float = 1,
                                           speechDucks: (Double) -> [VolumeAutomation.DuckWindow] = { _ in [] }) async throws -> [InsertedOverlay] {
        var inserted: [InsertedOverlay] = []

        for overlay in overlays {
            guard let url = overlay.media.resolve() else {
                Self.logger.warning("B-roll media missing: \(overlay.media.displayName, privacy: .public)")
                continue
            }
            let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            let sourceTrack = try await asset.loadTracks(withMediaType: .video).first
            if includeVideo, sourceTrack == nil {
                Self.logger.warning("B-roll has no video track: \(overlay.media.displayName, privacy: .public)")
            }

            // Take as much of the cutaway as it actually has; a short clip
            // simply ends early rather than stretching.
            let assetDuration = try await asset.load(.duration).seconds
            let available = max(0, assetDuration - overlay.sourceStart)
            let take = min(overlay.duration, available)
            guard take >= EditDecisionList.minimumClipDuration else { continue }

            let sourceRange = CMTimeRange(
                start: CMTime(seconds: overlay.sourceStart, preferredTimescale: timescale),
                duration: CMTime(seconds: take, preferredTimescale: timescale))
            let programStart = overlay.timelineRange.lowerBound + timelineOffset
            let at = CMTime(seconds: programStart, preferredTimescale: timescale)

            var videoTrackID = kCMPersistentTrackID_Invalid
            if includeVideo, let sourceTrack {
                guard let compTrack = composition.addMutableTrack(
                    withMediaType: .video,
                    preferredTrackID: kCMPersistentTrackID_Invalid) else {
                    throw BuildError.cannotAddTrack("b-roll \(overlay.media.displayName)")
                }
                compTrack.preferredTransform = sourceTrack.preferredTransform
                do {
                    try compTrack.insertTimeRange(sourceRange, of: sourceTrack, at: at)
                    videoTrackID = compTrack.trackID
                } catch {
                    Self.logger.error("B-roll insert failed: \(error.localizedDescription, privacy: .public)")
                    composition.removeTrack(compTrack)
                    continue
                }
            }

            // The cutaway's own audio, on its own track, only when asked for.
            var audioParameters: AVMutableAudioMixInputParameters?
            if let audio = overlay.audio, audio.isEnabled,
               let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first,
               let audioTrack = composition.addMutableTrack(
                   withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                do {
                    try audioTrack.insertTimeRange(sourceRange, of: sourceAudio, at: at)
                    let start = programStart
                    let level = audio.linearGain * masterGain
                    let params = AVMutableAudioMixInputParameters(track: audioTrack)
                    if let duckDB = audio.duckUnderSpeechDB, duckDB > 0 {
                        // Music-clip behavior: THIS clip dips under speech,
                        // same engine as the music bed, faded at its edges.
                        var points = VolumeAutomation.envelope(
                            base: level,
                            joins: [],
                            ducks: speechDucks(duckDB),
                            crossfadeDuration: 0,
                            duration: start + take)
                        points = VolumeAutomation.fadedAtEdges(points,
                                                               spanStart: start,
                                                               spanEnd: start + take,
                                                               fade: 0.35)
                        VolumeAutomation.apply(points, to: params, timescale: timescale)
                    } else {
                        // Butt-joining against silence clicks, so give the
                        // clip's own edges the same short fade a cut boundary
                        // gets — via the shared envelope, one ramp emitter.
                        VolumeAutomation.apply([
                            .init(time: start, volume: 0),
                            .init(time: start + crossfadeDuration, volume: level),
                            .init(time: start + max(take - crossfadeDuration, crossfadeDuration),
                                  volume: level),
                            .init(time: start + take, volume: 0),
                        ], to: params, timescale: timescale)
                    }
                    audioParameters = params
                } catch {
                    Self.logger.error("B-roll audio insert failed: \(error.localizedDescription, privacy: .public)")
                    composition.removeTrack(audioTrack)
                }
            }

            inserted.append(InsertedOverlay(
                overlayID: overlay.id,
                videoTrackID: videoTrackID,
                audioParameters: audioParameters,
                programRange: programStart...(programStart + take)))
        }
        return inserted
    }

    /// Duck windows for everything that actually made it into the composition.
    static func duckWindows(for overlays: [OverlayClip],
                            inserted: [InsertedOverlay]) -> [VolumeAutomation.DuckWindow] {
        let byID = Dictionary(uniqueKeysWithValues: inserted.map { ($0.overlayID, $0.programRange) })
        return overlays.compactMap { overlay in
            guard let audio = overlay.audio, audio.isEnabled,
                  let ducking = audio.ducking,
                  let range = byID[overlay.id] else { return nil }
            return VolumeAutomation.DuckWindow(start: range.lowerBound,
                                               end: range.upperBound,
                                               settings: ducking)
        }
    }

    // MARK: - Audio mix

    /// Mix parameters for one audio track: the track's level trim, plus the
    /// micro-fade pair around every join.
    ///
    /// `gain` scales the ramp endpoints as well as the base volume. Ramping to
    /// a hardcoded 1.0 would make every cut boundary jump the track back to
    /// unity for 7.5 ms — an audible tick on any track that isn't at 0 dB.
    /// One envelope per track, covering both the micro-fades at cut boundaries
    /// and any ducking under external audio.
    ///
    /// These are computed together rather than layered, because their ramps
    /// overlap in time and overlapping `setVolumeRamp` ranges on one parameters
    /// object are not a defined composition — see `VolumeAutomation`.
    private static func audioParameters(for track: AVMutableCompositionTrack,
                                        joins: [Double],
                                        gain: Float,
                                        ducks: [VolumeAutomation.DuckWindow] = [],
                                        duration: Double) -> AVMutableAudioMixInputParameters {
        let params = AVMutableAudioMixInputParameters(track: track)
        // A silent track needs no envelope — and it can't be ducked below zero,
        // so mute and solo compose for free.
        guard gain > 0 else {
            params.setVolume(0, at: .zero)
            return params
        }
        let points = VolumeAutomation.envelope(base: gain,
                                               joins: joins,
                                               ducks: ducks,
                                               crossfadeDuration: crossfadeDuration,
                                               duration: duration)
        VolumeAutomation.apply(points, to: params, timescale: timescale)
        return params
    }

    // MARK: - Video composition

    private static func makeVideoComposition(project: EditProject,
                                             videoTrackParticipants: [CMPersistentTrackID: String],
                                             overlayTrackIDs: [CMPersistentTrackID: UUID],
                                             transforms: [CMPersistentTrackID: CGAffineTransform],
                                             bookendTrackIDs: [CMPersistentTrackID: ProgramBookendSlot],
                                             renderSize: CGSize,
                                             frameRate: Double,
                                             burnCaptions: Bool,
                                             watermark: WatermarkContext?) -> AVMutableVideoComposition {
        let videoComposition = AVMutableVideoComposition()
        videoComposition.customVideoCompositorClass = LayoutVideoCompositor.self
        videoComposition.renderSize = renderSize
        // Follow the fastest source, clamped to sane bounds; 30 when nothing
        // reported a rate (stills-only or unreadable).
        let fps = frameRate > 0 ? min(max(frameRate.rounded(), 24), 60) : 30
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))

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

        // Instruction boundaries, in edited time: wherever the layout changes,
        // and wherever a cutaway starts or ends — an instruction has one fixed
        // picture recipe, so an overlay appearing mid-instruction would be
        // invisible until the next one.
        var boundarySet: Set<Double> = [0]
        for cue in mappedCues where cue.atTime > 0 && cue.atTime < duration {
            boundarySet.insert(cue.atTime)
        }
        let overlays = project.sortedOverlays
        for overlay in overlays {
            for edge in [overlay.timelineRange.lowerBound, overlay.timelineRange.upperBound]
            where edge > 0 && edge < duration {
                boundarySet.insert(edge)
            }
        }
        var boundaries = boundarySet.sorted()
        boundaries.append(max(duration, 1.0 / 30.0))

        // Everything from here is emitted in PROGRAM time: the composition's
        // clock includes the intro, while all of the authoring above is in
        // edited time. This is the single conversion point.
        let offset = project.programOffset
        let speakerTimeline = Self.speakerTimeline(project: project)
            .map { (time: $0.time + offset, participantId: $0.participantId) }
        // Stable participant ordering for deterministic tiling.
        let orderedParticipants = project.videoTracks.map(\.participantId)

        var captionContext: CaptionRenderContext?
        if burnCaptions, let style = project.captions, let transcript = project.transcript {
            captionContext = CaptionRenderContext(
                words: transcript.enabledWords(edl: project.edl).map {
                    CaptionRenderContext.TimedWord(text: $0.word.text,
                                                   start: $0.timelineStart + offset,
                                                   end: $0.timelineStart + offset + $0.word.duration,
                                                   trackId: $0.word.trackId)
                },
                style: style)
        }

        var instructions: [LayoutCompositionInstruction] = []
        for i in 0..<(boundaries.count - 1) {
            let start = boundaries[i]
            let end = boundaries[i + 1]
            guard end > start else { continue }
            // Cutaways covering the middle of this instruction's span. The
            // boundary set above guarantees an overlay either covers a whole
            // instruction or none of it, so testing the midpoint is exact.
            let midpoint = (start + end) / 2
            let activeOverlays = overlays.filter {
                $0.timelineRange.lowerBound <= midpoint && midpoint < $0.timelineRange.upperBound
            }
            let activeOverlayTracks: [CMPersistentTrackID: OverlayClip] = activeOverlays
                .reduce(into: [:]) { result, overlay in
                    if let trackID = overlayTrackIDs.first(where: { $0.value == overlay.id })?.key {
                        result[trackID] = overlay
                    }
                }

            let instruction = LayoutCompositionInstruction(
                timeRange: CMTimeRange(
                    start: CMTime(seconds: start + offset, preferredTimescale: timescale),
                    end: CMTime(seconds: end + offset, preferredTimescale: timescale)),
                layout: mappedCues.layout(at: start, fallback: .grid),
                participantByTrackID: videoTrackParticipants,
                participantOrder: orderedParticipants,
                speakerTimeline: speakerTimeline,
                captionContext: captionContext,
                cropPaths: project.cropPaths ?? [:],
                overlaysByTrackID: activeOverlayTracks,
                transformByTrackID: transforms,
                watermark: watermark)
            instructions.append(instruction)
        }

        // Bookends are ordinary instructions whose only lane is the bookend's
        // own track, shown full screen — so `tiles(...)` is reused verbatim and
        // no participant can leak into the intro.
        for (trackID, slot) in bookendTrackIDs {
            let lane = "bookend-\(slot.rawValue)"
            let range = slot == .intro
                ? 0...offset
                : (offset + duration)...project.programDuration
            guard range.upperBound > range.lowerBound else { continue }
            instructions.append(LayoutCompositionInstruction(
                timeRange: CMTimeRange(
                    start: CMTime(seconds: range.lowerBound, preferredTimescale: timescale),
                    end: CMTime(seconds: range.upperBound, preferredTimescale: timescale)),
                layout: .fullScreen(participantId: lane),
                participantByTrackID: [trackID: lane],
                participantOrder: [lane],
                speakerTimeline: [],
                captionContext: nil,
                transformByTrackID: transforms.filter { $0.key == trackID }))
        }
        instructions.sort { $0.timeRange.start < $1.timeRange.start }
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
    /// B-roll cutaways playing across this whole instruction, by the
    /// composition track carrying each one.
    let overlaysByTrackID: [CMPersistentTrackID: OverlayClip]
    /// Non-identity `preferredTransform` per track. Empty for the usual case
    /// of landscape participant cameras.
    let transformByTrackID: [CMPersistentTrackID: CGAffineTransform]
    /// Brand-kit watermark, drawn topmost. Export-only (nil in previews).
    let watermark: CompositionBuilder.WatermarkContext?

    init(timeRange: CMTimeRange,
         layout: ProgramLayout,
         participantByTrackID: [CMPersistentTrackID: String],
         participantOrder: [String],
         speakerTimeline: [(time: Double, participantId: String)],
         captionContext: CaptionRenderContext?,
         cropPaths: [String: [CropKeyframe]] = [:],
         overlaysByTrackID: [CMPersistentTrackID: OverlayClip] = [:],
         transformByTrackID: [CMPersistentTrackID: CGAffineTransform] = [:],
         watermark: CompositionBuilder.WatermarkContext? = nil) {
        self.timeRange = timeRange
        self.layout = layout
        self.participantByTrackID = participantByTrackID
        self.participantOrder = participantOrder
        self.speakerTimeline = speakerTimeline
        self.captionContext = captionContext
        self.cropPaths = cropPaths
        self.overlaysByTrackID = overlaysByTrackID
        self.transformByTrackID = transformByTrackID
        self.watermark = watermark
        // Overlay tracks must be requested too, or `sourceFrame(byTrackID:)`
        // returns nothing for them and the cutaway silently never appears.
        self.requiredSourceTrackIDs = (Array(participantByTrackID.keys)
                                       + Array(overlaysByTrackID.keys))
            .map { NSNumber(value: $0) }
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
    private static let logger = Logger(subsystem: "com.aviashkenazi.streamit", category: "LayoutVideoCompositor")

    private let renderQueue = DispatchQueue(label: "com.aviashkenazi.streamit.postedit.compositor")
    private let ciContext = CIContext(options: [.cacheIntermediates: false,
                                                .name: "PostEditCompositor"])
    private var renderContext: AVVideoCompositionRenderContext?
    private var shouldCancel = false
    /// Lanes that have already been reported as frame-starved (renderQueue).
    private var starvedLanes: Set<String> = []

    // `[String: any Sendable]` is what the macOS 26 SDK declares. Older SDKs
    // used `[String: Any]`; if this ever has to build against one, both
    // property signatures change together.
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
            guard let pixelBuffer = request.sourceFrame(byTrackID: trackID) else {
                // Once per lane, not per frame: a lane that never delivers
                // (e.g. an intro that decodes to nothing) otherwise renders
                // silent black with no trail to follow.
                if starvedLanes.insert(participantId).inserted {
                    Self.logger.error("no source frame for lane \(participantId, privacy: .public) (track \(trackID)) at \(time, format: .fixed(precision: 2))s")
                }
                continue
            }
            var image = CIImage(cvPixelBuffer: pixelBuffer)
            if let transform = instruction.transformByTrackID[trackID] {
                // Rotate a portrait or otherwise transformed source upright
                // before it is fitted, then re-origin it — a transformed image
                // can end up with a negative extent origin, which would place
                // the tile off-canvas.
                image = image.transformed(by: transform)
                image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX,
                                                                y: -image.extent.minY))
            }
            frames[participantId] = image
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

        // B-roll sits above the participants and below the captions: a cutaway
        // should hide faces, but subtitles have to stay readable over it.
        for (trackID, overlay) in instruction.overlaysByTrackID {
            guard let buffer = request.sourceFrame(byTrackID: trackID) else { continue }
            let frame = CIImage(cvPixelBuffer: buffer)
            let target = overlay.mode == .fullFrame
                ? canvas
                : CGRect(x: canvas.minX + overlay.insetRect.minX * canvas.width,
                         // insetRect is y-down like the rest of the document;
                         // CoreImage is y-up.
                         y: canvas.minY + (1 - overlay.insetRect.maxY) * canvas.height,
                         width: overlay.insetRect.width * canvas.width,
                         height: overlay.insetRect.height * canvas.height)
            var placed = Self.aspectFill(frame, into: target)
            if overlay.opacity < 1 {
                placed = placed.applyingFilter("CIColorMatrix", parameters: [
                    "inputAVector": CIVector(x: 0, y: 0, z: 0, w: overlay.opacity),
                ])
            }
            image = placed.composited(over: image)
        }

        if let captions = instruction.captionContext,
           let overlay = CaptionRenderer.image(at: time,
                                               words: captions.words,
                                               style: captions.style,
                                               canvasSize: size) {
            image = overlay.composited(over: image)
        }

        // Brand-kit watermark, topmost — above captions on purpose: a logo
        // half-hidden behind a subtitle line reads as a rendering bug.
        if let watermark = instruction.watermark {
            var mark = CIImage(cgImage: watermark.image)
            let markExtent = mark.extent
            if markExtent.width > 0, markExtent.height > 0 {
                let targetWidth = canvas.width * watermark.width
                let scale = targetWidth / markExtent.width
                mark = mark.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                // Kit position is the unit CENTER, y-down; CoreImage is y-up.
                let center = CGPoint(x: canvas.width * watermark.position.x,
                                     y: canvas.height * (1 - watermark.position.y))
                mark = mark.transformed(by: CGAffineTransform(
                    translationX: center.x - mark.extent.width / 2 - mark.extent.minX,
                    y: center.y - mark.extent.height / 2 - mark.extent.minY))
                if watermark.opacity < 1 {
                    mark = mark.applyingFilter("CIColorMatrix", parameters: [
                        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: watermark.opacity),
                    ])
                }
                image = mark.composited(over: image)
            }
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
