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

            VStack(spacing: 14) {
                topBar(timer, onColor: onColor)
                Spacer()

                if timer.inLeadIn(now: now) {
                    // Pre-start: "Get ready" + 3,2,1.
                    Text("Get ready").font(.title2.bold()).foregroundStyle(onColor)
                    Text("\(Int(timer.leadInRemaining(now: now).rounded(.up)))")
                        .font(.system(size: landscape ? 220 : 110, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(onColor)
                } else if landscape {
                    // Landscape: big time on the left, Total/stats on the right.
                    HStack(alignment: .center, spacing: 20) {
                        VStack(spacing: 10) {
                            phaseHeader(timer, now: now, tint: tint, onColor: onColor)
                            heroTime(intervalRemaining, onColor: onColor, big: true)
                        }
                        Spacer()
                        statsColumn(timer, totalRemaining: totalRemaining, pos: pos,
                                    showInterval: phase == nil, onColor: onColor)
                    }
                    .frame(maxWidth: .infinity)
                } else {
                    phaseHeader(timer, now: now, tint: tint, onColor: onColor)
                    heroTime(intervalRemaining, onColor: onColor, big: false)
                    statsRow(timer, totalRemaining: totalRemaining, pos: pos,
                             showInterval: phase == nil, onColor: onColor)
                }

                Spacer()
                controls(timer, onColor: onColor)
            }
            .padding()
        }
    }

    private func topBar(_ timer: RunningTimerState, onColor: Color) -> some View {
        HStack {
            Text(timer.preset.displayName).font(.title3.bold())
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
            VStack(spacing: 10) {
                Text("Round \(phase.round) of \(phase.rounds)").font(.headline)
                HStack(spacing: 8) {
                    phaseCapsule("Work", active: phase.isWork, tint: tint, onColor: onColor)
                    phaseCapsule("Rest", active: !phase.isWork, tint: tint, onColor: onColor)
                }
            }
            .foregroundStyle(onColor)
        } else if let label = timer.currentIntervalLabel(now: now) {
            Text(label).font(.title2.bold()).foregroundStyle(onColor)
        }
    }

    /// The big interval countdown. `big` (landscape) makes it much larger.
    private func heroTime(_ remaining: TimeInterval, onColor: Color, big: Bool) -> some View {
        Text(formatClock(remaining))
            .font(.system(size: big ? 240 : 96, weight: .bold, design: .rounded))
            .monospacedDigit().minimumScaleFactor(0.4).lineLimit(1)
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

    private func controls(_ timer: RunningTimerState, onColor: Color) -> some View {
        HStack(spacing: 20) {
            roundButton("backward.end.fill", onColor) { engine.skipToPreviousInterval(id: timer.id) }
            if timer.isRunning {
                roundButton("pause.fill", onColor) { engine.pause(id: timer.id) }
            } else {
                roundButton("play.fill", onColor) { engine.resume(id: timer.id) }
            }
            roundButton("forward.end.fill", onColor) { engine.skipToNextInterval(id: timer.id) }
            roundButton("stop.fill", onColor) { engine.stop(id: timer.id) }
        }
    }

    private func roundButton(_ system: String, _ onColor: Color,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.title2)
                .foregroundStyle(onColor)
                .frame(width: 60, height: 60)
                .background(.ultraThinMaterial, in: Circle())
        }
    }
}
