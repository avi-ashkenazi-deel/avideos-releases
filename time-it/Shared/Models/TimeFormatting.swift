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
