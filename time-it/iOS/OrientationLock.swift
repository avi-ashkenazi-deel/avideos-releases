import SwiftUI

/// Controls which orientations the app allows at runtime. The Info.plist permits
/// landscape, but we lock to portrait everywhere except the activity (running /
/// session) screens, which call `set(.allButUpsideDown)` while visible.
enum OrientationLock {
    /// Read by `AppDelegate.application(_:supportedInterfaceOrientationsFor:)`.
    static var mask: UIInterfaceOrientationMask = .portrait

    @MainActor
    static func set(_ newMask: UIInterfaceOrientationMask) {
        guard mask != newMask else { return }
        mask = newMask
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: newMask))
            scene.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        }
    }
}

/// Minimal app delegate so we can answer the orientation query per app state.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationLock.mask
    }
}
