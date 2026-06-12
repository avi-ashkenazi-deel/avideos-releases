import Foundation
import Combine

/// App-wide settings shared across the iPhone and Watch. Currently just the
/// master `OutputMode`, persisted to the App Group so it survives relaunches and
/// is broadcast to the other device via `ConnectivityBridge`.
@MainActor
final class AppSettings: ObservableObject {

    @Published var outputMode: OutputMode {
        didSet {
            guard outputMode != oldValue else { return }
            persist()
            if !applyingRemote { onChange?(outputMode) }
        }
    }

    /// Fired for *local* changes only (UI toggles), so the host can sync them to
    /// the other device. Remote-applied changes do not re-broadcast (no echo).
    var onChange: ((OutputMode) -> Void)?

    private let defaults = AppGroup.sharedDefaults
    private static let key = "outputMode"
    private var applyingRemote = false

    init() {
        let raw = defaults.string(forKey: Self.key)
        outputMode = raw.flatMap(OutputMode.init(rawValue:)) ?? .both
    }

    /// Apply a value received from the other device without re-broadcasting it.
    func applyRemote(_ mode: OutputMode) {
        applyingRemote = true
        outputMode = mode
        applyingRemote = false
    }

    private func persist() {
        defaults.set(outputMode.rawValue, forKey: Self.key)
    }
}
