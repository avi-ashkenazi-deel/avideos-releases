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

    /// Fired on every *discrete* schedule change (start/stop/pause/resume/adjust/
    /// edit/complete) — not on every tick — so the host can refresh Live
    /// Activities and re-schedule background notifications.
    var onTimersChanged: ((_ running: [RunningTimerState]) -> Void)?

    /// Fired when an interval/milestone cue fires, so the host can refresh the
    /// Live Activity's "next" label without rescheduling notifications.
    var onCueFired: ((_ running: [RunningTimerState]) -> Void)?

    init(announcer: Announcer? = nil) {
        self.announcer = announcer
    }

    func setAnnouncer(_ announcer: Announcer) { self.announcer = announcer }

    // MARK: - Controls

    func start(_ preset: TimerPreset, now: Date = Date()) {
        let leadIn = TimeInterval(preset.startCountdown ?? 0)
        let state = RunningTimerState(preset: preset, now: now, leadIn: leadIn)
        running.append(state)
        // With a lead-in, the "3,2,1… Let's go" is the start cue; otherwise
        // announce the start now.
        if leadIn <= 0 {
            if outputMode.speaksAnnouncements {
                announcer?.speak(preset.startAnnouncement)
            } else {
                announcer?.haptic(.success)
            }
        }
        notifyChange()
        startTickerIfNeeded()
    }

    func pause(id: UUID, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }), running[i].isRunning else { return }
        running[i].bankedElapsed = running[i].elapsed(now: now)
        running[i].isRunning = false
        notifyChange()
    }

    func resume(id: UUID, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }), !running[i].isRunning else { return }
        running[i].startDate = now
        running[i].isRunning = true
        notifyChange()
        startTickerIfNeeded()
    }

    /// Add/subtract time on the fly (e.g. "+30s"). Negative values shorten.
    func adjust(id: UUID, by delta: TimeInterval, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }) else { return }
        // Shift banked elapsed in the opposite direction: adding time means less
        // has elapsed. Re-baseline the live portion to keep wall-clock accuracy.
        running[i].bankedElapsed = max(0, running[i].elapsed(now: now) - delta)
        running[i].startDate = now
        // A backwards jump can "un-fire" cues; recompute the fired set so they
        // can announce again if we crossed back before them.
        reconcileFired(&running[i], now: now)
        notifyChange()
    }

    /// Jump to the start of the next interval (skips the rest of the current
    /// one), advancing the overall elapsed time so the total updates too.
    func skipToNextInterval(id: UUID, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }) else { return }
        let e = running[i].elapsed(now: now)
        let bounds = running[i].segmentBoundaries()
        let target = bounds.first { $0 > e + 0.05 } ?? running[i].preset.duration
        setElapsed(&running[i], to: target, now: now)
        notifyChange()
    }

    /// Jump to the previous interval boundary. If we're more than ~1s into the
    /// current interval, restart it; otherwise step back to the previous one.
    func skipToPreviousInterval(id: UUID, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }) else { return }
        let e = running[i].elapsed(now: now)
        let starts = ([0] + running[i].segmentBoundaries()).sorted()
        let curIdx = starts.lastIndex { $0 <= e + 0.0001 } ?? 0
        let target = (e - starts[curIdx] > 1.0) ? starts[curIdx] : starts[max(0, curIdx - 1)]
        setElapsed(&running[i], to: target, now: now)
        notifyChange()
    }

    /// Re-baseline a running timer to a specific elapsed offset, preserving
    /// run/pause state. Cues strictly before the new point are marked fired (so
    /// they don't replay); a cue landing exactly on the new point still fires
    /// (so skipping *to* an interval announces it).
    private func setElapsed(_ s: inout RunningTimerState, to newElapsed: TimeInterval, now: Date) {
        let clamped = max(0, min(newElapsed, s.preset.duration))
        s.bankedElapsed = clamped
        s.startDate = now
        s.firedCueIDs = Set(s.cues.filter { $0.fireTime < clamped - 0.05 }.map(\.id))
        if let cd = s.preset.finalCountdown {
            let remaining = s.preset.duration - clamped
            s.lastCountdownSecondSpoken = remaining > Double(cd.lastSeconds) ? nil : Int(remaining.rounded(.up))
        }
        s.intervalCountdownTarget = nil
        s.lastIntervalCountdownSecond = nil
    }
    /// preserving how much has already elapsed. Cues that now sit in the past are
    /// marked fired so they don't retroactively announce.
    func editRunning(id: UUID, to newPreset: TimerPreset, now: Date = Date()) {
        guard let i = running.firstIndex(where: { $0.id == id }) else { return }
        let elapsed = running[i].elapsed(now: now)
        running[i].preset = newPreset
        // Re-baseline so the elapsed amount is preserved against the new duration.
        running[i].bankedElapsed = min(elapsed, newPreset.duration)
        running[i].startDate = now
        // Any cue already in the past on the new schedule is considered fired.
        running[i].firedCueIDs = Set(
            running[i].cues.filter { $0.fireTime <= elapsed }.map(\.id)
        )
        if let cd = newPreset.finalCountdown {
            let remaining = running[i].remaining(now: now)
            running[i].lastCountdownSecondSpoken = remaining > Double(cd.lastSeconds) ? nil : Int(remaining.rounded(.up))
        }
        notifyChange()
    }

    func stop(id: UUID) {
        running.removeAll { $0.id == id }
        notifyChange()
        stopTickerIfIdle()
    }

    func stopAll() {
        running.removeAll()
        notifyChange()
        stopTickerIfIdle()
    }

    // MARK: - Tick loop

    private func startTickerIfNeeded() {
        guard ticker == nil, !running.isEmpty else { return }
        // 0.1s is fine enough to land each integer second for the spoken
        // countdown while staying cheap (one shared timer for all runs).
        //
        // Deliberately the DEFAULT runloop mode, not .common: menus/pickers hold
        // the runloop in tracking mode while open, and a .common-mode tick keeps
        // publishing at 10Hz underneath them — the re-renders slam every open
        // dropdown shut (all menus "stopped working" whenever a timer ran).
        // Pausing the tick during that brief tracking is harmless: elapsed time
        // is derived from wall-clock dates, so nothing drifts; a due cue fires
        // on the first tick after the menu closes.
        let t = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // A little tolerance lets the OS coalesce wakeups (battery).
        t.tolerance = 0.02
        ticker = t
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

        var scheduleChanged = false
        var cueFired = false

        for i in running.indices {
            guard running[i].isRunning else { continue }
            if processLeadIn(&running[i], now: now) { continue }   // still counting in
            if processCues(&running[i], now: now) { cueFired = true }
            processCountdown(&running[i], now: now)
            processIntervalCountdown(&running[i], now: now)

            if running[i].isComplete(now: now) {
                if running[i].hasNextRepeat {
                    advanceRepeat(&running[i], now: now)
                    scheduleChanged = true
                } else {
                    announceCompletion(name: running[i].preset.displayName)
                    completed.append(running[i].id)
                }
            }
        }

        if !completed.isEmpty {
            running.removeAll { completed.contains($0.id) }
            scheduleChanged = true
        }
        // Trigger a publish even when only derived values changed (progress).
        objectWillChange.send()
        if scheduleChanged { notifyChange() }
        else if cueFired { onCueFired?(running) }
        stopTickerIfIdle()
    }

    /// The "3,2,1… Let's go" lead-in. Returns true while still counting in (so
    /// the main run is skipped this tick).
    private func processLeadIn(_ s: inout RunningTimerState, now: Date) -> Bool {
        guard s.leadIn > 0 else { return false }
        if now < s.startDate {
            let second = Int(s.leadInRemaining(now: now).rounded(.up))
            if second >= 1, second != s.lastLeadInSecondSpoken {
                if outputMode.speaksAnnouncements { announcer?.speak("\(second)") }
                announcer?.haptic(.notification)
                s.lastLeadInSecondSpoken = second
            }
            return true
        }
        // Lead-in just finished → "Let's go" once, then fall through to run.
        if !s.leadInDone {
            s.leadInDone = true
            if outputMode.speaksAnnouncements { announcer?.speak("Let's go") }
            announcer?.haptic(.success)
        }
        return false
    }

    // MARK: - Milestone / countdown side effects

    @discardableResult
    private func processCues(_ s: inout RunningTimerState, now: Date) -> Bool {
        let elapsed = s.elapsed(now: now)
        let due = MilestoneScheduler.dueCues(
            s.cues, elapsed: elapsed, alreadyFired: s.firedCueIDs
        )
        for cue in due {
            // The OutputMode decides the channel(s); the cue supplies the words
            // and the buzz pattern.
            let ch = outputMode.channels(forMilestoneAlert: cue.alert)
            if ch.voice && !cue.spokenText.isEmpty { announcer?.speak(cue.spokenText) }
            if ch.haptic { announcer?.haptic(cue.haptic) }
            s.firedCueIDs.insert(cue.id)
        }
        return !due.isEmpty
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

    /// Count down the last N seconds before each interval boundary (e.g. "5,4,3,
    /// 2,1" into the next interval), if the interval plan has it enabled.
    private func processIntervalCountdown(_ s: inout RunningTimerState, now: Date) {
        guard let plan = s.preset.intervals, plan.countdownEnabled else { return }
        let elapsed = s.elapsed(now: now)
        let bounds = plan.boundaries(forDuration: s.preset.duration)
        guard let next = bounds.first(where: { $0 > elapsed + 0.0001 }) else { return }
        let prev = bounds.last(where: { $0 <= elapsed + 0.0001 }) ?? 0
        // Reset the per-second tracker whenever we start counting to a new boundary.
        if s.intervalCountdownTarget != next {
            s.intervalCountdownTarget = next
            s.lastIntervalCountdownSecond = nil
        }
        // Whole-interval mode counts the entire current segment; otherwise the
        // configured last-N window.
        let window = plan.countsWholeInterval ? Int((next - prev).rounded()) : plan.countdownSeconds
        guard window > 0, let second = MilestoneScheduler.countdownSecond(
            remaining: next - elapsed, window: window,
            lastSpoken: s.lastIntervalCountdownSecond
        ) else { return }
        let ch = outputMode.countdownChannels(hapticEnabled: true)
        if ch.speak { announcer?.speak("\(second)") }
        if ch.buzz { announcer?.haptic(.notification) }
        s.lastIntervalCountdownSecond = second
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
        s.firedCueIDs = []
        s.lastCountdownSecondSpoken = nil
        s.intervalCountdownTarget = nil
        s.lastIntervalCountdownSecond = nil
    }

    /// After a backwards time adjustment, drop fired flags for cues that now lie
    /// in the future again so they can re-announce.
    private func reconcileFired(_ s: inout RunningTimerState, now: Date) {
        let elapsed = s.elapsed(now: now)
        let cuesByID = Dictionary(uniqueKeysWithValues: s.cues.map { ($0.id, $0) })
        s.firedCueIDs = s.firedCueIDs.filter { id in
            guard let cue = cuesByID[id] else { return false }
            return cue.fireTime <= elapsed
        }
        if let cd = s.preset.finalCountdown {
            let remaining = s.remaining(now: now)
            if remaining > Double(cd.lastSeconds) { s.lastCountdownSecondSpoken = nil }
        }
    }

    /// Tracks the last emptiness we told the host about, so keep-alive resources
    /// (audio session, silent player, workout session) only get poked on real
    /// empty <-> non-empty transitions — not on every pause/skip/edit.
    private var lastNotifiedEmpty: Bool?

    /// Lightweight refresh used on every tick: keep `hasActiveTimer` accurate and
    /// notify hosts of empty/non-empty transitions (no per-tick reschedule).
    private func refreshActivity() {
        let active = running.contains { $0.isRunning }
        if active != hasActiveTimer { hasActiveTimer = active }
        let empty = running.isEmpty
        if empty != lastNotifiedEmpty {
            lastNotifiedEmpty = empty
            onRunningSetChanged?(empty)
        }
    }

    /// Full notify on discrete schedule changes: refresh + reschedule hook.
    private func notifyChange() {
        refreshActivity()
        onTimersChanged?(running)
    }
}
