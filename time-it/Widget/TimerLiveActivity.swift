import WidgetKit
import SwiftUI
import ActivityKit
import AppIntents

/// Renders the running timer on the Lock Screen and across the Dynamic Island
/// presentations. When the timer has intervals, the hero is the *interval*
/// countdown (matching the in-app running screen) with the total shown secondary;
/// otherwise the total is the hero. The card is tinted with the timer's color and
/// everything is driven by `timerInterval` ranges, so it ticks without per-second
/// updates.
@available(iOS 16.2, *)
struct TimerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TimerActivityAttributes.self) { context in
            let tint = Color(hex: context.state.colorHex)
            // Lock Screen / banner presentation.
            LockScreenView(state: context.state, timerID: context.attributes.timerID)
                .padding()
                .activityBackgroundTint(tint.opacity(0.18))
                .activitySystemActionForegroundColor(tint)
        } dynamicIsland: { context in
            let tint = Color(hex: context.state.colorHex)
            let s = context.state
            return DynamicIsland {
                // Expanded (on long-press): just the essentials — what phase,
                // the countdown, and a thin progress bar.
                DynamicIslandExpandedRegion(.leading) {
                    Label(s.intervalLabel ?? s.name, systemImage: "timer")
                        .font(.caption.bold()).foregroundStyle(tint).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    heroTime(s).font(.title3.monospacedDigit().bold())
                        .foregroundStyle(tint).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        heroProgress(s, tint: tint)
                        controls(context.attributes.timerID, isRunning: s.isRunning, tint: tint)
                    }
                }
            } compactLeading: {
                Image(systemName: "timer").foregroundStyle(tint)
            } compactTrailing: {
                // Cap the width so the live countdown doesn't reserve a wide,
                // jittery frame — the island stays as narrow as the time needs.
                heroTime(s).monospacedDigit().foregroundStyle(tint)
                    .frame(maxWidth: 54)
            } minimal: {
                Image(systemName: "timer").foregroundStyle(tint)
            }
            .keylineTint(tint)
        }
    }
}

@available(iOS 16.2, *)
private struct LockScreenView: View {
    let state: TimerActivityAttributes.ContentState
    let timerID: String

    var body: some View {
        let tint = Color(hex: state.colorHex)
        VStack(spacing: 10) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(state.name).font(.headline).lineLimit(1)
                    if let label = state.intervalLabel {
                        Text(label).font(.subheadline.bold()).foregroundStyle(tint).lineLimit(1)
                    } else if let next = state.nextCueLabel {
                        Text("Next: \(next)").font(.caption).foregroundStyle(.secondary)
                    }
                    heroProgress(state, tint: tint)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    heroTime(state).font(.system(size: 34, weight: .semibold, design: .rounded))
                        .monospacedDigit().foregroundStyle(tint)
                    if state.hasIntervals {
                        HStack(spacing: 3) {
                            totalText(state).monospacedDigit()
                            Text("left").opacity(0.8)
                        }
                        .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            controls(timerID, isRunning: state.isRunning, tint: tint)
        }
    }
}

// MARK: - Shared bits

/// Tappable transport controls (iOS 17+ interactive Live Activity buttons):
/// pause/resume, skip to next interval, and stop — all without opening the app.
@available(iOS 16.2, *)
@ViewBuilder
private func controls(_ timerID: String, isRunning: Bool, tint: Color) -> some View {
    if #available(iOS 17.0, *) {
        HStack(spacing: 28) {
            Button(intent: PauseResumeTimerIntent(timerID: timerID)) {
                Image(systemName: isRunning ? "pause.fill" : "play.fill")
            }
            Button(intent: SkipIntervalIntent(timerID: timerID)) {
                Image(systemName: "forward.end.fill")
            }
            Button(intent: StopTimerIntent(timerID: timerID)) {
                Image(systemName: "stop.fill")
            }
        }
        .font(.title3)
        .foregroundStyle(tint)
        .buttonStyle(.plain)
    }
}

/// The hero countdown: the interval range when the timer has intervals,
/// otherwise the total run range.
@available(iOS 16.2, *)
@ViewBuilder
private func heroTime(_ state: TimerActivityAttributes.ContentState) -> some View {
    if state.isRunning {
        if state.hasIntervals {
            Text(timerInterval: state.intervalStartDate...state.intervalEndDate, countsDown: true)
                .multilineTextAlignment(.trailing)
        } else {
            Text(timerInterval: state.startDate...state.endDate, countsDown: true)
                .multilineTextAlignment(.trailing)
        }
    } else {
        Text(formatClock(state.hasIntervals ? state.intervalPausedRemaining : state.pausedRemaining))
    }
}

/// The total run time remaining, shown secondary when there are intervals.
@available(iOS 16.2, *)
@ViewBuilder
private func totalText(_ state: TimerActivityAttributes.ContentState) -> some View {
    if state.isRunning {
        Text(timerInterval: state.startDate...state.endDate, countsDown: true)
            .multilineTextAlignment(.trailing)
    } else {
        Text(formatClock(state.pausedRemaining))
    }
}

/// Progress for the hero (interval when present, else the whole run).
@available(iOS 16.2, *)
@ViewBuilder
private func heroProgress(_ state: TimerActivityAttributes.ContentState, tint: Color) -> some View {
    if state.isRunning {
        let range = state.hasIntervals
            ? state.intervalStartDate...state.intervalEndDate
            : state.startDate...state.endDate
        ProgressView(timerInterval: range, countsDown: false)
            .tint(tint).labelsHidden()
    } else {
        ProgressView(value: 0).tint(tint)
    }
}
