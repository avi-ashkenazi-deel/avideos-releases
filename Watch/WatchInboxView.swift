import SwiftUI

/// Watch inbox. For this first iteration the watch reads from the bundled demo
/// inbox; syncing a real Gmail session to the watch comes later.
struct WatchInboxView: View {
    @StateObject private var viewModel = InboxViewModel(mailService: MockMailService())

    var body: some View {
        NavigationStack {
            List(viewModel.emails) { email in
                NavigationLink {
                    WatchPlayerView(email: email)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(email.from.displayName)
                            .font(.headline)
                            .fontWeight(email.isRead ? .regular : .semibold)
                            .lineLimit(1)
                        Text(email.subjectOrFallback)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            .navigationTitle("Inbox")
            .overlay {
                if viewModel.isLoading && viewModel.emails.isEmpty {
                    ProgressView()
                }
            }
        }
        .task { if viewModel.emails.isEmpty { await viewModel.load() } }
    }
}
