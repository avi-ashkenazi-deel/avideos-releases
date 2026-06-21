import SwiftUI

/// The "Saved" tab: web pages shared into VoiceInbox from Safari, Feedly, etc.
/// Each ready article plays through the same listening UI as email, fully
/// offline once its content has been cached.
struct SavedArticlesView: View {
    var body: some View {
        NavigationStack { SavedArticlesList() }
    }
}

/// The saved-articles list plus its toolbar — but **no** `NavigationStack` of its
/// own, so it can be the iPhone tab (wrapped by `SavedArticlesView`) or the iPad
/// split view's content column (where the split view supplies navigation).
struct SavedArticlesList: View {
    /// Hidden on iPad, where the split view's column provides Highlights.
    var showsHighlightsButton: Bool = true

    @EnvironmentObject private var player: EmailPlayerViewModel
    @StateObject private var store = SavedArticleStore.shared
    @State private var showPasteText = false

    var body: some View {
        Group {
            if store.articles.isEmpty {
                SavedEmptyState()
            } else {
                List {
                    ForEach(store.articles) { article in
                        row(for: article)
                            // Highlight the article currently loaded in the player.
                            .listRowBackground(
                                article.id == player.parsed?.email.id
                                    ? Color.accentColor.opacity(0.12)
                                    : Color.clear
                            )
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Saved")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if store.isProcessing { ProgressView() }
                // Paste any text (a doc, a message, notes) and listen to it.
                Button { showPasteText = true } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add text to listen to")
                if showsHighlightsButton { HighlightsToolbarButton() }
            }
        }
        .sheet(isPresented: $showPasteText) {
            NavigationStack { PasteTextView() }
        }
        .refreshable { await store.refresh() }
        .task { await store.refresh() }
    }

    @ViewBuilder
    private func row(for article: SavedArticle) -> some View {
        switch article.status {
        case .ready:
            Button {
                open(article)
            } label: {
                SavedArticleRow(article: article)
            }
            .buttonStyle(.plain)
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) { store.delete(article.id) } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
            .swipeActions(edge: .leading) {
                Button {
                    store.markRead(article.id, read: !article.isRead)
                } label: {
                    Label(article.isRead ? "Unread" : "Read",
                          systemImage: article.isRead ? "circle" : "checkmark.circle")
                }
                .tint(.blue)
            }
        default:
            SavedArticleRow(article: article)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) { store.delete(article.id) } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    if article.status == .failed {
                        Button { Task { await store.retry(article.id) } } label: {
                            Label("Retry", systemImage: "arrow.clockwise")
                        }
                        .tint(.orange)
                    }
                }
        }
    }

    /// Load the cached article into the shared player and expand Now Playing.
    private func open(_ article: SavedArticle) {
        guard let html = store.content(for: article.id) else {
            // Offline copy missing (e.g. cleared storage): re-fetch it.
            Task { await store.retry(article.id) }
            return
        }
        player.open(
            email: article.makeEmail(html: html),
            isLocal: true,
            markReadOverride: { [weak store] id in store?.markRead(id) }
        )
    }
}

private struct SavedArticleRow: View {
    let article: SavedArticle

    var body: some View {
        HStack(spacing: 12) {
            statusIcon
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(article.displayTitle)
                    .font(.subheadline)
                    .fontWeight(article.isRead ? .regular : .semibold)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let site = article.siteName ?? article.url.host {
                        Text(site).lineLimit(1)
                    }
                    if article.status == .pending {
                        Text("• Saving…")
                    } else if article.status == .failed {
                        Text("• Couldn't load").foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if article.status == .ready, let excerpt = article.excerpt, !excerpt.isEmpty {
                    Text(excerpt)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch article.status {
        case .pending: ProgressView()
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .ready:
            Image(systemName: article.isRead ? "headphones" : "headphones.circle.fill")
                .foregroundStyle(article.isRead ? .secondary : Color.accentColor)
        }
    }
}

private struct SavedEmptyState: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "bookmark")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Nothing saved yet")
                .font(.headline)
            Text("Share a web page from Safari, Feedly, or any app using the Share button and pick VoiceInbox. It'll be cached here to listen offline.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(40)
    }
}
