import SwiftUI
import AVFoundation
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var settings = AppSettings.shared
    @ObservedObject private var skipRules = SkipRuleStore.shared
    @Environment(\.dismiss) private var dismiss

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]

    /// Configured per-language speeds, sorted by language name for a stable list.
    private var sortedLanguageSpeeds: [(key: String, value: Double)] {
        settings.languageSpeeds
            .map { (key: $0.key, value: $0.value) }
            .sorted { languageName($0.key) < languageName($1.key) }
    }

    /// Languages that have an installed voice and don't yet have a speed override.
    private var addableLanguages: [(code: String, name: String)] {
        let configured = Set(settings.languageSpeeds.keys)
        let codes = Set(AVSpeechSynthesisVoice.speechVoices()
            .compactMap { $0.language.split(separator: "-").first.map(String.init) })
        return codes.subtracting(configured)
            .map { (code: $0, name: languageName($0)) }
            .sorted { $0.name < $1.name }
    }

    private func languageName(_ code: String) -> String {
        Locale.current.localizedString(forLanguageCode: code) ?? code.uppercased()
    }

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
                ForEach(sortedLanguageSpeeds, id: \.key) { entry in
                    Picker(languageName(entry.key), selection: Binding(
                        get: { entry.value },
                        set: { settings.languageSpeeds[entry.key] = $0 }
                    )) {
                        ForEach(speeds, id: \.self) { Text("\($0, specifier: "%g")×").tag($0) }
                    }
                }
                .onDelete { offsets in
                    let keys = sortedLanguageSpeeds.map(\.key)
                    offsets.map { keys[$0] }.forEach(settings.removeLanguageSpeed)
                }

                if !addableLanguages.isEmpty {
                    Menu {
                        ForEach(addableLanguages, id: \.code) { lang in
                            Button(lang.name) { settings.addLanguageSpeed(lang.code) }
                        }
                    } label: {
                        Label("Add a language", systemImage: "plus")
                    }
                }
            } header: {
                Text("Per-language speed")
            } footer: {
                Text("Some voices read certain languages less clearly. Set a speed for a language and it's used automatically whenever that language is read; everything else uses the default speed above. Swipe to remove.")
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
                Picker("Appearance", selection: $settings.appearance) {
                    ForEach(AppearanceMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Appearance")
            } footer: {
                Text("\"System\" follows your phone — dark when your phone is in dark mode. Pick Light or Dark to force it.")
            }

            Section {
                Picker("Text size", selection: $settings.readingTextSize) {
                    ForEach(ReadingTextSize.allCases) { size in
                        Text(size.title).tag(size)
                    }
                }
                Toggle("Keep screen awake", isOn: $settings.keepScreenAwake)
                Toggle("Picture in Picture", isOn: $settings.pictureInPicture)
            } header: {
                Text("Reading")
            } footer: {
                Text("Size of the text in the email/article reading view. \"Keep screen awake\" stops the screen auto-locking while you watch it read. \"Picture in Picture\" floats what's being read in a small window when you leave the app mid-email.")
            }

            if !skipRules.rules.isEmpty {
                Section {
                    ForEach(skipRules.rules) { rule in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rule.phrase)
                                .font(.subheadline)
                                .lineLimit(2)
                            Text(rule.scopeDescription)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { offsets in
                        offsets.map { skipRules.rules[$0].id }.forEach(skipRules.remove)
                    }
                } header: {
                    Text("Skipped lines")
                } footer: {
                    Text("Lines you've chosen to never read aloud. Long-press any sentence while reading to add one (for that sender or everyone). Swipe to remove.")
                }
            }

            Section {
                Picker("Voice", selection: $settings.voiceIdentifier) {
                    Text("System default").tag("")
                    ForEach(voices, id: \.identifier) { voice in
                        Text("\(voice.name) — \(Self.qualityLabel(voice.quality)) · \(voice.language)")
                            .tag(voice.identifier)
                    }
                }
                .disabled(settings.useElevenLabs)

                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Get higher-quality voices", systemImage: "arrow.down.circle")
                }
                .disabled(settings.useElevenLabs)
            } header: {
                Text("System voice")
            } footer: {
                if settings.useElevenLabs {
                    Text("Disabled while ElevenLabs is on.")
                } else {
                    Text("Voices marked “Basic” are the lightweight ones built into iOS — they sound robotic. “Enhanced” and “Premium” voices sound far more natural (close to what Safari’s “Listen to Page” uses). Tap “Get higher-quality voices”, then go to Accessibility ▸ Spoken Content ▸ Voices to download one, and pick it here.")
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
        AVSpeechSynthesisVoice.speechVoices().sorted {
            if $0.language != $1.language { return $0.language < $1.language }
            // Within a language, list the better-sounding voices first.
            if $0.quality.rawValue != $1.quality.rawValue { return $0.quality.rawValue > $1.quality.rawValue }
            return $0.name < $1.name
        }
    }

    /// Human-readable quality tier so it's obvious which voices sound natural.
    static func qualityLabel(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium: return "Premium"
        case .enhanced: return "Enhanced"
        default: return "Basic"
        }
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
