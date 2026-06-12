import Foundation

/// Shared-storage helpers for the App Group that both the iPhone and Watch apps
/// belong to. Falls back to the local documents directory if the group container
/// is unavailable (e.g. previews / unit tests without entitlements).
enum AppGroup {
    static let identifier = "group.com.aviashkenazi.timeit"

    static var containerURL: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    static var sharedDefaults: UserDefaults {
        UserDefaults(suiteName: identifier) ?? .standard
    }
}
