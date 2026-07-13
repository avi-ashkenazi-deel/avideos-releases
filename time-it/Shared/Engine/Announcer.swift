import Foundation

/// The engine emits abstract "speak this" / "buzz this" events; each platform
/// supplies a concrete `Announcer` that turns them into AVSpeechSynthesizer
/// speech and WatchKit/UIKit haptics. Keeping the protocol this thin means all
/// the *policy* (which channel fires, given the OutputMode) lives in the engine
/// and stays unit-testable.
@MainActor
protocol Announcer: AnyObject {
    /// Speak a phrase. Implementations should queue, not overlap, utterances.
    func speak(_ text: String)
    /// Play a distinct haptic buzz.
    func haptic(_ pattern: HapticPattern)
}
