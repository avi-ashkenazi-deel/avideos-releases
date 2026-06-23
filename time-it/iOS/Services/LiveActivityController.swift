import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// Starts, updates, and ends a Live Activity per running timer so progress shows
/// on the Lock Screen and in the Dynamic Island, and the timer keeps visibly
/// counting after you leave the app. Driven by `TimerEngine.onTimersChanged`.
@available(iOS 16.2, *)
@MainActor
final class LiveActivityController {

    private var activities: [String: Activity<TimerActivityAttributes>] = [:]

    /// Reconcile live activities against the current set of running timers:
    /// start ones that are new, update the rest, end ones that disappeared.
    func sync(_ running: [RunningTimerState], now: Date = Date()) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let liveIDs = Set(running.map { $0.id.uuidString })

        // End activities whose timer is gone.
        for (id, activity) in activities where !liveIDs.contains(id) {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
            activities[id] = nil
        }

        for timer in running {
            let id = timer.id.uuidString
            let state = contentState(for: timer, now: now)
            if let activity = activities[id] {
                Task { await activity.update(ActivityContent(state: state, staleDate: timer.endDate(now: now))) }
            } else {
                start(id: id, state: state, staleDate: timer.endDate(now: now))
            }
        }
    }

    /// End everything (e.g. on Stop All).
    func endAll() {
        for (_, activity) in activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        activities.removeAll()
    }

    // MARK: Helpers

    private func start(id: String, state: TimerActivityAttributes.ContentState, staleDate: Date) {
        do {
            let activity = try Activity.request(
                attributes: TimerActivityAttributes(timerID: id),
                content: ActivityContent(state: state, staleDate: staleDate),
                pushType: nil
            )
            activities[id] = activity
        } catch {
            #if DEBUG
            print("LiveActivity start failed: \(error)")
            #endif
        }
    }

    private func contentState(for timer: RunningTimerState,
                              now: Date) -> TimerActivityAttributes.ContentState {
        let remaining = timer.remaining(now: now)
        let elapsed = timer.elapsed(now: now)
        let seg = timer.currentSegment(now: now)
        let pos = timer.intervalPosition(now: now)
        let hasIntervals = pos.total > 1

        return .init(
            name: timer.preset.displayName,
            startDate: now.addingTimeInterval(-elapsed),
            endDate: now.addingTimeInterval(remaining),
            isRunning: timer.isRunning,
            pausedRemaining: remaining,
            colorHex: timer.preset.colorHex,
            nextCueLabel: timer.nextCueLabel(now: now),
            hasIntervals: hasIntervals,
            // Anchor the interval window to wall-clock so the widget can tick it.
            intervalStartDate: now.addingTimeInterval(-(elapsed - seg.start)),
            intervalEndDate: now.addingTimeInterval(seg.end - elapsed),
            intervalPausedRemaining: timer.intervalRemaining(now: now),
            intervalLabel: intervalLabel(for: timer, now: now, pos: pos)
        )
    }

    /// A short label for the interval in progress: Work/Rest for work-rest plans,
    /// otherwise the cue's own label, falling back to "Interval i/N".
    private func intervalLabel(for timer: RunningTimerState, now: Date,
                               pos: (index: Int, total: Int)) -> String? {
        if let phase = timer.workRestPhase(now: now) {
            return phase.isWork ? "Work" : "Rest"
        }
        if let label = timer.currentIntervalLabel(now: now) { return label }
        return pos.total > 1 ? "Interval \(pos.index)/\(pos.total)" : nil
    }
}
#endif
