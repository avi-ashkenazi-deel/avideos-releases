import Foundation

/// A single resolved point during a run at which we alert the user. Both
/// interval boundaries and one-off custom milestones are flattened into cues so
/// the engine and scheduler treat them uniformly. Cues are *derived* (not stored
/// directly) — see `TimerPreset.cues()`.
struct TimerCue: Identifiable, Hashable {
    /// Stable within a run so the engine can track which cues already fired.
    /// Interval cues use "interval-<n>"; milestone cues use the milestone UUID.
    let id: String
    /// Elapsed offset from the start of the run at which this cue fires.
    let fireTime: TimeInterval
    let alert: AlertStyle
    let haptic: HapticPattern
    /// Spoken when the voice channel is active.
    let spokenText: String
    /// Shown in the UI (running view, "next cue").
    let displayLabel: String
}
