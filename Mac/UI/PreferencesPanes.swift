import SwiftUI
import AppKit

// The Ecamm-style preference panes. Shape & Size edits the open PROJECT
// (canvas + fps are document fields — a vertical show and a wide show keep
// their own shapes); the rest bind to AppPreferences / audio settings.

// MARK: - Shape & Size

/// Program shape presets. Aspect = width / height.
enum VideoShape: String, CaseIterable {
    case wide, classic, square, tall

    var displayName: String {
        switch self {
        case .wide: "Wide (16:9)"
        case .classic: "Classic (4:3)"
        case .square: "Square (1:1)"
        case .tall: "Tall (9:16)"
        }
    }

    var aspect: Double {
        switch self {
        case .wide: 16.0 / 9.0
        case .classic: 4.0 / 3.0
        case .square: 1
        case .tall: 9.0 / 16.0
        }
    }
}

/// Quality tiers, expressed as the frame height (width follows the shape).
enum VideoSizeTier: Int, CaseIterable {
    case uhd = 2160
    case high = 1080
    case medium = 720
    case low = 540

    var displayName: String {
        switch self {
        case .uhd: "4K (2160)"
        case .high: "High (1080p)"
        case .medium: "Medium (720p)"
        case .low: "Low (540p)"
        }
    }
}

struct ShapeSizePane: View {
    @Environment(StudioController.self) private var studio
    /// Aspect changes stretch existing overlays (element transforms are unit
    /// fractions of the canvas), so they confirm first.
    @State private var pendingShape: VideoShape?

    private var canvas: CGSize { studio.project.canvasSize }

    private var currentShape: VideoShape {
        let aspect = canvas.height > 0 ? canvas.width / canvas.height : 16.0 / 9.0
        return VideoShape.allCases.min {
            abs($0.aspect - aspect) < abs($1.aspect - aspect)
        } ?? .wide
    }

    private var currentSize: VideoSizeTier {
        let height = Int(canvas.height)
        return VideoSizeTier.allCases.min {
            abs($0.rawValue - height) < abs($1.rawValue - height)
        } ?? .high
    }

