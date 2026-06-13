import SwiftUI

/// Freestyle "document the session" view. The workout is recording (Functional
/// Strength Training); the time counts up. Between sets — e.g. after a max set of
/// pull-ups — tap a rest button and it runs a countdown that buzzes/announces the
/// final seconds to bring you back, then returns here.
struct WatchSessionView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        VStack(spacing: 8) {
            if let start = model.sessionStart {
                TimelineView(.periodic(from: .now, by: 0.03)) { context in
                    Text(formatClockMillis(context.date.timeIntervalSince(start)))
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                }
            }
            Text("Session").font(.caption2).foregroundStyle(.secondary)

            HStack(spacing: 6) {
                restButton(":30", 30)
                restButton("1:00", 60)
                restButton("2:00", 120)
            }

            Button(role: .destructive) { model.endSession() } label: {
                Text("End").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 6)
    }

    private func restButton(_ label: String, _ seconds: TimeInterval) -> some View {
        Button { model.addRest(seconds) } label: {
            Text(label).frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.borderedProminent)
    }
}
