import SwiftUI

/// Freestyle "document the session" view. The workout records as Functional
/// Strength Training; the time counts up. Page 1 shows the elapsed time and the
/// quick-rest circles; swipe left to page 2 for the End button (so there's no
/// big red button crowding the main screen).
struct WatchSessionView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var finishDetector: SessionFinishDetector
    @EnvironmentObject private var settings: AppSettings

    /// On-screen label for the session (recorded as Functional Strength Training).
    private let sessionName = "Calisthenics"

    var body: some View {
        TabView {
            mainPage
            endPage
        }
        // "Looks finished?" nudge from inactivity / low heart rate.
        .onChange(of: finishDetector.suggestsEnd) { _, suggests in
            if suggests { HapticPlayer.play(.retry) }
        }
        .confirmationDialog("Still working out?", isPresented: $finishDetector.suggestsEnd) {
            Button("End session", role: .destructive) { model.endSession() }
            Button("Keep going", role: .cancel) { finishDetector.keepGoing() }
        } message: {
            Text("Looks like you might be done.")
        }
    }

    private var mainPage: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let start = model.sessionStart {
                TimelineView(.periodic(from: .now, by: 0.03)) { context in
                    Text(formatClockMillis(context.date.timeIntervalSince(start)))
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                        .monospacedDigit()
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "figure.strengthtraining.traditional")
                    .foregroundStyle(.green)
                Text(sessionName)
                    .foregroundStyle(.secondary)
            }
            .font(.callout)

            Spacer()

            HStack(spacing: 10) {
                ForEach(Array(settings.restDurations.enumerated()), id: \.offset) { _, secs in
                    restCircle(restLabel(secs), secs)
                }
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
    }

    private var endPage: some View {
        VStack {
            Spacer()
            Button(role: .destructive) { model.endSession() } label: {
                Text("End session").frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            Spacer()
        }
        .padding()
    }

    private func restCircle(_ label: String, _ seconds: TimeInterval) -> some View {
        Button { model.addRest(seconds) } label: {
            Text(label)
                .font(.headline)
                .foregroundStyle(.white)
                .frame(width: 62, height: 62)
                .background(Color.gray.opacity(0.55), in: Circle())
        }
        .buttonStyle(.plain)
    }
}
