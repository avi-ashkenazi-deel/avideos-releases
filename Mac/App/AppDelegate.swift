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

    private func installInputProbe() {
        inputProbe.append(NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [inputLog] event in
            let window = event.window
            let title = window?.title ?? "<no window>"
            let cls = window.map { String(describing: type(of: $0)) } ?? "-"
            var hit = "(no window)"
            if let window, let content = window.contentView {
                let inContent = content.convert(event.locationInWindow, from: nil)
                hit = content.hitTest(inContent).map { String(describing: type(of: $0)) } ?? "(none)"
            }
            let key = NSApp.keyWindow?.title ?? "<nil>"
            let main = NSApp.mainWindow?.title ?? "<nil>"
            inputLog.notice("mouseDown at \(String(describing: event.locationInWindow), privacy: .public) window='\(title, privacy: .public)' [\(cls, privacy: .public)] hit=\(hit, privacy: .public) keyWindow='\(key, privacy: .public)' mainWindow='\(main, privacy: .public)'")
            return event
        } as Any)
        inputProbe.append(NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [inputLog] event in
            let title = event.window?.title ?? "<no window>"
            let key = NSApp.keyWindow?.title ?? "<nil>"
            inputLog.notice("keyDown code=\(event.keyCode) mods=\(event.modifierFlags.rawValue) window='\(title, privacy: .public)' keyWindow='\(key, privacy: .public)'")
            return event
        } as Any)
        inputLog.notice("input probe installed; policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) windows=\(NSApp.windows.count)")
        // Window inventory: catches an invisible window sitting over the UI.
        for (index, window) in NSApp.windows.enumerated() {
            inputLog.notice("window[\(index)] '\(window.title, privacy: .public)' [\(String(describing: type(of: window)), privacy: .public)] level=\(window.level.rawValue) visible=\(window.isOccluded ? "occluded" : "yes", privacy: .public) frame=\(String(describing: window.frame), privacy: .public) ignoresMouse=\(window.ignoresMouseEvents)")
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
