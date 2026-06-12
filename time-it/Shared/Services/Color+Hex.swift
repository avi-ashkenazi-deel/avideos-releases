import SwiftUI

extension Color {
    /// Create a color from a "#RRGGBB" string. Falls back to orange on bad input.
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).uppercased()
        var rgb: UInt64 = 0
        guard s.count == 6, Scanner(string: s).scanHexInt64(&rgb) else {
            self = .orange
            return
        }
        self = Color(
            red: Double((rgb & 0xFF0000) >> 16) / 255,
            green: Double((rgb & 0x00FF00) >> 8) / 255,
            blue: Double(rgb & 0x0000FF) / 255
        )
    }
}

/// A small fixed palette for tinting presets, exposed in the editor.
enum PresetPalette {
    static let hexes = ["#FF9500", "#0A84FF", "#30D158", "#FF375F", "#BF5AF2", "#FFD60A"]
}

/// Format seconds as m:ss or h:mm:ss for display.
func formatClock(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    return h > 0
        ? String(format: "%d:%02d:%02d", h, m, s)
        : String(format: "%d:%02d", m, s)
}
