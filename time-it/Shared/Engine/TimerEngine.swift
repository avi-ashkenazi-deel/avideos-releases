import Foundation
import Combine

/// Drives every running timer at once from a single tick. The heavy lifting of
/// *what* to announce lives in pure, testable helpers (`MilestoneScheduler`);
/// this class owns the clock, the published state, and the side effects.
@MainActor
final class TimerEngine: ObservableObject {

    /// All timers currently counting (running or paused). Order = start order.
    @Published private(set) var running: [RunningTimerState] = []

    /// True whenever at least one timer is actively running (not paused). The
    /// watch app observes this to start/stop its workout keep-alive session.
    @Published private(set) var hasActiveTimer: Bool = false

    /// Master output channel applied to every announcement. The host keeps this
    /// in sync with `AppSettings.outputMode`.
    var outputMode: OutputMode = .both

    private weak var announcer: Announcer?
    private var ticker: Timer?

    /// Fired when the running set transitions empty <-> non-empty, so hosts can
    /// manage background/keep-alive resources.
    var onRunningSetChanged: ((_ isEmpty: Bool) -> Void)?

    init(announcer: Announcer? = nil) {
        self.announcer = announcer
    }

    func setAnnouncer(_ announcer: Announcer) { self.announcer = announcer }

    // MARK: - Controls

    func start(_ preset: TimerPreset, now: Date = Date()) {
        let state = RunningTimerState(preset: preset, now: now)
        running.append(state)
        if outputMode.speaksAnnouncements {
            announcer?.speak("Starting \(preset.name)")
        } else {
            announcer?.haptic(.success)
        }
        refreshActivity()
        startTickerIfNeeded()
    }

    func pause(id: UUID, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }), running[i].isRunning else { return }
        running[i].bankedElapsed = running[i].elapsed(now: now)
        running[i].isRunning = false
        refreshActivity()
    }

    func resume(id: UUID, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }), !running[i].isRunning else { return }
        running[i].startDate = now
        running[i].isRunning = true
        refreshActivity()
        startTickerIfNeeded()
    }

    /// Add/subtract time on the fly (e.g. "+30s"). Negative values shorten.
    func adjust(id: UUID, by delta: TimeInterval, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }) else { return }
        // Shift banked elapsed in the opposite direction: adding time means less
        // has elapsed. Re-baseline the live portion to keep wall-clock accuracy.
        running[i].bankedElapsed = max(0, running[i].elapsed(now: now) - delta)
        running[i].startDate = now
        // A backwards jump can "un-fire" milestones; recompute the fired set so
        // they can announce again if we crossed back before them.
        reconcileFired(&running[i], now: now)
    }

    func stop(id: UUID) {
        running.removeAll { $0.id == id }
        refreshActivity()
        stopTickerIfIdle()
    }

    func stopAll() {
        running.removeAll()
        refreshActivity()
        stopTickerIfIdle()
    }

    // MARK: - Tick loop

    private func startTickerIfNeeded() {
        guard ticker == nil, !running.isEmpty else { return }
        // 0.1s is fine enough to land each integer second for the spoken
        // countdown while staying cheap (one shared timer for all runs).
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopTickerIfIdle() {
        if running.isEmpty {
            ticker?.invalidate()
            ticker = nil
        }
    }

    private func tick(now: Date = Date()) {
        guard !running.isEmpty else { stopTickerIfIdle(); return }
        var completed: [UUID] = []

        for i in running.indices {
            guard running[i].isRunning else { continue }
            processMilestones(&running[i], now: now)
            processCountdown(&running[i], now: now)

            if running[i].isComplete(now: now) {
                if running[i].hasNextRepeat {
                    advanceRepeat(&running[i], now: now)
                } else {
                    announceCompletion(name: running[i].preset.name)
                    completed.append(running[i].id)
                }
            }
        }

        if !completed.isEmpty {
            running.removeAll { completed.contains($0.id) }
            refreshActivity()
        }
        // Trigger a publish even when only derived values changed (progress).
        objectWillChange.send()
        stopTickerIfIdle()
    }

    // MARK: - Milestone / countdown side effects

    private func processMilestones(_ s: inout RunningTimerState, now: Date) {
        let elapsed = s.elapsed(now: now)
        let due = MilestoneScheduler.dueMilestones(
            in: s.preset, elapsed: elapsed, alreadyFired: s.firedMilestoneIDs
        )
        for m in due {
            // The OutputMode decides the channel(s); the milestone supplies the
            // words and the buzz pattern.
            let ch = outputMode.channels(forMilestoneAlert: m.alert)
            if ch.voice { announcer?.speak(m.spokenText(forDuration: s.preset.duration)) }
            if ch.haptic { announcer?.haptic(m.haptic) }
            s.firedMilestoneIDs.insert(m.id)
        }
    }

    private func processCountdown(_ s: inout RunningTimerState, now: Date) {
        guard let cd = s.preset.finalCountdown else { return }
        let remaining = s.remaining(now: now)
        guard let second = MilestoneScheduler.countdownSecond(
            remaining: remaining, window: cd.lastSeconds, lastSpoken: s.lastCountdownSecondSpoken
        ) else { return }
        let ch = outputMode.countdownChannels(hapticEnabled: cd.haptic)
        if ch.speak { announcer?.speak("\(second)") }
        if ch.buzz { announcer?.haptic(.notification) }
        s.lastCountdownSecondSpoken = second
    }

    /// Announce a fully-completed timer: spoken "complete" (unless silent) plus
    /// the emphatic "time's up" buzz (unless voice-only).
    private func announceCompletion(name: String) {
        let ch = outputMode.channels(forMilestoneAlert: .voiceAndHaptic)
        if ch.voice { announcer?.speak("\(name) complete") }
        if ch.haptic { announcer?.haptic(.timeUp) }
    }

    /// Begin the next back-to-back repeat, resetting per-run firing state.
    private func advanceRepeat(_ s: inout RunningTimerState, now: Date) {
        // Short between-repeats cue: buzz unless we're in pure voice mode.
        if outputMode != .voiceOnly { announcer?.haptic(.success) }
        if outputMode == .voiceOnly { announcer?.speak("Next") }
        s.currentRepeat += 1
        s.startDate = now
        s.bankedElapsed = 0
        s.firedMilestoneIDs = []
        s.lastCountdownSecondSpoken = nil
    }

    /// After a backwards time adjustment, drop fired flags for milestones that
    /// now lie in the future again so they can re-announce.
    private func reconcileFired(_ s: inout RunningTimerState, now: Date) {
        let elapsed = s.elapsed(now: now)
        s.firedMilestoneIDs = s.firedMilestoneIDs.filter { id in
            guard let m = s.preset.milestones.first(where: { $0.id == id }) else { return false }
            return m.trigger.fireTime(forDuration: s.preset.duration) <= elapsed
        }
        if let cd = s.preset.finalCountdown {
            let remaining = s.remaining(now: now)
            if remaining > Double(cd.lastSeconds) { s.lastCountdownSecondSpoken = nil }
        }
    }

    private func refreshActivity() {
        let active = running.contains { $0.isRunning }
        if active != hasActiveTimer { hasActiveTimer = active }
        onRunningSetChanged?(running.isEmpty)
    }
}
