import SwiftUI
import AppKit

/// Settings → Streaming: where the show goes. One row per destination
/// (platform, orientation, quality), the YouTube account, and the vertical
/// canvas options. Stream keys are typed here once and kept in the Keychain.
struct StreamingPane: View {
    @Environment(StudioController.self) private var studio
    @State private var editing: StreamDestination?
    @State private var isNew = false

    var body: some View {
        @Bindable var studio = studio
        @Bindable var prefs = studio.prefs
        let live = studio.live
        Form {
            Section {
                if live.destinations.isEmpty {
                    Text("No destinations yet. Add YouTube, LinkedIn, X, Twitch, Instagram, TikTok or any RTMP server.")
                        .foregroundStyle(.secondary)
                }
                ForEach(live.destinations) { destination in
                    DestinationRow(destination: destination,
                                   isLive: live.liveDestinationIDs.contains(destination.id)) {
                        isNew = false
                        editing = destination
                    }
                }
                .onMove { live.move(fromOffsets: $0, toOffset: $1) }
                Menu {
                    ForEach(StreamPlatform.allCases, id: \.self) { platform in
                        Button(platform.displayName) {
                            isNew = true
                            editing = StreamDestination(platform: platform)
                        }
                    }
                } label: {
                    Label("Add Destination", systemImage: "plus")
                }
                .fixedSize()
            } header: {
                Text("Destinations")
            } footer: {
                let enabled = Set(live.destinations.filter(\.isEnabled).map(\.id))
                if !enabled.isEmpty {
                    let mbps = live.estimatedUploadMbps(for: enabled)
                    Text("Streaming to every ticked destination needs about \(mbps, specifier: "%.1f") Mbps of upload. Each destination is its own connection from this Mac, so check your upload speed before a big show.")
                        .font(.caption)
                        .foregroundStyle(mbps > 20 ? Color.orange : Color.secondary)
                }
            }

            YouTubeAccountSection()

            Section("Vertical (9:16)") {
                Toggle("Show the vertical canvas beside the main one", isOn: $studio.showsVerticalCanvas)
                Toggle("Record a vertical file too", isOn: $prefs.recordVerticalToo)
                Text("Every scene gets a vertical layout automatically. Switch the canvas to V to move or hide things for vertical only; the horizontal design never changes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(minHeight: 480)
        .sheet(item: $editing) { destination in
            DestinationEditor(destination: destination, isNew: isNew) { result in
                switch result {
                case .save(let updated):
                    if isNew { live.add(updated) } else { live.update(updated) }
                case .delete:
                    live.remove(id: destination.id)
                case .cancel:
                    if isNew { destination.deleteStreamKey() }
                }
                editing = nil
            }
        }
    }
}

private struct DestinationRow: View {
    @Environment(StudioController.self) private var studio
    let destination: StreamDestination
    let isLive: Bool
    let edit: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(
                get: { destination.isEnabled },
                set: { on in
                    var updated = destination
                    updated.isEnabled = on
                    studio.live.update(updated)
                }))
                .labelsHidden()
                .help("Ticked by default when you go live")
            PlatformBadge(platform: destination.platform)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(destination.name).font(.body.weight(.medium))
                    if isLive {
                        Text("LIVE")
                            .font(.system(size: 9, weight: .heavy))
                            .padding(.horizontal, 4)
                            .background(Color.red, in: RoundedRectangle(cornerRadius: 3))
                            .foregroundStyle(.white)
                    }
                }
                Text("\(destination.orientation.displayName) · \(destination.tier.displayName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let problem = destination.configurationProblem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            Button("Edit…", action: edit)
                .disabled(isLive)
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { if !isLive { edit() } }
    }
}

// MARK: - Editor

private struct DestinationEditor: View {
    enum Result { case save(StreamDestination), delete, cancel }

    @State var destination: StreamDestination
    let isNew: Bool
    let done: (Result) -> Void

    @State private var key = ""
    @State private var keySaved = false
    @State private var showsKey = false
    private var google: GoogleOAuth { GoogleOAuth.shared }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    HStack {
                        PlatformBadge(platform: destination.platform)
                        Picker("Platform", selection: platformBinding) {
                            ForEach(StreamPlatform.allCases, id: \.self) { platform in
                                Text(platform.displayName).tag(platform)
                            }
                        }
                    }
                    TextField("Name", text: $destination.name)
                    Picker("Shape", selection: $destination.orientation) {
                        ForEach(StreamOrientation.allCases, id: \.self) { orientation in
                            Text(orientation.displayName).tag(orientation)
                        }
                    }
                    Picker("Quality", selection: $destination.tier) {
                        ForEach(StreamQualityTier.allCases, id: \.self) { tier in
                            Text(tier.displayName).tag(tier)
                        }
                    }
                }

