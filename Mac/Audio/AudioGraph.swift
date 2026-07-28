import Foundation
import AVFoundation
import Accelerate
import os

/// Engine #2 of three — the mix hub. Structure per strip:
///
///   entry (source node / player bus) → [insert chain] → strip mixer
///
/// Fan-out (three buses, per strip):
///  - `programMixer`: every strip — what recording and the virtual mic get.
///  - `mixMinusMixer`: every non-guest strip — that omission IS the
///    mix-minus, structurally guaranteeing guests never hear themselves.
///  - `monitorMixer`: every strip EXCEPT the mic — the host must not hear
///    their own voice on the speakers (asked for explicitly on first use).
///    The mic reaches it only through `micMonitorGate`, off by default.
///
/// Outputs: monitorMixer → mainMixer → outputNode (monitor device); the
/// program bus reaches mainMixer only through a silencer so its tap fires.
/// One tap on programMixer multiplexes program-ring (virtual mic feeder) +
/// recording sink + program meter; one tap on mixMinusMixer feeds the
/// guest-send ring.
///
/// The mix-minus bus has to reach the output too, because AVAudioEngine only
/// renders what reaches the output — an unconnected bus is never pulled and its
/// tap never fires. But it must not be *heard*, or every non-guest strip
/// arrives at the speakers twice. It goes through `mixMinusSilencer`, whose
/// `outputVolume` is 0: the tap upstream of it still sees full signal, and the
/// monitor gets zeros.
final class AudioGraph {
    let engine = AVAudioEngine()

    // Bus mixers.
    let programMixer = AVAudioMixerNode()
    let mixMinusMixer = AVAudioMixerNode()
    /// Exists only to mute the mix-minus bus on the way to the monitor.
    ///
    /// This used to be `mixMinusMixer.volume = 0` — the `AVAudioMixing`
    /// property, which scales a node's contribution at its destination and
    /// would have left the upstream tap intact. On a real Mac it silences
    /// nothing: `AVAudioMixerNode`'s AVAudioMixing conformance is not
    /// dependable when the node is acting as a source, and the audible result
    /// was hearing yourself, the music and the pads twice, summed — 6 dB up and
    /// phase-coherent. `outputVolume` on a node whose only job is to be
    /// silenced is well-defined and cannot be misread.
    private let mixMinusSilencer = AVAudioMixerNode()
    /// What the speakers actually play. Everything except the mic feeds it
    /// directly; the mic only via `micMonitorGate`.
    let monitorMixer = AVAudioMixerNode()
    /// Same trick as `mixMinusSilencer`, for the program bus: it must reach
    /// the output so the engine pulls it and its tap fires, but the audible
    /// path is the monitor bus — without this, every strip arrives at the
    /// speakers twice (and the mic once too often).
    private let programSilencer = AVAudioMixerNode()
    /// Mic → monitor, normally silent. `outputVolume` 1 turns on
    /// self-monitoring for hosts who want to hear themselves.
    private let micMonitorGate = AVAudioMixerNode()

    /// Whether the host hears their own mic on the monitor output.
    var micMonitorEnabled: Bool {
        get { micMonitorGate.outputVolume > 0.5 }
        set { micMonitorGate.outputVolume = newValue ? 1 : 0 }
    }

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
    let programRing = RingBuffer(duration: 0.25)    // → "streamit Microphone" feeder
    let mixMinusRing = RingBuffer(duration: 0.25)   // → "streamit Guest Send" feeder
    let movieRing = RingBuffer(duration: 0.3)       // ← MovieAudioTap

    /// Program-bus meter.
    private var programLevels = AudioLevels()
    private var programLevelsLock = os_unfair_lock()

    /// Program tap consumers beyond the ring (recording).
    let recordingSink = RecordingAudioSink()

    // Pre-mix buses that fan multiple players into one strip entry.
    let padsBus = AVAudioMixerNode()
    let musicBus = AVAudioMixerNode()

    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "audiograph")

    // MARK: - Build

    /// Builds the static part of the graph. `micRing` comes from MicCapture.
    func build(micRing: RingBuffer) {
        let format = CanonicalAudio.format

        engine.attach(programMixer)
        engine.attach(mixMinusMixer)
        engine.attach(mixMinusSilencer)
        engine.attach(monitorMixer)
        engine.attach(programSilencer)
        engine.attach(micMonitorGate)
        engine.attach(padsBus)
        engine.attach(musicBus)

        // Bus wiring. The MONITOR bus is what's heard; the program bus only
        // reaches the output through a silencer so its tap keeps firing.
        engine.connect(monitorMixer, to: engine.mainMixerNode, format: format)
        engine.connect(programMixer, to: programSilencer, format: format)
        engine.connect(programSilencer, to: engine.mainMixerNode, format: format)
        programSilencer.outputVolume = 0

        // Mic self-monitoring path, silent unless the host opts in.
        engine.connect(micMonitorGate, to: monitorMixer, format: format)
        micMonitorGate.outputVolume = 0

        // The mix-minus bus reaches the output only so the engine pulls it and
        // its tap fires; the silencer makes sure none of it is audible. The tap
        // sits on mixMinusMixer, upstream of the silencer, so it still gets the
        // full signal to send to guests.
        engine.connect(mixMinusMixer, to: mixMinusSilencer, format: format)
        engine.connect(mixMinusSilencer, to: engine.mainMixerNode, format: format)
        mixMinusSilencer.outputVolume = 0

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

        // Strip → buses. Guests skip mix-minus (that's the whole trick);
        // the mic skips the monitor — its only local path is the gate.
        let isGuest: Bool
        if case .guest = id { isGuest = true } else { isGuest = false }
        var destinations = [AVAudioConnectionPoint(node: programMixer,
                                                   bus: programMixer.nextAvailableInputBus)]
        if !isGuest {
            destinations.append(AVAudioConnectionPoint(node: mixMinusMixer,
                                                       bus: mixMinusMixer.nextAvailableInputBus))
        }
        if id == .mic {
            destinations.append(AVAudioConnectionPoint(node: micMonitorGate,
                                                       bus: micMonitorGate.nextAvailableInputBus))
        } else {
            destinations.append(AVAudioConnectionPoint(node: monitorMixer,
                                                       bus: monitorMixer.nextAvailableInputBus))
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
    ///
    /// `scratch` is a local `var` captured by the render closure: Swift boxes
    /// it once at closure creation (heap-allocated then, kept alive by the
    /// closure), so the render path itself never allocates — it only mutates
    /// the pre-sized array in place. One box per source node, so concurrent
    /// render callbacks of different nodes never share scratch.
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
