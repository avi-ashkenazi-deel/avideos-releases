import AppIntents

/// Registers the zero-setup Siri phrases (also surfaced in Shortcuts, Spotlight,
/// and the Action Button). Apple requires the app name in the spoken phrase, so
/// these read "… in Time It". The `\(\.$preset)` slot is filled from the user's
/// own timer names (see `TimerPresetQuery`).
@available(iOS 16.0, *)
struct TimeItShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartTimerIntent(),
            phrases: [
                "Start \(\.$preset) in \(.applicationName)",
                "Start my \(\.$preset) in \(.applicationName)",
                "Start \(\.$preset) timer in \(.applicationName)",
                "Begin \(\.$preset) in \(.applicationName)",
            ],
            shortTitle: "Start Timer",
            systemImageName: "timer"
        )
    }
}
