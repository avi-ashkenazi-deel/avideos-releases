import Foundation

/// Format seconds as m:ss or h:mm:ss for display. Foundation-only (lives in
/// Models) so the engine, widgets, and unit tests can all use it without pulling
/// in SwiftUI.
func formatClock(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    return h > 0
        ? String(format: "%d:%02d:%02d", h, m, s)
        : String(format: "%d:%02d", m, s)
}

/// m:ss.cc — adds hundredths of a second for a live, fast-moving readout.
func formatClockMillis(_ seconds: TimeInterval) -> String {
    let total = max(0, seconds)
    let m = Int(total) / 60
    let s = Int(total) % 60
    let cs = Int((total - total.rounded(.down)) * 100)
    return String(format: "%d:%02d.%02d", m, s, cs)
}

