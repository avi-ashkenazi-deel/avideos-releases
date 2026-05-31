import Foundation

/// Single source of truth for the App Group used to share data between the main
/// app, the Apple Watch app, and the Share Extension (saved-article handoff).
///
/// The identifier must match the `com.apple.security.application-groups`
/// entitlement on every target that uses it, and be registered for your team in
/// the Apple Developer portal. Change it in this one place if you re-register.
enum AppGroup {
    static let identifier = "group.com.voiceinbox.shared"

    /// The shared container directory, or the per-process Documents directory as a
    /// fallback when the group isn't provisioned (e.g. SwiftUI previews).
    static var containerURL: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: identifier) ?? .standard
    }
}
