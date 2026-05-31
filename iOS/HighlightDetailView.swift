import SwiftUI

/// A saved highlight with its note, and a link back to the source email — open
/// it to listen again starting from the exact spot the highlight was captured.
struct HighlightDetailView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var player: EmailPlayerViewModel
    @ObservedObject private var store = HighlightStore.shared
    let highlight: Highlight
    @State private var note: String
    @State private var openError: String?

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
                Button {
                    listen()
                } label: {
                    Label("Listen in “\(highlight.emailSubject)”", systemImage: "play.circle.fill")
                }
                if let openError {
                    Text(openError).font(.footnote).foregroundStyle(.red)
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

    /// Load the source email into the shared player and resume at the captured
    /// block, expanding the Now Playing view.
    private func listen() {
        openError = nil
        Task {
            do {
                let email = try await appState.mailService.fetchFullEmail(id: highlight.emailID)
                player.open(email: email, isLocal: true, startBlock: highlight.blockIndex)
            } catch {
                openError = error.localizedDescription
            }
        }
    }
}
