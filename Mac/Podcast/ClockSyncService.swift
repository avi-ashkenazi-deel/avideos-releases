import Foundation
import os

/// One completed clock-sync round (the best of the burst's samples).
struct ClockSyncResult: Sendable, Equatable {
    /// serverTimeMs − monotonicMs of the min-RTT sample.
    var offsetMs: Double
    /// Round-trip time of the sample that was kept.
    var rttMs: Double
    /// ± error estimate (half the kept RTT, floored at 1 ms).
    var uncertaintyMs: Double
    /// How many of the burst's requests succeeded.
    var sampleCount: Int
}

/// NTP-style synchronizer for `SessionClock`.
///
/// Each sync round issues `samplesPerBurst` sequential `GET /v1/time`
/// requests. For every sample:
///
///     rtt      = tReceive − tSend                (monotonic ms)
///     offset   = serverTimeMs − (tSend + rtt/2)
///
/// The sample with the minimum RTT wins the round (least queuing noise) and
/// its `rtt/2` becomes the uncertainty. The service resamples every
/// `resampleInterval` so wake-from-sleep and long-session drift are corrected.
final class ClockSyncService: @unchecked Sendable {
    /// Returns the worker's `serverTimeMs` (one `GET /v1/time`).
    typealias ServerTimeFetcher = @Sendable () async throws -> Double

    enum SyncError: LocalizedError {
        case noSamples(lastError: String?)

        var errorDescription: String? {
            switch self {
            case .noSamples(let lastError):
                var text = "Could not reach the session time server."
                if let lastError { text += " (\(lastError))" }
                return text
            }
        }
    }

    let clock: SessionClock

    private let fetchServerTimeMs: ServerTimeFetcher
    private let samplesPerBurst: Int
    private let interSampleDelay: Duration
    private let resampleInterval: Duration
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "ClockSync")

    private let stateLock = NSLock()
    private var resampleTask: Task<Void, Never>?
    private var _lastResult: ClockSyncResult?

    init(
        clock: SessionClock,
        samplesPerBurst: Int = 5,
        interSampleDelay: Duration = .milliseconds(100),
        resampleInterval: Duration = .seconds(300),
        fetchServerTimeMs: @escaping ServerTimeFetcher
    ) {
        self.clock = clock
        self.samplesPerBurst = max(1, samplesPerBurst)
        self.interSampleDelay = interSampleDelay
        self.resampleInterval = resampleInterval
        self.fetchServerTimeMs = fetchServerTimeMs
    }

    deinit {
        resampleTask?.cancel()
    }

    /// Result of the most recent successful sync round, if any.
    var lastResult: ClockSyncResult? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _lastResult
    }

    /// Runs one sync round immediately and applies it to the clock.
    @discardableResult
    func syncOnce() async throws -> ClockSyncResult {
        var best: (offsetMs: Double, rttMs: Double)?
        var successes = 0
        var lastErrorText: String?

        for sampleIndex in 0..<samplesPerBurst {
            if sampleIndex > 0 {
                try? await Task.sleep(for: interSampleDelay)
            }
            let tSend = MonotonicClock.nowMs()
            do {
                let serverTimeMs = try await fetchServerTimeMs()
                let tReceive = MonotonicClock.nowMs()
                let rtt = max(0, tReceive - tSend)
                let offset = serverTimeMs - (tSend + rtt / 2)
                successes += 1
                if best == nil || rtt < best!.rttMs {
                    best = (offset, rtt)
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastErrorText = error.localizedDescription
                log.warning("time sample \(sampleIndex + 1)/\(self.samplesPerBurst) failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        guard let best else {
            throw SyncError.noSamples(lastError: lastErrorText)
        }

        let result = ClockSyncResult(
            offsetMs: best.offsetMs,
            rttMs: best.rttMs,
            uncertaintyMs: max(1, best.rttMs / 2),
            sampleCount: successes
        )
        clock.apply(offsetMs: result.offsetMs, uncertaintyMs: result.uncertaintyMs)
        stateLock.lock()
        _lastResult = result
        stateLock.unlock()

        log.info("clock synced: offset=\(result.offsetMs, format: .fixed(precision: 1))ms rtt=\(result.rttMs, format: .fixed(precision: 1))ms ±\(result.uncertaintyMs, format: .fixed(precision: 1))ms (\(result.sampleCount) samples)")
        return result
    }

    /// Starts the background resample loop (initial sync happens immediately).
    /// Idempotent: calling `start()` while running does nothing.
    func start() {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard resampleTask == nil else { return }
        resampleTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    try await self.syncOnce()
                } catch is CancellationError {
                    return
                } catch {
                    self.log.error("clock sync round failed: \(error.localizedDescription, privacy: .public)")
                }
                do {
                    try await Task.sleep(for: self.resampleInterval)
                } catch {
                    return
                }
            }
        }
    }

    /// Stops the background resample loop. The clock keeps its last offset.
    func stop() {
        stateLock.lock()
        defer { stateLock.unlock() }
        resampleTask?.cancel()
        resampleTask = nil
    }
}
