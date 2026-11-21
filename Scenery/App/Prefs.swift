import Foundation
import SceneryCore

/// Every setting the app reads.
///
/// All of these live in the app's normal preferences domain, which means IT
/// can pin any of them with a device-management profile (see
/// `it-admin/README.md`). A pinned value always wins and `isManaged` reports it,
/// so the picker can show the control as locked.
enum Prefs {
    enum Key {
        /// String. Where the approved catalog lives. Empty = bundled demo.
        static let manifestURL = "ManifestURL"
        /// Integer. How often to check the manifest for changes.
        static let refreshIntervalMinutes = "RefreshIntervalMinutes"
        /// String. Pins one wallpaper id on every display, right now.
        static let forcedWallpaperID = "ForcedWallpaperID"
        /// Bool. Freeze video wallpapers while on battery power.
        static let pauseVideoOnBattery = "PauseVideoOnBattery"
        /// Bool. Show the still frame instead of playing video at all.
        static let disableVideo = "DisableVideo"

        // Private state, not meant to be managed.
        static let selection = "Selection"
        static let didSetUpLoginItem = "DidSetUpLoginItem"
        static let manifestETag = "ManifestETag"
        static let manifestCachedFrom = "ManifestCachedFrom"
    }

    static let defaults = UserDefaults.standard

    static func registerDefaults() {
        defaults.register(defaults: [
            Key.refreshIntervalMinutes: 30,
            Key.pauseVideoOnBattery: true,
            Key.disableVideo: false,
        ])
    }

    static func isManaged(_ key: String) -> Bool {
        defaults.objectIsForced(forKey: key)
    }

    static var manifestURL: URL? {
        guard let text = defaults.string(forKey: Key.manifestURL)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
            let url = URL(string: text), let scheme = url.scheme?.lowercased() else {
            return nil
        }
        // Remote catalogs must be https. A local file is allowed so that
        // designers can try a catalog folder on their own Mac.
        return (scheme == "https" || scheme == "file") ? url : nil
    }

    static var refreshInterval: TimeInterval {
        let minutes = defaults.integer(forKey: Key.refreshIntervalMinutes)
        return TimeInterval(min(max(minutes, 5), 24 * 60)) * 60
    }

    static var forcedWallpaperID: String? {
        guard let id = defaults.string(forKey: Key.forcedWallpaperID)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
            return nil
        }
        return id
    }

    static var pauseVideoOnBattery: Bool {
        get { defaults.bool(forKey: Key.pauseVideoOnBattery) }
        set { defaults.set(newValue, forKey: Key.pauseVideoOnBattery) }
    }

    static var disableVideo: Bool {
        defaults.bool(forKey: Key.disableVideo)
    }

    static var selection: SelectionState {
        get {
            guard let data = defaults.data(forKey: Key.selection),
                  let state = try? JSONDecoder().decode(SelectionState.self, from: data) else {
                return SelectionState()
            }
            return state
        }
        set {
            if let data = try? JSONEncoder().encode(newValue) {
                defaults.set(data, forKey: Key.selection)
            }
        }
    }
}
