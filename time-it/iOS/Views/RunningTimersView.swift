import SwiftUI

/// Full-screen running view for the single active timer. A colored fill drains
/// downward as the time runs out, with a huge countdown — readable from across
/// the gym. Takes over the whole screen while a timer runs and returns to the
/// library automatically when it's stopped. Re-renders on the engine's ~10×/sec
/// published ticks.
struct RunningTimerScreen: View {
    @EnvironmentObject private var engine: TimerEngine
    @State private var editing = false

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
        let intervalRemaining = timer.intervalRemaining(now: now)
        let totalRemaining = timer.remaining(now: now)
        // The fill follows the *interval* (the big number), draining and
        // resetting at each boundary.
        let fraction = timer.intervalFraction(now: now)

        return GeometryReader { geo in
            ZStack(alignment: .bottom) {
                tint.opacity(0.12).ignoresSafeArea()

                Rectangle()
                    .fill(tint)
                    .frame(height: geo.size.height * fraction)
                    .ignoresSafeArea(edges: .bottom)
                    .animation(.linear(duration: 0.12), value: fraction)

                VStack(spacing: 12) {
                    topBar(timer)
                    OutputModePicker()
                    Spacer()

                    // Hero: the current interval's countdown.
                    if let label = timer.currentIntervalLabel(now: now) {
                        Text(label)
                            .font(.title2.bold()).foregroundStyle(.white)
                            .shadow(radius: 4)
                    }
                    Text(formatClock(intervalRemaining))
                        .font(.system(size: min(geo.size.width * 0.30, 160),
                                      weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.5)
                        .foregroundStyle(.white)
                        .shadow(radius: 8)

                    // Secondary: total time left, plus what's next.
                    VStack(spacing: 2) {
                        Text("Total \(formatClock(totalRemaining))")
                            .font(.title3).monospacedDigit()
                        if let next = timer.nextCueLabel(now: now) {
                            Text("Next: \(next)").font(.subheadline)
                        }
                        if timer.preset.repeatCount > 1 {
                            Text("Set \(timer.currentRepeat) of \(timer.preset.repeatCount)")
                                .font(.subheadline)
                        }
                    }
                    .foregroundStyle(.white.opacity(0.9))
                    .shadow(radius: 3)

                    Spacer()
                    controls(timer)
                }
                .padding()
            }
        }
    }

    private func topBar(_ timer: RunningTimerState) -> some View {
        HStack {
            Text(timer.preset.displayName)
                .font(.title3.bold()).foregroundStyle(.white).shadow(radius: 4)
            Spacer()
            Button { editing = true } label: {
                Image(systemName: "slider.horizontal.3").font(.title3)
            }
            .foregroundStyle(.white)
        }
    }

    private func controls(_ timer: RunningTimerState) -> some View {
        HStack(spacing: 20) {
            // Previous / next interval — also re-baselines the total.
            roundButton("backward.end.fill") { engine.skipToPreviousInterval(id: timer.id) }
            if timer.isRunning {
                roundButton("pause.fill") { engine.pause(id: timer.id) }
            } else {
                roundButton("play.fill") { engine.resume(id: timer.id) }
            }
            roundButton("forward.end.fill") { engine.skipToNextInterval(id: timer.id) }
            roundButton("stop.fill") { engine.stop(id: timer.id) }
        }
    }

    private func roundButton(_ system: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.title2)
                .foregroundStyle(.white)
                .frame(width: 60, height: 60)
                .background(.ultraThinMaterial, in: Circle())
        }
    }
}
