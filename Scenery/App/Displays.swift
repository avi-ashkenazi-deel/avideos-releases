import AppKit
import CoreGraphics

/// A connected monitor, described in a way that survives restarts and
/// re-plugging (the identifier comes from the display itself, not from the
/// order it was connected in).
struct Display: Identifiable, Equatable {
    let id: String
    let name: String
    /// Position in the global desktop, in AppKit coordinates (origin bottom-left).
    let frame: CGRect
    /// The display that carries the menu bar.
    let isPrimary: Bool
}

enum Displays {
    static func current() -> [Display] {
        NSScreen.screens.map { screen in
            Display(
                id: identifier(for: screen),
                name: screen.localizedName,
                frame: screen.frame,
                isPrimary: screen.frame.origin == .zero
            )
        }
    }

    /// Screens keyed by display identifier. Mirrored displays share one entry.
    static func screensByID() -> [String: NSScreen] {
        var result: [String: NSScreen] = [:]
        for screen in NSScreen.screens {
            let id = identifier(for: screen)
            if result[id] == nil { result[id] = screen }
        }
        return result
    }

    static func identifier(for screen: NSScreen) -> String {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let number = screen.deviceDescription[key] as? NSNumber else {
            return "display-\(screen.localizedName)"
        }
        let displayID = CGDirectDisplayID(number.uint32Value)
        if let uuid = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue(),
           let text = CFUUIDCreateString(nil, uuid) {
            return text as String
        }
        return "display-\(displayID)"
    }
}
