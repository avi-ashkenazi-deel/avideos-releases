import SwiftUI
import AVFoundation   // camera strip enumerates AVCaptureDevices

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
    @Environment(\.openWindow) private var openWindow
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
            VStack(spacing: 10) {
                if studio.activeSceneIsCamera && studio.prefs.showCameraSwitcher {
                    cameraStrip
                }
                recordButton
            }
            .padding(.bottom, 18)
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

    /// Scene name + menu, sitting on the video like Ecamm's scene dropdown:
    /// "Show Scenes Window" first, then the scenes with their ⌘N shortcuts.
    private var sceneSwitcher: some View {
        Menu {
            Button("Show Scenes Window") {
                openWindow(id: "palette", value: PaletteKind.scenes)
            }
            .keyboardShortcut("\\", modifiers: [.command])

            Divider()

            ForEach(studio.project.scenes) { scene in
                Button {
                    studio.switchScene(to: scene.id)
                } label: {
                    if scene.id == studio.project.activeSceneID {
                        Label(scene.name, systemImage: "checkmark")
                    } else {
                        Text(scene.name)
                    }
                }
                // ⌘1…⌘9 badges match the Studio menu bindings, which are the
                // ones that fire while the popup is closed.
                .modifier(SceneShortcutBadge(number: studio.project.shortcutNumber(for: scene.id)))
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

    /// Ecamm's camera strip: one LIVE preview tile per device (phones and
    /// iPads included once presented), in a stable name order — tiles never
    /// shuffle on click. Clicking dissolves the program to that camera.
    private var cameraStrip: some View {
        // Discovery order shifts with use; name order keeps every tile where
        // the host's muscle memory expects it.
        let devices = CameraSource.availableCameras().sorted {
            $0.localizedName.localizedCaseInsensitiveCompare($1.localizedName) == .orderedAscending
        }
        return HStack(spacing: 8) {
            ForEach(devices, id: \.uniqueID) { device in
                let isActive = studio.activeSceneCameraUID == device.uniqueID
                    || (studio.activeSceneCameraUID == nil
                        && device.uniqueID == CameraSource.device(uniqueID: nil)?.uniqueID)
                Button {
                    studio.setActiveCamera(deviceUniqueID: device.uniqueID)
                } label: {
                    VStack(spacing: 3) {
                        CameraThumbnailView(deviceUniqueID: device.uniqueID)
                            .frame(width: 76, height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .strokeBorder(isActive ? Color.white : .white.opacity(0.2),
                                                  lineWidth: isActive ? 2 : 1)
                            )
                        Text(device.localizedName)
                            .font(.caption2)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(width: 80)
                    }
                }
                .buttonStyle(.plain)
                .help(device.localizedName)
            }
        }
        .padding(8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    private var recordButton: some View {
        Button {
            studio.toggleRecording()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: studio.isRecording ? "stop.fill" : "record.circle")
                Text(studio.recordingCountdown.map { "\($0)…" }
                     ?? (studio.isRecording ? "Stop" : "Record"))
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

/// Tiny live preview for a camera-strip tile. Each tile runs its own low-res
/// capture session — macOS shares a device between sessions in-process, so
/// the program feed is unaffected.
/// verify on Mac: some virtual cameras refuse a second session; their tile
/// stays dark but still switches.
private struct CameraThumbnailView: NSViewRepresentable {
    let deviceUniqueID: String

    final class PreviewView: NSView {
        var session: AVCaptureSession?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let session else { return }
            if window == nil {
                if session.isRunning { session.stopRunning() }
            } else if !session.isRunning {
                DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
            }
        }
    }

    func makeNSView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.black.cgColor

        guard let device = AVCaptureDevice(uniqueID: deviceUniqueID),
              let input = try? AVCaptureDeviceInput(device: device) else { return view }
        let session = AVCaptureSession()
        if session.canSetSessionPreset(.low) {
            session.sessionPreset = .low   // it's a 76pt tile
        }
        guard session.canAddInput(input) else { return view }
        session.addInput(input)

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        layer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        view.layer?.addSublayer(layer)
        view.session = session
        // startRunning blocks; never on the main thread.
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        return view
    }

    func updateNSView(_ nsView: PreviewView, context: Context) {}

    static func dismantleNSView(_ nsView: PreviewView, coordinator: ()) {
        nsView.session?.stopRunning()
        nsView.session = nil
    }
}

/// ⌘N badges on scene menu items; scenes without an assignment get none.
private struct SceneShortcutBadge: ViewModifier {
    let number: Int?

    func body(content: Content) -> some View {
        if let number, (1...9).contains(number) {
            content.keyboardShortcut(KeyEquivalent(Character("\(number)")),
                                     modifiers: [.command])
        } else {
            content
        }
    }
}

/// The preferences window, Ecamm-style panes: General, Shape & Size,
/// Recording, Video, Audio, plus Shortcuts and MIDI.
struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
            ShapeSizePane()
                .tabItem { Label("Shape & Size", systemImage: "aspectratio") }
            RecordingPane()
                .tabItem { Label("Recording", systemImage: "record.circle") }
            VideoPane()
                .tabItem { Label("Video", systemImage: "video") }
            AudioPane()
                .tabItem { Label("Audio", systemImage: "speaker.wave.2") }
            ShortcutsSettingsView()
                .tabItem { Label("Shortcuts", systemImage: "keyboard") }
            MIDISettingsView()
                .tabItem { Label("MIDI", systemImage: "pianokeys") }
        }
        .frame(width: 620)
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

            // Audio devices and monitoring live in the Audio pane now.

            Section("Main Window") {
                Toggle("Show Camera Switcher", isOn: Binding(
                    get: { studio.prefs.showCameraSwitcher },
                    set: { studio.prefs.showCameraSwitcher = $0 }
                ))
                Text("The live camera strip above Record when a camera scene is active.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("Keep Utility Windows In Front", isOn: Binding(
                    get: { studio.prefs.palettesStayVisibleInBackground },
                    set: { studio.prefs.palettesStayVisibleInBackground = $0 }
                ))
                Text("Palette windows stay visible while another app is frontmost — handy when streamit feeds Zoom behind your call.")
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
