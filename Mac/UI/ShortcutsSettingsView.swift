import SwiftUI
import KeyboardShortcuts

/// Settings → Shortcuts. Two jobs: show the host every key combo the app
/// responds to, and let them rebind the global ones.
///
/// The distinction on this pane is the one that matters in practice:
/// **global** hotkeys work while another app is frontmost (you are live in
/// Zoom); **menu** shortcuts only work when the studio is focused.
struct ShortcutsSettingsView: View {
    @Environment(AudioEngineController.self) private var audio

    var body: some View {
        Form {
            Section {
                Text("Global hotkeys work even when another app is frontmost — that is the point of them: you are presenting in Zoom and still need a sound effect or a scene change. Click a combo to rebind it.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section("Sound Pads (global)") {
                // Index-based: `id: \.offset` on an enumerated sequence is a
                // key path into a tuple element, which Swift rejects.
                ForEach(KeyboardShortcuts.Name.padSlots.indices, id: \.self) { slot in
                    KeyboardShortcuts.Recorder(padLabel(slot: slot + 1),
                                               name: KeyboardShortcuts.Name.padSlots[slot])
                }
            }

            Section("Show Control (global)") {
                KeyboardShortcuts.Recorder("Start / stop recording:", name: .toggleRecording)
                KeyboardShortcuts.Recorder("Pause / resume recording:", name: .toggleRecordingPause)
                KeyboardShortcuts.Recorder("Mute / unmute microphone:", name: .toggleMicMute)
                KeyboardShortcuts.Recorder("Next scene:", name: .nextScene)
                KeyboardShortcuts.Recorder("Previous scene:", name: .previousScene)
                KeyboardShortcuts.Recorder("Show / hide teleprompter:", name: .toggleTeleprompter)
                KeyboardShortcuts.Recorder("Prompter play / pause:", name: .prompterPlayPause)
                KeyboardShortcuts.Recorder("Music play / pause:", name: .musicPlayPause)
            }

            Section("Music Sections (global)") {
                Text("Fire a section of the loaded track. A slot with no section bound to it does nothing.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                // `id: \.self` on indices — key paths cannot address tuple
                // elements, so no `\.offset` on an enumerated sequence.
                ForEach(KeyboardShortcuts.Name.sectionSlots.indices, id: \.self) { slot in
                    KeyboardShortcuts.Recorder(sectionLabel(slot: slot + 1),
                                               name: KeyboardShortcuts.Name.sectionSlots[slot])
                }
                KeyboardShortcuts.Recorder("Switch mode (cut / at loop end):",
                                           name: .sectionSwitchModeToggle)
                KeyboardShortcuts.Recorder("Loop the playing section:", name: .sectionLoopToggle)
                KeyboardShortcuts.Recorder("Drop a marker at the playhead:", name: .dropMusicMarker)
                KeyboardShortcuts.Recorder("Cancel the queued section:", name: .cancelQueuedSection)
            }

            Section("Menu Shortcuts (studio focused)") {
                Text("Fixed combos, listed in the Studio menu:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(Self.menuShortcuts) { item in
                    row(item)
                }
            }

            Section("Editor (edit mode)") {
                ForEach(Self.editorShortcuts) { item in
                    row(item)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
    }

    /// "Pad 3 — airhorn" when a pad occupies that slot, plain "Pad 3" if not,
    /// so the list reads like the soundboard the host is looking at.
    private func padLabel(slot: Int) -> String {
        if let pad = audio.pads.first(where: { $0.hotkeyIndex == slot }) {
            return "Pad \(slot) — \(pad.name):"
        }
        return "Pad \(slot) (empty):"
    }

    /// Same idea for sections, with a third case: sections belong to a track,
    /// so with nothing loaded there is nothing any slot could fire.
    private func sectionLabel(slot: Int) -> String {
        guard audio.sectionHostTrack != nil else { return "Section \(slot) (no track loaded):" }
        if let section = audio.musicSections.first(where: { $0.hotkeyIndex == slot }) {
            return "Section \(slot) — \(section.name):"
        }
        return "Section \(slot) (empty):"
    }

    /// A reference row. A struct rather than a tuple because `ForEach` needs an
    /// `id`, and key paths can't address tuple elements.
    private struct ShortcutReference: Identifiable {
        let action: String
        let keys: String
        var id: String { action }
    }

    private func row(_ item: ShortcutReference) -> some View {
        HStack {
            Text(item.action)
            Spacer()
            Text(item.keys)
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
        }
    }

    private static let menuShortcuts: [ShortcutReference] = [
        .init(action: "Start / stop recording", keys: "⇧⌘R"),
        .init(action: "Mute / unmute microphone", keys: "⇧⌘M"),
        .init(action: "Next scene", keys: "⌘]"),
        .init(action: "Previous scene", keys: "⌘["),
        .init(action: "Switch to scene 1…9", keys: "⌘1…⌘9"),
        .init(action: "Show / hide teleprompter", keys: "⇧⌘T"),
        .init(action: "Prompter play / pause", keys: "⌥⌘T"),
        .init(action: "Music play / pause", keys: "⇧⌘P"),
        .init(action: "Next / previous track", keys: "⇧⌘] / ⇧⌘["),
    ]

    private static let editorShortcuts: [ShortcutReference] = [
        .init(action: "Play / pause preview", keys: "Space"),
        .init(action: "Split at playhead", keys: "S"),
        .init(action: "Step one frame back / forward", keys: "← / →"),
        .init(action: "Cut selected words / clip", keys: "⌫"),
        .init(action: "Undo / redo", keys: "⌘Z / ⇧⌘Z"),
    ]
}
