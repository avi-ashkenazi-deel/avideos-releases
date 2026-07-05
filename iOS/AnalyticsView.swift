import SwiftUI
import Charts

/// "Your listening" — a day/week/month breakdown of minutes listened, plus
/// totals for emails/articles finished, words, time, the people you listen to
/// most, and ElevenLabs usage/cost when that voice is used.
struct AnalyticsView: View {
    @StateObject private var analytics = AnalyticsStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var confirmReset = false
    @State private var range: AnalyticsRange = .month
    @State private var selectedLabel: String?

    private var stats: ListeningStats { analytics.stats }
    private var buckets: [ListeningBucket] { analytics.buckets(for: range) }

    /// The period the listener tapped on the chart, if any.
    private var selectedBucket: ListeningBucket? {
        guard let selectedLabel else { return nil }
        return buckets.first { $0.label == selectedLabel }
    }

    var body: some View {
        Form {
            if stats.emailsListened > 0 {
                breakdownSection
            }

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

    /// The day/week/month bar chart plus a selector and a detail/comparison line.
    private var breakdownSection: some View {
        Section {
            Picker("Range", selection: $range) {
                ForEach(AnalyticsRange.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)

            Chart(buckets) { bucket in
                BarMark(
                    x: .value("Period", bucket.label),
                    y: .value("Minutes", bucket.minutes)
                )
                .foregroundStyle(barColor(bucket))
                .cornerRadius(4)
            }
            // Keep the bars in chronological order (nominal axis would otherwise
            // sort alphabetically).
            .chartXScale(domain: buckets.map(\.label))
            .chartXSelection(value: $selectedLabel)
            .chartYAxisLabel("minutes")
            .frame(height: 190)
            .padding(.top, 4)
            // Animate the bars when you switch day/week/month.
            .animation(.easeInOut(duration: 0.4), value: range)

            HStack {
                Text(detailTitle).font(.subheadline.weight(.semibold))
                Spacer()
                Text(detailValue).font(.subheadline).foregroundStyle(.secondary)
            }
        } header: {
            Text("Listening over time")
        } footer: {
            Text("Minutes listened per \(range.title.lowercased()). Tap a bar to see that \(range.title.lowercased())'s total.")
        }
        .onChange(of: range) { _, _ in selectedLabel = nil }
    }

    private func barColor(_ bucket: ListeningBucket) -> Color {
        guard selectedLabel != nil else { return .accentColor }
        return bucket.label == selectedLabel ? .accentColor : .accentColor.opacity(0.35)
    }

    /// The detail line: the tapped period, or the whole-range total if none.
    private var detailTitle: String { selectedBucket?.label ?? "Total" }

    private var detailValue: String {
        let seconds = selectedBucket?.seconds ?? buckets.reduce(0) { $0 + $1.seconds }
        let emails = selectedBucket?.emails ?? buckets.reduce(0) { $0 + $1.emails }
        return "\(Self.timeString(seconds)) · \(emails) \(emails == 1 ? "email" : "emails")"
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
