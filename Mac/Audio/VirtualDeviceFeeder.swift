import Foundation
import AVFoundation
import os

/// Engine #3 of three: a tiny engine whose only job is to pull a ring and
/// play it into one of our virtual loopback devices ("AVideos Microphone" or
/// "AVideos Guest Send"). Whatever we play into the device's output side,
/// Zoom/LiveKit read back from its input side — that's the loopback driver's
/// contract.
final class VirtualDeviceFeeder {
    let deviceUID: String

    private let ring: RingBuffer
    private let deviceManager: AudioDeviceManager
    private let engine = AVAudioEngine()
    private var sourceNode: AVAudioSourceNode?
    private(set) var isRunning = false
    private var deinterleaveScratch = [Float](repeating: 0, count: 8192 * 2)
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "feeder")

    init(deviceUID: String, ring: RingBuffer, deviceManager: AudioDeviceManager) {
        self.deviceUID = deviceUID
        self.ring = ring
        self.deviceManager = deviceManager
    }

    /// Starts feeding if the device exists; safe to call repeatedly (e.g.
    /// from the device-list listener after driver install).
    func startIfAvailable() {
        guard !isRunning else { return }
        guard deviceManager.isDevicePresent(uid: deviceUID) else { return }

        let format = CanonicalAudio.format
        let ring = self.ring

        let node = AVAudioSourceNode(format: format) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let frames = Int(frameCount)
            guard let self,
                  abl.count >= 1,
                  let leftData = abl[0].mData?.assumingMemoryBound(to: Float.self) else {
                return noErr
            }
            // Pull interleaved from the ring, deinterleave into the ABL.
            // Ring zero-fills on underrun, so silence flows when idle.
            let needed = frames * 2
            if self.deinterleaveScratch.count < needed {
                // Should never happen at fixed 48k/512 render sizes; guarded anyway.
                return noErr
            }
            self.deinterleaveScratch.withUnsafeMutableBufferPointer { buf in
                guard let base = buf.baseAddress else { return }
                _ = ring.read(into: base, frameCount: frames)
                if abl.count >= 2, let rightData = abl[1].mData?.assumingMemoryBound(to: Float.self) {
                    for i in 0..<frames {
                        leftData[i] = base[i * 2]
                        rightData[i] = base[i * 2 + 1]
                    }
                } else {
                    for i in 0..<frames {
                        leftData[i] = (base[i * 2] + base[i * 2 + 1]) * 0.5
                    }
                }
            }
            return noErr
        }

        engine.attach(node)
        engine.connect(node, to: engine.outputNode, format: format)
        guard deviceManager.setOutputDevice(uid: deviceUID, on: engine) else {
            engine.detach(node)
            return
        }
        do {
            engine.prepare()
            try engine.start()
            sourceNode = node
            isRunning = true
            log.info("Feeding virtual device \(self.deviceUID)")
        } catch {
            engine.detach(node)
            log.error("Feeder start failed for \(self.deviceUID): \(error.localizedDescription)")
        }
    }

    func stop() {
        guard isRunning else { return }
        engine.stop()
        if let node = sourceNode {
            engine.detach(node)
        }
        sourceNode = nil
        isRunning = false
    }

    /// Device-list change hook: stop if our device vanished, start if it appeared.
    func reconcile() {
        let present = deviceManager.isDevicePresent(uid: deviceUID)
        if present && !isRunning {
            startIfAvailable()
        } else if !present && isRunning {
            stop()
        }
    }
}
