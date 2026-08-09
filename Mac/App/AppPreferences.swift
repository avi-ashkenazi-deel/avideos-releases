import Foundation
import Observation

/// App-level preferences — the Ecamm-style Preferences window's backing
/// store. These are behavior toggles and defaults, not document state, so
/// they live in UserDefaults (the `workerBaseURL` / palette-board
/// precedent), not in the project file or the audio-settings JSON.
///
/// Every property persists on write and is `@Observable`, so preference
/// panes bind directly and consumers (MainWindow, palettes, recorder)
/// re-render on change.
@MainActor
@Observable
final class AppPreferences {
    /// What kind a newly added scene gets from the plus button's primary
    /// click (the menu still offers all kinds).
    enum DefaultSceneKind: String, CaseIterable {
        case camera, screenShare, movie, interview

        var displayName: String {
            switch self {
            case .camera: "Camera"
            case .screenShare: "Screen Share"
            case .movie: "Movie"
            case .interview: "Interview"
            }
        }
    }

    private let defaults = UserDefaults.standard

    // MARK: Recording

    var recordingCodec: ProgramRecorder.Codec {
        didSet { defaults.set(recordingCodec.rawValue, forKey: "pref.recordingCodec") }
    }
    /// nil = the default ~/Movies/Streamit.
    var recordingsFolderPath: String? {
        didSet { defaults.set(recordingsFolderPath, forKey: "pref.recordingsFolder") }
    }
    /// Wait three seconds before a recording actually starts.
    var recordCountdown: Bool {
        didSet { defaults.set(recordCountdown, forKey: "pref.recordCountdown") }
    }

    // MARK: Video

    var defaultSceneTransition: SceneTransitionStyle {
        didSet { defaults.set(defaultSceneTransition.rawValue, forKey: "pref.defaultSceneTransition") }
    }
    var defaultSceneKind: DefaultSceneKind {
        didSet { defaults.set(defaultSceneKind.rawValue, forKey: "pref.defaultSceneKind") }
    }
    /// Movie scenes start playing on switch; off = they wait, paused on the
    /// first frame.
    var autoPlayMovies: Bool {
        didSet { defaults.set(autoPlayMovies, forKey: "pref.autoPlayMovies") }
    }

    // MARK: General

    var showCameraSwitcher: Bool {
        didSet { defaults.set(showCameraSwitcher, forKey: "pref.showCameraSwitcher") }
    }
    /// Keep the palette windows visible while another app is frontmost
    /// (they normally hide on deactivate, panel-style).
    var palettesStayVisibleInBackground: Bool {
        didSet { defaults.set(palettesStayVisibleInBackground, forKey: "pref.palettesStayVisible") }
    }

    // MARK: Editor / export

    /// Normalize editor exports to delivery loudness (−16 LUFS audio master,
    /// −14 LUFS video). ExportService reads the same key directly — the
    /// editor's services don't depend on the studio hub.
    var normalizeExportLoudness: Bool {
        didSet { defaults.set(normalizeExportLoudness, forKey: "pref.normalizeExportLoudness") }
    }

    // MARK: Guests / call-ins

    /// Off (the default) is the call-in posture: a joining caller waits in
    /// the green room — connected, hearing the show, visible to the host —
    /// until put on air. On restores walk-right-in for planned interviews.
    var guestsStartOnAir: Bool {
        didSet { defaults.set(guestsStartOnAir, forKey: "pref.guestsStartOnAir") }
    }

    init() {
        recordingCodec = defaults.string(forKey: "pref.recordingCodec")
            .flatMap(ProgramRecorder.Codec.init(rawValue:)) ?? .hevc
        recordingsFolderPath = defaults.string(forKey: "pref.recordingsFolder")
        recordCountdown = defaults.bool(forKey: "pref.recordCountdown")
        defaultSceneTransition = defaults.string(forKey: "pref.defaultSceneTransition")
            .flatMap(SceneTransitionStyle.init(rawValue:)) ?? .magicMove
        defaultSceneKind = defaults.string(forKey: "pref.defaultSceneKind")
            .flatMap(DefaultSceneKind.init(rawValue:)) ?? .camera
        autoPlayMovies = defaults.object(forKey: "pref.autoPlayMovies") as? Bool ?? true
        showCameraSwitcher = defaults.object(forKey: "pref.showCameraSwitcher") as? Bool ?? true
        palettesStayVisibleInBackground = defaults.bool(forKey: "pref.palettesStayVisible")
        guestsStartOnAir = defaults.bool(forKey: "pref.guestsStartOnAir")
        normalizeExportLoudness = defaults.object(forKey: "pref.normalizeExportLoudness") as? Bool ?? true
    }
}
