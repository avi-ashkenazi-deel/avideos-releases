import Foundation
import Combine

/// Watches a freestyle session for signs you've finished and raises a gentle
/// "Still working out?" suggestion — never ends anything on its own.
///
/// To avoid nagging, it's deliberately conservative: it only asks after the
/// session has run a while, requires you to be BOTH idle *and* at a low heart
/// rate (when HR is available), and snoozes for a good while after you say
/// "Keep going".
@MainActor
final class SessionFinishDetector: ObservableObject {
    /// True when we think the session may be over; the UI shows an End prompt.
    @Published var suggestsEnd = false

    // Tunables (conservative so it rarely false-fires).
    var minSessionDuration: TimeInterval = 10 * 60  // never ask before this
    var idleTimeout: TimeInterval = 6 * 60          // no interaction (paired with low HR)
    var idleOnlyTimeout: TimeInterval = 12 * 60     // when no HR is available
    var lowHRThreshold: Double = 80                 // bpm — genuinely resting
    var lowHRWindow: TimeInterval = 5 * 60          // sustained below threshold
    var snooze: TimeInterval = 10 * 60              // quiet period after "Keep going"

    private var monitorStart = Date()
    private var lastActivity = Date()
    private var lowHRSince: Date?
    private var lastHRUpdate: Date?
    private var snoozeUntil = Date.distantPast
    private var active = false
    private var checkTimer: Timer?

    func startMonitoring() {
        active = true
        suggestsEnd = false
        monitorStart = Date()
        lastActivity = Date()
        lowHRSince = nil
        lastHRUpdate = nil
        snoozeUntil = .distantPast
        checkTimer?.invalidate()
        checkTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluate() }
        }
    }

    func stopMonitoring() {
        active = false
        suggestsEnd = false
        checkTimer?.invalidate()
        checkTimer = nil
    }

    /// Call on any deliberate interaction (e.g. starting a rest) — means you're
    /// still going, so reset the idle clock and clear any pending suggestion.
    func noteActivity() {
        lastActivity = Date()
        lowHRSince = nil
        suggestsEnd = false
    }

    /// Feed live heart rate from the workout session.
    func updateHeartRate(_ bpm: Double) {
        lastHRUpdate = Date()
        if bpm < lowHRThreshold {
            if lowHRSince == nil { lowHRSince = Date() }
        } else {
            lowHRSince = nil   // moving again — reset the resting clock
        }
    }

    /// "Keep going" — dismiss and stay quiet for `snooze` so it doesn't re-nag.
    func keepGoing() {
        suggestsEnd = false
        lastActivity = Date()
        lowHRSince = nil
        snoozeUntil = Date().addingTimeInterval(snooze)
    }

    private func evaluate() {
        guard active, !suggestsEnd else { return }
        let now = Date()
        guard now >= snoozeUntil,
              now.timeIntervalSince(monitorStart) >= minSessionDuration else { return }

        let idle = now.timeIntervalSince(lastActivity) >= idleTimeout
        let haveHR = lastHRUpdate != nil
        let lowHR = lowHRSince.map { now.timeIntervalSince($0) >= lowHRWindow } ?? false

        // With heart rate, require BOTH idle and a sustained low HR. Without HR,
        // fall back to a long idle on its own.
        let finished = haveHR
            ? (idle && lowHR)
            : (now.timeIntervalSince(lastActivity) >= idleOnlyTimeout)
        if finished { suggestsEnd = true }
    }
}