    var body: some View {
        Form {
            Picker("Video Shape", selection: Binding(
                get: { currentShape },
                set: { newShape in
                    guard newShape != currentShape else { return }
                    pendingShape = newShape   // confirm: overlays will stretch
                }
            )) {
                ForEach(VideoShape.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            Text("The shape of the program for streaming and recording. This project: \(Int(canvas.width))×\(Int(canvas.height)).")
                .font(.caption)
                .foregroundStyle(.secondary)

            Picker("Video Size", selection: Binding(
                get: { currentSize },
                set: { apply(shape: currentShape, size: $0, fps: studio.project.frameRate) }
            )) {
                ForEach(VideoSizeTier.allCases, id: \.self) { Text($0.displayName).tag($0) }
            }
            Text("The frame size for streaming and recording. The virtual camera is happiest at 1080p.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Picker("Frame Rate", selection: Binding(
                get: { studio.project.frameRate },
                set: { apply(shape: currentShape, size: currentSize, fps: $0) }
            )) {
                ForEach([24, 25, 30, 50, 60], id: \.self) { Text("\($0) FPS").tag($0) }
            }
            Text("25 or 30 FPS is normal depending on your region. 50 or 60 doubles the work everywhere downstream.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if studio.isRecording {
                Label("Shape, size and frame rate can't change while recording.",
                      systemImage: "record.circle")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
        .disabled(studio.isRecording)
        .confirmationDialog(
            "Change the video shape?",
            isPresented: Binding(get: { pendingShape != nil },
                                 set: { if !$0 { pendingShape = nil } }),
            titleVisibility: .visible
        ) {
            Button("Change Shape") {
                if let shape = pendingShape {
                    apply(shape: shape, size: currentSize, fps: studio.project.frameRate)
                }
                pendingShape = nil
            }
            Button("Cancel", role: .cancel) { pendingShape = nil }
        } message: {
            Text("Overlay positions and sizes are relative to the canvas, so existing overlays will stretch to the new shape. You may need to re-lay-out scenes.")
        }
    }

    private func apply(shape: VideoShape, size: VideoSizeTier, fps: Int) {
        let height = size.rawValue
        let width = Int((Double(height) * shape.aspect).rounded() / 2) * 2
        studio.applyCanvasSettings(size: CGSize(width: CGFloat(width), height: CGFloat(height)),
                                   fps: fps)
    }
}

// MARK: - Recording

struct RecordingPane: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        @Bindable var prefs = studio.prefs
        Form {
            Picker("Video Codec", selection: $prefs.recordingCodec) {
                Text("HEVC (H.265)").tag(ProgramRecorder.Codec.hevc)
                Text("H.264").tag(ProgramRecorder.Codec.h264)
            }
            Text("HEVC is smaller at the same quality; H.264 is the compatibility pick. Applies from the next recording.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Recordings Folder") {
                HStack {
                    Text(prefs.recordingsFolderPath ?? "~/Movies/Streamit")
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .foregroundStyle(.secondary)
                    Button("Choose…") { chooseFolder() }
                    if prefs.recordingsFolderPath != nil {
                        Button("Reset") { prefs.recordingsFolderPath = nil }
                    }
                }
            }

            Toggle("Record Countdown", isOn: $prefs.recordCountdown)
            Text("Wait three seconds before a recording starts. Press Record again during the count to cancel.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("Recordings are .mov with 5-second fragments — a crash loses at most the last five seconds.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose Recordings Folder"
        if panel.runModal() == .OK, let url = panel.url {
            studio.prefs.recordingsFolderPath = url.path
        }
    }
}

// MARK: - Video

struct VideoPane: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        @Bindable var studio = studio
        @Bindable var prefs = studio.prefs
        Form {
            Picker("Default Source Mode", selection: $prefs.defaultSceneKind) {
                ForEach(AppPreferences.DefaultSceneKind.allCases, id: \.self) {
                    Text($0.displayName).tag($0)
                }
            }
            Text("What the scene list's plus button adds on a plain click (the menu still offers every kind).")
                .font(.caption)
                .foregroundStyle(.secondary)

            Picker("Default Transition", selection: $prefs.defaultSceneTransition) {
                ForEach(SceneTransitionStyle.allCases, id: \.self) {
                    Text($0.displayName).tag($0)
                }
            }
            Text("The transition newly created scenes start with. Each scene can override it from its context menu.")
                .font(.caption)
                .foregroundStyle(.secondary)

            LabeledContent("Transition Duration") {
                Slider(value: $studio.project.defaultTransitionDuration, in: 0.1...2)
                Text(String(format: "%.1fs", studio.project.defaultTransitionDuration))
                    .font(.caption.monospacedDigit())
                    .frame(width: 36)
            }

            Toggle("Auto-Play Video Files", isOn: $prefs.autoPlayMovies)
            Text("Movie scenes start playing when you switch to them. Off: they hold their first frame until you press play.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
}

// MARK: - Audio

struct AudioPane: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        Form {
            Section {
                Picker("Speakers", selection: Binding(
                    get: { studio.audio.monitorDeviceUID ?? "" },
                    set: { studio.audio.setMonitorDevice(uid: $0.isEmpty ? nil : $0) }
                )) {
                    Text("System Default").tag("")
                    ForEach(studio.audio.outputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
                Text("Where movies, sound effects, music and guests play locally.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Picker("Microphone", selection: Binding(
                    get: { studio.audio.micDeviceUID ?? "" },
                    set: { studio.audio.setMicDevice(uid: $0.isEmpty ? nil : $0) }
                )) {
                    Text("System Default").tag("")
                    ForEach(studio.audio.inputDevices, id: \.uid) { device in
                        Text(device.name).tag(device.uid)
                    }
                }
            }

            Section {
                Toggle("Use Echo Cancellation (voice processing)", isOn: Binding(
                    get: { studio.audio.voiceProcessingEnabled },
                    set: { studio.audio.voiceProcessingEnabled = $0 }
                ))
                Text("Apple's voice processing on the microphone: echo cancellation and noise suppression.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("Hear My Own Mic (self-monitoring)", isOn: Binding(
                    get: { studio.audio.micMonitorEnabled },
                    set: { studio.audio.micMonitorEnabled = $0 }
                ))
                Text("Off by default. The mic always reaches recordings, the virtual mic and guests — this only controls your speakers.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("Mute Movie Sound On Speakers", isOn: Binding(
                    get: { studio.audio.movieMonitorMuted },
                    set: { studio.audio.movieMonitorMuted = $0 }
                ))
                Text("Roll a movie into the broadcast without hearing it locally. The program, recording and guests keep its sound.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Editor Exports") {
                @Bindable var prefs = studio.prefs
                Toggle("Normalize Loudness On Export", isOn: $prefs.normalizeExportLoudness)
                Text("Editor exports are measured (EBU R128) and brought to delivery loudness: −16 LUFS for audio masters, −14 LUFS for video. Mix balance is untouched; stems are never normalized.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
