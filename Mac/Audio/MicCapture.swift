import Foundation
import AVFoundation
import Accelerate
import os

/// Smoothed level metering shared by strips and the ducker. Thread-safe read.
struct AudioLevels {
    var rms: Float = 0
    var peak: Float = 0
}

/// Engine #1 of three: microphone capture on its own engine so its clock
/// domain (the input device) and Apple's voice-processing side effects are
/// quarantined away from the mix hub. Output: canonical-format frames into a
/// ring the hub's mic source node pulls.
final class MicCapture {
    let ring = RingBuffer(duration: 0.25)

    /// Raw device-format buffers pre-conversion, for podcast local recording.
    /// Called on the tap thread.
    var rawBufferTap: ((AVAudioPCMBuffer, AVAudioTime) -> Void)?

    private let engine = AVAudioEngine()
    private let deviceManager: AudioDeviceManager
    private var converter: AVAudioConverter?
    private var convertedBuffer: AVAudioPCMBuffer?
    private var interleaveScratch = [Float](repeating: 0, count: 48_000)

    private var levelsLock = os_unfair_lock()
    private var _levels = AudioLevels()
    private(set) var isRunning = false
    private(set) var currentDeviceUID: String?
    private(set) var voiceProcessingEnabled = false

    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "mic")

    init(deviceManager: AudioDeviceManager) {
        self.deviceManager = deviceManager
    }

    var levels: AudioLevels {
        os_unfair_lock_lock(&levelsLock)
        defer { os_unfair_lock_unlock(&levelsLock) }
        return _levels
    }

    func start(deviceUID: String?, voiceProcessing: Bool) {
        stop()
        currentDeviceUID = deviceUID
        voiceProcessingEnabled = voiceProcessing

        _ = deviceManager.setInputDevice(uid: deviceUID, on: engine)

        if voiceProcessing {
            // Voice processing forces the AU into VP mode with its own
            // constraints; contained here because this engine only captures.
            // verify on Mac: throws-signature — setVoiceProcessingEnabled is
            // `try engine.inputNode.setVoiceProcessingEnabled(true)`.
            do {
                try engine.inputNode.setVoiceProcessingEnabled(true)
            } catch {
                log.error("Voice processing unavailable: \(error.localizedDescription)")
                voiceProcessingEnabled = false
            }
        }

        let inputFormat = engine.inputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            log.error("Mic input format unavailable (no device?)")
            return
        }
        let canonical = CanonicalAudio.format
        converter = AVAudioConverter(from: inputFormat, to: canonical)
        convertedBuffer = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: 8192)

        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, time in
            self?.ingest(buffer: buffer, time: time)
        }

        do {
            engine.prepare()
            try engine.start()
            isRunning = true
        } catch {
            log.error("Mic engine start failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        // Always remove the tap, not just when running: start() installs the
        // tap before engine.start(), so a failed start leaves a tap behind
        // with isRunning == false — an early-out here would make the next
        // start() install a second tap on the same bus (runtime exception).
        // removeTap(onBus:) is a safe no-op when no tap is installed.
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        ring.reset()
        isRunning = false
    }

    /// Restart-based toggles (device or VP changes need a fresh engine).
    func setVoiceProcessing(_ enabled: Bool) {
        guard enabled != voiceProcessingEnabled else { return }
        start(deviceUID: currentDeviceUID, voiceProcessing: enabled)
    }

    func setDevice(uid: String?) {
        guard uid != currentDeviceUID else { return }
        start(deviceUID: uid, voiceProcessing: voiceProcessingEnabled)
    }

    // MARK: - Tap path (audio thread; no allocation in steady state)

    private func ingest(buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        rawBufferTap?(buffer, time)

        guard let converter, let converted = convertedBuffer else { return }

        var consumed = false
        converter.convert(to: converted, error: nil, withInputFrom: { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        })

        let frames = Int(converted.frameLength)
        guard frames > 0, let channels = converted.floatChannelData else { return }

        // Meter from the converted (canonical) samples.
        var rms: Float = 0
        var peak: Float = 0
        vDSP_rmsqv(channels[0], 1, &rms, vDSP_Length(frames))
        vDSP_maxmgv(channels[0], 1, &peak, vDSP_Length(frames))
        os_unfair_lock_lock(&levelsLock)
        // Light smoothing: fast attack, slower release.
        _levels.rms = max(rms, _levels.rms * 0.85)
        _levels.peak = max(peak, _levels.peak * 0.9)
        os_unfair_lock_unlock(&levelsLock)

        // Interleave into the ring (canonical is non-interleaved stereo).
        let needed = frames * 2
        if interleaveScratch.count < needed {
            interleaveScratch = [Float](repeating: 0, count: needed)
        }
        let left = channels[0]
        let right = converted.format.channelCount >= 2 ? channels[1] : channels[0]
        interleaveScratch.withUnsafeMutableBufferPointer { out in
            guard let base = out.baseAddress else { return }
            for i in 0..<frames {
                base[i * 2] = left[i]
                base[i * 2 + 1] = right[i]
            }
        }
        interleaveScratch.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return }
            _ = ring.write(interleaved: base, frameCount: frames)
        }
        converted.frameLength = 0
    }
}
