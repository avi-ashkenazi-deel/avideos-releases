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

/// Black or white — whichever stays legible on top of the given hex color.
/// Used by the running view so the big countdown reads on any tint (white was
/// invisible on the bright greens/yellows).
func contrastingTextColor(forHex hex: String) -> Color {
    let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).uppercased()
    var rgb: UInt64 = 0
    guard s.count == 6, Scanner(string: s).scanHexInt64(&rgb) else { return .white }
    let r = Double((rgb & 0xFF0000) >> 16) / 255
    let g = Double((rgb & 0x00FF00) >> 8) / 255
    let b = Double(rgb & 0x0000FF) / 255
    let luminance = 0.299 * r + 0.587 * g + 0.114 * b
    return luminance > 0.55 ? .black : .white
}

/// A small fixed palette for tinting presets, exposed in the editor.
enum PresetPalette {
    static let hexes = ["#FF9500", "#0A84FF", "#30D158", "#FF375F", "#BF5AF2", "#FFD60A"]

    /// A new preset gets a random tint from the palette.
    static var random: String { hexes.randomElement() ?? "#FF9500" }

    static func name(for hex: String) -> String {
        switch hex.uppercased() {
        case "#FF9500": return "Orange"
        case "#0A84FF": return "Blue"
        case "#30D158": return "Green"
        case "#FF375F": return "Red"
        case "#BF5AF2": return "Purple"
        case "#FFD60A": return "Yellow"
        default: return "Custom"
        }
    }
}
