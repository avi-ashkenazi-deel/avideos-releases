import Foundation
import AVFoundation
import LiveKit
import os

/// Bridges one guest's LiveKit audio track into the mixer: SDK buffers →
/// interleaved-stereo ring writes. The SDK's own playback of the track is
/// muted at subscribe time (see GuestSessionController) so guest audio
/// reaches the speakers ONLY through our mixer strip — otherwise it doubles
/// outside our volume control.
final class GuestAudioReceiver: AudioRenderer {
    let identity: String
    private let ring: RingBuffer
    /// Preallocated interleave scratch; render-path allocation-free.
    private var scratch: [Float]
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "guest-audio")

    init(identity: String, ring: RingBuffer) {
        self.identity = identity
        self.ring = ring
        self.scratch = [Float](repeating: 0, count: 48_000) // 0.5s stereo headroom
    }

    // MARK: - AudioRenderer

    /// LiveKit delivers 48kHz PCM buffers (mono or stereo, usually
    /// non-interleaved Float32). // verify on Mac: exact AudioRenderer
    /// requirement — LiveKit 2.x uses `render(pcmBuffer: AVAudioPCMBuffer)`.
    func render(pcmBuffer: AVAudioPCMBuffer) {
        let frameCount = Int(pcmBuffer.frameLength)
        guard frameCount > 0, let channelData = pcmBuffer.floatChannelData else { return }
        let channels = Int(pcmBuffer.format.channelCount)
        let needed = frameCount * 2
        if scratch.count < needed {
            // Growth only on format surprises; steady state never allocates.
            scratch = [Float](repeating: 0, count: needed)
        }

        scratch.withUnsafeMutableBufferPointer { out in
            guard let outBase = out.baseAddress else { return }
            if channels >= 2 {
                let left = channelData[0]
                let right = channelData[1]
                for i in 0..<frameCount {
                    outBase[i * 2] = left[i]
                    outBase[i * 2 + 1] = right[i]
                }
            } else {
                let mono = channelData[0]
                for i in 0..<frameCount {
                    outBase[i * 2] = mono[i]
                    outBase[i * 2 + 1] = mono[i]
                }
            }
        }
        scratch.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return }
            ring.write(frames: base, frameCount: frameCount)
        }
    }
}
