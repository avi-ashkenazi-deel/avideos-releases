import Foundation
import AVFoundation
import CoreMedia
import Metal
import os

/// Video-file playback as a frame source. AVPlayerItemVideoOutput is a pull
/// API, which fits the render loop perfectly: `latestFrame(at:)` copies the
/// pixel buffer for the host time being rendered. A 24fps movie into a 30fps
/// program naturally duplicates; 60 into 30 naturally decimates.
final class MovieSource: FrameSource {
    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let url: URL
    private let loops: Bool
    private let muted: Bool
    private let converter: PixelBufferTextureConverter

    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var output: AVPlayerItemVideoOutput?
    private var lastFrame: SourceFrame?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "movie")

    /// The player, exposed so the audio graph can tap movie audio via an
    /// MTAudioProcessingTap / AVAudioMix (wired by AudioEngineController).
    var avPlayer: AVPlayer? { player }
    /// Fires on the main queue when (non-looping) playback finishes.
    var onPlaybackEnded: (() -> Void)?

    init(key: SourceKey, url: URL, loops: Bool, muted: Bool, metalDevice: MTLDevice) {
        self.key = key
        self.url = url
        self.loops = loops
        self.muted = muted
        self.converter = PixelBufferTextureConverter(device: metalDevice)
    }

    func start() {
        guard state == .idle else { return }
        state = .starting

        let item = AVPlayerItem(url: url)
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        let output = AVPlayerItemVideoOutput(pixelBufferAttributes: attributes)
        item.add(output)
        self.output = output

        let player = AVQueuePlayer(playerItem: item)
        player.isMuted = muted
        player.actionAtItemEnd = loops ? .advance : .pause
        if loops {
            looper = AVPlayerLooper(player: player, templateItem: item)
        } else {
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: item,
                queue: .main
            ) { [weak self] _ in
                self?.onPlaybackEnded?()
            }
        }
        self.player = player
        player.play()
        state = .running
    }

    func stop() {
        player?.pause()
        looper = nil
        player = nil
        output = nil
        lastFrame = nil
        state = .idle
    }

    func pause() { player?.pause() }
    func resume() { player?.play() }
    func seek(to seconds: Double) {
        player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600),
                     toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        guard let output, let player, player.currentItem != nil else { return lastFrame }
        let itemTime = output.itemTime(forHostTime: CACurrentMediaTime())
        guard output.hasNewPixelBuffer(forItemTime: itemTime),
              let pixelBuffer = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil),
              let texture = converter.texture(from: pixelBuffer) else {
            return lastFrame
        }
        let frame = SourceFrame(pixelBuffer: pixelBuffer, texture: texture, presentationTime: time)
        lastFrame = frame
        return frame
    }
}
