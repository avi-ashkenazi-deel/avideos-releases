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
        let remaining = timer.remaining(now: now)
        let fraction = timer.preset.duration > 0
            ? max(0, min(1, remaining / timer.preset.duration)) : 0

        return GeometryReader { geo in
            ZStack(alignment: .bottom) {
                tint.opacity(0.12).ignoresSafeArea()

                // The draining fill: full at the start, empties as time passes.
                Rectangle()
                    .fill(tint)
                    .frame(height: geo.size.height * fraction)
                    .ignoresSafeArea(edges: .bottom)
                    .animation(.linear(duration: 0.12), value: fraction)

                VStack(spacing: 12) {
                    topBar(timer)
                    OutputModePicker()
                    Spacer()
                    Text(formatClock(remaining))
                        .font(.system(size: min(geo.size.width * 0.30, 160),
                                      weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.5)
                        .foregroundStyle(.white)
                        .shadow(radius: 8)
                    if let next = timer.nextCueLabel(now: now) {
                        Text("Next: \(next)")
                            .font(.headline).foregroundStyle(.white.opacity(0.9))
                            .shadow(radius: 4)
                    }
                    if timer.preset.repeatCount > 1 {
                        Text("Set \(timer.currentRepeat) of \(timer.preset.repeatCount)")
                            .font(.subheadline).foregroundStyle(.white.opacity(0.8))
                    }
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
            roundButton("gobackward.10") { engine.adjust(id: timer.id, by: -10) }
            if timer.isRunning {
                roundButton("pause.fill") { engine.pause(id: timer.id) }
            } else {
                roundButton("play.fill") { engine.resume(id: timer.id) }
            }
            roundButton("goforward.30") { engine.adjust(id: timer.id, by: 30) }
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
