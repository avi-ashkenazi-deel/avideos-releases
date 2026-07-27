import Foundation
import AVFoundation
import AudioToolbox
import os

/// One effect insert on a mixer strip. `macroAmount` is the one-knob control
/// mapped onto sensible multi-parameter curves per kind; `fullStateData`
/// persists the AU's complete state (covers third-party plug-ins and
/// "advanced" tweaks made in the plug-in's own UI).
struct InsertEffect: Identifiable, Codable {
    enum Kind: Codable, Hashable {
        case compressor
        case delay
        case eq
        case reverb
        case thirdParty(componentType: UInt32, subType: UInt32, manufacturer: UInt32, name: String)
    }

    let id: UUID
    var kind: Kind
    var bypassed: Bool
    var macroAmount: Double
    var fullStateData: Data?

    init(kind: Kind, bypassed: Bool = false, macroAmount: Double = 0.5) {
        self.id = UUID()
        self.kind = kind
        self.bypassed = bypassed
        self.macroAmount = macroAmount
    }

    var displayName: String {
        switch kind {
        case .compressor: "Compressor"
        case .delay: "Delay"
        case .eq: "EQ"
        case .reverb: "Reverb"
        case .thirdParty(_, _, _, let name): name
        }
    }
}

/// Runtime insert chain for one strip: builds/owns the AVAudioUnit nodes and
/// rewires source → inserts → strip mixer whenever the chain changes.
/// Rewiring pauses nothing globally — AVAudioEngine allows attach/connect
/// while running; brief strip silence during a rebuild is acceptable.
final class InsertChain {
    private(set) var effects: [InsertEffect] = []
    private var nodes: [UUID: AVAudioUnit] = [:]

