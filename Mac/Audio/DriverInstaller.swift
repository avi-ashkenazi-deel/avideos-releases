import Foundation
import os

/// Installs the bundled CoreAudio loopback driver (AVideosAudio.driver) to
/// /Library/Audio/Plug-Ins/HAL with one admin prompt via
/// osascript-with-administrator-privileges (SMJobBless is deprecated and a
/// persistent privileged helper is overkill for a copy-once operation).
///
/// NOTE for project.yml: the install scripts (driver/install/*.sh) must be
/// copied into the app's Resources so `Bundle.main` can find them — add a
/// resources copy for `driver/install` to the AVideosStudio target when
/// generating on the Mac.
///
/// The coreaudiod restart audibly interrupts ALL apps' audio for ~1s — the
/// UI must warn and never trigger this mid-show.
final class DriverInstaller {
    enum Status: Equatable {
        case notInstalled
        case outOfDate(installed: String, bundled: String)
        case installed
        case failed(String)

        var displayText: String {
            switch self {
            case .notInstalled: "Not installed"
            case .outOfDate(let installed, let bundled): "Update available (\(installed) → \(bundled))"
            case .installed: "Installed"
            case .failed(let message): "Failed: \(message)"
            }
        }
    }

    static let installedDriverPath = "/Library/Audio/Plug-Ins/HAL/AVideosAudio.driver"
    static let microphoneUID = "com.aviashkenazi.avideos.vmic"
    static let guestSendUID = "com.aviashkenazi.avideos.gsend"

    private let deviceManager: AudioDeviceManager
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "driver")

    init(deviceManager: AudioDeviceManager) {
        self.deviceManager = deviceManager
    }

    // MARK: - Status

    func status() -> Status {
        let bundledVersion = Self.bundleVersion(at: bundledDriverURL())
        let installedVersion = Self.bundleVersion(at: URL(fileURLWithPath: Self.installedDriverPath))

        switch (installedVersion, bundledVersion) {
        case (nil, _):
            return .notInstalled
        case (let installed?, let bundled?) where installed != bundled:
            return .outOfDate(installed: installed, bundled: bundled)
        default:
            // Version matches (or we can't read the bundled copy — dev builds);
            // confirm the device actually registered with coreaudiod.
            return deviceManager.isDevicePresent(uid: Self.microphoneUID)
                ? .installed
                : .failed("Driver files present but the device didn't register — check Console for coreaudiod errors")
        }
    }

    private static func bundleVersion(at url: URL?) -> String? {
        guard let url,
              let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")),
              let version = info["CFBundleVersion"] as? String else { return nil }
        return version
    }

    private func bundledDriverURL() -> URL? {
        Bundle.main.resourceURL?.appendingPathComponent("AVideosAudio.driver")
    }

    private func bundledScriptURL(_ name: String) -> URL? {
        Bundle.main.resourceURL?.appendingPathComponent(name)
    }

    // MARK: - Install / uninstall

    /// Runs the privileged install; returns the resulting status. Polls up to
    /// 10s for the virtual mic to register after the coreaudiod restart.
    func install() async -> Status {
        guard let driver = bundledDriverURL(),
              FileManager.default.fileExists(atPath: driver.path) else {
            return .failed("Driver payload missing from the app bundle")
        }
        guard let script = bundledScriptURL("install-driver.sh"),
              FileManager.default.fileExists(atPath: script.path) else {
            return .failed("Install script missing from the app bundle")
        }

        let shellCommand = "/bin/bash '\(script.path)' '\(driver.path)'"
        if let error = await runWithAdminPrivileges(shellCommand) {
            return .failed(error)
        }

        // coreaudiod restarts; wait for our device to come up.
        for _ in 0..<20 {
            if deviceManager.isDevicePresent(uid: Self.microphoneUID) {
                return .installed
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return .failed("Installed, but the device didn't appear within 10s — see `log show --predicate 'process == \"coreaudiod\"' --last 5m`")
    }

    func uninstall() async -> Status {
        guard let script = bundledScriptURL("uninstall-driver.sh"),
              FileManager.default.fileExists(atPath: script.path) else {
            return .failed("Uninstall script missing from the app bundle")
        }
        if let error = await runWithAdminPrivileges("/bin/bash '\(script.path)'") {
            return .failed(error)
        }
        return .notInstalled
    }

    /// osascript "do shell script … with administrator privileges" — shows
    /// the system password prompt. Returns an error message or nil on success.
    private func runWithAdminPrivileges(_ command: String) async -> String? {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async { [log] in
                let escaped = command
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                let appleScript = "do shell script \"\(escaped)\" with administrator privileges"

                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
                process.arguments = ["-e", appleScript]
                let errPipe = Pipe()
                process.standardError = errPipe

                do {
                    try process.run()
                    process.waitUntilExit()
                    if process.terminationStatus == 0 {
                        continuation.resume(returning: nil)
                    } else {
                        let data = errPipe.fileHandleForReading.readDataToEndOfFile()
                        let message = String(data: data, encoding: .utf8)?
                            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "exit \(process.terminationStatus)"
                        // "User canceled" comes through this path too.
                        log.error("Privileged run failed: \(message)")
                        continuation.resume(returning: message)
                    }
                } catch {
                    continuation.resume(returning: error.localizedDescription)
                }
            }
        }
    }
}
