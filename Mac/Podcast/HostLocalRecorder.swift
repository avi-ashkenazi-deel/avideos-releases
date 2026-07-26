import AVFoundation
import CoreMedia
import Foundation
import os

/// Full-quality local recording of the host's camera and microphone.
///
/// Two independent `AVAssetWriter`s (video + audio) so a failure in one lane
/// never loses the other. Ingest methods are lock-guarded and allocation-light
/// so they can be called directly from the camera output queue and the audio
/// tap:
///
/// - `ingestVideo(_:)`     ← raw camera `CMSampleBuffer`s (StudioController's
///                            capture tap), passthrough dimensions up to 4K.
/// - `ingestMic(_:at:)`    ← `AVAudioPCMBuffer`s from the engine input tap,
///                            written as 48 kHz LPCM into .mov.
///
/// On the first sample of each lane a `ClockAnchor` maps media time 0 to the
/// session clock; every 10 s a `ChunkStamp` is appended for the drift fit
/// (host files aren't chunked — the stamp's `chunkIndex` counts 10 s windows).
final class HostLocalRecorder: @unchecked Sendable {

    enum VideoEncoderPreference: Sendable {
        /// ProRes 422 LT — the default full-quality mezzanine.
        case proRes422LT
        /// H.264 at 40 Mbps — fallback for machines/disks that can't keep up
        /// with ProRes.
        case h264HighBitrate
    }

    enum RecorderError: LocalizedError {
        case alreadyRecording
        case notRecording
        case directoryCreationFailed(String)
        case writerStartFailed(String)
        case writerFailed(lane: String, message: String)
        case noMediaCaptured

        var errorDescription: String? {
            switch self {
            case .alreadyRecording:
                return "A take is already being recorded."
            case .notRecording:
                return "No take is currently being recorded."
            case .directoryCreationFailed(let path):
                return "Could not create the recording folder at \(path)."
            case .writerStartFailed(let message):
                return "Could not start the local recording: \(message)"
            case .writerFailed(let lane, let message):
                return "The \(lane) recording failed: \(message)"
            case .noMediaCaptured:
                return "The take ended before any audio or video was captured."
            }
        }
    }

    /// Per-writer lane state (one for video, one for audio).
    private final class Lane {
        let kind: TrackKind
        let url: URL
        let writer: AVAssetWriter
        var input: AVAssetWriterInput?
        var anchor: ClockAnchor?
        var firstPTS: CMTime?
        var stamps: [ChunkStamp] = []
        var nextStampAtMediaMs: Double = 0
        var lastMediaMs: Double = 0
        var droppedSamples: Int = 0
        var failureMessage: String?
        var width: Int?
        var height: Int?
        var audioFormatDescription: CMAudioFormatDescription?

        init(kind: TrackKind, url: URL, writer: AVAssetWriter) {
            self.kind = kind
            self.url = url
            self.writer = writer
        }
    }

    /// Interval between drift-fit chunk stamps.
    private static let stampIntervalMs: Double = 10_000
    /// Passthrough cap: 4K DCI.
    private static let maxWidth = 4096
    private static let maxHeight = 2160

