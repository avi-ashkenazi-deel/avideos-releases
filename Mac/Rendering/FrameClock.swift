import Foundation
import CoreMedia

/// The program's frame clock: a `DispatchSourceTimer` on a dedicated
/// high-priority queue, NOT a CVDisplayLink — the program must keep producing
/// frames at exactly the project rate when the window is occluded or
/// minimized (the virtual camera is still feeding Zoom), and display links
/// are deprecated on macOS 14 and tied to display refresh anyway.
///
/// Tick timestamps come from the host-time clock; the same `CMTime` is
/// stamped on the program pixel buffer and reused by the recorder and the
/// virtual camera so all consumers share one timeline.
final class FrameClock {
    /// The render queue — the ONLY place compositing happens.
    let queue = DispatchQueue(label: "com.aviashkenazi.avideos.render", qos: .userInteractive)

    private var timer: DispatchSourceTimer?
    private(set) var fps: Int = 30

    /// Called on `queue` once per frame with the frame's host-clock time.
    var onTick: ((CMTime) -> Void)?

    var isRunning: Bool { timer != nil }

    func start(fps: Int) {
        stop()
        self.fps = max(1, min(fps, 60))
        let t = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
        t.schedule(deadline: .now(),
                   repeating: 1.0 / Double(self.fps),
                   leeway: .milliseconds(1))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            let now = CMClockGetTime(CMClockGetHostTimeClock())
            self.onTick?(now)
        }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    deinit {
        stop()
    }
}
