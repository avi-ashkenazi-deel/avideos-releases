import SwiftUI

/// The "Saved" tab: web pages shared into VoiceInbox from Safari, Feedly, etc.
/// Each ready article plays through the same listening UI as email, fully
/// offline once its content has been cached.
struct SavedArticlesView: View {
    @StateObject private var store = SavedArticleStore.shared

    var body: some View {
        NavigationStack {
            Group {
                if store.articles.isEmpty {
                    SavedEmptyState()
                } else {
                    List {
                        ForEach(store.articles) { article in
                            row(for: article)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Saved")
            .toolbar {
                if store.isProcessing {
                    ToolbarItem(placement: .topBarTrailing) { ProgressView() }
                }
            }
            .refreshable { await store.refresh() }
        }
        .task { await store.refresh() }
    }

    @ViewBuilder
    private func row(for article: SavedArticle) -> some View {
        switch article.status {
        case .ready:
            NavigationLink {
                if let html = store.content(for: article.id) {
                    EmailPlayerView(
                        email: article.makeEmail(html: html),
                        isLocalContent: true,
                        onMarkReadPersist: { id in store.markRead(id) }
                    )
                } else {
                    // Content file missing (e.g. cleared storage): re-fetch.
                    MissingContentView { Task { await store.retry(article.id) } }
                }
            } label: {
                SavedArticleRow(article: article)
            }
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

private struct MissingContentView: View {
    let retry: () -> Void
    var body: some View {
        VStack(spacing: 16) {
            Text("This article's offline copy is missing.")
                .font(.headline)
                .multilineTextAlignment(.center)
            Button("Download again", action: retry)
                .buttonStyle(.borderedProminent)
        }
        .padding(40)
    }
}
