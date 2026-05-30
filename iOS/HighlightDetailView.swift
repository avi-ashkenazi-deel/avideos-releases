import SwiftUI

/// A saved highlight with its note, and a link back to the source email — open
/// it to listen again starting from the exact spot the highlight was captured.
struct HighlightDetailView: View {
    @ObservedObject private var store = HighlightStore.shared
    let highlight: Highlight
    @State private var note: String

    init(highlight: Highlight) {
        self.highlight = highlight
        _note = State(initialValue: highlight.note)
    }

    var body: some View {
        Form {
            Section("Note") {
                TextField("Add a note…", text: $note, axis: .vertical)
                    .lineLimit(3...10)
            }

            Section("Highlighted") {
                Text(highlight.capturedText.isEmpty ? "(nothing captured)" : highlight.capturedText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section {
                NavigationLink {
                    EmailFromHighlightView(highlight: highlight)
                } label: {
                    Label("Listen in “\(highlight.emailSubject)”", systemImage: "play.circle.fill")
                }
            } footer: {
                Text("Opens the email and resumes from where you bookmarked it.")
            }

            Section {
                LabeledContent("Saved",
                               value: highlight.createdAt.formatted(.dateTime.month().day().hour().minute()))
            }
        }
        .navigationTitle("Highlight")
        .navigationBarTitleDisplayMode(.inline)
        // Persist note edits as you type.
        .onChange(of: note) { _, newValue in
            store.updateNote(for: highlight.id, note: newValue)
        }
    }
}

/// Loads the highlight's source email by id, then shows the player positioned at
/// the captured block. Used to "link back to the email" from a note.
struct EmailFromHighlightView: View {
    @EnvironmentObject private var appState: AppState
    let highlight: Highlight

    @State private var email: Email?
    @State private var loadError: String?

    var body: some View {
        Group {
            if let email {
                EmailPlayerView(email: email, startBlockIndex: highlight.blockIndex)
            } else if let loadError {
                ContentUnavailableView("Couldn't open the email",
                                       systemImage: "exclamationmark.triangle",
                                       description: Text(loadError))
            } else {
                ProgressView("Opening…")
            }
        }
        .task {
            do {
                email = try await appState.mailService.fetchFullEmail(id: highlight.emailID)
            } catch {
                loadError = error.localizedDescription
            }
        }
    }
}
