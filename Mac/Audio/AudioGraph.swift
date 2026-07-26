import Foundation
import AVFoundation
import Accelerate
import os

/// Engine #2 of three — the mix hub. Structure per strip:
///
///   entry (source node / player bus) → [insert chain] → strip mixer
///
/// Fan-out: mic/pads/music/movie strip mixers feed BOTH `programMixer` and
/// `mixMinusMixer` (multi-destination connect); guest strips feed
/// `programMixer` only — that omission IS the mix-minus, structurally
/// guaranteeing guests never hear themselves.
///
/// Outputs: programMixer → mainMixer → outputNode (monitor device);
/// one tap on programMixer multiplexes program-ring (virtual mic feeder) +
/// recording sink + program meter; one tap on mixMinusMixer feeds the
/// guest-send ring. mixMinusMixer also connects to mainMixer with its
/// AVAudioMixing `volume` at 0 so the engine pulls it without it being
/// audible (taps see the pre-destination signal).
/// // verify on Mac: AVAudioMixerNode.volume (AVAudioMixing) silences the
/// // destination contribution while installTap still receives full signal.
final class AudioGraph {
    let engine = AVAudioEngine()

    // Bus mixers.
    let programMixer = AVAudioMixerNode()
    let mixMinusMixer = AVAudioMixerNode()

    /// One strip = entry point + insert chain + strip mixer + meter state.
    final class Strip {
        let id: MixerStripID
        let entry: AVAudioNode           // source node or pre-mix bus
        let mixer = AVAudioMixerNode()
        var inserts: InsertChain?
        /// User fader (persisted) and automation gain (ducker) compose.
        var userVolume: Float = 1 { didSet { applyVolume() } }
        var duckGain: Float = 1 { didSet { applyVolume() } }
        var isMuted = false { didSet { applyVolume() } }
        var levels = AudioLevels()
        var levelsLock = os_unfair_lock()

        init(id: MixerStripID, entry: AVAudioNode) {
            self.id = id
            self.entry = entry
        }

        private func applyVolume() {
            mixer.outputVolume = isMuted ? 0 : userVolume * duckGain
        }

        func readLevels() -> AudioLevels {
            os_unfair_lock_lock(&levelsLock)
            defer { os_unfair_lock_unlock(&levelsLock) }
            return levels
        }
    }

    private(set) var strips: [MixerStripID: Strip] = [:]

    // Rings crossing engine/clock boundaries.
    let programRing = RingBuffer(duration: 0.25)    // → "AVideos Microphone" feeder
    let mixMinusRing = RingBuffer(duration: 0.25)   // → "AVideos Guest Send" feeder
    let movieRing = RingBuffer(duration: 0.3)       // ← MovieAudioTap

    /// Program-bus meter.
    private var programLevels = AudioLevels()
    private var programLevelsLock = os_unfair_lock()

    /// Program tap consumers beyond the ring (recording).
    let recordingSink = RecordingAudioSink()