    private weak var engine: AVAudioEngine?
    /// The strip's upstream node (source/player mixer) and downstream mixer.
    private weak var sourceNode: AVAudioNode?
    private weak var stripMixer: AVAudioMixerNode?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "inserts")

    init(engine: AVAudioEngine, source: AVAudioNode, stripMixer: AVAudioMixerNode) {
        self.engine = engine
        self.sourceNode = source
        self.stripMixer = stripMixer
    }

    // MARK: - Chain edits

    func setEffects(_ newEffects: [InsertEffect], instantiated: [UUID: AVAudioUnit]) {
        effects = newEffects
        nodes = instantiated
        rewire()
    }

    func add(_ effect: InsertEffect, node: AVAudioUnit) {
        effects.append(effect)
        nodes[effect.id] = node
        applyMacro(effect)
        rewire()
    }

    func remove(id: UUID) {
        effects.removeAll { $0.id == id }
        if let node = nodes.removeValue(forKey: id) {
            engine?.detach(node)
        }
        rewire()
    }

    func setBypassed(_ bypassed: Bool, id: UUID) {
        guard let index = effects.firstIndex(where: { $0.id == id }) else { return }
        effects[index].bypassed = bypassed
        nodes[id]?.auAudioUnit.shouldBypassEffect = bypassed
    }

    func setMacro(_ amount: Double, id: UUID) {
        guard let index = effects.firstIndex(where: { $0.id == id }) else { return }
        effects[index].macroAmount = amount
        applyMacro(effects[index])
    }

    func node(for id: UUID) -> AVAudioUnit? {
        nodes[id]
    }

    /// Strip teardown: detach every insert node from the engine (call before
    /// detaching the strip's mixer/entry, e.g. when a guest leaves).
    func detachAllNodes() {
        if let engine {
            for node in nodes.values where node.engine != nil {
                engine.detach(node)
            }
        }
        nodes.removeAll()
        effects.removeAll()
    }

    /// Snapshot each AU's fullState into the model for persistence.
    func capturedEffects() -> [InsertEffect] {
        effects.map { effect in
            var copy = effect
            if let node = nodes[effect.id],
               let state = node.auAudioUnit.fullState {
                copy.fullStateData = try? PropertyListSerialization.data(
                    fromPropertyList: state, format: .binary, options: 0)
            }
            return copy
        }
    }

    // MARK: - Wiring

    /// source → e1 → e2 → … → stripMixer (bypassed effects stay in the graph
    /// with shouldBypassEffect so toggling is glitch-free).
    private func rewire() {
        guard let engine, let source = sourceNode, let mixer = stripMixer else { return }
        let format = CanonicalAudio.format

        engine.disconnectNodeOutput(source)
        var upstream: AVAudioNode = source
        for effect in effects {
            guard let node = nodes[effect.id] else { continue }
            if node.engine == nil {
                engine.attach(node)
            }
            engine.disconnectNodeOutput(node)
            engine.connect(upstream, to: node, format: format)
            node.auAudioUnit.shouldBypassEffect = effect.bypassed
            upstream = node
        }
        engine.connect(upstream, to: mixer, format: format)
    }

    // MARK: - Macro curves

    /// One knob → musically useful parameter sweeps per built-in kind.
    private func applyMacro(_ effect: InsertEffect) {
        guard let node = nodes[effect.id] else { return }
        let amount = min(max(effect.macroAmount, 0), 1)

        switch effect.kind {
        case .compressor:
            // AUDynamicsProcessor via AudioUnit parameter API. `audioUnit` is
            // a non-optional AudioUnit on AVAudioUnit — there is nothing to
            // unwrap.
            let unit = node.audioUnit
            let threshold = Float(-8 - amount * 12)          // -8 … -20 dB
            let ratio = Float(2 + amount * 4)                // 2:1 … 6:1
            AudioUnitSetParameter(unit, kDynamicsProcessorParam_Threshold,
                                  kAudioUnitScope_Global, 0, threshold, 0)
            AudioUnitSetParameter(unit, kDynamicsProcessorParam_HeadRoom,
                                  kAudioUnitScope_Global, 0, 5, 0)
            AudioUnitSetParameter(unit, kDynamicsProcessorParam_AttackTime,
                                  kAudioUnitScope_Global, 0, 0.005, 0)
            AudioUnitSetParameter(unit, kDynamicsProcessorParam_ReleaseTime,
                                  kAudioUnitScope_Global, 0, 0.1, 0)
            // verify on Mac: expansion ratio param used as compression ratio on
            // AUDynamicsProcessor (kDynamicsProcessorParam_ExpansionRatio vs
            // the compression side); adjust to taste in the first build.
            AudioUnitSetParameter(unit, kDynamicsProcessorParam_ExpansionRatio,
                                  kAudioUnitScope_Global, 0, ratio, 0)
        case .delay:
            guard let delay = node as? AVAudioUnitDelay else { return }
            delay.wetDryMix = Float(amount * 40)             // 0 … 40 %
            delay.delayTime = 0.08 + amount * 0.37           // 80 … 450 ms
            delay.feedback = Float(20 + amount * 25)         // 20 … 45 %
            delay.lowPassCutoff = 12_000
        case .eq:
            guard let eq = node as? AVAudioUnitEQ, eq.bands.count >= 3 else { return }
            // "Presence" curve: warmth shelf + clarity bell + air shelf.
            let warmth = eq.bands[0]
            warmth.filterType = .lowShelf
            warmth.frequency = 120
            warmth.gain = Float(amount * 3)
            warmth.bypass = false
            let clarity = eq.bands[1]
            clarity.filterType = .parametric
            clarity.frequency = 3000
            clarity.bandwidth = 1.0
            clarity.gain = Float(amount * 4)
            clarity.bypass = false
            let air = eq.bands[2]
            air.filterType = .highShelf
            air.frequency = 10_000
            air.gain = Float(amount * 2.5)
            air.bypass = false
        case .reverb:
            guard let reverb = node as? AVAudioUnitReverb else { return }
            reverb.loadFactoryPreset(.mediumRoom)
            reverb.wetDryMix = Float(amount * 35)            // 0 … 35 %
        case .thirdParty:
            break   // third-party AUs are controlled via their own UI/fullState
        }
    }
}
