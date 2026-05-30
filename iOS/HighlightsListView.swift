import SwiftUI

struct HighlightsListView: View {
    @ObservedObject private var store = HighlightStore.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if store.highlights.isEmpty {
                ContentUnavailableView(
                    "No highlights yet",
                    systemImage: "highlighter",
                    description: Text("While listening, tap the highlighter or press an AirPod to save the last 10 seconds.")
                )
            } else {
                List {
                    ForEach(store.highlights) { highlight in
                        NavigationLink {
                            HighlightDetailView(highlight: highlight)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(highlight.emailSubject)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text(highlight.capturedText)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                                if !highlight.note.isEmpty {
                                    Label(highlight.note, systemImage: "note.text")
                                        .font(.footnote)
                                        .foregroundStyle(.primary)
                                }
                                Text(highlight.createdAt, format: .dateTime.month().day().hour().minute())
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .onDelete { indexSet in
                        indexSet.map { store.highlights[$0].id }.forEach(store.remove)
                    }
                }
            }
        }
        .navigationTitle("Highlights & Notes")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }
}
