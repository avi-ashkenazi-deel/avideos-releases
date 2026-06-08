import SwiftUI
import AVFoundation

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var settings = AppSettings.shared
    @Environment(\.dismiss) private var dismiss

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]

    @State private var elevenVoices: [ElevenLabsVoice] = []
    @State private var loadingVoices = false
    @State private var voiceError: String?
    @State private var showAddAccount = false

    var body: some View {
        Form {
            Section {
                Picker("Default speed", selection: Binding(
                    get: { settings.speed },
                    set: { settings.speed = $0 }
                )) {
                    ForEach(speeds, id: \.self) { Text("\($0, specifier: "%g")×").tag($0) }
                }

                Toggle("Auto-play next unread", isOn: $settings.autoAdvance)
            } header: {
                Text("Playback")
            } footer: {
                Text("When an email finishes, automatically open the next unread one, announce who it's from and its subject, then keep reading.")
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
                Picker("Text size", selection: $settings.readingTextSize) {
                    ForEach(ReadingTextSize.allCases) { size in
                        Text(size.title).tag(size)
                    }
                }
            } header: {
                Text("Reading")
            } footer: {
                Text("Size of the text in the email/article reading view.")
            }

            Section {
                Picker("Voice", selection: $settings.voiceIdentifier) {
                    Text("System default").tag("")
                    ForEach(voices, id: \.identifier) { voice in
                        Text("\(voice.name) (\(voice.language))").tag(voice.identifier)
                    }
                }
                .disabled(settings.useElevenLabs)
            } header: {
                Text("System voice")
            } footer: {
                if settings.useElevenLabs {
                    Text("Disabled while ElevenLabs is on.")
                }
            }

            elevenLabsSection

            Section {
                Toggle("Voice notes on highlights", isOn: $settings.airPodsHighlightEnabled)
                NavigationLink {
                    AirPodsControlsView()
                } label: {
                    Label("AirPods controls & gestures", systemImage: "airpods")
                }
            } header: {
                Text("AirPods")
            } footer: {
                Text("Next/Previous always move by sentence (and skip an image when one is showing). With this on, bookmarking a moment offers to dictate a note out loud, hands-free (needs the screen unlocked for the mic). Tap “AirPods controls & gestures” to see the exact presses for your AirPods.")
            }

            Section {
                ForEach(appState.connectedAccounts) { acc in
                    Button {
                        Task { await appState.switchTo(acc.id) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(acc.displayName).foregroundStyle(.primary)
                                Text(acc.email).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if acc.id == appState.activeAccountID {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .swipeActions {
                        Button(role: .destructive) {
                            Task { await appState.removeAccount(acc.id) }
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
                #if os(iOS)
                Button {
                    showAddAccount = true
                } label: {
                    Label("Add another account", systemImage: "plus.circle")
                }
                #endif
            } header: {
                Text(appState.connectedAccounts.isEmpty ? "Account" : "Accounts")
            } footer: {
                if appState.connectedAccounts.count > 1 {
                    Text("Tap an account to switch its inbox. Settings, saved links, and highlights are shared across all accounts.")
                }
            }

            Section {
                LabeledContent("Version", value: Self.versionString)
                #if os(iOS)
                Button("Sign out of all", role: .destructive) {
                    appState.signOut()
                    dismiss()
                }
                #endif
            }
        }
        .sheet(isPresented: $showAddAccount) {
            AddAccountSheet()
        }
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .onChange(of: settings.elevenLabsAPIKey) { _, _ in relayElevenLabs() }
        .onChange(of: settings.elevenLabsVoiceID) { _, _ in relayElevenLabs() }
        .onChange(of: settings.useElevenLabs) { _, _ in relayElevenLabs() }
    }

    /// Push the ElevenLabs config to the watch (the key isn't shared via the
    /// app group because it lives in the per-app Keychain).
    private func relayElevenLabs() {
        WatchConnectivityBridge.shared.syncElevenLabsConfig(
            key: settings.elevenLabsAPIKey,
            voiceID: settings.elevenLabsVoiceID,
            enabled: settings.useElevenLabs
        )
    }

    private var voices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .sorted { $0.language == $1.language ? $0.name < $1.name : $0.language < $1.language }
    }

    /// App version + build, so it's easy to confirm which TestFlight build is installed.
    private static var versionString: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    // MARK: - ElevenLabs

    @ViewBuilder
    private var elevenLabsSection: some View {
        Section {
            Toggle("Use ElevenLabs voice", isOn: $settings.useElevenLabs)

            if settings.useElevenLabs {
                SecureField("API key", text: $settings.elevenLabsAPIKey)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                Button {
                    loadVoices()
                } label: {
                    HStack {
                        Text(elevenVoices.isEmpty ? "Load voices" : "Reload voices")
                        if loadingVoices { Spacer(); ProgressView() }
                    }
                }
                .disabled(settings.elevenLabsAPIKey.isEmpty || loadingVoices)

                if !elevenVoices.isEmpty {
                    Picker("Voice", selection: $settings.elevenLabsVoiceID) {
                        Text("None").tag("")
                        ForEach(elevenVoices) { voice in
                            Text(voice.name).tag(voice.voiceID)
                        }
                    }
                    .onChange(of: settings.elevenLabsVoiceID) { _, newValue in
                        settings.elevenLabsVoiceName =
                            elevenVoices.first { $0.voiceID == newValue }?.name ?? ""
                    }
                } else if !settings.elevenLabsVoiceID.isEmpty {
                    LabeledContent("Voice",
                                   value: settings.elevenLabsVoiceName.isEmpty
                                       ? settings.elevenLabsVoiceID
                                       : settings.elevenLabsVoiceName)
                }

                if let voiceError {
                    Text(voiceError).font(.footnote).foregroundStyle(.red)
                }
            }
        } header: {
            Text("ElevenLabs voice")
        } footer: {
            Text("Use a premium cloud voice from ElevenLabs. Requires your API key (stored on this device); audio is billed by ElevenLabs and needs a network connection.")
        }
    }

    private func loadVoices() {
        loadingVoices = true
        voiceError = nil
        let client = ElevenLabsClient(apiKey: settings.elevenLabsAPIKey)
        Task {
            do {
                elevenVoices = try await client.voices()
            } catch {
                voiceError = error.localizedDescription
            }
            loadingVoices = false
        }
    }
}

/// Compact sheet for choosing which provider to connect. Dismisses before the
/// OAuth web flow presents, so the sign-in sheet isn't fighting this one.
private struct AddAccountSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button { connect(.google) } label: {
                    Label("Google", systemImage: "envelope.fill")
                }
                Button { connect(.microsoft) } label: {
                    Label("Outlook", systemImage: "envelope.fill")
                }
            }
            .navigationTitle("Add account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.height(240)])
    }

    private func connect(_ provider: MailAccount.Provider) {
        dismiss()
        Task { await appState.addAccount(provider: provider) }
    }
}
