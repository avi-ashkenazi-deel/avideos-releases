import Foundation

/// Format seconds for display. Minutes:seconds up to 99 minutes (so 90 min reads
/// "90:00"), then h:mm:ss only beyond that. Foundation-only (lives in Models) so
/// the engine, widgets, and unit tests can all use it without pulling in SwiftUI.
func formatClock(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    if total >= 6000 {   // 100 minutes — switch to hours
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return String(format: "%d:%02d:%02d", h, m, s)
    }
    return String(format: "%d:%02d", total / 60, total % 60)
}

/// Short label for a rest-button duration: "30s", "1m", "1:30", "2m".
func restLabel(_ seconds: TimeInterval) -> String {
    let s = Int(seconds.rounded())
    if s % 60 == 0 { return "\(s / 60)m" }
    if s < 60 { return "\(s)s" }
    return formatClock(seconds)   // m:ss
}

/// m:ss.cc — adds hundredths of a second for a live, fast-moving readout.
func formatClockMillis(_ seconds: TimeInterval) -> String {
    let total = max(0, seconds)
    let m = Int(total) / 60
    let s = Int(total) % 60
    let cs = Int((total - total.rounded(.down)) * 100)
    return String(format: "%d:%02d.%02d", m, s, cs)
}

