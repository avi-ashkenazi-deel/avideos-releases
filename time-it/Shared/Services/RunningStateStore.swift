import Foundation

/// Persists the currently-running timer so a run survives the app being killed
/// mid-timer (a phone call, a low-memory jetsam, a crash). Written on every
/// discrete change; read once at launch.
enum RunningStateStore {
    private static var url: URL {
        AppGroup.containerURL.appendingPathComponent("running.json")
    }

    static func save(_ states: [RunningTimerState]) {
        let snapshots = states.map(\.snapshot)
        guard !snapshots.isEmpty else { clear(); return }
        if let data = try? JSONEncoder().encode(snapshots) {
            try? data.write(to: url, options: .atomic)
        }
    }

    static func clear() {
        try? FileManager.default.removeItem(at: url)
    }

    /// Load persisted snapshots that are still valid to resume — i.e. the run
    /// hasn't already elapsed past its end while the app was gone.
    static func loadRestorable(now: Date = Date()) -> [RunningTimerState] {
        guard let data = try? Data(contentsOf: url),
              let snapshots = try? JSONDecoder().decode([RunningTimerSnapshot].self, from: data)
        else { return [] }
        return snapshots
            .map { RunningTimerState(restoring: $0) }
            .filter { $0.remaining(now: now) > 1 }   // still time left to run
            .map { var s = $0; s.markElapsedCuesFired(now: now); return s }
    }
}