    // Pre-mix buses that fan multiple players into one strip entry.
    let padsBus = AVAudioMixerNode()
    let musicBus = AVAudioMixerNode()

    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "audiograph")

    // MARK: - Build

    /// Builds the static part of the graph. `micRing` comes from MicCapture.
    func build(micRing: RingBuffer) {
        let format = CanonicalAudio.format

        engine.attach(programMixer)
        engine.attach(mixMinusMixer)
        engine.attach(padsBus)
        engine.attach(musicBus)

        // Bus wiring.
        engine.connect(programMixer, to: engine.mainMixerNode, format: format)
        engine.connect(mixMinusMixer, to: engine.mainMixerNode, format: format)
        mixMinusMixer.volume = 0   // pulled by the engine, silent on monitor

        // Static strips.
        addStrip(id: .mic, entry: makeRingSource(ring: micRing))
        addStrip(id: .pads, entry: padsBus)
        addStrip(id: .music, entry: musicBus)
        addStrip(id: .movie, entry: makeRingSource(ring: movieRing))

        installBusTaps()
    }

    func start() throws {
        engine.prepare()
        try engine.start()
    }

    func stop() {
        programMixer.removeTap(onBus: 0)
        mixMinusMixer.removeTap(onBus: 0)
        engine.stop()
    }

    // MARK: - Strips

    @discardableResult
    func addStrip(id: MixerStripID, entry: AVAudioNode) -> Strip {
        let format = CanonicalAudio.format
        let strip = Strip(id: id, entry: entry)
        if entry.engine == nil {
            engine.attach(entry)
        }
        engine.attach(strip.mixer)
        strip.inserts = InsertChain(engine: engine, source: entry, stripMixer: strip.mixer)

        // Entry → strip mixer (the insert chain re-wires this when populated).
        engine.connect(entry, to: strip.mixer, format: format)

        // Strip → buses. Guests skip mix-minus (that's the whole trick).
        let isGuest: Bool
        if case .guest = id { isGuest = true } else { isGuest = false }
        var destinations = [AVAudioConnectionPoint(node: programMixer,
                                                   bus: programMixer.nextAvailableInputBus)]
        if !isGuest {
            destinations.append(AVAudioConnectionPoint(node: mixMinusMixer,
                                                       bus: mixMinusMixer.nextAvailableInputBus))
        }
        engine.connect(strip.mixer, to: destinations, fromBus: 0, format: format)

        // Per-strip meter tap.
        strip.mixer.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak strip] buffer, _ in
            guard let strip, let data = buffer.floatChannelData else { return }
            var rms: Float = 0
            var peak: Float = 0
            vDSP_rmsqv(data[0], 1, &rms, vDSP_Length(buffer.frameLength))
            vDSP_maxmgv(data[0], 1, &peak, vDSP_Length(buffer.frameLength))
            os_unfair_lock_lock(&strip.levelsLock)
            strip.levels.rms = max(rms, strip.levels.rms * 0.85)
            strip.levels.peak = max(peak, strip.levels.peak * 0.9)
            os_unfair_lock_unlock(&strip.levelsLock)
        }

        strips[id] = strip
        return strip
    }

    /// Adds a live guest strip while the engine runs.
    func addGuestStrip(identity: String) -> RingBuffer {
        let ring = RingBuffer(duration: 0.3)
        addStrip(id: .guest(identity), entry: makeRingSource(ring: ring))
        return ring
    }

    func removeGuestStrip(identity: String) {
        guard let strip = strips.removeValue(forKey: .guest(identity)) else { return }
        strip.mixer.removeTap(onBus: 0)          // taps off before detach
        strip.inserts?.detachAllNodes()          // any insert AUs on the strip
        engine.detach(strip.mixer)
        engine.detach(strip.entry)
    }

    func strip(_ id: MixerStripID) -> Strip? {
        strips[id]
    }

    // MARK: - Sources

    /// AVAudioSourceNode that pulls interleaved frames from a ring and emits
    /// them non-interleaved (canonical). Ring zero-fills on underrun.
    private func makeRingSource(ring: RingBuffer) -> AVAudioSourceNode {
        var scratch = [Float](repeating: 0, count: 8192 * 2)
        return AVAudioSourceNode(format: CanonicalAudio.format) { _, _, frameCount, audioBufferList -> OSStatus in
            let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let frames = Int(frameCount)
            guard abl.count >= 1,
                  let left = abl[0].mData?.assumingMemoryBound(to: Float.self),
                  frames * 2 <= scratch.count else { return noErr }
            scratch.withUnsafeMutableBufferPointer { buf in
                guard let base = buf.baseAddress else { return }
                _ = ring.read(into: base, frameCount: frames)
                if abl.count >= 2, let right = abl[1].mData?.assumingMemoryBound(to: Float.self) {
                    for i in 0..<frames {
                        left[i] = base[i * 2]
                        right[i] = base[i * 2 + 1]
                    }
                } else {
                    for i in 0..<frames {
                        left[i] = (base[i * 2] + base[i * 2 + 1]) * 0.5
                    }
                }
            }
            return noErr
        }
    }

    // MARK: - Bus taps

    private func installBusTaps() {
        let format = CanonicalAudio.format

        // ONE tap per node — multiplex inside it. Each tap owns its own
        // interleave scratch (captured `var`, closure boxes it by reference,
        // pre-sized so the steady-state render path never allocates): the two
        // taps can fire concurrently on independent tap threads, so a single
        // shared scratch array would be a data race.
        var programScratch = [Float](repeating: 0, count: 16384)
        programMixer.installTap(onBus: 0, bufferSize: 512, format: format) { [weak self] buffer, time in
            guard let self else { return }
            Self.writeInterleaved(buffer, into: self.programRing, scratch: &programScratch)
            if self.recordingSink.isAttached {
                self.recordingSink.ingest(buffer: buffer, time: time)
            }
            if let data = buffer.floatChannelData {
                var rms: Float = 0
                var peak: Float = 0
                vDSP_rmsqv(data[0], 1, &rms, vDSP_Length(buffer.frameLength))
                vDSP_maxmgv(data[0], 1, &peak, vDSP_Length(buffer.frameLength))
                os_unfair_lock_lock(&self.programLevelsLock)
                self.programLevels.rms = max(rms, self.programLevels.rms * 0.85)
                self.programLevels.peak = max(peak, self.programLevels.peak * 0.9)
                os_unfair_lock_unlock(&self.programLevelsLock)
            }
        }

        var mixMinusScratch = [Float](repeating: 0, count: 16384)
        mixMinusMixer.installTap(onBus: 0, bufferSize: 512, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            Self.writeInterleaved(buffer, into: self.mixMinusRing, scratch: &mixMinusScratch)
        }
    }

    private static func writeInterleaved(_ buffer: AVAudioPCMBuffer,
                                         into ring: RingBuffer,
                                         scratch: inout [Float]) {
        guard let data = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let needed = frames * 2
        if scratch.count < needed {
            scratch = [Float](repeating: 0, count: needed)
        }
        let left = data[0]
        let right = buffer.format.channelCount >= 2 ? data[1] : data[0]
        scratch.withUnsafeMutableBufferPointer { out in
            guard let base = out.baseAddress else { return }
            for i in 0..<frames {
                base[i * 2] = left[i]
                base[i * 2 + 1] = right[i]
            }
        }
        scratch.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return }
            _ = ring.write(interleaved: base, frameCount: frames)
        }
    }

    func readProgramLevels() -> AudioLevels {
        os_unfair_lock_lock(&programLevelsLock)
        defer { os_unfair_lock_unlock(&programLevelsLock) }
        return programLevels
    }

    // MARK: - Monitor

    var monitorVolume: Float {
        get { engine.mainMixerNode.outputVolume }
        set { engine.mainMixerNode.outputVolume = newValue }
    }
}
