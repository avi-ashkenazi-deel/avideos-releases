import SwiftUI

/// Running view for the single active timer on the watch. Page 1 (the default)
/// is a full-screen draining bar with the interval name and the interval + total
/// countdowns (with hundredths). Swipe left to page 2 for the controls — so the
/// numbers screen stays clean and there's a single set of buttons.
struct WatchRunningView: View {
    @EnvironmentObject private var engine: TimerEngine

    var body: some View {
        if let timer = engine.running.first {
            TabView {
                WatchTimesPage(timer: timer)
                WatchControlsPage(timer: timer)
            }
            // Default watch TabView is horizontal paging — swipe left for controls.
        } else {
            Color.clear
        }
    }
}

private struct WatchTimesPage: View {
    let timer: RunningTimerState

    var body: some View {
        let tint = Color(hex: timer.preset.colorHex)
        GeometryReader { geo in
            // Fast timeline so the hundredths actually move.
            TimelineView(.periodic(from: .now, by: 0.03)) { context in
                let now = context.date
                let fraction = timer.intervalFraction(now: now)
                let pos = timer.intervalPosition(now: now)
                ZStack(alignment: .bottom) {
                    tint.opacity(0.18)
                    Rectangle()
                        .fill(tint)
                        .frame(height: geo.size.height * fraction)

                    VStack(spacing: 2) {
                        HStack(spacing: 6) {
                            if timer.preset.isWorkout {
                                Image(systemName: "figure.strengthtraining.traditional")
                                    .font(.headline)
                                    .foregroundStyle(.green)
                                    .shadow(radius: 3)
                            }
                            if let label = intervalName(now) {
                                Text(label)
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                    .shadow(radius: 3)
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        // Interval remaining — the hero, with hundredths.
                        Text(formatClockMillis(timer.intervalRemaining(now: now)))
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .shadow(radius: 4)
                        // Total time left, smaller.
                        Text("total \(formatClock(timer.remaining(now: now)))")
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.85))
                            .shadow(radius: 2)

                        // Sets (position through the cycle) + Cycle (repeat).
                        HStack(spacing: 12) {
                            if pos.total > 1 { stat("\(pos.index)/\(pos.total)", "Sets") }
                            if timer.preset.repeatCount > 1 {
                                stat("\(timer.currentRepeat)/\(timer.preset.repeatCount)", "Cycle")
                            }
                        }
                        .padding(.top, 2)
                        Spacer()
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        .ignoresSafeArea()
    }

    private func stat(_ value: String, _ label: String) -> some View {
        HStack(spacing: 3) {
            Text(value).font(.caption).bold().foregroundStyle(.white)
            Text(label).font(.caption2).foregroundStyle(.white.opacity(0.7))
        }
        .shadow(radius: 2)
    }

    /// Interval label when there is one; for a plain rest with no intervals fall
    /// back to its name ("Rest"); otherwise nothing.
    private func intervalName(_ now: Date) -> String? {
        if let label = timer.currentIntervalLabel(now: now) { return label }
        if timer.preset.intervals == nil { return timer.preset.displayName }
        return nil
    }
}

private struct WatchControlsPage: View {
    @EnvironmentObject private var engine: TimerEngine
    let timer: RunningTimerState

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                button("backward.end.fill") { engine.skipToPreviousInterval(id: timer.id) }
                if timer.isRunning {
                    button("pause.fill") { engine.pause(id: timer.id) }
                } else {
                    button("play.fill") { engine.resume(id: timer.id) }
                }
            }
            HStack(spacing: 10) {
                button("forward.end.fill") { engine.skipToNextInterval(id: timer.id) }
                button("stop.fill", tint: .red) { engine.stop(id: timer.id) }
            }
        }
        .padding(.horizontal, 6)
    }

    private func button(_ system: String, tint: Color = .accentColor,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.title3).frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .tint(tint)
    }
}
