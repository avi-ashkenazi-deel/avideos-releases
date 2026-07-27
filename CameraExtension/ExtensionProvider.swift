//
//  ExtensionProvider.swift
//  CameraExtension — streamit virtual camera (CoreMediaIO system extension)
//
//  CMIOExtensionProviderSource implementation. The provider owns exactly one
//  device ("streamit Camera") which in turn publishes the source stream that
//  conferencing apps consume and the sink stream that the streamit host
//  app feeds. This layer is intentionally thin: client connect/disconnect is
//  accept-all (per-stream authorization happens in the stream sources) and
//  the only provider-level property we surface is the manufacturer.
//

import Foundation
import CoreMediaIO
import os.log

/// Shared logger for the whole extension process.
let extensionLog = Logger(
    subsystem: "com.aviashkenazi.streamit.cameraextension",
    category: "CameraExtension"
)

final class ExtensionProviderSource: NSObject, CMIOExtensionProviderSource {

    private(set) var provider: CMIOExtensionProvider!
    private var deviceSource: ExtensionDeviceSource!

    /// - Parameter clientQueue: queue on which client (Zoom/Meet/host app)
    ///   callbacks are delivered; `nil` lets CoreMediaIO pick one.
    init(clientQueue: DispatchQueue?) {
        super.init()

        provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
        deviceSource = ExtensionDeviceSource(localizedName: CameraConfig.deviceName)

        do {
            try provider.addDevice(deviceSource.device)
        } catch {
            // Without the device the extension is useless; crash loudly so the
            // failure shows up in the system log instead of a silent black hole.
            fatalError("CameraExtension: failed to add device: \(error.localizedDescription)")
        }

        extensionLog.info("Provider initialized, device \(CameraConfig.deviceName, privacy: .public) registered")
    }

    // MARK: - CMIOExtensionProviderSource

    func connect(to client: CMIOExtensionClient) throws {
        // Accept every client. The sink stream re-checks the client identity in
        // authorizedToStartStream(for:), which is where write access is gated.
        extensionLog.debug("Client connected: pid=\(client.pid) signingID=\(client.signingID ?? "<none>", privacy: .public)")
    }

    func disconnect(from client: CMIOExtensionClient) {
        extensionLog.debug("Client disconnected: pid=\(client.pid)")
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.providerManufacturer]
    }

    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let providerProperties = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) {
            providerProperties.manufacturer = "streamit"
        }
        return providerProperties
    }

    func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {
        // No settable provider-level properties.
    }
}
