import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Set by StreamitApp once the SwiftUI scene comes up.
    weak var studio: StudioController?

    /// Keeps the process out of App Nap while live — the render clock, the
    /// offscreen web views, and the audio engines must not be throttled when
    /// the window is occluded (the virtual camera keeps feeding Zoom).
    private var activityToken: NSObjectProtocol?

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
