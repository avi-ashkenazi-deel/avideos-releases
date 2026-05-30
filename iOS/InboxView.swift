import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel: InboxViewModel
    @State private var showSettings = false
    @State private var showHighlights = false

    init() {
        // Placeholder; replaced in onAppear once we have appState's service.
        _viewModel = StateObject(wrappedValue: InboxViewModel(mailService: MockMailService()))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.emails.isEmpty {
                    ProgressView("Loading inbox…")
                } else {
                    List(viewModel.emails) { email in
                        NavigationLink {
                            EmailPlayerView(email: email) { id in
                                viewModel.markReadLocally(id)
                            }
                        } label: {
                            EmailRow(email: email)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if !email.isRead {
                                Button {
                                    Task { await viewModel.markRead(email.id) }
                                } label: {
                                    Label("Mark read", systemImage: "envelope.open")
                                }
                                .tint(.blue)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await viewModel.load() }
                }
            }
            .navigationTitle("Inbox")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if viewModel.unreadCount > 0 {
                        Text("\(viewModel.unreadCount) unread")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showHighlights = true } label: {
                        Image(systemName: "highlighter")
                    }
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                NavigationStack { SettingsView() }
            }
            .sheet(isPresented: $showHighlights) {
                NavigationStack { HighlightsListView() }
            }
        }
        .task {
            viewModel.configure(appState.mailService)
            if viewModel.emails.isEmpty {
                await viewModel.load()
            }
        }
    }
}

private struct EmailRow: View {
    let email: Email

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(email.isRead ? Color.gray.opacity(0.2) : Color.accentColor.opacity(0.2))
                Text(email.from.initial)
                    .font(.headline)
                    .foregroundStyle(email.isRead ? .secondary : Color.accentColor)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(email.from.displayName)
                        .font(.subheadline)
                        .fontWeight(email.isRead ? .regular : .semibold)
                        .lineLimit(1)
                    Spacer()
                    Text(email.receivedAt, format: .relative(presentation: .numeric))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(email.subjectOrFallback)
                    .font(.subheadline)
                    .fontWeight(email.isRead ? .regular : .medium)
                    .lineLimit(1)
                Text(email.snippet)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}
