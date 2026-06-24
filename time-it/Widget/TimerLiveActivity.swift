import WidgetKit
import SwiftUI
import ActivityKit

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
            LockScreenView(state: context.state)
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
                    heroProgress(s, tint: tint)
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

    var body: some View {
        let tint = Color(hex: state.colorHex)
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
    }
}

// MARK: - Shared bits

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
