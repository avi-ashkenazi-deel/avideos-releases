import AppKit
import Observation

/// Named sets of window frames — the studio window plus every open palette
/// — saved and restored from the Window menu. Palette windows are identified
/// by their frame-autosave name ("palette-<kind>"), which
/// `PaletteWindowConfigurator` sets, so no window subclassing is needed.
///
/// Restoring a layout re-opens palettes that were part of it (via the
/// `openPalette` hook the app installs) and closes none: a layout is
/// additive, "put these where they were", not "close everything else".
@MainActor
@Observable
final class WindowLayoutStore {
    static let shared = WindowLayoutStore()

    private static let defaultsKey = "windowLayouts"
    private static let studioKey = "studio"

    /// Saved layout names, sorted — what the menu lists.
    private(set) var names: [String] = []

    /// Installed by the app so a restore can open a palette that isn't up.
    var openPalette: ((PaletteKind) -> Void)?

    private var layouts: [String: [String: String]] {
        get {
            (UserDefaults.standard.dictionary(forKey: Self.defaultsKey) as? [String: [String: String]]) ?? [:]
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.defaultsKey)
            names = newValue.keys.sorted()
        }
    }

    private init() {
        names = layouts.keys.sorted()
    }

    // MARK: - Save / restore / delete

    func save(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        var frames: [String: String] = [:]
        for window in NSApp.windows where window.isVisible {
            if let key = Self.key(for: window) {
                frames[key] = NSStringFromRect(window.frame)
            }
        }
        var all = layouts
        all[trimmed] = frames
        layouts = all
    }

    func restore(name: String) {
        guard let frames = layouts[name] else { return }
        // Palettes that aren't open yet need opening first; their frame is
        // applied once the window exists.
        for (key, _) in frames where key != Self.studioKey {
            if let kind = PaletteKind(rawValue: key), !Self.paletteWindowExists(kind) {
                openPalette?(kind)
            }
        }
        // Frames land after the run loop has created any new windows.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            for window in NSApp.windows {
                guard let key = Self.key(for: window), let frame = frames[key] else { continue }
                window.setFrame(NSRectFromString(frame), display: true, animate: true)
            }
        }
    }

    func delete(name: String) {
        var all = layouts
        all.removeValue(forKey: name)
        layouts = all
    }

    // MARK: - Move all windows to another display

    /// Every visible window keeps its position RELATIVE to its screen's
    /// visible area and re-lands at the same relative spot on the next
    /// display (wrapping). With one display this is a no-op.
    func moveAllWindowsToNextDisplay() {
        let screens = NSScreen.screens
        guard screens.count > 1 else { return }
        for window in NSApp.windows where window.isVisible {
            guard let current = window.screen ?? NSScreen.main,
                  let index = screens.firstIndex(of: current) else { continue }
            let target = screens[(index + 1) % screens.count]
            let from = current.visibleFrame
            let to = target.visibleFrame
            let frame = window.frame
            let relX = from.width > 0 ? (frame.minX - from.minX) / from.width : 0
            let relY = from.height > 0 ? (frame.minY - from.minY) / from.height : 0
            var origin = NSPoint(x: to.minX + relX * to.width, y: to.minY + relY * to.height)
            origin.x = min(max(origin.x, to.minX), max(to.maxX - frame.width, to.minX))
            origin.y = min(max(origin.y, to.minY), max(to.maxY - frame.height, to.minY))
            window.setFrameOrigin(origin)
        }
    }

    // MARK: - Helpers

    /// "studio" for the main window, the palette kind's raw value for a
    /// palette, nil for anything else (alerts, popovers, Settings).
    private static func key(for window: NSWindow) -> String? {
        let autosave = window.frameAutosaveName
        if autosave.hasPrefix("palette-") {
            return String(autosave.dropFirst("palette-".count))
        }
        if window.identifier?.rawValue.hasPrefix("studio") == true {
            return studioKey
        }
        return nil
    }

    private static func paletteWindowExists(_ kind: PaletteKind) -> Bool {
        NSApp.windows.contains { $0.frameAutosaveName == "palette-\(kind.rawValue)" && $0.isVisible }
    }

    /// AppKit prompt — Commands have nowhere to hang a SwiftUI alert.
    static func promptForLayoutName() -> String? {
        let alert = NSAlert()
        alert.messageText = "Save Window Layout"
        alert.informativeText = "Remembers where the studio window and every open palette sit."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.placeholderString = "Layout name"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        return field.stringValue
    }
}
