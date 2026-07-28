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
    private var heartbeatTimer: Timer?
    private var heartbeatCount = 0
    private var clickCount = 0
    private var keyCount = 0

    private var hoverTimer: Timer?

    /// The title of the very window being looked at now reports, live, whether
    /// the system's pointer position is inside the system's window frame:
    ///
    ///   IN  m(730,540) c2 k1     pointer inside the frame; clicks should land
    ///   OUT m(1571,411) c0 k0    pointer OUTSIDE the frame macOS believes in
    ///
    /// Every recorded click so far has landed just outside the logical frame
    /// while the user was visually on the window — so either the window is
    /// drawn away from its logical frame, or the pointer is reported away from
    /// its visual position (a pointer-driver issue). Holding the pointer over
    /// the window's centre and reading the title separates the two.
    private func updateTitleCounter() {
        guard let window = NSApp.windows.first else { return }
        let mouse = NSEvent.mouseLocation
        let inside = NSPointInRect(mouse, window.frame)
        window.title = "\(inside ? "IN" : "OUT") m(\(Int(mouse.x)),\(Int(mouse.y))) c\(clickCount) k\(keyCount)"
    }

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
        // The pid makes two concurrently running instances — one drawn on
        // screen, one not — instantly visible as interleaved prefixes.
        try? diagHandle?.write(contentsOf: Data("\(Date()) [\(ProcessInfo.processInfo.processIdentifier)] \(line)\n".utf8))
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
            self?.clickCount += 1
            self?.updateTitleCounter()
            self?.diagLine("mouseDown at \(event.locationInWindow) window='\(title)' [\(cls)] hit=\(hit) keyWindow='\(key)' mainWindow='\(main)'")
            return event
        } as Any)
        inputProbe.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let title = event.window?.title ?? "<no window>"
            let key = NSApp.keyWindow?.title ?? "<nil>"
            self?.keyCount += 1
            self?.updateTitleCounter()
            self?.diagLine("keyDown code=\(event.keyCode) mods=\(event.modifierFlags.rawValue) window='\(title)' keyWindow='\(key)'")
            return event
        } as Any)
        // Fires ONLY for events delivered to OTHER applications. If a click on
        // our own window shows up here instead of in the local monitor above,
        // some other app's window — visible or not — is sitting over ours and
        // taking the event; the frontmost name says whose.
        inputProbe.append(NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            let front = NSWorkspace.shared.frontmostApplication
            let location = NSEvent.mouseLocation
            // The verdict flag: a click INSIDE our own window's screen rect
            // that was delivered to another application is proof positive that
            // an invisible window sits on top of ours.
            let inOurWindow = NSApp.windows.first.map { NSPointInRect(location, $0.frame) } ?? false
            self?.diagLine("GLOBAL mouseDown at \(location) inOurWindow=\(inOurWindow) delivered to '\(front?.localizedName ?? "?")' (pid \(front?.processIdentifier ?? -1))\(inOurWindow ? "  <-- ANOTHER APP IS COVERING OUR WINDOW" : "")")
        } as Any)
        diagLine("input probe installed; policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) windows=\(NSApp.windows.count)")
        for (index, screen) in NSScreen.screens.enumerated() {
            diagLine("screen[\(index)] frame=\(screen.frame) visible=\(screen.visibleFrame)")
        }

        // EXPERIMENT: after 2 s, move the window to the primary display's
        // centre. The autosaved frame (2998, -42) straddles the second
        // display's edge; if clicks work at the primary's centre but not
        // there, the fault is window placement — a Space/display boundary —
        // and not event routing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, let window = NSApp.windows.first else { return }
            self.diagLine("EXPERIMENT: window was \(window.frame) onActiveSpace=\(window.isOnActiveSpace)")
            if let primary = NSScreen.screens.first {
                let f = window.frame
                window.setFrameOrigin(NSPoint(x: primary.visibleFrame.midX - f.width / 2,
                                              y: primary.visibleFrame.midY - f.height / 2))
                window.makeKeyAndOrderFront(nil)
                self.diagLine("EXPERIMENT: window moved to \(window.frame) onActiveSpace=\(window.isOnActiveSpace)")
            }
        }

        // The launch inventory is a single instant — occlusion and activation
        // both settle asynchronously, so sample them for 30 seconds. If the
        // window never reports onscreen=true, the window being clicked on the
        // monitor is not this window. If active never goes true, the app never
        // completes activation, which kills the menu bar and key equivalents.
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.heartbeatCount += 1
            let front = NSWorkspace.shared.frontmostApplication
            self.diagLine("heartbeat[\(self.heartbeatCount)] active=\(NSApp.isActive) frontmost='\(front?.localizedName ?? "?")' (pid \(front?.processIdentifier ?? -1))")
            // Cooperative activation has proven flaky across identical
            // launches (run 2 activated instantly, run 3 never did). If we are
            // still inactive by the third beat, force it the pre-macOS-14 way
            // and log the outcome — diagnostic and workaround-proof at once.
            if self.heartbeatCount == 3, !NSApp.isActive {
                NSApp.activate(ignoringOtherApps: true)
                self.diagLine("forced activate(ignoringOtherApps:) — active now \(NSApp.isActive)")
            }
            for window in NSApp.windows {
                self.diagLine("  hb '\(window.title)' key=\(window.isKeyWindow) main=\(window.isMainWindow) onscreen=\(window.occlusionState.contains(.visible)) onActiveSpace=\(window.isOnActiveSpace) frame=\(window.frame)")
            }
            if self.heartbeatCount >= 10 {
                self.heartbeatTimer?.invalidate()
                self.heartbeatTimer = nil
                self.diagLine("heartbeat done")
            }
        }
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

        // Live pointer-vs-frame readout in the title, 10 Hz for ten minutes.
        hoverTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.updateTitleCounter()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) { [weak self] in
            self?.hoverTimer?.invalidate()
            self?.hoverTimer = nil
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        diagLine("applicationDidBecomeActive")
    }

    func applicationDidResignActive(_ notification: Notification) {
        diagLine("applicationDidResignActive")
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
