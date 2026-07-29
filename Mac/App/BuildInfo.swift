import Foundation

/// Who am I, and how fresh is this binary?
///
/// Deliberately runtime-only — no build script, no generated source, nothing
/// that can dirty the working tree or invalidate a code signature. The build
/// TIME comes from the executable's own modification date, which for a local
/// Xcode build is exactly when it was compiled. That is the number that
/// answers "am I actually running what I just pulled?".
enum BuildInfo {
    /// Marketing version, e.g. "0.3.0" (project.yml MARKETING_VERSION).
    static let version: String =
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"

    /// Build number, e.g. "19" (project.yml CURRENT_PROJECT_VERSION).
    static let build: String =
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"

    /// When this binary was compiled, or nil if the executable can't be read.
    static let builtAt: Date? = {
        guard let url = Bundle.main.executableURL,
              let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        else { return nil }
        return values.contentModificationDate
    }()

    /// "17:57" today, "Jul 28 17:57" otherwise — short enough for the HUD.
    static let builtAtShortString: String = {
        guard let builtAt else { return "—" }
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(builtAt)
            ? "HH:mm"
            : "MMM d HH:mm"
        return formatter.string(from: builtAt)
    }()

    /// "v0.3.0 (19) · 17:57" — the HUD line, next to the frame rate.
    static var hudString: String {
        "v\(version) (\(build)) · \(builtAtShortString)"
    }

    /// The long form, for the menu and the About panel.
    static var longString: String {
        guard let builtAt else { return "Version \(version) (\(build))" }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return "Version \(version) (\(build)) — built \(formatter.string(from: builtAt))"
    }
}
