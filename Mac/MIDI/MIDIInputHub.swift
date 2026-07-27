import Foundation
import CoreMIDI
import os

/// Receives MIDI from every connected source and hands parsed messages to the
/// main actor.
///
/// Deliberately **not** `@MainActor`: this type lives where the CoreMIDI read
/// block lands, which is a high-priority CoreMIDI thread, not main. The block
/// does exactly three things — filter, pack, hop — and nothing else. In
/// particular it must never touch `@Observable` state, which would be both a
/// main-actor data race and SwiftUI invalidation from an audio-adjacent thread.
///
/// Note this is *not* the `MainActor.assumeIsolated` pattern used for the
/// Carbon hotkey handler in `GlobalShortcuts.bind`. That one genuinely runs on
/// the main run loop; asserting the same thing here would be undefined
/// behaviour.
final class MIDIInputHub {
    /// Called on the **main queue**, one message at a time.
    var onMessage: ((MIDIMessage) -> Void)?
    /// Called on the main queue whenever the connected device list changes.
    var onDevicesChanged: (([String]) -> Void)?

    private var client = MIDIClientRef()
    private var port = MIDIPortRef()
    private var connected: Set<MIDIUniqueID> = []
    private let lock = NSLock()
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "midi")

    private(set) var isStarted = false

    // MARK: - Lifecycle

    func start() {
        guard !isStarted else { return }

        // verify on Mac: `MIDIClientCreateWithBlock` delivers its notify block
        // on an internal queue rather than the creating thread's run loop
        // (unlike the older `MIDIClientCreate`), so the hop below is required
        // rather than merely tidy.
        var status = MIDIClientCreateWithBlock("AVideos" as CFString, &client) { [weak self] notification in
            guard notification.pointee.messageID == .msgSetupChanged else { return }
            DispatchQueue.main.async { self?.rescanSources() }
        }
        guard status == noErr else {
            log.error("MIDIClientCreateWithBlock failed: \(status)")
            return
        }

        // verify on Mac: the MIDI 1.0 protocol event-list API. Chosen over the
        // legacy MIDIPacketList path, where Swift iteration through
        // MIDIPacketNext is a well-known source of misaligned-pointer bugs.
        status = MIDIInputPortCreateWithProtocol(
            client, "AVideos In" as CFString, ._1_0, &port
        ) { [weak self] eventList, _ in
            self?.handle(eventList: eventList)
        }
        guard status == noErr else {
            log.error("MIDIInputPortCreateWithProtocol failed: \(status)")
            return
        }

        isStarted = true
        rescanSources()
    }

    func stop() {
        guard isStarted else { return }
        MIDIPortDispose(port)
        MIDIClientDispose(client)
        lock.withLock { connected.removeAll() }
        isStarted = false
    }

    // MARK: - Sources

    /// Connects every source, and only the ones not already connected.
    ///
    /// Connecting everything by default is the right call for a live host: you
    /// plug in one controller and it works, rather than having to find it in a
    /// list first.
    private func rescanSources() {
        var names: [String] = []
        for index in 0..<MIDIGetNumberOfSources() {
            let source = MIDIGetSource(index)
            var uniqueID: MIDIUniqueID = 0
            MIDIObjectGetIntegerProperty(source, kMIDIPropertyUniqueID, &uniqueID)
            names.append(Self.displayName(of: source))

            let isNew = lock.withLock { connected.insert(uniqueID).inserted }
            guard isNew else { continue }
            let status = MIDIPortConnectSource(port, source, nil)
            if status != noErr {
                log.error("couldn't connect MIDI source: \(status)")
                lock.withLock { _ = connected.remove(uniqueID) }
            }
        }
        // verify on Mac: whether CoreMIDI implicitly drops removed sources, or
        // whether MIDIPortDisconnectSource bookkeeping is needed here too.
        onDevicesChanged?(names)
    }

    private static func displayName(of object: MIDIObjectRef) -> String {
        var name: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(object, kMIDIPropertyDisplayName, &name) == noErr,
              let value = name?.takeRetainedValue() else { return "Unknown device" }
        return value as String
    }

    // MARK: - Receiving

    private func handle(eventList: UnsafePointer<MIDIEventList>) {
        // Everything in here runs on a CoreMIDI thread. Filter first so a
        // device emitting active sensing at 300/s cannot flood the main queue,
        // then pack into a Sendable value and hop.
        var messages: [MIDIMessage] = []
        for packet in eventList.unsafeSequence() {
            for word in packet.words() {
                guard let message = Self.parse(word: word) else { continue }
                messages.append(message)
            }
        }
        guard !messages.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for message in messages { self.onMessage?(message) }
        }
    }

    /// Decodes one MIDI 1.0 Universal MIDI Packet word.
    ///
    /// Message type 0x2 is "MIDI 1.0 channel voice"; everything else — system
    /// real-time (clock, active sensing), sysex, utility — is dropped here,
    /// before it can cost anything.
    private static func parse(word: UInt32) -> MIDIMessage? {
        let messageType = UInt8((word >> 28) & 0xF)
        guard messageType == 0x2 else { return nil }

        let status = UInt8((word >> 20) & 0xF0)
        let channel = UInt8((word >> 16) & 0x0F)
        let data1 = UInt8((word >> 8) & 0x7F)
        let data2 = UInt8(word & 0x7F)

        // Note on / control change / program change only. Pitch bend,
        // aftertouch and note-off are deliberately ignored in v1.
        guard status == 0x90 || status == 0xB0 || status == 0xC0 else { return nil }
        return MIDIMessage(status: status, channel: channel, data1: data1, data2: data2)
    }
}
