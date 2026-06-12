import SwiftUI

/// Live view of running timers on the watch. A `TimelineView` drives smooth
/// 1-second redraws of the countdown; milestone feedback is primarily haptic.
struct WatchRunningView: View {
    @EnvironmentObject private var engine: TimerEngine

    var body: some View {
        TabView {
            ForEach(engine.running) { timer in
                WatchTimerPage(timer: timer)
            }
        }
        .tabViewStyle(.verticalPage)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) { engine.stopAll() } label: {
                    Image(systemName: "stop.fill")
                }
            }
        }
    }
}

private struct WatchTimerPage: View {
    @EnvironmentObject private var engine: TimerEngine
    let timer: RunningTimerState

    var body: some View {
        let tint = Color(hex: timer.preset.colorHex)
        VStack(spacing: 8) {
            Text(timer.preset.name).font(.caption).foregroundStyle(.secondary).lineLimit(1)

            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                let now = context.date
                ZStack {
                    Circle().stroke(tint.opacity(0.2), lineWidth: 8)
                    Circle()
                        .trim(from: 0, to: timer.progress(now: now))
                        .stroke(tint, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text(formatClock(timer.remaining(now: now)))
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                }
            }

            HStack(spacing: 16) {
                if timer.isRunning {
                    Button { engine.pause(id: timer.id) } label: { Image(systemName: "pause.fill") }
                } else {
                    Button { engine.resume(id: timer.id) } label: { Image(systemName: "play.fill") }
                }
                Button(role: .destructive) { engine.stop(id: timer.id) } label: {
                    Image(systemName: "stop.fill")
                }
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 4)
    }
}
