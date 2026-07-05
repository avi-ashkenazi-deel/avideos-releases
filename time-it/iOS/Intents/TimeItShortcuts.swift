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
        AppShortcut(
            intent: PauseTimerIntent(),
            phrases: ["Pause \(.applicationName)", "Pause my timer in \(.applicationName)"],
            shortTitle: "Pause Timer",
            systemImageName: "pause.fill"
        )
        AppShortcut(
            intent: ResumeTimerIntent(),
            phrases: ["Resume \(.applicationName)", "Resume my timer in \(.applicationName)"],
            shortTitle: "Resume Timer",
            systemImageName: "play.fill"
        )
        AppShortcut(
            intent: StopCurrentTimerIntent(),
            phrases: ["Stop \(.applicationName)", "Stop my timer in \(.applicationName)"],
            shortTitle: "Stop Timer",
            systemImageName: "stop.fill"
        )
        AppShortcut(
            intent: StartRestIntent(),
            phrases: ["Start a rest in \(.applicationName)", "Rest in \(.applicationName)"],
            shortTitle: "Start a Rest",
            systemImageName: "pause.circle"
        )
    }
}
