import Foundation
import os

/// What a MIDI control does when it fires. Deliberately the *same* action
/// vocabulary the section pads and the global hotkeys use, so there is one
/// action layer with three input devices rather than three parallel paths.
enum MIDIAction: Codable, Hashable, Sendable {
    /// 1-based, the same slot namespace as `MusicSection.hotkeyIndex`.
    case section(index: Int)
    /// The soundboard comes along for free.
    case pad(index: Int)
    case switchModeCut
    case switchModeAtLoopEnd
    case toggleSectionLoop
    case cancelQueued
    case musicPlayPause
    case dropMarker

    var displayName: String {
        switch self {
        case .section(let index): "Section \(index)"
        case .pad(let index): "Pad \(index)"
        case .switchModeCut: "Switch mode: cut"
        case .switchModeAtLoopEnd: "Switch mode: at loop end"
        case .toggleSectionLoop: "Toggle section loop"
        case .cancelQueued: "Cancel queued section"
        case .musicPlayPause: "Music play / pause"
        case .dropMarker: "Drop a marker"
        }
    }

    /// Everything bindable, in the order the settings table shows it.
    static var all: [MIDIAction] {
        // Written with explicit element types: an implicit-member closure body
        // inside a `+` chain is exactly the shape Swift fails to infer.
        let sections: [MIDIAction] = (1...9).map { MIDIAction.section(index: $0) }
        let pads: [MIDIAction] = (1...9).map { MIDIAction.pad(index: $0) }
        let globals: [MIDIAction] = [.switchModeCut, .switchModeAtLoopEnd,
                                     .toggleSectionLoop, .cancelQueued,
                                     .musicPlayPause, .dropMarker]
        return sections + pads + globals
    }
}

/// One parsed MIDI message, reduced to the four bytes that matter.
///
/// A small `Sendable` value specifically so the CoreMIDI read block can hand it
/// across to the main actor without touching anything shared.
struct MIDIMessage: Hashable, Sendable {
    /// High nibble: 0x90 note on, 0xB0 control change, 0xC0 program change.
    var status: UInt8
    var channel: UInt8
    var data1: UInt8
    var data2: UInt8

    var isNoteOn: Bool { status == 0x90 && data2 > 0 }
    var isControlChange: Bool { status == 0xB0 }
    var isProgramChange: Bool { status == 0xC0 }

    /// Whether this message should *fire* something.
    ///
    /// Note-on with velocity 0 is the running-status note-off convention and
    /// must not retrigger. A CC is treated as a switch: half-way up is on,
    /// which covers footswitches and pads in both momentary and toggle mode.
    var isTrigger: Bool {
        isNoteOn || (isControlChange && data2 >= 64) || isProgramChange
    }

    var displayDescription: String {
        let kind = switch status {
        case 0x90: "Note"
        case 0xB0: "CC"
        case 0xC0: "Program"
        default: "0x\(String(status, radix: 16))"
        }
        return "\(kind) \(data1) · ch \(channel + 1) · val \(data2)"
    }
}

struct MIDIBinding: Identifiable, Codable, Hashable {
    var id: UUID
    var action: MIDIAction
    var status: UInt8
    /// 0…15, or `anyChannel` — some controllers change channel per bank.
    var channel: UInt8
    var data1: UInt8
    /// Display only. Bindings are deliberately device-agnostic so unplugging
    /// and replugging, or swapping to an identical controller, still works.
    var deviceName: String?

    static let anyChannel: UInt8 = 0xFF

    init(id: UUID = UUID(),
         action: MIDIAction,
         status: UInt8,
         channel: UInt8,
         data1: UInt8,
         deviceName: String? = nil) {
        self.id = id
        self.action = action
        self.status = status
        self.channel = channel
        self.data1 = data1
        self.deviceName = deviceName
    }

    func matches(_ message: MIDIMessage) -> Bool {
        guard status == message.status, data1 == message.data1 else { return false }
        return channel == Self.anyChannel || channel == message.channel
    }
}

/// Bindings live in their own file, **not** in `audio-settings.json`.
///
/// That file is the one that costs the host their entire mixer if it fails to
/// decode, and MIDI bindings are the newest and least-settled schema here — the
/// most likely to change shape. Keeping them apart means a MIDI mistake can
/// never take the devices, faders, ducker, inserts and playlist with it.
final class MIDIBindingStore {
    private let url: URL
    private var pendingSave: DispatchWorkItem?
    private let queue = DispatchQueue(label: "com.aviashkenazi.avideos.midibindings", qos: .utility)
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "midi")

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("AVideos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("midi-bindings.json")
    }

    func load() -> [MIDIBinding] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONDecoder().decode([MIDIBinding].self, from: data)
        } catch {
            log.error("midi-bindings.json unreadable: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func saveDebounced(_ bindings: [MIDIBinding], delay: TimeInterval = 0.5) {
        pendingSave?.cancel()
        let work = DispatchWorkItem { [url] in
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            if let data = try? encoder.encode(bindings) {
                try? data.write(to: url, options: .atomic)
            }
        }
        pendingSave = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
