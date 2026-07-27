import Foundation
import Observation
import os

/// Turns MIDI messages into the same facade calls the section pads and global
/// hotkeys make, and owns learn mode.
///
/// One action layer, three input devices — a MIDI pad, a hotkey and a click all
/// land on the identical `AudioEngineController` method.
@MainActor
@Observable
final class MIDIController {
    private let hub = MIDIInputHub()
    private let store = MIDIBindingStore()
    private weak var audio: AudioEngineController?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "midi")

    private(set) var bindings: [MIDIBinding] = []
    private(set) var deviceNames: [String] = []
    /// Last message seen, bound or not. Non-negotiable for debugging a
    /// controller that appears to send nothing — the same reasoning as showing
    /// raw driver status rather than hiding it.
    private(set) var lastMessage: MIDIMessage?
    private(set) var isRunning = false

    /// While non-nil, the next trigger binds instead of firing.
    var learningAction: MIDIAction?
    private var learnTimeout: Task<Void, Never>?

    // MARK: - Lifecycle

    func start(audio: AudioEngineController) {
        guard !isRunning else { return }
        self.audio = audio
        bindings = store.load()

        hub.onMessage = { [weak self] message in
            // Already hopped to main by the hub.
            self?.handle(message)
        }
        hub.onDevicesChanged = { [weak self] names in
            self?.deviceNames = names
        }
        hub.start()
        isRunning = hub.isStarted
    }

    func stop() {
        hub.stop()
        learnTimeout?.cancel()
        isRunning = false
    }

    // MARK: - Receiving

    private func handle(_ message: MIDIMessage) {
        lastMessage = message
        guard message.isTrigger else { return }

        if let action = learningAction {
            bind(action: action, to: message)
            return
        }
        for binding in bindings where binding.matches(message) {
            perform(binding.action)
        }
    }

    private func perform(_ action: MIDIAction) {
        guard let audio else { return }
        switch action {
        case .section(let index): audio.playSection(hotkeyIndex: index)
        case .pad(let index): audio.playPad(hotkeyIndex: index)
        case .switchModeCut: audio.sectionSwitchMode = .hardCut
        case .switchModeAtLoopEnd: audio.sectionSwitchMode = .atLoopEnd
        case .toggleSectionLoop: audio.toggleSectionLoop()
        case .cancelQueued: audio.cancelQueuedSection()
        case .musicPlayPause: audio.musicPlayPause()
        case .dropMarker: _ = audio.dropMarkerAtPlayhead()
        }
    }

    // MARK: - Learn

    func beginLearning(_ action: MIDIAction) {
        learningAction = action
        learnTimeout?.cancel()
        learnTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            self?.learningAction = nil
        }
    }

    func cancelLearning() {
        learningAction = nil
        learnTimeout?.cancel()
    }

    private func bind(action: MIDIAction, to message: MIDIMessage) {
        // Binding a control that is already spoken for replaces the old
        // binding rather than stacking a second one on the same key.
        bindings.removeAll { $0.action == action }
        bindings.removeAll { $0.status == message.status && $0.data1 == message.data1
                             && ($0.channel == message.channel || $0.channel == MIDIBinding.anyChannel) }
        bindings.append(MIDIBinding(action: action,
                                    status: message.status,
                                    channel: message.channel,
                                    data1: message.data1,
                                    deviceName: deviceNames.first))
        cancelLearning()
        store.saveDebounced(bindings)
    }

    func removeBinding(id: UUID) {
        bindings.removeAll { $0.id == id }
        store.saveDebounced(bindings)
    }

    func setAnyChannel(_ any: Bool, forBindingID id: UUID) {
        guard let index = bindings.firstIndex(where: { $0.id == id }) else { return }
        bindings[index].channel = any ? MIDIBinding.anyChannel : 0
        store.saveDebounced(bindings)
    }

    func binding(for action: MIDIAction) -> MIDIBinding? {
        bindings.first { $0.action == action }
    }
}
