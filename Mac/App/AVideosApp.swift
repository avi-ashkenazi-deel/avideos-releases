import SwiftUI

/// AVideos Studio — macOS live-streaming studio.
///
/// The app has two top-level modes:
///  - Live mode: the studio (scenes, mixer, guests, virtual camera/mic).
///  - Edit mode: the post-session editor over podcast-mode recordings.
///
/// `StudioController` owns every live subsystem (render engine, sources,
/// audio graph, virtual camera, recorder, guest session) and is created once
/// for the app's lifetime.
@main
struct AVideosApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @State private var studio = StudioController()

    var body: some Scene {
        Window("AVideos Studio", id: "studio") {
            MainWindow()
                .environment(studio)
                .onAppear { appDelegate.studio = studio }
        }
        .windowResizability(.contentSize)
        .commands {
            StudioCommands(studio: studio)
        }

        Settings {
            SettingsView()
                .environment(studio)
        }
    }
}

/// Menu-bar commands for the things a host reaches for mid-show.
struct StudioCommands: Commands {
    let studio: StudioController

    var body: some Commands {
        CommandMenu("Studio") {
            Button(studio.isRecording ? "Stop Recording" : "Start Recording") {
                studio.toggleRecording()
            }
            .keyboardShortcut("r", modifiers: [.command, .shift])

            Divider()

            Button("Toggle Teleprompter") {
                studio.teleprompter.toggleVisible()
            }
            .keyboardShortcut("t", modifiers: [.command, .shift])
        }
    }
}
