import Foundation
import AVFoundation
import MediaToolbox
import os

/// Extracts a movie-scene AVPlayer's audio into the mixer via an
/// MTAudioProcessingTap on the player item's audio mix: the tap's process
/// callback receives PCM as the player renders it; we interleave it into the
/// movie ring, then zero-fill the tap's output buffers so the player's own
/// device path stays silent — the mixer strip is the only audible path.
final class MovieAudioTap {
    private let ring: RingBuffer
    private var currentPlayer: AVPlayer?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "movietap")

    /// Context handed to the C callbacks. Owns conversion scratch.
    private final class TapContext {
        let ring: RingBuffer
        var sampleRate: Double = CanonicalAudio.sampleRate
        var channelCount: Int = 2
        var scratch = [Float](repeating: 0, count: 16384)

        init(ring: RingBuffer) {
            self.ring = ring
        }
    }

    private var context: TapContext?

    init(ring: RingBuffer) {
        self.ring = ring
    }

    /// Attaches to the player's current item. The player should stay muted
    /// (`player.isMuted = true`); the movie strip carries the audio.
    func attach(to player: AVPlayer) {
        // verify on Mac: `asset.tracks(withMediaType:)` is the synchronous
        // API, deprecated since macOS 13 (deprecation warning, not an error)
        // and it returns [] if the asset's tracks aren't loaded yet — switch
        // to `try await item.asset.loadTracks(withMediaType: .audio)` if
        // attach races item readiness.
        guard let item = player.currentItem,
              let assetTrack = item.asset.tracks(withMediaType: .audio).first else {
            log.info("Movie has no audio track")
            return
        }
        detach()

        let context = TapContext(ring: ring)
        self.context = context
        self.currentPlayer = player

        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(context).toOpaque()),
            init: { tap, clientInfo, tapStorageOut in
                tapStorageOut.pointee = clientInfo
            },
            finalize: { tap in
                Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
            },
            prepare: { tap, maxFrames, processingFormat in
                let ctx = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                ctx.sampleRate = processingFormat.pointee.mSampleRate
                ctx.channelCount = Int(processingFormat.pointee.mChannelsPerFrame)
                let needed = Int(maxFrames) * 2
                if ctx.scratch.count < needed {
                    ctx.scratch = [Float](repeating: 0, count: needed)
                }
            },
            unprepare: { _ in },
            process: { tap, numberFrames, _, bufferListInOut, numberFramesOut, flagsOut in
                var timeRange = CMTimeRange()
                let status = MTAudioProcessingTapGetSourceAudio(
                    tap, numberFrames, bufferListInOut, flagsOut, &timeRange, numberFramesOut)
                guard status == noErr else { return }

                let ctx = Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                let abl = UnsafeMutableAudioBufferListPointer(bufferListInOut)
                let frames = Int(numberFramesOut.pointee)
                guard frames > 0, abl.count >= 1,
                      let ch0 = abl[0].mData?.assumingMemoryBound(to: Float.self) else { return }

                // NOTE: assumes the tap's processing format sample rate matches
                // canonical 48k (AVPlayer usually renders at the file rate).
                // verify on Mac: if a 44.1k file drifts audibly, add an
                // AVAudioConverter here keyed on ctx.sampleRate.
                let ch1 = abl.count >= 2
                    ? abl[1].mData?.assumingMemoryBound(to: Float.self) ?? ch0
                    : ch0
                let needed = frames * 2
                if ctx.scratch.count < needed { return }   // never grow on the render thread
                ctx.scratch.withUnsafeMutableBufferPointer { out in
                    guard let base = out.baseAddress else { return }
                    for i in 0..<frames {
                        base[i * 2] = ch0[i]
                        base[i * 2 + 1] = ch1[i]
                    }
                }
                ctx.scratch.withUnsafeBufferPointer { buf in
                    guard let base = buf.baseAddress else { return }
                    _ = ctx.ring.write(interleaved: base, frameCount: frames)
                }

                // Silence the player's own output path: the mixer strip is
                // the only audible route (otherwise movie audio doubles
                // through the system output device).
                for buffer in abl {
                    if let data = buffer.mData {
                        memset(data, 0, Int(buffer.mDataByteSize))
                    }
                }
            })

        var tap: Unmanaged<MTAudioProcessingTap>?
        let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks,
                                                kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
        guard status == noErr, let tap else {
            log.error("MTAudioProcessingTapCreate failed: \(status)")
            Unmanaged<TapContext>.fromOpaque(Unmanaged.passUnretained(context).toOpaque()).release()
            self.context = nil
            return
        }

        let inputParams = AVMutableAudioMixInputParameters(track: assetTrack)
        inputParams.audioTapProcessor = tap.takeRetainedValue()
        let audioMix = AVMutableAudioMix()
        audioMix.inputParameters = [inputParams]
        item.audioMix = audioMix
        player.isMuted = false   // the tap needs the render path live; the
                                 // strip fader is the audible control.
        player.volume = 1
    }

    func detach() {
        currentPlayer?.currentItem?.audioMix = nil
        currentPlayer = nil
        context = nil
        ring.reset()
    }
}
