import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import Metal
import os

/// Records the composited program (video) + mixed program audio to disk while
/// live. Just another consumer of the render loop — start/stop freely.
///
/// Container: .mov with `movieFragmentInterval` = 5s so a crash loses at most
/// the last five seconds. Video: HEVC by default (hardware encode everywhere
/// we deploy), H.264 toggle for compatibility. Audio: AAC 48kHz stereo fed by
/// the audio graph's program tap — both sides stamp against the host clock,
/// so A/V sync holds by construction.
final class ProgramRecorder: ProgramFrameConsumer {
    enum Codec: String, CaseIterable {
        case hevc
        case h264

        var avCodec: AVVideoCodecType {
            switch self {
            case .hevc: .hevc
            case .h264: .h264
            }
        }
    }

    enum RecorderState: Equatable {
        case idle
        case recording(startedAt: Date)
        case failed(String)
    }

    private(set) var state: RecorderState = .idle
    private(set) var outputURL: URL?
    private(set) var droppedVideoFrames = 0

    /// Paused mid-take. `AVAssetWriter` has no pause API — see the
    /// timeline-compaction note on `pause()`.
    private(set) var isPaused = false

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sessionStarted = false
    private var firstVideoTime: CMTime = .invalid

    /// Host time the current pause began (`.invalid` when running).
    private var pauseStartedAtHostTime: CMTime = .invalid
    /// Total time spent paused so far, subtracted from every appended
    /// timestamp so the file has no gap.
    private var pausedDuration: CMTime = .zero
    /// Host time of the last resume. Anything stamped earlier than this is
    /// stale pause-window media and must be dropped, or the compacted
    /// timeline would go backwards.
    private var resumedAtHostTime: CMTime = .invalid

