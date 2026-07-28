import AppKit
import os

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Set by StreamitApp once the SwiftUI scene comes up.
    weak var studio: StudioController?

    /// Keeps the process out of App Nap while live — the render clock, the
    /// offscreen web views, and the audio engines must not be throttled when
    /// the window is occluded (the virtual camera keeps feeding Zoom).
    private var activityToken: NSObjectProtocol?

    // MARK: - Input diagnostics (TEMPORARY — remove once first-run input works)
    //
    // Bring-up instrument for "the app is frontmost and rendering but clicks
    // do nothing". These monitors are pure observers: they log where each
    // mouse-down and key-down actually lands and return the event unchanged.
    // One click then tells us which layer is broken:
    //   - no line at all        → the event never reached the process
    //   - window is nil/other   → an invisible window of ours is eating it
    //   - hit=(none)            → AppKit hit-testing finds no view
    //   - hit=SomeView          → AppKit is fine; the fault is above, in SwiftUI
    private var inputProbe: [Any] = []
    private let inputLog = Logger(subsystem: "com.aviashkenazi.streamit", category: "input-diag")
    private var diagHandle: FileHandle?

    /// Every probe line goes to the unified log AND to a plain file, because
    /// `log stream` needs an admin account and the bring-up machine's user
    /// isn't one. `cat /tmp/streamit-input-diag.log` needs nothing.
    private func diagLine(_ line: String) {
        inputLog.notice("\(line, privacy: .public)")
        if diagHandle == nil {
            let path = "/tmp/streamit-input-diag.log"
            FileManager.default.createFile(atPath: path, contents: nil)
            diagHandle = FileHandle(forWritingAtPath: path)
            _ = try? diagHandle?.seekToEnd()
        }
        try? diagHandle?.write(contentsOf: Data("\(Date()) \(line)\n".utf8))
    }

    private func installInputProbe() {
        inputProbe.append(NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            let window = event.window
            let title = window?.title ?? "<no window>"
            let cls = window.map { String(describing: type(of: $0)) } ?? "-"
            var hit = "(no window)"
            // hitTest(_:) wants the point in the receiver's SUPERVIEW's
            // coordinates, so test from the window's frame view (the content
            // view's superview), whose own coordinates are window coordinates.
            if let window, let frameView = window.contentView?.superview {
                hit = frameView.hitTest(event.locationInWindow).map { String(describing: type(of: $0)) } ?? "(none)"
            }
            let key = NSApp.keyWindow?.title ?? "<nil>"
            let main = NSApp.mainWindow?.title ?? "<nil>"
            self?.diagLine("mouseDown at \(event.locationInWindow) window='\(title)' [\(cls)] hit=\(hit) keyWindow='\(key)' mainWindow='\(main)'")
            return event
        } as Any)
        inputProbe.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let title = event.window?.title ?? "<no window>"
            let key = NSApp.keyWindow?.title ?? "<nil>"
            self?.diagLine("keyDown code=\(event.keyCode) mods=\(event.modifierFlags.rawValue) window='\(title)' keyWindow='\(key)'")
            return event
        } as Any)
        diagLine("input probe installed; policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) windows=\(NSApp.windows.count)")
        // Window inventory: catches an invisible window sitting over the UI.
        for (index, window) in NSApp.windows.enumerated() {
            diagLine("window[\(index)] '\(window.title)' [\(String(describing: type(of: window)))] level=\(window.level.rawValue) visible=\(window.isVisible) onscreen=\(window.occlusionState.contains(.visible)) frame=\(window.frame) ignoresMouse=\(window.ignoresMouseEvents)")
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Running the binary directly — which is what a bring-up loop does, to
        // keep the logs on the terminal — leaves the process unregistered with
        // LaunchServices. AppKit then treats it as a background app: the window
        // draws and the render loop runs, but it never becomes key, so every
        // click is silently discarded. Asserting the policy makes a terminal
        // launch behave like a double-click, and changes nothing for one.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()

        activityToken = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "Live video pipeline must keep producing frames"
        )

        installInputProbe()
    }

    func applicationWillTerminate(_ notification: Notification) {
        studio?.shutdown()
        if let token = activityToken {
            ProcessInfo.processInfo.endActivity(token)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Closing the window while live would silently kill the virtual
        // camera feed mid-meeting; keep running until the user quits.
        false
    }
}
