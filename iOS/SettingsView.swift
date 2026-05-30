import SwiftUI
import AVFoundation

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var settings = AppSettings.shared
    @Environment(\.dismiss) private var dismiss

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

    var body: some View {
        Form {
            Section("Playback") {
                Picker("Default speed", selection: Binding(
                    get: { settings.speed },
                    set: { settings.speed = $0 }
                )) {
                    ForEach(speeds, id: \.self) { Text("\($0, specifier: "%g")×").tag($0) }
                }

                Toggle("Remove silence", isOn: $settings.removeSilence)
            }

            Section {
                Picker("When there's an image", selection: $settings.imageBehavior) {
                    ForEach(ImageBehavior.allCases) { behavior in
                        Text(behavior.title).tag(behavior)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Images")
            } footer: {
                Text(settings.imageBehavior.detail)
            }

            Section {
                Picker("Voice", selection: $settings.voiceIdentifier) {
                    Text("System default").tag("")
                    ForEach(voices, id: \.identifier) { voice in
                        Text("\(voice.name) (\(voice.language))").tag(voice.identifier)
                    }
                }
            } header: {
                Text("Voice")
            }

            Section {
                Toggle("Highlight with AirPods", isOn: $settings.airPodsHighlightEnabled)
            } header: {
                Text("AirPods")
            } footer: {
                Text("When on, an AirPods press captures a highlight of the last 10 seconds instead of skipping ahead. Use the on-screen Next button to skip.")
            }

            Section("Account") {
                if let account = appState.account {
                    LabeledContent("Signed in", value: account.emailAddress)
                }
                #if os(iOS)
                Button("Sign out", role: .destructive) {
                    appState.signOut()
                    dismiss()
                }
                #endif
            }
        }
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }

    private var voices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .sorted { $0.language == $1.language ? $0.name < $1.name : $0.language < $1.language }
    }
}