    private let queue = DispatchQueue(label: "com.aviashkenazi.streamit.recorder", qos: .userInitiated)
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "recorder")

    var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }

    /// Media actually written so far, i.e. wall time minus every paused span —
    /// which is exactly the duration of the finished file. This is the number
    /// the HUD counts up.
    var recordedDuration: TimeInterval {
        guard case .recording(let startedAt) = state else { return 0 }
        var paused = pausedDuration.seconds
        if isPaused, pauseStartedAtHostTime.isValid {
            paused += CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()),
                                     pauseStartedAtHostTime).seconds
        }
        return max(0, Date().timeIntervalSince(startedAt) - paused)
    }

    // MARK: - Lifecycle

    /// Starts a recording session. `audioFormat` comes from the audio graph
    /// (48kHz stereo Float32) and is transcoded to AAC by the writer.
    func start(canvasSize: CGSize,
               frameRate: Int,
               codec: Codec = .hevc,
               projectName: String,
               folderPath: String? = nil) throws {
        try queue.sync {
            guard writer == nil else { return }

            let url = Self.outputURL(projectName: projectName, folderPath: folderPath)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)

            let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
            writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)

            let width = Int(canvasSize.width)
            let height = Int(canvasSize.height)
            let bitrate = Self.bitrate(width: width, height: height, fps: frameRate, codec: codec)

            let videoSettings: [String: Any] = [
                AVVideoCodecKey: codec.avCodec,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
                ],
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: bitrate,
                    AVVideoExpectedSourceFrameRateKey: frameRate,
                    AVVideoMaxKeyFrameIntervalKey: frameRate * 2,
                ],
            ]
            let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
            videoInput.expectsMediaDataInRealTime = true
            let adaptor = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: videoInput,
                sourcePixelBufferAttributes: [
                    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                    kCVPixelBufferWidthKey as String: width,
                    kCVPixelBufferHeightKey as String: height,
                ])
            guard writer.canAdd(videoInput) else {
                throw NSError(domain: "ProgramRecorder", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Can't add video input"])
            }
            writer.add(videoInput)

            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 256_000,
            ]
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            audioInput.expectsMediaDataInRealTime = true
            if writer.canAdd(audioInput) {
                writer.add(audioInput)
            }

            guard writer.startWriting() else {
                throw writer.error ?? NSError(domain: "ProgramRecorder", code: 2,
                                              userInfo: [NSLocalizedDescriptionKey: "Writer failed to start"])
            }

            self.writer = writer
            self.videoInput = videoInput
            self.audioInput = audioInput
            self.pixelBufferAdaptor = adaptor
            self.sessionStarted = false
            self.firstVideoTime = .invalid
            self.isPaused = false
            self.pauseStartedAtHostTime = .invalid
            self.pausedDuration = .zero
            self.resumedAtHostTime = .invalid
            self.outputURL = url
            self.droppedVideoFrames = 0
            self.state = .recording(startedAt: Date())
            self.log.info("Recording to \(url.path)")
        }
    }

    func stop(completion: @escaping (URL?) -> Void) {
        queue.async { [weak self] in
            guard let self, let writer = self.writer else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            let url = self.outputURL
            self.videoInput?.markAsFinished()
            self.audioInput?.markAsFinished()
            writer.finishWriting {
                DispatchQueue.main.async {
                    completion(writer.status == .completed ? url : nil)
                }
            }
            self.writer = nil
            self.videoInput = nil
            self.audioInput = nil
            self.pixelBufferAdaptor = nil
            self.isPaused = false
            self.pauseStartedAtHostTime = .invalid
            self.pausedDuration = .zero
            self.resumedAtHostTime = .invalid
            self.state = .idle
        }
    }

    // MARK: - Pause / resume

    /// Pauses mid-take. There is no `AVAssetWriter.pause()`, so this works by
    /// **compacting the timeline**: while paused nothing is appended, and every
    /// timestamp appended afterwards has the accumulated paused span
    /// subtracted from it. The file therefore contains no gap — it plays as if
    /// the pause never happened — and video and audio stay in sync because
    /// both sides are stamped against the same host clock and get the same
    /// offset.
    ///
    /// Not a `RecorderState` case on purpose: the writer really is still
    /// writing, `outputURL` is still the take in progress, and every existing
    /// `isRecording` check should stay true through a pause.
    func pause() {
        queue.async { [weak self] in
            guard let self, self.writer != nil, !self.isPaused else { return }
            self.isPaused = true
            self.pauseStartedAtHostTime = CMClockGetTime(CMClockGetHostTimeClock())
            self.log.info("Recording paused")
        }
    }

    func resume() {
        queue.async { [weak self] in
            guard let self, self.writer != nil, self.isPaused else { return }
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            if self.pauseStartedAtHostTime.isValid {
                self.pausedDuration = CMTimeAdd(
                    self.pausedDuration,
                    CMTimeSubtract(now, self.pauseStartedAtHostTime))
            }
            self.isPaused = false
            self.pauseStartedAtHostTime = .invalid
            self.resumedAtHostTime = now
            self.log.info("Recording resumed")
        }
    }

    func setPaused(_ paused: Bool) {
        paused ? pause() : resume()
    }

    // MARK: - ProgramFrameConsumer (render queue)

    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime) {
        queue.async { [weak self] in
            guard let self,
                  let writer = self.writer,
                  let videoInput = self.videoInput,
                  let adaptor = self.pixelBufferAdaptor,
                  writer.status == .writing else { return }

            // Paused: not a dropped frame, a deliberately unwritten one.
            if self.isPaused { return }
            // A frame stamped inside the pause window but delivered after the
            // resume would compact to a timestamp at or before the last one
            // written, which the writer rejects.
            if self.resumedAtHostTime.isValid, time < self.resumedAtHostTime { return }

            let pts = CMTimeSubtract(time, self.pausedDuration)

            if !self.sessionStarted {
                writer.startSession(atSourceTime: pts)
                self.sessionStarted = true
                self.firstVideoTime = pts
            }

            guard videoInput.isReadyForMoreMediaData else {
                self.droppedVideoFrames += 1
                return
            }
            if !adaptor.append(pixelBuffer, withPresentationTime: pts) {
                self.droppedVideoFrames += 1
                if writer.status == .failed {
                    self.state = .failed(writer.error?.localizedDescription ?? "Writer failed")
                    self.log.error("Recorder failed: \(String(describing: writer.error))")
                }
            }
        }
    }

    // MARK: - Audio (fed by RecordingAudioSink)

    /// Appends a mixed-program audio sample buffer (host-clock stamped).
    func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        queue.async { [weak self] in
            guard let self,
                  let writer = self.writer,
                  let audioInput = self.audioInput,
                  writer.status == .writing,
                  self.sessionStarted,   // video defines t0; drop earlier audio
                  !self.isPaused,
                  audioInput.isReadyForMoreMediaData else { return }

            let raw = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            // Same stale-buffer guard as the video path: audio captured during
            // the pause can still be queued behind the resume.
            if self.resumedAtHostTime.isValid, raw < self.resumedAtHostTime { return }

            let pts = CMTimeSubtract(raw, self.pausedDuration)
            // Drop audio that predates the session start.
            if pts < self.firstVideoTime { return }

            guard self.pausedDuration != .zero else {
                audioInput.append(sampleBuffer)   // never paused: append as-is
                return
            }
            // Retiming needs a copy; the buffer we were handed belongs to the
            // audio tap. Take the existing timing and replace only the
            // presentation stamp — for LPCM the entry's `duration` is the
            // PER-SAMPLE duration (1/48000), not the buffer's total, so
            // `CMSampleBufferGetDuration` would be wrong here.
            // verify on Mac: first use of CMSampleBufferCreateCopyWithNewTiming
            // in this codebase — if AAC encode rejects the copy, the fallback
            // is to retime inside RecordingAudioSink instead (it owns the
            // buffer before it is made data-ready).
            var timing = CMSampleTimingInfo()
            guard CMSampleBufferGetSampleTimingInfo(sampleBuffer,
                                                    at: 0,
                                                    timingInfoOut: &timing) == noErr else {
                self.log.error("Couldn't read audio timing while paused-offsetting")
                return
            }
            timing.presentationTimeStamp = pts
            var retimed: CMSampleBuffer?
            let status = CMSampleBufferCreateCopyWithNewTiming(
                allocator: kCFAllocatorDefault,
                sampleBuffer: sampleBuffer,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timing,
                sampleBufferOut: &retimed)
            if status == noErr, let retimed {
                audioInput.append(retimed)
            } else {
                self.log.error("Couldn't retime paused audio (status \(status))")
            }
        }
    }

    // MARK: - Helpers

    private static func outputURL(projectName: String, folderPath: String?) -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let stamp = formatter.string(from: Date())
        let safeName = projectName.replacingOccurrences(of: "/", with: "-")
        // The Recordings pane can point somewhere else; default stays
        // ~/Movies/Streamit.
        let folder = folderPath.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Streamit")
        return folder.appendingPathComponent("\(stamp) — \(safeName).mov")
    }

    private static func bitrate(width: Int, height: Int, fps: Int, codec: Codec) -> Int {
        // ~12 Mbps for 1080p30 HEVC; scale by pixels and fps, H.264 ×1.5.
        let base = Double(width * height) / (1920.0 * 1080.0) * 12_000_000
        let fpsFactor = Double(fps) / 30.0
        let codecFactor = codec == .h264 ? 1.5 : 1.0
        return Int(base * fpsFactor * codecFactor)
    }
}
