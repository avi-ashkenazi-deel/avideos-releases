import SwiftUI

/// "Your listening" — totals for emails/articles finished, words, time, the
/// people you listen to most, and ElevenLabs usage/cost when that voice is used.
struct AnalyticsView: View {
    @StateObject private var analytics = AnalyticsStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var confirmReset = false

    private var stats: ListeningStats { analytics.stats }

    var body: some View {
        Form {
            Section("Totals") {
                StatRow(label: "Emails listened", value: "\(stats.emailsListened)", systemImage: "envelope.open")
                StatRow(label: "Words", value: stats.words.formatted(), systemImage: "text.word.spacing")
                StatRow(label: "Time listening", value: Self.timeString(stats.listeningSeconds), systemImage: "clock")
            }

            if stats.elevenLabsCharacters > 0 {
                Section {
                    StatRow(label: "Characters", value: stats.elevenLabsCharacters.formatted(), systemImage: "character.cursor.ibeam")
                    StatRow(label: "Estimated cost",
                            value: analytics.estimatedElevenLabsCost.formatted(.currency(code: "USD")),
                            systemImage: "creditcard")
                } header: {
                    Text("ElevenLabs usage")
                } footer: {
                    Text("ElevenLabs bills per character. Cost is approximate, at about \(Self.rateString) per 1,000 characters — check your plan for the exact rate. The on-device system voice is free and isn't counted here.")
                }
            }

            if !analytics.topSenders.isEmpty {
                Section("Who you listen to most") {
                    ForEach(Array(analytics.topSenders.prefix(10))) { sender in
                        SenderRow(sender: sender)
                    }
                }
            }

            if stats.emailsListened > 0 || stats.elevenLabsCharacters > 0 {
                Section {
                    Button("Reset analytics", role: .destructive) { confirmReset = true }
                }
            }
        }
        .navigationTitle("Your listening")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        .overlay {
            if stats.emailsListened == 0 && stats.elevenLabsCharacters == 0 {
                ContentUnavailableView(
                    "Nothing yet",
                    systemImage: "chart.bar",
                    description: Text("Finish listening to an email and your stats will show up here.")
                )
            }
        }
        .confirmationDialog("Reset all listening analytics?",
                            isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset", role: .destructive) { analytics.reset() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private static var rateString: String {
        AnalyticsStore.approxCostPerThousandChars.formatted(.currency(code: "USD"))
    }

    /// Compact h/m/s string, e.g. "2h 13m" or "47s".
    static func timeString(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 0 { return "\(h)h \(m)m" }
        if m > 0 { return "\(m)m \(s)s" }
        return "\(s)s"
    }
}

private struct StatRow: View {
    let label: String
    let value: String
    let systemImage: String

    var body: some View {
        HStack {
            Label(label, systemImage: systemImage)
            Spacer()
            Text(value)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
        }
    }
}

private struct SenderRow: View {
    let sender: SenderStat

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(sender.name)
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
            Text("\(sender.emails) \(sender.emails == 1 ? "email" : "emails") · \(AnalyticsView.timeString(sender.seconds))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
