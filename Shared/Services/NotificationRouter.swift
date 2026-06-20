import Foundation
import Combine

/// Bridges a tapped notification to the UI. The notification delegate sets the
/// pending target; `RootView` observes it, opens that item, then clears it.
@MainActor
final class NotificationRouter: ObservableObject {
    static let shared = NotificationRouter()

    /// Feed item id to open, set when the user taps a feed notification.
    @Published var openFeedItemID: String?
}
