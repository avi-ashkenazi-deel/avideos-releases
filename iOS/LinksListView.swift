import SwiftUI

/// Shows every link found in the current email/article so the listener can see
/// where each one goes — and save the interesting ones into the Saved area to
/// listen to later — without having to tap through or leave the player.
struct LinksListView: View {
    let links: [EmailLink]

    @ObservedObject private var store = SavedArticleStore.shared
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                ForEach(links) { link in
                    row(link)
                }
            } footer: {
                Text("Tap a link to open it. Tap the bookmark to add it to Saved — it's fetched and extracted so you can listen to it later, even offline.")
            }
        }
        .navigationTitle("Links")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
    }

    private func row(_ link: EmailLink) -> some View {
        let saved = store.isSaved(link.url)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(link.text)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Text(link.displayHost)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                store.saveLink(link.url, title: link.text)
            } label: {
                Image(systemName: saved ? "checkmark.circle.fill" : "bookmark")
                    .font(.title3)
                    .foregroundStyle(saved ? Color.green : Color.accentColor)
            }
            .buttonStyle(.plain)
            .disabled(saved)
            .accessibilityLabel(saved ? "Saved" : "Save link")
        }
        .contentShape(Rectangle())
        .onTapGesture { openURL(link.url) }
    }
}
