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
                    globalShortcuts.register(studio: studio)
                }
        }
        .windowResizability(.contentSize)
        .commands {
            StudioCommands(studio: studio)
        }

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

    /// Sidebar positions that get a ⌘N shortcut (the first nine scenes).
    private var sceneMenuIndices: Range<Int> {
        0..<min(studio.project.scenes.count, 9)
    }

    var body: some Commands {
        CommandMenu("Studio") {
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
                // ⌘1…⌘9 jump straight to a scene by sidebar position. Indexed
                // rather than enumerated: `id:` key paths can't address tuple
                // elements.
                ForEach(sceneMenuIndices, id: \.self) { index in
                    Button(studio.project.scenes[index].name) {
                        studio.switchToScene(number: index + 1)
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")),
                                      modifiers: [.command])
                }
            }

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
