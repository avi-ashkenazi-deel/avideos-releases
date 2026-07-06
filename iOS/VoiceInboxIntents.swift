import AppIntents

/// Real Siri integration via App Intents. These let the listener control
/// VoiceInbox hands-free with "Hey Siri …", the Action Button, or Shortcuts —
/// most importantly, dictating a note onto a highlight of whatever's playing.
///
/// Note: these act on the *currently playing* item, so the app must be running
/// (it is whenever audio is playing). When nothing is playing they say so rather
/// than failing silently.

// MARK: - Add a note (the headline feature)

struct AddNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Add a Note"
    static var description = IntentDescription(
        "Capture a highlight of what HearIt is reading and attach a spoken note.")
    // Run in the background so Siri can take the note without leaving the lock screen.
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Note", requestValueDialog: "What's the note?")
    var note: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let player = EmailPlayerViewModel.active, player.hasCurrentItem else {
            return .result(dialog: "Nothing's playing in HearIt right now, so there's nothing to note.")
        }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let highlight = player.captureHighlight(presentComposer: false) else {
            return .result(dialog: "I couldn't capture that moment.")
        }
        if !trimmed.isEmpty {
            HighlightStore.shared.updateNote(for: highlight.id, note: trimmed)
        }
        return .result(dialog: "Saved your note.")
    }
}

// MARK: - Capture a highlight (no note)

struct CaptureHighlightIntent: AppIntent {
    static var title: LocalizedStringResource = "Highlight This"
    static var description = IntentDescription("Bookmark the moment HearIt is reading.")
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let player = EmailPlayerViewModel.active, player.hasCurrentItem else {
            return .result(dialog: "Nothing's playing to highlight.")
        }
        _ = player.captureHighlight(presentComposer: false)
        return .result(dialog: "Highlighted.")
    }
}

// MARK: - Transport

struct NextItemIntent: AppIntent {
    static var title: LocalizedStringResource = "Next Item"
    static var description = IntentDescription("Mark the current item read and move to the next.")
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let player = EmailPlayerViewModel.active, player.canSkipToNextItem else {
            return .result(dialog: "There's nothing to move on to.")
        }
        player.skipToNextItem()
        return .result(dialog: "Moving on.")
    }
}

struct TogglePlaybackIntent: AppIntent {
    static var title: LocalizedStringResource = "Play or Pause"
    static var description = IntentDescription("Play or pause HearIt.")
    static var openAppWhenRun: Bool = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let player = EmailPlayerViewModel.active, player.hasCurrentItem else {
            return .result(dialog: "Nothing's loaded to play.")
        }
        player.togglePlayPause()
        return .result(dialog: player.isPlaying ? "Playing." : "Paused.")
    }
}

// MARK: - Siri phrases

struct VoiceInboxShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddNoteIntent(),
            phrases: [
                "Add a note in \(.applicationName)",
                "Take a note in \(.applicationName)",
                "Note this in \(.applicationName)"
            ],
            shortTitle: "Add a Note",
            systemImageName: "highlighter"
        )
        AppShortcut(
            intent: CaptureHighlightIntent(),
            phrases: [
                "Highlight this in \(.applicationName)",
                "Bookmark this in \(.applicationName)"
            ],
            shortTitle: "Highlight This",
            systemImageName: "bookmark"
        )
        AppShortcut(
            intent: NextItemIntent(),
            phrases: [
                "Next in \(.applicationName)",
                "Skip this in \(.applicationName)"
            ],
            shortTitle: "Next Item",
            systemImageName: "forward.end"
        )
        AppShortcut(
            intent: TogglePlaybackIntent(),
            phrases: [
                "Play \(.applicationName)",
                "Pause \(.applicationName)"
            ],
            shortTitle: "Play or Pause",
            systemImageName: "playpause"
        )
    }
}
