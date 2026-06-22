import Foundation
import Combine

/// Watches a freestyle session for signs you've finished and raises a gentle
/// "Still working out?" suggestion — never ends anything on its own. Two signals
/// feed it today: inactivity (no rests/interaction for a while) and a sustained
/// low heart rate. (A gym geofence is a planned third signal.)
@MainActor
final class SessionFinishDetector: ObservableObject {
    /// True when we think the session may be over; the UI shows an End prompt.
    @Published var suggestsEnd = false

    // Tunables (sensible defaults; kept conservative to avoid false nudges).
    var idleTimeout: TimeInterval = 4 * 60        // no interaction
    var lowHRThreshold: Double = 95               // bpm
    var lowHRWindow: TimeInterval = 3 * 60        // sustained below threshold
    var minSessionDuration: TimeInterval = 10 * 60 // never ask before this

    private var monitorStart = Date()
    private var lastActivity = Date()
    private var lowHRSince: Date?
    private var active = false
    private var checkTimer: Timer?

    func startMonitoring() {
        active = true
        suggestsEnd = false
        monitorStart = Date()
        lastActivity = Date()
        lowHRSince = nil
        checkTimer?.invalidate()
        checkTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
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
        if bpm < lowHRThreshold {
            if lowHRSince == nil { lowHRSince = Date() }
        } else {
            lowHRSince = nil
        }
    }

    /// "Keep going" — dismiss and reset the clocks so it doesn't immediately re-fire.
    func keepGoing() {
        suggestsEnd = false
        lastActivity = Date()
        lowHRSince = nil
    }

    private func evaluate() {
        guard active, !suggestsEnd else { return }
        let now = Date()
        // Don't nag in the first 10 minutes of a session.
        guard now.timeIntervalSince(monitorStart) >= minSessionDuration else { return }
        let idle = now.timeIntervalSince(lastActivity) >= idleTimeout
        let lowHR = lowHRSince.map { now.timeIntervalSince($0) >= lowHRWindow } ?? false
        if idle || lowHR { suggestsEnd = true }
    }
}
