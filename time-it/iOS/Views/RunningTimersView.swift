import SwiftUI

/// Full-screen running view for the single active timer. The whole screen is the
/// timer's color: a brighter fill drains downward over a darker base as the
/// current interval counts down. The big number is the interval; total time,
/// the set/interval position and (for work/rest) the Work/Rest phase sit around
/// it. Re-renders on the engine's ~10×/sec published ticks.
struct RunningTimerScreen: View {
    @EnvironmentObject private var engine: TimerEngine
    @Environment(\.verticalSizeClass) private var vSize
    @State private var editing = false

    /// Landscape on iPhone reports a compact height — make the countdown bigger.
    private var landscape: Bool { vSize == .compact }

    var body: some View {
        if let timer = engine.running.first {
            content(for: timer)
                .sheet(isPresented: $editing) {
                    PresetEditorView(preset: timer.preset, title: "Edit running") { updated in
                        engine.editRunning(id: timer.id, to: updated)
                    }
                }
        } else {
            Color.clear
        }
    }

    private func content(for timer: RunningTimerState) -> some View {
        let now = Date()                              // fresh each publish
        let tint = Color(hex: timer.preset.colorHex)
        let onColor = contrastingTextColor(forHex: timer.preset.colorHex)
        let intervalRemaining = timer.intervalRemaining(now: now)
        let totalRemaining = timer.remaining(now: now)
        let fraction = timer.intervalFraction(now: now)
        let phase = timer.workRestPhase(now: now)
        let pos = timer.intervalPosition(now: now)

        return ZStack(alignment: .bottom) {
            // Whole-screen color: darker base, brighter fill draining from bottom.
            GeometryReader { geo in
                ZStack(alignment: .bottom) {
                    tint.brightness(-0.28)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    Rectangle()
                        .fill(tint)
                        .frame(height: geo.size.height * fraction)
                }
            }
            .ignoresSafeArea()
            .animation(.linear(duration: 0.12), value: fraction)

            if timer.inLeadIn(now: now) {
                leadInForeground(timer, now: now, onColor: onColor)
            } else if landscape {
                landscapeForeground(timer, now: now, tint: tint, onColor: onColor,
                                    intervalRemaining: intervalRemaining,
                                    totalRemaining: totalRemaining, pos: pos, phase: phase)
            } else {
                portraitForeground(timer, now: now, tint: tint, onColor: onColor,
                                   intervalRemaining: intervalRemaining,
                                   totalRemaining: totalRemaining, pos: pos, phase: phase)
            }
        }
    }

    // MARK: Foreground layouts

    private func portraitForeground(_ timer: RunningTimerState, now: Date, tint: Color, onColor: Color,
                                    intervalRemaining: TimeInterval, totalRemaining: TimeInterval,
                                    pos: (index: Int, total: Int),
                                    phase: (round: Int, isWork: Bool, rounds: Int)?) -> some View {
        VStack(spacing: 14) {
            topBar(timer, now: now, onColor: onColor)
            Spacer()
            phaseHeader(timer, now: now, tint: tint, onColor: onColor)
            heroTime(intervalRemaining, onColor: onColor, big: false)
            statsRow(timer, totalRemaining: totalRemaining, pos: pos,
                     showInterval: phase == nil, onColor: onColor)
            Spacer()
            controls(timer, onColor: onColor)
        }
        .padding()
    }

    /// Landscape: big time on the left half; Work/Rest top-right, Total/Sets
    /// mid-right, controls bottom-right.
    private func landscapeForeground(_ timer: RunningTimerState, now: Date, tint: Color, onColor: Color,
                                     intervalRemaining: TimeInterval, totalRemaining: TimeInterval,
                                     pos: (index: Int, total: Int),
                                     phase: (round: Int, isWork: Bool, rounds: Int)?) -> some View {
        VStack(spacing: 6) {
            topBar(timer, now: now, onColor: onColor)
            HStack(alignment: .top, spacing: 16) {
                VStack {
                    Spacer()
                    heroTime(intervalRemaining, onColor: onColor, big: true)
                    Spacer()
                }
                .frame(maxWidth: .infinity)

                VStack(alignment: .trailing, spacing: 0) {
                    phaseHeader(timer, now: now, tint: tint, onColor: onColor)
                    Spacer()
                    statsColumn(timer, totalRemaining: totalRemaining, pos: pos,
                                showInterval: phase == nil, onColor: onColor)
                    Spacer()
                    controls(timer, onColor: onColor, size: 42)
                }
                .frame(width: 230)
            }
        }
        .padding()
    }

