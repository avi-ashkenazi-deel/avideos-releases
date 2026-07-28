import SwiftUI

/// The main window: live-mode studio (scenes | preview+panels | inspector)
/// or edit mode when a session is opened in the editor.
struct MainWindow: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        switch studio.mode {
        case .live:
            StudioLayout()
        case .edit(let project):
            EditWorkspaceView(project: project) {
                studio.closeEditor()
            }
        }
    }
}

/// Ecamm-style shell: the live preview fills the window, and every control
/// surface is a floating palette sitting on the recording itself (see
/// `FloatingPalettes.swift`). On-video chrome: the scene switcher top-left,
/// the record button bottom-center, the palette strip on the right edge.
private struct StudioLayout: View {
    @Environment(StudioController.self) private var studio
    @State private var showingSessionLibrary = false
    @State private var showingScriptEditor = false

    var body: some View {
        @Bindable var studio = studio
        canvas
        .overlay(alignment: .trailing) {
            PaletteStrip().padding(.trailing, 8)
        }
        .confirmationDialog("Recording saved",
                            isPresented: $studio.showingRecordingOptions,
                            titleVisibility: .visible) {
            Button("Open in Editor") { studio.openLastRecordingInEditor() }
            Button("Show in Finder") { studio.revealLastRecordingInFinder() }
            Button("Delete (Bad Take)", role: .destructive) { studio.discardLastRecording() }
            Button("Keep", role: .cancel) {}
        } message: {
            Text(studio.lastRecordingURL?.lastPathComponent ?? "")
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 10) {
                sceneSwitcher
                StatsHUD()
            }
            .padding(10)
        }
        .overlay(alignment: .bottom) {
            recordButton.padding(.bottom, 18)
        }
        .toolbar { toolbarContent }
        .sheet(isPresented: $showingSessionLibrary) {
            SessionLibraryView()
                .frame(minWidth: 760, minHeight: 480)
        }
        .sheet(isPresented: $showingScriptEditor) {
            ScriptEditorView(store: ScriptStore(),
                             controller: studio.teleprompter,
                             scenes: studio.project.scenes.map { ($0.id, $0.name) })
        }
    }

    private var canvas: some View {
        ZStack {
            if let engine = studio.renderEngine {
                ProgramPreviewView(previewStore: studio.previewStore,
                                   device: engine.device,
                                   framesPerSecond: studio.project.frameRate)
            } else {
                ContentUnavailableView("No Metal device", systemImage: "exclamationmark.triangle")
            }
            CanvasEditorOverlay()
        }
        .coordinateSpace(name: "canvas")
        .background(Color.black)
        .ignoresSafeArea()
    }

    /// Scene name + menu, sitting on the video like Ecamm's scene dropdown.
    private var sceneSwitcher: some View {
        Menu {
            ForEach(Array(studio.project.scenes.enumerated()), id: \.element.id) { index, scene in
                Button {
                    studio.switchToScene(number: index + 1)
                } label: {
                    if scene.id == studio.project.activeSceneID {
                        Label(scene.name, systemImage: "checkmark")
                    } else {
                        Text(scene.name)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(studio.activeScene?.name ?? "No Scene")
                    .font(.callout.weight(.semibold))
                Image(systemName: "chevron.down")
                    .font(.caption2)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.ultraThinMaterial, in: Capsule())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var recordButton: some View {
        Button {
            studio.toggleRecording()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: studio.isRecording ? "stop.fill" : "record.circle")
                Text(studio.isRecording ? "Stop" : "Record")
                    .font(.body.weight(.semibold))
            }
            .padding(.horizontal, 26)
            .padding(.vertical, 10)
            .background(studio.isRecording ? Color.red : Color.accentColor,
                        in: RoundedRectangle(cornerRadius: 9))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        // ⇧⌘R already lives on the Studio menu command; binding it here too
        // would fire the toggle twice per press.
        .help("Record the program to disk (⇧⌘R)")
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup {
            // Record lives on the video itself (bottom-center), not up here.
            Button {
                studio.teleprompter.toggleVisible()
            } label: {
                Label("Teleprompter", systemImage: "text.viewfinder")
            }
            .help("Toggle the teleprompter panel (⇧⌘T)")

            Button {
                showingScriptEditor = true
            } label: {
                Label("Scripts", systemImage: "doc.text")
            }

            Button {
                showingSessionLibrary = true
            } label: {
                Label("Sessions", systemImage: "tray.full")
            }
            .help("Podcast-mode session library")
        }
    }
}

/// App settings: session server, AI key, devices.
struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
            ShortcutsSettingsView()
                .tabItem { Label("Shortcuts", systemImage: "keyboard") }
            MIDISettingsView()
                .tabItem { Label("MIDI", systemImage: "pianokeys") }
        }
        .frame(width: 560)
    }
}

private struct GeneralSettingsView: View {
    @Environment(StudioController.self) private var studio
    @State private var workerURLText = ""
    @State private var claudeKey = ""

    var body: some View {
        Form {
            Section("Session Server") {
                TextField("Worker URL (https://…workers.dev)", text: $workerURLText)
                    .onSubmit {
                        studio.workerBaseURL = URL(string: workerURLText)
                    }
                Text("The Cloudflare Worker that hosts guest sessions and recording uploads — see infra/worker/README.md.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("AI") {
                SecureField("Claude API key", text: $claudeKey)
                    .onSubmit {
                        ClaudeAPIClient.storeAPIKey(claudeKey)
                    }
                Text("Powers AI take selection, clip suggestions, chapters, and moment search. Stored in the Keychain.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Audio Devices") {
                Picker("Microphone", selection: Binding(
                    get: { studio.audio.micDeviceUID ?? "" },
                    set: { studio.audio.setMicDevice(uid: $0.isEmpty ? nil : $0) }
                )) {
                    Text("System Default").tag("")
                    ForEach(studio.audio.inputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                Picker("Monitor Output", selection: Binding(
                    get: { studio.audio.monitorDeviceUID ?? "" },
                    set: { studio.audio.setMonitorDevice(uid: $0.isEmpty ? nil : $0) }
                )) {
                    Text("System Default").tag("")
                    ForEach(studio.audio.outputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                Toggle("Mic noise suppression (Apple voice processing)", isOn: Binding(
                    get: { studio.audio.voiceProcessingEnabled },
                    set: { studio.audio.voiceProcessingEnabled = $0 }
                ))
                Toggle("Hear my own mic (self-monitoring)", isOn: Binding(
                    get: { studio.audio.micMonitorEnabled },
                    set: { studio.audio.micMonitorEnabled = $0 }
                ))
                Text("Off by default. The mic always reaches recordings, the virtual mic and guests — this only controls your local speakers.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Virtual Devices") {
                DriverStatusView()
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .onAppear {
            workerURLText = studio.workerBaseURL?.absoluteString ?? ""
            claudeKey = ClaudeAPIClient.storedAPIKey() ?? ""
        }
    }
}
