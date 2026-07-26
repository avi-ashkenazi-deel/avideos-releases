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

private struct StudioLayout: View {
    @Environment(StudioController.self) private var studio
    @State private var bottomTab: BottomTab = .mixer
    @State private var showingSessionLibrary = false
    @State private var showingScriptEditor = false

    private enum BottomTab: String, CaseIterable {
        case mixer = "Mixer"
        case sounds = "Sounds"
        case music = "Music"
        case guests = "Guests"
        case setup = "Setup"
    }

    var body: some View {
        NavigationSplitView {
            SceneListView()
                .navigationSplitViewColumnWidth(min: 170, ideal: 200, max: 280)
        } detail: {
            HSplitView {
                VSplitView {
                    canvas
                        .frame(minHeight: 280)
                    bottomPanel
                        .frame(minHeight: 160, idealHeight: 220, maxHeight: 340)
                }
                InspectorView()
                    .frame(minWidth: 240, idealWidth: 280, maxWidth: 340)
            }
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
                ProgramPreviewView(previewStore: studio.previewStore, device: engine.device)
            } else {
                ContentUnavailableView("No Metal device", systemImage: "exclamationmark.triangle")
            }
            CanvasEditorOverlay()
        }
        .coordinateSpace(name: "canvas")
        .background(Color.black)
        .overlay(alignment: .topLeading) {
            StatsHUD().padding(8)
        }
    }

    private var bottomPanel: some View {
        VStack(spacing: 0) {
            Picker("", selection: $bottomTab) {
                ForEach(BottomTab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            switch bottomTab {
            case .mixer: MixerPanelView()
            case .sounds: SoundBoardView()
            case .music: MusicPlaylistView()
            case .guests: GuestsPanelView()
            case .setup: ScrollView { DriverStatusView().padding(10) }
            }
        }
        .background(.black.opacity(0.15))
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup {
            Button {
                studio.toggleRecording()
            } label: {
                Label(studio.isRecording ? "Stop" : "Record",
                      systemImage: studio.isRecording ? "stop.circle.fill" : "record.circle")
                    .foregroundStyle(studio.isRecording ? .red : .primary)
            }
            .help("Record the program to disk (⇧⌘R)")

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
