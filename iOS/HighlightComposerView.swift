import SwiftUI

/// Shown right after a highlight is captured: the snippet that was just read,
/// plus a note field. The highlight is already saved; this edits its note.
struct HighlightComposerView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = HighlightStore.shared

    let highlight: Highlight
    @State private var note: String

    init(highlight: Highlight) {
        self.highlight = highlight
        _note = State(initialValue: highlight.note)
    }

    var body: some View {
        Form {
            Section("Highlighted") {
                Text(highlight.capturedText.isEmpty ? "(nothing captured)" : highlight.capturedText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("Your note") {
                TextField("Add a note…", text: $note, axis: .vertical)
                    .lineLimit(3...8)
            }
        }
        .navigationTitle("New highlight")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Delete", role: .destructive) {
                    store.remove(highlight.id)
                    dismiss()
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    store.updateNote(for: highlight.id, note: note)
                    dismiss()
                }
            }
        }
    }
}