    private let sessionId: String
    private let hostParticipantId: String
    private let clock: SessionClock
    private let videoPreference: VideoEncoderPreference
    private let rootDirectory: URL
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "HostLocalRecorder")

    private let lock = NSLock()
    private var takeId: String?
    private var videoLane: Lane?
    private var audioLane: Lane?

    /// - Parameter rootDirectory: defaults to ~/Movies/AVideos/Sessions.
    init(
        sessionId: String,
        hostParticipantId: String,
        clock: SessionClock,
        videoPreference: VideoEncoderPreference = .proRes422LT,
        rootDirectory: URL? = nil
    ) {
        self.sessionId = sessionId
        self.hostParticipantId = hostParticipantId
        self.clock = clock
        self.videoPreference = videoPreference
        self.rootDirectory = rootDirectory
            ?? FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("AVideos/Sessions", isDirectory: true)
    }

    var isRecording: Bool {
        lock.lock()
        defer { lock.unlock() }
        return takeId != nil
    }

    // MARK: - Lifecycle

    /// Prepares both writers. Actual writing starts lazily on each lane's
    /// first ingested sample (dimensions/format aren't known until then).
    func start(takeId: String) async throws {
        lock.lock()
        defer { lock.unlock() }
        guard self.takeId == nil else { throw RecorderError.alreadyRecording }

        let sessionDir = rootDirectory.appendingPathComponent(sessionId, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        } catch {
            throw RecorderError.directoryCreationFailed(sessionDir.path)
        }

        func makeLane(_ kind: TrackKind) throws -> Lane {
            let url = sessionDir.appendingPathComponent("host-\(takeId)-\(kind.rawValue).mov")
            try? FileManager.default.removeItem(at: url)
            let writer: AVAssetWriter
            do {
                writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            } catch {
                throw RecorderError.writerStartFailed(error.localizedDescription)
            }
            return Lane(kind: kind, url: url, writer: writer)
        }

        videoLane = try makeLane(.video)
        audioLane = try makeLane(.audio)
        self.takeId = takeId
        log.info("recording started: take \(takeId, privacy: .public) in \(sessionDir.path, privacy: .public)")
    }

    /// Finalizes both writers and returns one `TrackRecord` per lane that
    /// captured media, with `localURL` set and `finalized == true`.
    func stop() async throws -> [TrackRecord] {
        lock.lock()
        guard takeId != nil else {
            lock.unlock()
            throw RecorderError.notRecording
        }
        let lanes = [videoLane, audioLane].compactMap { $0 }
        takeId = nil
        videoLane = nil
        audioLane = nil
        lock.unlock()

        var records: [TrackRecord] = []
        var firstFailure: RecorderError?

        for lane in lanes {
            switch lane.writer.status {
            case .writing:
                lane.input?.markAsFinished()
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    lane.writer.finishWriting { continuation.resume() }
                }
                if lane.writer.status == .failed {
                    let message = lane.writer.error?.localizedDescription ?? "unknown writer error"
                    log.error("\(lane.kind.rawValue, privacy: .public) writer failed on finish: \(message, privacy: .public)")
                    firstFailure = firstFailure ?? .writerFailed(lane: lane.kind.rawValue, message: message)
                    continue
                }
                if lane.droppedSamples > 0 {
                    log.warning("\(lane.kind.rawValue, privacy: .public) lane dropped \(lane.droppedSamples) samples (writer backpressure)")
                }
                records.append(makeRecord(for: lane))
            case .failed:
                let message = lane.failureMessage ?? lane.writer.error?.localizedDescription ?? "unknown writer error"
                firstFailure = firstFailure ?? .writerFailed(lane: lane.kind.rawValue, message: message)
                lane.writer.cancelWriting()
                try? FileManager.default.removeItem(at: lane.url)
            default:
                // Never received a sample — nothing to keep.
                lane.writer.cancelWriting()
                try? FileManager.default.removeItem(at: lane.url)
            }
        }

        if records.isEmpty {
            throw firstFailure ?? RecorderError.noMediaCaptured
        }
        if let firstFailure {
            // One lane survived; surface the other lane's failure in the log
            // and keep what we have — losing the good lane helps nobody.
            log.error("partial take: \(firstFailure.localizedDescription, privacy: .public)")
        }
        log.info("recording stopped: \(records.count) track(s) finalized")
        return records
    }

    private func makeRecord(for lane: Lane) -> TrackRecord {
        TrackRecord(
            participantId: hostParticipantId,
            kind: lane.kind,
            anchor: lane.anchor,
            chunkCount: 0, // host tracks are single local files, not chunked uploads
            chunkTimeline: lane.stamps,
            finalized: true,
            mimeType: "video/quicktime",
            width: lane.width,
            height: lane.height,
            localURL: lane.url
        )
    }

    // MARK: - Video ingest

    /// Call from the camera capture tap with raw camera sample buffers.
    /// Cheap no-op while not recording.
    func ingestVideo(_ sampleBuffer: CMSampleBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let lane = videoLane, takeId != nil, lane.failureMessage == nil else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid else { return }

        if lane.input == nil {
            guard let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
            do {
                try startVideoLane(lane, format: format, firstPTS: pts)
            } catch {
                lane.failureMessage = error.localizedDescription
                log.error("video lane start failed: \(error.localizedDescription, privacy: .public)")
                return
            }
        }

        append(sampleBuffer, pts: pts, to: lane)
    }

    private func startVideoLane(_ lane: Lane, format: CMFormatDescription, firstPTS: CMTime) throws {
        let dimensions = CMVideoFormatDescriptionGetDimensions(format)
        let (width, height) = Self.clampedToUHD(width: Int(dimensions.width), height: Int(dimensions.height))

        var settings: [String: Any] = [
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        switch videoPreference {
        case .proRes422LT:
            settings[AVVideoCodecKey] = AVVideoCodecType.proRes422LT
        case .h264HighBitrate:
            settings[AVVideoCodecKey] = AVVideoCodecType.h264
            settings[AVVideoCompressionPropertiesKey] = [
                AVVideoAverageBitRateKey: 40_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any]
        }

        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard lane.writer.canAdd(input) else {
            throw RecorderError.writerStartFailed("video input rejected by writer")
        }
        lane.writer.add(input)
        guard lane.writer.startWriting() else {
            throw RecorderError.writerStartFailed(lane.writer.error?.localizedDescription ?? "startWriting failed")
        }
        lane.writer.startSession(atSourceTime: firstPTS)
        lane.input = input
        lane.firstPTS = firstPTS
        lane.width = width
        lane.height = height
        // The first frame's PTS is its capture time; the tap delivers it a few
        // ms later. clock.now() at this point is a good-enough anchor — the
        // per-track drift fit and waveform alignment refine from here.
        lane.anchor = ClockAnchor(
            mediaTimeMs: 0,
            sessionTimeMs: clock.now(),
            uncertaintyMs: clock.uncertaintyMs
        )
        lane.nextStampAtMediaMs = 0
        log.info("video lane started \(width)x\(height) (\(String(describing: self.videoPreference), privacy: .public))")
    }

    // MARK: - Audio ingest

    /// Call from the microphone tap (`AVAudioEngine` input node tap or
    /// equivalent) with the tap's PCM buffers and their timestamps.
    func ingestMic(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
        lock.lock()
        defer { lock.unlock() }
        guard let lane = audioLane, takeId != nil, lane.failureMessage == nil else { return }
        guard buffer.frameLength > 0 else { return }

        let sampleRate = buffer.format.sampleRate
        let pts: CMTime
        if when.isSampleTimeValid {
            pts = CMTime(value: CMTimeValue(when.sampleTime), timescale: CMTimeScale(sampleRate))
        } else if when.isHostTimeValid {
            pts = CMTime(seconds: AVAudioTime.seconds(forHostTime: when.hostTime), preferredTimescale: 1_000_000_000)
        } else {
            return
        }

        if lane.input == nil {
            do {
                try startAudioLane(lane, format: buffer.format, firstPTS: pts, firstBuffer: buffer)
            } catch {
                lane.failureMessage = error.localizedDescription
                log.error("audio lane start failed: \(error.localizedDescription, privacy: .public)")
                return
            }
        }

        guard let sampleBuffer = makeSampleBuffer(from: buffer, pts: pts, lane: lane) else {
            lane.droppedSamples += 1
            return
        }
        append(sampleBuffer, pts: pts, to: lane)
    }

    private func startAudioLane(_ lane: Lane, format: AVAudioFormat, firstPTS: CMTime, firstBuffer: AVAudioPCMBuffer) throws {
        let channels = max(1, Int(format.channelCount))
        // 48 kHz LPCM in .mov; AVAssetWriter sample-rate-converts if the tap
        // runs at 44.1 kHz etc.
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 24,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard lane.writer.canAdd(input) else {
            throw RecorderError.writerStartFailed("audio input rejected by writer")
        }
        lane.writer.add(input)
        guard lane.writer.startWriting() else {
            throw RecorderError.writerStartFailed(lane.writer.error?.localizedDescription ?? "startWriting failed")
        }
        lane.writer.startSession(atSourceTime: firstPTS)
        lane.input = input
        lane.firstPTS = firstPTS
        // The tap hands us a buffer after capturing it, so "now" corresponds
        // to the buffer's END; back-date by the buffer duration to anchor the
        // first sample.
        let bufferDurationMs = Double(firstBuffer.frameLength) / format.sampleRate * 1_000.0
        lane.anchor = ClockAnchor(
            mediaTimeMs: 0,
            sessionTimeMs: clock.now() - bufferDurationMs,
            uncertaintyMs: clock.uncertaintyMs
        )
        lane.nextStampAtMediaMs = 0
        log.info("audio lane started: \(channels)ch @\(format.sampleRate, format: .fixed(precision: 0))Hz -> 48kHz LPCM")
    }

    private func makeSampleBuffer(from buffer: AVAudioPCMBuffer, pts: CMTime, lane: Lane) -> CMSampleBuffer? {
        if lane.audioFormatDescription == nil {
            lane.audioFormatDescription = buffer.format.formatDescription
        }
        guard let formatDescription = lane.audioFormatDescription else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buffer.format.sampleRate)),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        var status = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: nil,
            dataReady: false,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: formatDescription,
            sampleCount: CMItemCount(buffer.frameLength),
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 0,
            sampleSizeArray: nil,
            sampleBufferOut: &sampleBuffer
        )
        guard status == noErr, let sampleBuffer else { return nil }

        status = CMSampleBufferSetDataBufferFromAudioBufferList(
            sampleBuffer,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0,
            bufferList: buffer.audioBufferList
        )
        guard status == noErr else { return nil }
        return sampleBuffer
    }

    // MARK: - Shared append + stamping

    private func append(_ sampleBuffer: CMSampleBuffer, pts: CMTime, to lane: Lane) {
        guard let input = lane.input, let firstPTS = lane.firstPTS else { return }
        guard lane.writer.status == .writing else {
            if lane.writer.status == .failed, lane.failureMessage == nil {
                lane.failureMessage = lane.writer.error?.localizedDescription ?? "writer failed"
                log.error("\(lane.kind.rawValue, privacy: .public) writer failed mid-take: \(lane.failureMessage!, privacy: .public)")
            }
            return
        }

        if input.isReadyForMoreMediaData {
            if !input.append(sampleBuffer) {
                lane.failureMessage = lane.writer.error?.localizedDescription ?? "append failed"
                log.error("\(lane.kind.rawValue, privacy: .public) append failed: \(lane.failureMessage!, privacy: .public)")
                return
            }
        } else {
            // Real-time source: never block the capture thread; count and move on.
            lane.droppedSamples += 1
            return
        }

        let mediaMs = CMTimeSubtract(pts, firstPTS).seconds * 1_000.0
        lane.lastMediaMs = mediaMs
        if mediaMs >= lane.nextStampAtMediaMs {
            lane.stamps.append(ChunkStamp(
                chunkIndex: lane.stamps.count,
                mediaTimeMs: mediaMs,
                sessionTimeMs: clock.now()
            ))
            lane.nextStampAtMediaMs += Self.stampIntervalMs
        }
    }

    /// Scales (width, height) down to fit 4096x2160, preserving aspect ratio,
    /// rounded to even values. Passthrough when already within bounds.
    static func clampedToUHD(width: Int, height: Int) -> (Int, Int) {
        guard width > maxWidth || height > maxHeight else { return (width, height) }
        let scale = min(Double(maxWidth) / Double(width), Double(maxHeight) / Double(height))
        let even: (Double) -> Int = { Int(($0 / 2).rounded(.down)) * 2 }
        return (max(2, even(Double(width) * scale)), max(2, even(Double(height) * scale)))
    }
}
