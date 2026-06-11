import SwiftUI

/// Paste (or type) any text and save it as a ready-to-listen Saved item — a doc,
/// a long message, meeting notes. No fetching involved; it's playable instantly
/// and offline.
struct PasteTextView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""
    @FocusState private var textFocused: Bool

    var body: some View {
        Form {
            Section {
                TextField("Title (optional)", text: $title)
            }
            Section {
                TextEditor(text: $text)
                    .frame(minHeight: 220)
                    .focused($textFocused)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("Paste or type the text to listen to…")
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8)
                                .allowsHitTesting(false)
                        }
                    }
            } footer: {
                Text("Saved under Saved → plays like any article, offline too.")
            }
        }
        .navigationTitle("Listen to text")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    SavedArticleStore.shared.addPastedText(title: title, text: text)
                    dismiss()
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onAppear { textFocused = true }
    }
}
