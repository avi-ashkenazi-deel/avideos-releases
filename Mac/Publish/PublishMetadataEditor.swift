import SwiftUI

/// Metadata form for one queued upload. Deliberately exposes only the fields
/// the publishers in `Publishers.swift` actually send:
///
/// - YouTube: title, description (chapter lines ride along — YouTube parses
///   "00:00 Title" natively), tags. Uploads land as **private**.
/// - TikTok: title only, posted at SELF_ONLY visibility.
/// - Instagram: nothing is uploaded; the Graph API needs the file on a public
///   URL, so the publisher reveals it in Finder for manual posting.
///
/// Anything the pipeline can't do yet is stated in the UI rather than shown
/// as a control that quietly does nothing.
struct PublishMetadataEditor: View {
    @Binding var platform: PublishPlatform
    @Binding var title: String
    @Binding var descriptionText: String
    @Binding var tagText: String
    @Binding var scheduleEnabled: Bool
    @Binding var scheduledAt: Date

    /// YouTube-format chapter list from ChapterGenerator, when the project has
    /// one. Enables the "Append chapters" button.
    let chaptersText: String?
    let isAuthorized: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("Platform", selection: $platform) {
                ForEach(PublishPlatform.allCases) { option in
                    Text(option.displayName).tag(option)
                }
            }
            .pickerStyle(.segmented)

            if !isAuthorized {
                Label("Not signed in to \(platform.displayName). Connect it below before publishing.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            TextField("Title", text: $title)
                .textFieldStyle(.roundedBorder)

            switch platform {
            case .youtube:
                youtubeFields
            case .tiktok:
                Text("TikTok's direct-post API takes the title only, and posts arrive at SELF_ONLY visibility — promote the post in the TikTok app.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .instagram:
                Text("Instagram's Graph API pulls video from a public URL, which this build does not host. Publishing reveals the file in Finder so you can post it from the Instagram app.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            scheduleControls
        }
    }

    private var youtubeFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Description").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if let chaptersText, !chaptersText.isEmpty {
                        Button("Append Chapters") {
                            if !descriptionText.isEmpty && !descriptionText.hasSuffix("\n\n") {
                                descriptionText += "\n\n"
                            }
                            descriptionText += chaptersText
                        }
                        .buttonStyle(.link)
                        .font(.caption)
                    }
                }
                TextEditor(text: $descriptionText)
                    .font(.body)
                    .frame(minHeight: 90)
                    .overlay(RoundedRectangle(cornerRadius: 5)
                        .strokeBorder(.secondary.opacity(0.3)))
            }

            TextField("Tags (comma separated)", text: $tagText)
                .textFieldStyle(.roundedBorder)

            Text("Uploads are created as private so you can review before going public.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private var scheduleControls: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Schedule for later", isOn: $scheduleEnabled)
            if scheduleEnabled {
                DatePicker("Publish at", selection: $scheduledAt,
                           in: Date()...,
                           displayedComponents: [.date, .hourAndMinute])
                Text("Scheduling is local: AVideos Studio must be running at that time for the upload to start.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Per-platform connection status. `PlatformAuth` stores tokens in the
/// Keychain but the authorization-code flow needs a client ID the user
/// registers themselves, so this view reports state and points at Settings
/// instead of pretending to own an OAuth flow.
struct PlatformAuthView: View {
    let auth: PlatformAuth
    /// Bumped by the parent after a sign-out so the rows re-read the Keychain.
    var refreshToken: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connections").font(.headline)
            ForEach(PublishPlatform.allCases) { platform in
                HStack {
                    Image(systemName: auth.isAuthorized(platform)
                          ? "checkmark.circle.fill" : "circle.dashed")
                        .foregroundStyle(auth.isAuthorized(platform) ? .green : .secondary)
                    Text(platform.displayName)
                    Spacer()
                    if auth.isAuthorized(platform) {
                        Text("Connected").font(.caption).foregroundStyle(.secondary)
                        Button("Sign Out") { auth.removeToken(for: platform) }
                            .buttonStyle(.link)
                            .font(.caption)
                    } else {
                        Text("Add a client ID in Settings → Publishing")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .id("\(platform.rawValue)-\(refreshToken)")
            }
        }
    }
}
