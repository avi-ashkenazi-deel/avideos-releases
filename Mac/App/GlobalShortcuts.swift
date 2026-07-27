import AppKit
import KeyboardShortcuts

/// Global hotkeys: the things a host needs while **another app is frontmost**
/// — you are presenting in Zoom, the studio is behind it, and you still need
/// to fire a sound, switch scene, or kill your mic.
///
/// These are Carbon-registered system hotkeys (via KeyboardShortcuts), so they
/// work unfocused and need no accessibility permission.
///
/// Deliberately distinct default combos from the in-app menu equivalents
/// (⇧⌘R record, ⇧⌘T prompter, …): a global hotkey fires *in addition* to a
/// matching menu key equivalent when the app is frontmost, which would toggle
/// twice. Menu = ⇧⌘-based, global = ⌃⌥-based, pads = ⌥-based. Everything here
/// is rebindable in Settings → Shortcuts.
extension KeyboardShortcuts.Name {
    // Sound pads: ⌥1…⌥9.
    static let pad1 = Self("pad1", default: .init(.one, modifiers: [.option]))
    static let pad2 = Self("pad2", default: .init(.two, modifiers: [.option]))
    static let pad3 = Self("pad3", default: .init(.three, modifiers: [.option]))
    static let pad4 = Self("pad4", default: .init(.four, modifiers: [.option]))
    static let pad5 = Self("pad5", default: .init(.five, modifiers: [.option]))
    static let pad6 = Self("pad6", default: .init(.six, modifiers: [.option]))
    static let pad7 = Self("pad7", default: .init(.seven, modifiers: [.option]))
    static let pad8 = Self("pad8", default: .init(.eight, modifiers: [.option]))
    static let pad9 = Self("pad9", default: .init(.nine, modifiers: [.option]))

    // Show control.
    static let toggleRecording = Self("toggleRecording",
                                      default: .init(.r, modifiers: [.control, .option]))
    static let toggleMicMute = Self("toggleMicMute",
                                    default: .init(.m, modifiers: [.control, .option]))
    static let nextScene = Self("nextScene",
                                default: .init(.rightArrow, modifiers: [.control, .option]))
    static let previousScene = Self("previousScene",
                                    default: .init(.leftArrow, modifiers: [.control, .option]))
    static let toggleTeleprompter = Self("toggleTeleprompter",
                                         default: .init(.t, modifiers: [.control, .option]))
    static let prompterPlayPause = Self("prompterPlayPause",
                                        default: .init(.space, modifiers: [.control, .option]))
    static let musicPlayPause = Self("musicPlayPause",
                                     default: .init(.p, modifiers: [.control, .option]))

    // Music sections: ⌃⌥1…⌃⌥9, the performance sibling of the pads. Distinct
    // from ⌥1…⌥9 (pads) and ⌘1…⌘9 (scenes), so nothing double-fires.
    static let section1 = Self("section1", default: .init(.one, modifiers: [.control, .option]))
    static let section2 = Self("section2", default: .init(.two, modifiers: [.control, .option]))
    static let section3 = Self("section3", default: .init(.three, modifiers: [.control, .option]))
    static let section4 = Self("section4", default: .init(.four, modifiers: [.control, .option]))
    static let section5 = Self("section5", default: .init(.five, modifiers: [.control, .option]))
    static let section6 = Self("section6", default: .init(.six, modifiers: [.control, .option]))
    static let section7 = Self("section7", default: .init(.seven, modifiers: [.control, .option]))
    static let section8 = Self("section8", default: .init(.eight, modifiers: [.control, .option]))
    static let section9 = Self("section9", default: .init(.nine, modifiers: [.control, .option]))

    /// Switching behaviour has to be reachable while another app is frontmost:
    /// the segmented control only exists when the studio is, which by
    /// definition it isn't when global hotkeys matter.
    static let sectionSwitchModeToggle = Self("sectionSwitchMode",
                                              default: .init(.c, modifiers: [.control, .option]))
    static let sectionLoopToggle = Self("sectionLoop",
                                        default: .init(.l, modifiers: [.control, .option]))
    /// ⌃⌥K, not ⌃⌥M — mic mute must never be shadowed.
    static let dropMusicMarker = Self("dropMusicMarker",
                                      default: .init(.k, modifiers: [.control, .option]))
    /// With a queued switch there can be seconds between "wrong pad" and
    /// "on air". Zero reads as "slot none", and sits with 1…9.
    static let cancelQueuedSection = Self("cancelQueuedSection",
                                          default: .init(.zero, modifiers: [.control, .option]))