    private func leadInForeground(_ timer: RunningTimerState, now: Date, onColor: Color) -> some View {
        VStack(spacing: 14) {
            topBar(timer, now: now, onColor: onColor)
            Spacer()
            Text("Get ready").font(.title2.bold()).foregroundStyle(onColor)
            Text("\(Int(timer.leadInRemaining(now: now).rounded(.up)))")
                .font(.system(size: landscape ? 220 : 110, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(onColor)
            Spacer()
            controls(timer, onColor: onColor)
        }
        .padding()
    }

    private func topBar(_ timer: RunningTimerState, now: Date, onColor: Color) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(timer.preset.displayName).font(.title3.bold())
                if let phase = timer.workRestPhase(now: now) {
                    Text("Round \(phase.round) of \(phase.rounds)")
                        .font(.subheadline).opacity(0.8)
                }
            }
            Spacer()
            Button { editing = true } label: {
                Image(systemName: "slider.horizontal.3").font(.title3)
            }
        }
        .foregroundStyle(onColor)
    }

    @ViewBuilder private func phaseHeader(_ timer: RunningTimerState, now: Date,
                                          tint: Color, onColor: Color) -> some View {
        if let phase = timer.workRestPhase(now: now) {
            // Round X of Y now lives under the name; here just the Work/Rest pills.
            HStack(spacing: 8) {
                phaseCapsule("Work", active: phase.isWork, tint: tint, onColor: onColor)
                phaseCapsule("Rest", active: !phase.isWork, tint: tint, onColor: onColor)
            }
            .foregroundStyle(onColor)
        } else if let label = timer.currentIntervalLabel(now: now) {
            Text(label).font(.title2.bold()).foregroundStyle(onColor)
        }
    }

    /// The big interval countdown. `big` (landscape) makes it much larger; it
    /// scales down only as far as needed to fit on one line.
    private func heroTime(_ remaining: TimeInterval, onColor: Color, big: Bool) -> some View {
        Text(formatClock(remaining))
            .font(.system(size: big ? 340 : 110, weight: .bold, design: .rounded))
            .monospacedDigit().minimumScaleFactor(0.3).lineLimit(1)
            .foregroundStyle(onColor)
    }

    /// Total + Sets/Cycle stacked for the right side in landscape.
    private func statsColumn(_ timer: RunningTimerState, totalRemaining: TimeInterval,
                             pos: (index: Int, total: Int), showInterval: Bool,
                             onColor: Color) -> some View {
        VStack(alignment: .trailing, spacing: 12) {
            stat("TOTAL", formatClock(totalRemaining), onColor)
            if timer.preset.repeatCount > 1 {
                stat("SETS", "\(timer.currentRepeat)/\(timer.preset.repeatCount)", onColor)
            }
            if showInterval && pos.total > 1 {
                stat("INTERVAL", "\(pos.index)/\(pos.total)", onColor)
            }
        }
    }

    private func phaseCapsule(_ label: String, active: Bool, tint: Color, onColor: Color) -> some View {
        Text(label)
            .font(.subheadline.bold())
            .padding(.horizontal, 18).padding(.vertical, 7)
            .background(active ? onColor : .clear, in: Capsule())
            .foregroundStyle(active ? tint : onColor)
            .overlay(Capsule().strokeBorder(onColor.opacity(active ? 0 : 0.5), lineWidth: 1.5))
    }

    private func statsRow(_ timer: RunningTimerState, totalRemaining: TimeInterval,
                          pos: (index: Int, total: Int), showInterval: Bool,
                          onColor: Color) -> some View {
        HStack(spacing: 28) {
            if timer.preset.repeatCount > 1 {
                stat("SETS", "\(timer.currentRepeat)/\(timer.preset.repeatCount)", onColor)
            }
            stat("TOTAL", formatClock(totalRemaining), onColor)
            if showInterval && pos.total > 1 {
                stat("INTERVAL", "\(pos.index)/\(pos.total)", onColor)
            }
        }
    }

    private func stat(_ title: String, _ value: String, _ onColor: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
            Text(title).font(.caption2).tracking(1)
        }
        .foregroundStyle(onColor)
    }

    private func controls(_ timer: RunningTimerState, onColor: Color, size: CGFloat = 60) -> some View {
        HStack(spacing: size * 0.33) {
            roundButton("backward.end.fill", onColor, size: size) { engine.skipToPreviousInterval(id: timer.id) }
            if timer.isRunning {
                roundButton("pause.fill", onColor, size: size) { engine.pause(id: timer.id) }
            } else {
                roundButton("play.fill", onColor, size: size) { engine.resume(id: timer.id) }
            }
            roundButton("forward.end.fill", onColor, size: size) { engine.skipToNextInterval(id: timer.id) }
            roundButton("stop.fill", onColor, size: size) { engine.stop(id: timer.id) }
        }
    }

    private func roundButton(_ system: String, _ onColor: Color, size: CGFloat = 60,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: size * 0.34))
                .foregroundStyle(onColor)
                .frame(width: size, height: size)
                .background(.ultraThinMaterial, in: Circle())
        }
    }
}
