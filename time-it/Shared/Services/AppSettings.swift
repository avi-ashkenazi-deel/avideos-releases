import Foundation
import Combine

/// App-wide settings shared across the iPhone and Watch: the master `OutputMode`
/// and the three quick-rest durations used in a session. Persisted to the App
/// Group and broadcast to the other device via `ConnectivityBridge`.
@MainActor
final class AppSettings: ObservableObject {

    @Published var outputMode: OutputMode {
        didSet {
            guard outputMode != oldValue else { return }
            defaults.set(outputMode.rawValue, forKey: Self.modeKey)
            if !applyingRemote { onChange?(outputMode) }
        }
    }

    /// The three rest-button durations (seconds) shown in a session, on both
    /// devices. Editable in iPhone settings.
    @Published var restDurations: [TimeInterval] {
        didSet {
            guard restDurations != oldValue else { return }
            defaults.set(restDurations, forKey: Self.restsKey)
            if !applyingRemote { onRestsChange?(restDurations) }
        }
    }

    /// The activity type the "Free workout" session records on the Apple Watch.
    /// Picks the workout logged to Fitness and the icon shown for the session.
    @Published var sessionWorkoutKind: WorkoutKind {
        didSet {
            guard sessionWorkoutKind != oldValue else { return }
            defaults.set(sessionWorkoutKind.rawValue, forKey: Self.kindKey)
            if !applyingRemote { onWorkoutKindChange?(sessionWorkoutKind) }
        }
    }

    /// Fired for *local* changes only, so the host can sync them to the other
    /// device. Remote-applied changes do not re-broadcast (no echo).
    var onChange: ((OutputMode) -> Void)?
    var onRestsChange: (([TimeInterval]) -> Void)?
    var onWorkoutKindChange: ((WorkoutKind) -> Void)?

    static let defaultRests: [TimeInterval] = [30, 60, 120]

    private let defaults = AppGroup.sharedDefaults
    private static let modeKey = "outputMode"
    private static let restsKey = "restDurations"
    private static let kindKey = "sessionWorkoutKind"
    private var applyingRemote = false

    init() {
        let raw = defaults.string(forKey: Self.modeKey)
        outputMode = raw.flatMap(OutputMode.init(rawValue:)) ?? .both
        let rests = defaults.array(forKey: Self.restsKey) as? [TimeInterval]
        restDurations = (rests?.count == 3) ? rests! : Self.defaultRests
        let kindRaw = defaults.string(forKey: Self.kindKey)
        sessionWorkoutKind = kindRaw.flatMap(WorkoutKind.init(rawValue:)) ?? .functionalStrength
    }

    func applyRemote(_ mode: OutputMode) {
        applyingRemote = true
        outputMode = mode
        applyingRemote = false
    }

    func applyRemoteRests(_ rests: [TimeInterval]) {
        guard rests.count == 3 else { return }
        applyingRemote = true
        restDurations = rests
        applyingRemote = false
    }

    func applyRemoteWorkoutKind(_ kind: WorkoutKind) {
        applyingRemote = true
        sessionWorkoutKind = kind
        applyingRemote = false
    }
}
