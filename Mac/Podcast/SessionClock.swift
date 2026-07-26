import Foundation
import os

/// Monotonic host time source for the podcast session clock.
///
/// All intra-session deltas MUST come from a monotonic clock —
/// `Date()`/`CFAbsoluteTimeGetCurrent()` jump when NTP or the user adjusts the
/// wall clock, which would corrupt drift fits. `CLOCK_UPTIME_RAW` is the
/// mach_absolute_time-derived clock (does not tick while the machine sleeps;
/// the periodic resync in `ClockSyncService` re-anchors after wake).
enum MonotonicClock {
    /// Milliseconds on the raw uptime clock. Only meaningful as deltas or as
    /// input to `SessionClock`, never as wall time.
    static func nowMs() -> Double {
        Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000.0
    }
}

/// The shared session timebase: server epoch milliseconds reconstructed from
/// the local monotonic clock plus an NTP-style offset maintained by
/// `ClockSyncService`.
///
/// `now()` is cheap and safe to call from real-time capture callbacks (a
/// single lock acquisition, no allocation, no syscall beyond the clock read).
final class SessionClock: @unchecked Sendable {
    private let lock = NSLock()
    private var _offsetMs: Double
    private var _uncertaintyMs: Double
    private var _isSynchronized: Bool

    /// - Parameters:
    ///   - offsetMs: initial serverTime − monotonicTime offset. Defaults to a
    ///     wall-clock-derived guess so `now()` is at least plausible before
    ///     the first sync completes.
    ///   - uncertaintyMs: initial ± error estimate.
    init(offsetMs: Double? = nil, uncertaintyMs: Double = 5_000) {
        // Pre-sync fallback: wall clock as a rough proxy for server time.
        self._offsetMs = offsetMs ?? (Date().timeIntervalSince1970 * 1_000.0 - MonotonicClock.nowMs())
        self._uncertaintyMs = uncertaintyMs
        self._isSynchronized = false
    }

    /// Current session time in milliseconds (server epoch ms).
    func now() -> Double {
        lock.lock()
        defer { lock.unlock() }
        return MonotonicClock.nowMs() + _offsetMs
    }

    /// serverTimeMs − monotonicMs, as last measured.
    var offsetMs: Double {
        lock.lock()
        defer { lock.unlock() }
        return _offsetMs
    }

    /// Estimated ± error of the current offset, in milliseconds.
    var uncertaintyMs: Double {
        lock.lock()
        defer { lock.unlock() }
        return _uncertaintyMs
    }

    /// False until the first successful `/v1/time` sync has been applied.
    var isSynchronized: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isSynchronized
    }

    /// Applies a freshly measured offset. Called by `ClockSyncService`.
    func apply(offsetMs: Double, uncertaintyMs: Double) {
        lock.lock()
        defer { lock.unlock() }
        _offsetMs = offsetMs
        _uncertaintyMs = uncertaintyMs
        _isSynchronized = true
    }
}
