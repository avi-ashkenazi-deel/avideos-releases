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

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sessionStarted = false
    private var firstVideoTime: CMTime = .invalid

    private let queue = DispatchQueue(label: "com.aviashkenazi.avideos.recorder", qos: .userInitiated)
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "recorder")

    var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }

    // MARK: - Lifecycle

    /// Starts a recording session. `audioFormat` comes from the audio graph
    /// (48kHz stereo Float32) and is transcoded to AAC by the writer.
    func start(canvasSize: CGSize,
               frameRate: Int,
               codec: Codec = .hevc,
               projectName: String) throws {
        try queue.sync {
            guard writer == nil else { return }

            let url = Self.outputURL(projectName: projectName)
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
            self.state = .idle
        }
    }

    // MARK: - ProgramFrameConsumer (render queue)

    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime) {
        queue.async { [weak self] in
            guard let self,
                  let writer = self.writer,
                  let videoInput = self.videoInput,
                  let adaptor = self.pixelBufferAdaptor,
                  writer.status == .writing else { return }

            if !self.sessionStarted {
                writer.startSession(atSourceTime: time)
                self.sessionStarted = true
                self.firstVideoTime = time
            }

            guard videoInput.isReadyForMoreMediaData else {
                self.droppedVideoFrames += 1
                return
            }
            if !adaptor.append(pixelBuffer, withPresentationTime: time) {
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
                  audioInput.isReadyForMoreMediaData else { return }
            // Drop audio that predates the session start.
            if CMSampleBufferGetPresentationTimeStamp(sampleBuffer) < self.firstVideoTime { return }
            audioInput.append(sampleBuffer)
        }
    }

    // MARK: - Helpers

    private static func outputURL(projectName: String) -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let stamp = formatter.string(from: Date())
        let safeName = projectName.replacingOccurrences(of: "/", with: "-")
        let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask)[0]
        return movies.appendingPathComponent("AVideos/\(stamp) — \(safeName).mov")
    }

    private static func bitrate(width: Int, height: Int, fps: Int, codec: Codec) -> Int {
        // ~12 Mbps for 1080p30 HEVC; scale by pixels and fps, H.264 ×1.5.
        let base = Double(width * height) / (1920.0 * 1080.0) * 12_000_000
        let fpsFactor = Double(fps) / 30.0
        let codecFactor = codec == .h264 ? 1.5 : 1.0
        return Int(base * fpsFactor * codecFactor)
    }
}
