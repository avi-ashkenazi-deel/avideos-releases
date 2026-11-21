import AppKit
import IOKit.ps

/// Answers one question: "is it a good moment to be playing video?"
///
/// Everything here is event-driven. Nothing polls, so the monitor costs
/// nothing while the answer is not changing.
final class PowerMonitor {
    /// Called on the main thread whenever any of the values below may have changed.
    var onChange: (() -> Void)?

    private(set) var isOnBattery = false
    private(set) var isLowPowerMode = false
    private(set) var areDisplaysAsleep = false
    private(set) var isSessionActive = true

    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var powerSource: CFRunLoopSource?

    init() {
        isOnBattery = Self.readIsOnBattery()
        isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled

        observe(.default, .NSProcessInfoPowerStateDidChange) { monitor in
            monitor.isLowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.screensDidSleepNotification) { $0.areDisplaysAsleep = true }
        observe(workspace, NSWorkspace.screensDidWakeNotification) { $0.areDisplaysAsleep = false }
        // Fast user switching: another person is at the keyboard.
        observe(workspace, NSWorkspace.sessionDidResignActiveNotification) { $0.isSessionActive = false }
        observe(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { $0.isSessionActive = true }

        // Plugging in or unplugging the charger.
        let context = Unmanaged.passUnretained(self).toOpaque()
        if let source = IOPSNotificationCreateRunLoopSource({ context in
            guard let context else { return }
            let monitor = Unmanaged<PowerMonitor>.fromOpaque(context).takeUnretainedValue()
            monitor.isOnBattery = PowerMonitor.readIsOnBattery()
            monitor.onChange?()
        }, context)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
            powerSource = source
        }
    }

    deinit {
        for (center, token) in observers {
            center.removeObserver(token)
        }
        if let powerSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), powerSource, .defaultMode)
        }
    }

    private func observe(
        _ center: NotificationCenter,
        _ name: Notification.Name,
        update: @escaping (PowerMonitor) -> Void
    ) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            update(self)
            self.onChange?()
        }
        observers.append((center, token))
    }

    private static func readIsOnBattery() -> Bool {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(snapshot)?.takeUnretainedValue() else {
            return false
        }
        // The value of kIOPMBatteryPowerKey.
        return (type as String) == "Battery Power"
    }
}
