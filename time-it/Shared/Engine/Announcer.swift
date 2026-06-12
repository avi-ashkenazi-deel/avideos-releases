import Foundation

/// The engine emits abstract "announce this" events; each platform supplies a
/// concrete `Announcer` that turns them into speech and/or haptics. This keeps
/// `TimerEngine` free of any AVFoundation / WatchKit imports and lets the iOS
/// and watchOS apps differ (e.g. watch may suppress speech during a talk).
@MainActor
protocol Announcer: AnyObject {
    /// Speak a phrase. Implementations should queue, not overlap, utterances.
    func speak(_ text: String)
    /// Play a distinct haptic buzz.
    func haptic(_ pattern: HapticPattern)
    /// A timer (or repeat) just finished. `isFinalRepeat` is true on the last one.
    func timerCompleted(name: String, isFinalRepeat: Bool)
}

/// Convenience: fire the appropriate channels for a milestone's alert style.
extension Announcer {
    func fire(_ milestone: TimerMilestone, duration: TimeInterval) {
        if milestone.alert.includesVoice {
            speak(milestone.spokenText(forDuration: duration))
        }
        if milestone.alert.includesHaptic {
            haptic(milestone.haptic)
        }
    }
}
