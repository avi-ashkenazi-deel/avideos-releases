import Foundation

#if os(iOS)
import UIKit

/// Tiny wrapper around the system haptics, used to confirm hands-free actions
/// (e.g. capturing a highlight via an AirPods press) when the screen isn't visible.
enum Haptics {
    @MainActor static func success() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.success)
    }
}

#else

enum Haptics {
    @MainActor static func success() {}
}

#endif
