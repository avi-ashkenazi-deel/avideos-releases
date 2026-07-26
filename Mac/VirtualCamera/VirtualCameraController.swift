import Foundation
import SystemExtensions
import os

/// Installs/activates the CMIO camera extension and reports its status for
/// the UI. Activation requires the app to run from /Applications (or
/// `systemextensionsctl developer on` during development — see
/// docs/DEV_SETUP.md) and shows a one-time user approval in System Settings.
@MainActor
@Observable
final class VirtualCameraController: NSObject {
    enum Status: Equatable {
        case unknown
        case notInstalled
        case pendingApproval
        case installed
        case failed(String)

        var displayText: String {
            switch self {
            case .unknown: "Checking…"
            case .notInstalled: "Not installed"
            case .pendingApproval: "Waiting for approval in System Settings"
            case .installed: "Installed"
            case .failed(let message): "Failed: \(message)"
            }
        }
    }

    static let extensionBundleID = "com.aviashkenazi.avideos.cameraextension"

    private(set) var status: Status = .unknown
    /// True once the sink stream is accepting our frames.
    private(set) var isStreaming = false

    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "virtualcam")

    /// The frame writer; created lazily once the extension's device appears.
    let sinkWriter = SinkStreamWriter()

    func activate() {
        status = .unknown
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: Self.extensionBundleID,
            queue: .main)
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func deactivate() {
        let request = OSSystemExtensionRequest.deactivationRequest(
            forExtensionWithIdentifier: Self.extensionBundleID,
            queue: .main)
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    /// Tries to attach to the extension's sink stream; retries are cheap and
    /// safe to call whenever the studio goes live.
    func connectSinkIfNeeded() {
        guard status == .installed || status == .unknown else { return }
        Task.detached { [sinkWriter, log] in
            do {
                try sinkWriter.connect()
                await MainActor.run { self.isStreaming = true }
            } catch {
                log.info("Virtual camera sink not reachable yet: \(error.localizedDescription)")
                await MainActor.run { self.isStreaming = false }
            }
        }
    }

    func disconnectSink() {
        sinkWriter.disconnect()
        isStreaming = false
    }
}

extension VirtualCameraController: OSSystemExtensionRequestDelegate {
    nonisolated func request(_ request: OSSystemExtensionRequest,
                             actionForReplacingExtension existing: OSSystemExtensionProperties,
                             withExtension ext: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction {
        // Always upgrade to the bundled version.
        .replace
    }

    nonisolated func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        Task { @MainActor in
            self.status = .pendingApproval
        }
    }

    nonisolated func request(_ request: OSSystemExtensionRequest,
                             didFinishWithResult result: OSSystemExtensionRequest.Result) {
        Task { @MainActor in
            switch result {
            case .completed:
                self.status = .installed
                self.connectSinkIfNeeded()
            case .willCompleteAfterReboot:
                self.status = .pendingApproval
            @unknown default:
                self.status = .installed
            }
        }
    }

    nonisolated func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        Task { @MainActor in
            let nsError = error as NSError
            // "Extension not found" style errors on first run mean not installed.
            self.status = .failed(nsError.localizedDescription)
            self.log.error("System extension request failed: \(nsError)")
        }
    }
}
