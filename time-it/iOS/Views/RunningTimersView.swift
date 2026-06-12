import SwiftUI

/// Live dashboard of every concurrently running timer. Refreshes on the engine's
/// published changes (which tick ~10×/sec while timers run).
struct RunningTimersView: View {
    @EnvironmentObject private var engine: TimerEngine

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                OutputModePicker()
                    .padding(.horizontal)
                    .padding(.top, 8)

                if engine.running.isEmpty {
                    Spacer()
                    ContentUnavailableView(
                        "No timers running",
                        systemImage: "timer",
                        description: Text("Start one from the Timers tab.")
                    )
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(engine.running) { timer in
                                RunningTimerCard(timer: timer)
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Running")
            .toolbar {
                if !engine.running.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Stop all", role: .destructive) { engine.stopAll() }
                    }
                }
            }
        }
    }
}

private struct RunningTimerCard: View {
    @EnvironmentObject private var engine: TimerEngine
    let timer: RunningTimerState
    @State private var editing = false

    var body: some View {
        // Re-read live values each render; the engine publishes on every tick.
        let now = Date()
        let remaining = timer.remaining(now: now)
        let progress = timer.progress(now: now)
        let tint = Color(hex: timer.preset.colorHex)

        VStack(spacing: 12) {
            HStack {
                Text(timer.preset.displayName).font(.headline)
                if timer.preset.repeatCount > 1 {
                    Text("set \(timer.currentRepeat)/\(timer.preset.repeatCount)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if !timer.isRunning {
                    Text("Paused").font(.caption.bold()).foregroundStyle(.orange)
                }
                Button { editing = true } label: { Image(systemName: "slider.horizontal.3") }
                    .buttonStyle(.plain)
            }

            ZStack {
                Circle().stroke(tint.opacity(0.2), lineWidth: 10)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(tint, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(formatClock(remaining))
                    .font(.system(size: 40, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }
            .frame(height: 180)

            if let next = timer.nextCueLabel(now: now) {
                Label("Next: \(next)", systemImage: "bell")
                    .font(.caption).foregroundStyle(.secondary)
            }

            HStack(spacing: 24) {
                ControlButton(system: "gobackward.10") { engine.adjust(id: timer.id, by: -10) }
                if timer.isRunning {
                    ControlButton(system: "pause.fill") { engine.pause(id: timer.id) }
                } else {
                    ControlButton(system: "play.fill") { engine.resume(id: timer.id) }
                }
                ControlButton(system: "goforward.30") { engine.adjust(id: timer.id, by: 30) }
                ControlButton(system: "stop.fill", role: .destructive) { engine.stop(id: timer.id) }
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
        .sheet(isPresented: $editing) {
            // Live edit: seed the editor with the running preset and apply the
            // result to the running timer, preserving elapsed time.
            PresetEditorView(preset: timer.preset, title: "Edit running") { updated in
                engine.editRunning(id: timer.id, to: updated)
            }
        }
    }
}

private struct ControlButton: View {
    let system: String
    var role: ButtonRole? = nil
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            Image(systemName: system).font(.title2)
        }
        .buttonStyle(.bordered)
        .clipShape(Circle())
    }
}