    /// The nine pad slots in order, so the soundboard can look up the shortcut
    /// currently assigned to a pad and show it truthfully on the pad.
    static let padSlots: [KeyboardShortcuts.Name] = [
        .pad1, .pad2, .pad3, .pad4, .pad5, .pad6, .pad7, .pad8, .pad9,
    ]

    /// `hotkeyIndex` on `SoundPad` is 1-based.
    static func padSlot(hotkeyIndex: Int) -> KeyboardShortcuts.Name? {
        guard hotkeyIndex >= 1, hotkeyIndex <= padSlots.count else { return nil }
        return padSlots[hotkeyIndex - 1]
    }

    static let sectionSlots: [KeyboardShortcuts.Name] = [
        .section1, .section2, .section3, .section4, .section5,
        .section6, .section7, .section8, .section9,
    ]

    /// `hotkeyIndex` on `MusicSection` is 1-based, same as `SoundPad`'s.
    static func sectionSlot(hotkeyIndex: Int) -> KeyboardShortcuts.Name? {
        guard hotkeyIndex >= 1, hotkeyIndex <= sectionSlots.count else { return nil }
        return sectionSlots[hotkeyIndex - 1]
    }
}

/// Binds the global hotkeys to studio actions. Registered once, for the app's
/// lifetime; KeyboardShortcuts appends handlers, so double registration would
/// double-fire every key.
@MainActor
final class GlobalShortcutRegistrar {
    private var isRegistered = false

    func register(studio: StudioController) {
        guard !isRegistered else { return }
        isRegistered = true

        for (slot, name) in KeyboardShortcuts.Name.padSlots.enumerated() {
            let hotkeyIndex = slot + 1
            bind(name, studio) { $0.audio.playPad(hotkeyIndex: hotkeyIndex) }
        }

        bind(.toggleRecording, studio) { $0.toggleRecording() }
        bind(.toggleMicMute, studio) { $0.audio.toggleMute(for: .mic) }
        bind(.nextScene, studio) { $0.advanceScene(by: 1) }
        bind(.previousScene, studio) { $0.advanceScene(by: -1) }
        bind(.toggleTeleprompter, studio) { $0.teleprompter.toggleVisible() }
        bind(.prompterPlayPause, studio) { $0.teleprompter.togglePlay() }
        bind(.musicPlayPause, studio) { $0.audio.musicPlayPause() }

        for (slot, name) in KeyboardShortcuts.Name.sectionSlots.enumerated() {
            let hotkeyIndex = slot + 1
            // A slot with nothing bound to it does nothing at all — never stop
            // the music, never start the wrong section. The pad's badge is the
            // whole truth about what a key does.
            bind(name, studio) { $0.audio.playSection(hotkeyIndex: hotkeyIndex) }
        }
        bind(.sectionSwitchModeToggle, studio) { $0.audio.toggleSectionSwitchMode() }
        bind(.sectionLoopToggle, studio)       { $0.audio.toggleSectionLoop() }
        bind(.dropMusicMarker, studio)         { _ = $0.audio.dropMarkerAtPlayhead() }
        bind(.cancelQueuedSection, studio)     { $0.audio.cancelQueuedSection() }
    }

    /// Registers one hotkey. KeyboardShortcuts invokes handlers from the Carbon
    /// hot-key handler on the main run loop, so the main-actor work runs
    /// synchronously — a pad has to fire now, not after an actor hop.
    private func bind(_ name: KeyboardShortcuts.Name,
                      _ studio: StudioController,
                      _ action: @escaping @MainActor (StudioController) -> Void) {
        KeyboardShortcuts.onKeyDown(for: name) {
            MainActor.assumeIsolated { action(studio) }
        }
    }
}