                if destination.platform == .youtube {
                    Section("YouTube") {
                        Toggle("Create the broadcast with my YouTube account", isOn: Binding(
                            get: { destination.usesLinkedYouTubeAccount ?? false },
                            set: { destination.usesLinkedYouTubeAccount = $0 }))
                        if destination.linkedYouTube {
                            if !google.isConnected {
                                Label("Connect your YouTube account below in Settings → Streaming first.",
                                      systemImage: "exclamationmark.triangle.fill")
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                            TextField("Title", text: Binding(
                                get: { destination.broadcastTitle ?? "" },
                                set: { destination.broadcastTitle = $0.isEmpty ? nil : $0 }),
                                      prompt: Text("Live on (today's date)"))
                            Picker("Privacy", selection: Binding(
                                get: { destination.broadcastPrivacy ?? "unlisted" },
                                set: { destination.broadcastPrivacy = $0 })) {
                                Text("Public").tag("public")
                                Text("Unlisted").tag("unlisted")
                                Text("Private").tag("private")
                            }
                            Text("streamit creates a new broadcast each time you go live, starts it when the video arrives and ends it when you stop. Comments come in automatically.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Text("With a pasted key, comments still come in once your YouTube account is connected.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if !destination.linkedYouTube {
                    Section {
                        TextField("Server URL", text: $destination.serverURL,
                                  prompt: Text("rtmp://… or rtmps://…"))
                        HStack {
                            Group {
                                if showsKey {
                                    TextField("Stream Key", text: $key)
                                } else {
                                    SecureField("Stream Key", text: $key)
                                }
                            }
                            .onChange(of: key) { _, _ in keySaved = false }
                            Button {
                                showsKey.toggle()
                            } label: {
                                Image(systemName: showsKey ? "eye.slash" : "eye")
                            }
                            .buttonStyle(.borderless)
                            if keySaved {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                                    .help("Saved in the Keychain")
                            }
                        }
                        Text(destination.platform.keyHelp)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Server and Key")
                    } footer: {
                        Text("The key is stored in your Mac's Keychain, never in a file.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if destination.platform == .twitch {
                    Section("Twitch chat") {
                        TextField("Channel", text: Binding(
                            get: { destination.twitchChannel ?? "" },
                            set: { destination.twitchChannel = $0.isEmpty ? nil : $0 }),
                                  prompt: Text("your channel name"))
                        Text("Chat is read without logging in. Only your channel name is needed.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let reason = destination.platform.commentsUnavailableReason {
                    Section {
                        Label("No live comments: \(reason)", systemImage: "bubble.left.and.exclamationmark.bubble.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                if !isNew {
                    Button("Delete", role: .destructive) { done(.delete) }
                }
                Spacer()
                Button("Cancel") { done(.cancel) }
                    .keyboardShortcut(.cancelAction)
                Button(isNew ? "Add" : "Save") {
                    if !destination.linkedYouTube {
                        destination.saveStreamKey(key)
                    }
                    done(.save(destination))
                }
                .keyboardShortcut(.defaultAction)
                .disabled(destination.name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)
        }
        .frame(width: 520, height: 560)
        .onAppear {
            key = destination.streamKey ?? ""
            keySaved = !key.isEmpty
        }
    }

    /// Switching platform brings its defaults along (server, shape,
    /// quality) unless the host already typed a server.
    private var platformBinding: Binding<StreamPlatform> {
        Binding(
            get: { destination.platform },
            set: { platform in
                let old = destination.platform
                if destination.serverURL.isEmpty || destination.serverURL == old.defaultServerURL {
                    destination.serverURL = platform.defaultServerURL
                }
                if destination.name == old.displayName { destination.name = platform.displayName }
                destination.orientation = platform.defaultOrientation
                destination.tier = platform.defaultTier
                destination.platform = platform
            })
    }
}

// MARK: - YouTube account

private struct YouTubeAccountSection: View {
    @State private var clientID = ""
    @State private var isWorking = false
    @State private var error: String?
    private var google: GoogleOAuth { GoogleOAuth.shared }

    var body: some View {
        Section {
            if google.isConnected {
                HStack {
                    Label(google.channelName ?? "Connected", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Spacer()
                    Button("Disconnect") { google.disconnect() }
                }
            } else {
                TextField("OAuth Client ID", text: $clientID,
                          prompt: Text("1234-abcd.apps.googleusercontent.com"))
                    .onSubmit { google.clientID = clientID }
                HStack {
                    Button(isWorking ? "Connecting…" : "Connect YouTube Account") {
                        google.clientID = clientID
                        isWorking = true
                        error = nil
                        Task {
                            do {
                                try await google.connect()
                            } catch {
                                self.error = error.localizedDescription
                            }
                            isWorking = false
                        }
                    }
                    .disabled(isWorking || !clientID.hasSuffix(".apps.googleusercontent.com"))
                    Spacer()
                }
                if let error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
        } header: {
            Text("YouTube Account")
        } footer: {
            Text("Optional. Connecting lets streamit create YouTube broadcasts for you and read their live chat. The client ID comes from your own Google Cloud project (docs/DEV_SETUP.md).")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .onAppear { clientID = google.clientID }
    }
}
