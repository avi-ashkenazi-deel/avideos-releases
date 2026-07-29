import SwiftUI

/// streamit — macOS live-streaming studio.
///
/// The app has two top-level modes:
///  - Live mode: the studio (scenes, mixer, guests, virtual camera/mic).
///  - Edit mode: the post-session editor over podcast-mode recordings.
///
/// `StudioController` owns every live subsystem (render engine, sources,
/// audio graph, virtual camera, recorder, guest session) and is created once
/// for the app's lifetime.
@main
struct StreamitApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var studio = StudioController()
    /// Registers the unfocused hotkeys once, for the app's lifetime.
    @State private var globalShortcuts = GlobalShortcutRegistrar()

    var body: some Scene {
        Window("streamit", id: "studio") {
            MainWindow()
                .environment(studio)
                .environment(studio.audio)   // MixerPanelView reads AudioEngineController directly
                .onAppear {
                    appDelegate.studio = studio
                    // Ignition lives here, not in StudioController.init: init
                    // runs before NSApplicationMain (it is a @State default
                    // value), and starting capture/audio/MIDI/CMIO that early
                    // races AppKit for the process's window-server
                    // registration — losing the race launches the app unable
                    // to be activated. onAppear runs after launch completes.
                    studio.bootSubsystems()
                    globalShortcuts.register(studio: studio)
                }
        }
        // `.contentSize` was wrong twice over. It pins the window to the
        // content's measured size, so a studio window the user cannot resize —
        // and this content is two nested AppKit split views (HSplitView inside
        // NavigationSplitView, VSplitView inside that), whose own sizing
        // negotiation fights a window that refuses to move. `.contentMinSize`
        // honours the panes' minimums and lets the window grow, which is what
        // every pane in here was written expecting.
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1440, height: 900)
        .commands {
            StudioCommands(studio: studio)
        }

        // Studio palettes: each is a real independent window (Ecamm-style),
        // opened from the preview's icon strip via
        // openWindow(id: "palette", value: kind) — the same value refocuses
        // the existing window instead of duplicating it. Window behavior
        // (floating level, hide-on-deactivate, frame autosave) is applied by
        // PaletteWindowConfigurator inside the content.
        WindowGroup(id: "palette", for: PaletteKind.self) { $kind in
            if let kind {
                PaletteWindowContent(kind: kind)
                    .environment(studio)
                    .environment(studio.audio)
            }
        }
        .windowResizability(.contentSize)

        Settings {
            SettingsView()
                .environment(studio)
                .environment(studio.audio)   // DriverStatusView subtree may resolve it too
        }
    }
}

/// Menu-bar commands for the things a host reaches for mid-show.
///
/// These fire while the studio is frontmost and exist mainly to be
/// *discoverable* — the menu shows each key combo. The same actions also have
/// **global** hotkeys (see `GlobalShortcuts.swift`) for when you are in Zoom
/// with the studio behind it; those use ⌃⌥-based combos so a frontmost
/// keypress can never trigger both paths and toggle twice.
struct StudioCommands: Commands {
    let studio: StudioController
    @Environment(\.openWindow) private var openWindow


    var body: some Commands {
        CommandGroup(after: .pasteboard) {
            // The discoverable twin of pressing Delete with the canvas
            // focused. Command-modified on purpose: the inspector has text
            // fields, and a bare-Delete menu equivalent would race them.
            // HIDES rather than deletes — deleting for real lives only in
            // the Overlays palette (asked for explicitly).
            Button("Hide Element") {
                if let id = studio.selectedElementID,
                   studio.findElement(id: id)?.isVisible == true {
                    studio.toggleElementVisibility(id: id)
                }
            }
            .keyboardShortcut(.delete, modifiers: [.command])
            .disabled(studio.selectedElementID == nil)
        }

        CommandMenu("Studio") {
            // The functional twin of the scene popup's first row — a view
            // menu's shortcuts only fire while it is open; this one is live
            // whenever the app is.
            Button("Show Scenes Window") {
                openWindow(id: "palette", value: PaletteKind.scenes)
            }
            .keyboardShortcut("\\", modifiers: [.command])

            Divider()

            Button(studio.isRecording ? "Stop Recording" : "Start Recording") {
                studio.toggleRecording()
            }
            .keyboardShortcut("r", modifiers: [.command, .shift])

            Button(studio.audio.isMuted(.mic) ? "Unmute Microphone" : "Mute Microphone") {
                studio.audio.toggleMute(for: .mic)
            }
            .keyboardShortcut("m", modifiers: [.command, .shift])

            Divider()

            Button("Next Scene") { studio.advanceScene(by: 1) }
                .keyboardShortcut("]", modifiers: [.command])
            Button("Previous Scene") { studio.advanceScene(by: -1) }
                .keyboardShortcut("[", modifiers: [.command])

            Menu("Switch to Scene") {
                // ⌘1…⌘9 per Project.sceneShortcuts: explicit per-scene
                // bindings win, the rest number by sidebar position.
                ForEach(studio.project.sceneShortcuts, id: \.scene.id) { entry in
                    Button(entry.scene.name) {
                        studio.switchToScene(number: entry.number)
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(entry.number)")),
                                      modifiers: [.command])
                }
            }

            Button("Duplicate Scene") {
                if let id = studio.project.activeSceneID {
                    studio.duplicateScene(id: id)
                }
            }
            .keyboardShortcut("d", modifiers: [.command])
            .disabled(studio.project.activeSceneID == nil)

            Divider()

            Button("Toggle Teleprompter") {
                studio.teleprompter.toggleVisible()
            }
            .keyboardShortcut("t", modifiers: [.command, .shift])

            Button("Prompter Play/Pause") {
                studio.teleprompter.togglePlay()
            }
            .keyboardShortcut("t", modifiers: [.command, .option])

            Divider()

            Button("Music Play/Pause") { studio.audio.musicPlayPause() }
                .keyboardShortcut("p", modifiers: [.command, .shift])
            Button("Next Track") { studio.audio.musicNext() }
                .keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Previous Track") { studio.audio.musicPrevious() }
                .keyboardShortcut("[", modifiers: [.command, .shift])
        }
    }
}
