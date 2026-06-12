import WidgetKit
import SwiftUI
import ActivityKit

/// Renders the running timer on the Lock Screen and across the Dynamic Island
/// presentations. The countdown text and progress bar are driven by the
/// `timerInterval` range, so they tick on their own without per-second updates.
@available(iOS 16.2, *)
struct TimerLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TimerActivityAttributes.self) { context in
            // Lock Screen / banner presentation.
            LockScreenView(state: context.state)
                .padding()
                .activityBackgroundTint(Color.black.opacity(0.4))
        } dynamicIsland: { context in
            let tint = Color(hex: context.state.colorHex)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.state.name, systemImage: "timer")
                        .font(.caption).foregroundStyle(tint).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    timeText(context.state).font(.title3.monospacedDigit()).foregroundStyle(tint)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 4) {
                        progress(context.state, tint: tint)
                        if let next = context.state.nextCueLabel {
                            Text("Next: \(next)").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: "timer").foregroundStyle(tint)
            } compactTrailing: {
                timeText(context.state).monospacedDigit().foregroundStyle(tint)
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
                if let next = state.nextCueLabel {
                    Text("Next: \(next)").font(.caption).foregroundStyle(.secondary)
                }
                progress(state, tint: tint)
            }
            Spacer()
            timeText(state).font(.system(size: 34, weight: .semibold, design: .rounded))
                .monospacedDigit().foregroundStyle(tint)
        }
    }
}

// MARK: - Shared bits

@available(iOS 16.2, *)
@ViewBuilder
private func timeText(_ state: TimerActivityAttributes.ContentState) -> some View {
    if state.isRunning {
        Text(timerInterval: state.startDate...state.endDate, countsDown: true)
            .multilineTextAlignment(.trailing)
    } else {
        Text(formatClock(state.pausedRemaining))
    }
}

@available(iOS 16.2, *)
@ViewBuilder
private func progress(_ state: TimerActivityAttributes.ContentState, tint: Color) -> some View {
    if state.isRunning {
        ProgressView(timerInterval: state.startDate...state.endDate, countsDown: false)
            .tint(tint).labelsHidden()
    } else {
        ProgressView(value: 0).tint(tint)
    }
}
