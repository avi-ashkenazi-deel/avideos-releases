import SwiftUI

/// Freestyle session on the iPhone: the time counts up and you tap a rest button
/// between sets (the rest runs as a normal countdown, then returns here). Same
/// idea as the watch session. Not recorded as a workout on the phone.
struct SessionScreen: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.verticalSizeClass) private var vSize

    private var landscape: Bool { vSize == .compact }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            if let start = model.sessionStart {
                TimelineView(.periodic(from: .now, by: 0.03)) { context in
                    Text(formatClockMillis(context.date.timeIntervalSince(start)))
                        .font(.system(size: landscape ? 130 : 64, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.5)
                }
            }
            Text("Session").foregroundStyle(.secondary)

            HStack(spacing: 16) {
                ForEach(Array(settings.restDurations.enumerated()), id: \.offset) { _, secs in
                    Button { model.addRest(secs) } label: {
                        Text(restLabel(secs))
                            .font(.title3.weight(.semibold))
                            .frame(width: 84, height: 84)
                            .background(.thinMaterial, in: Circle())
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()

            Button(role: .destructive) { model.endSession() } label: {
                Text("End session").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .padding(.horizontal)
        }
        .padding()
    }
}
