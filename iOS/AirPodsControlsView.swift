import SwiftUI
import AVFoundation

/// Best-effort detection of the connected audio output, so we can tailor the
/// gesture guidance. iOS gives no official "model" API; we read the current
/// route's port name (e.g. "Avi's AirPods Pro"), which the user can rename, so
/// this is a hint, not a guarantee.
enum AirPodsControls {
    enum Model {
        case pro          // AirPods Pro / Pro 2 (stem force sensor)
        case max          // AirPods Max (Digital Crown)
        case airPods      // AirPods 2/3/4 (tap or stem press, configurable)
        case otherBluetooth
        case none         // speaker / wired / nothing connected

        var title: String {
            switch self {
            case .pro: return "AirPods Pro"
            case .max: return "AirPods Max"
            case .airPods: return "AirPods"
            case .otherBluetooth: return "Bluetooth headphones"
            case .none: return "No headphones connected"
            }
        }
    }

    static func current() -> (model: Model, name: String?) {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let bluetooth = outputs.first {
            $0.portType == .bluetoothA2DP || $0.portType == .bluetoothLE || $0.portType == .bluetoothHFP
        }
        guard let port = bluetooth else { return (.none, outputs.first?.portName) }
        let name = port.portName
        let lower = name.lowercased()
        if lower.contains("airpods pro") { return (.pro, name) }
        if lower.contains("airpods max") { return (.max, name) }
        if lower.contains("airpods") { return (.airPods, name) }
        return (.otherBluetooth, name)
    }
}

private struct GestureRow: Identifiable {
    let id = UUID()
    let gesture: String
    let action: String
    let systemImage: String
}

/// Settings sub-screen: shows which AirPods we think are connected and the
/// gestures that control playback, tailored to the model and to whether the
/// AirPods-highlight option is on.
struct AirPodsControlsView: View {
    @ObservedObject private var settings = AppSettings.shared
    @State private var detection = AirPodsControls.current()

    private var model: AirPodsControls.Model { detection.model }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: model == .max ? "airpodsmax"
                          : model == .pro ? "airpodspro"
                          : model == .otherBluetooth ? "headphones" : "airpods")
                        .font(.title2)
                        .foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(detection.name ?? model.title)
                            .font(.headline)
                        Text(statusLine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("Detection is based on the connected device's name and may be off if you've renamed your AirPods. The gestures below are what VoiceInbox does with the standard transport controls.")
            }

            Section {
                Toggle("Highlight & voice notes", isOn: $settings.airPodsHighlightEnabled)
            } footer: {
                Text(settings.airPodsHighlightEnabled
                     ? "On: the next-track gesture saves a highlight of the last 10 seconds, then asks out loud “Do you want to add a note?” — say yes and dictate it, hands-free."
                     : "Off: the next-track gesture just skips to the next sentence.")
            }

            Section("Gestures") {
                ForEach(gestures) { row in
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.gesture).font(.subheadline.weight(.semibold))
                            Text(row.action).font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: row.systemImage)
                    }
                    .padding(.vertical, 2)
                }
            }

            if model == .airPods || model == .otherBluetooth {
                Section {
                    Text("Older AirPods and other headphones let you change which gesture sends each control in iOS Settings → Bluetooth → (your device). Map a gesture to “Next Track” to use the highlight/skip action.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("AirPods controls")
        .navigationBarTitleDisplayMode(.inline)
        // Refresh when the audio route changes (AirPods connect/disconnect).
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { _ in
            detection = AirPodsControls.current()
        }
        .onAppear { detection = AirPodsControls.current() }
    }

    private var statusLine: String {
        switch model {
        case .none: return "Connect your AirPods to control playback hands-free."
        case .otherBluetooth: return "Connected — standard transport controls apply."
        default: return "Connected"
        }
    }

    /// The "next track" gesture's meaning depends on the highlight toggle.
    private var nextAction: String {
        settings.airPodsHighlightEnabled
            ? "Highlight the last 10 seconds (then asks to add a note). Skips the image when one is on screen."
            : "Skip to the next sentence. Skips the image when one is on screen."
    }

    private var gestures: [GestureRow] {
        switch model {
        case .max:
            return [
                .init(gesture: "Press the Digital Crown", action: "Play or pause", systemImage: "playpause"),
                .init(gesture: "Press the crown twice", action: nextAction, systemImage: "forward.end"),
                .init(gesture: "Press the crown three times", action: "Back to the previous sentence", systemImage: "backward.end")
            ]
        case .otherBluetooth:
            return [
                .init(gesture: "Play / Pause button", action: "Play or pause", systemImage: "playpause"),
                .init(gesture: "Next track", action: nextAction, systemImage: "forward.end"),
                .init(gesture: "Previous track", action: "Back to the previous sentence", systemImage: "backward.end")
            ]
        default:
            // AirPods Pro / AirPods 4 (stem force sensor) — and the closest guidance
            // for other AirPods, which behave the same once mapped.
            return [
                .init(gesture: "Press the stem once", action: "Play or pause", systemImage: "playpause"),
                .init(gesture: "Press the stem twice", action: nextAction, systemImage: "forward.end"),
                .init(gesture: "Press the stem three times", action: "Back to the previous sentence", systemImage: "backward.end"),
                .init(gesture: "Press and hold", action: "Switches noise modes — handled by iOS, not the app", systemImage: "hand.point.up.left")
            ]
        }
    }
}
