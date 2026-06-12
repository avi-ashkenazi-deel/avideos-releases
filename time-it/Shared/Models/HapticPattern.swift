import Foundation

/// A platform-neutral haptic "vocabulary". Each case is meant to *feel*
/// distinct so the user can tell milestones apart on the wrist without looking
/// (e.g. halftime vs. wrap-up vs. time-is-up during a conference talk).
///
/// `HapticPlayer` maps these to concrete `WKHapticType` (watchOS) or
/// `UIFeedbackGenerator` (iOS) plays, including repeat counts for emphasis.
enum HapticPattern: String, Codable, CaseIterable, Identifiable {
    case notification   // single gentle tap — generic milestone
    case directionUp    // rising tap — "we're past the midpoint"
    case directionDown  // falling tap — "winding down"
    case success        // pleasant confirm — a soft checkpoint
    case retry          // double buzz — "heads up / warning"
    case stop           // strong buzz — "wrap up now"
    case timeUp         // emphatic triple buzz — "time is up"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .notification: return "Tap"
        case .directionUp: return "Rising"
        case .directionDown: return "Falling"
        case .success: return "Success"
        case .retry: return "Double buzz"
        case .stop: return "Strong buzz"
        case .timeUp: return "Time's up (triple)"
        }
    }
}
