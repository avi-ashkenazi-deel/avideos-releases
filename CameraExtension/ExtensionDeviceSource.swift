//
//  ExtensionDeviceSource.swift
//  CameraExtension — AVideos Studio virtual camera (CoreMediaIO system extension)
//
//  One CMIOExtensionDevice ("AVideos Camera") with two streams:
//
//    • Source stream (.source) — the frames conferencing apps (Zoom, Meet,
//      Photo Booth, …) consume.
//    • Sink stream (.sink)     — the app-facing input. AVideos Studio locates
//      this stream through the legacy CMIO C API and enqueues composited
//      program frames; we pull them with consumeSampleBuffer(from:) and
//      forward each one to the source stream with fresh host-time timing.
//
//  When no frames are arriving on the sink (host app closed, or a >1 s gap),
//  a 30 fps DispatchSourceTimer sends a pre-rendered branded splash frame
//  instead, so consumers always see *something* rather than a frozen or black
//  image.
//
//  The device also publishes one custom property (4CC 'avst') reporting
//  whether the sink is currently connected, so the host app can show status.
//
//  Design rule: this process stays dumb and frozen-after-bringup. It forwards
//  frames and paints a splash. All compositing/business logic lives in the app.
//

import Foundation
import CoreMediaIO
import CoreMedia
import CoreVideo
import os.log

// MARK: - Configuration

enum CameraConfig {

    static let deviceName = "AVideos Camera"

    /// Stable identifiers so the device/stream identity survives relaunches
    /// (apps remember cameras by unique ID).
    static let deviceUUID       = UUID(uuidString: "7F9C1D3A-52B4-4E7C-9A1E-0C2B6D8F4A10")!
    static let sourceStreamUUID = UUID(uuidString: "7F9C1D3A-52B4-4E7C-9A1E-0C2B6D8F4A11")!
    static let sinkStreamUUID   = UUID(uuidString: "7F9C1D3A-52B4-4E7C-9A1E-0C2B6D8F4A12")!

    /// Legacy (pre-CMIOExtension) device UID, visible to the C API.
    static let legacyDeviceID = "com.aviashkenazi.avideos.cameraextension.device"

    /// Nominal frame rate; formats advertise up to `maxFrameRate`.
    static let frameRate = 30
    static let maxFrameRate = 60

    /// If no sink frame has arrived within this window the extension falls
    /// back to the splash generator.
    static let sinkStaleInterval: TimeInterval = 1.0

    /// Only processes whose code-signing identifier matches this prefix may
    /// start (i.e. write to) the sink stream. Matches the host app
    /// (com.aviashkenazi.avideos) and any of its embedded helpers.
    static let trustedSigningIDPrefix = "com.aviashkenazi.avideos"

    /// Advertised formats, preferred first. 32BGRA only.
    struct FormatSpec { let width: Int32; let height: Int32 }
    static let formats: [FormatSpec] = [
        FormatSpec(width: 1920, height: 1080),
        FormatSpec(width: 1280, height: 720),
    ]

    /// Custom device property with 4CC 'avst'. CMIO extensions expose custom
    /// properties through the "4cc_<selector>_glob_0000" naming convention,
    /// which surfaces to legacy C-API clients as selector 'avst', global
    /// scope, main element. Value is an NSNumber (bool): sink connected?
    static let sinkConnectedProperty = CMIOExtensionProperty(rawValue: "4cc_avst_glob_0000")

    /// kIOAudioDeviceTransportTypeVirtual ('virt'). Hardcoded to avoid the
    /// IOKit.audio import in a sandboxed extension.
    static let virtualTransportType = 0x7669_7274
}

// MARK: - Device source

final class ExtensionDeviceSource: NSObject, CMIOExtensionDeviceSource {

    private(set) var device: CMIOExtensionDevice!

    private var sourceStreamSource: ExtensionSourceStreamSource!
    private var sinkStreamSource: ExtensionSinkStreamSource!

    /// Serial queue guarding all mutable state below and hosting the splash
    /// timer. Everything that touches counters/timestamps hops here.
    private let stateQueue = DispatchQueue(label: "com.aviashkenazi.avideos.cameraextension.state")

    private let splashGenerator = SplashFrameGenerator()
    private var splashTimer: DispatchSourceTimer?

    /// Number of clients currently streaming the source stream (Zoom + Meet
    /// at once = 2). Frames flow while > 0.
    private var streamingCounter = 0

    /// Number of clients currently streaming the sink stream. In practice 0
    /// or 1 (the host app), but counted anyway for correct start/stop pairing.
    private var sinkStreamingCounter = 0

    /// The client we are pulling sink buffers from (first sink client wins).
    private var sinkClient: CMIOExtensionClient?

    /// Host-clock time (seconds) of the most recent sink frame; 0 = never.
    private var lastSinkFrameSeconds: Double = 0

    /// Index into CameraConfig.formats currently active on the source stream;
    /// the splash is rendered at this size.
    private var activeFormatIndex = 0

    /// Stream formats shared verbatim by both streams (the sink accepts the
    /// same formats the source publishes).
    private let streamFormats: [CMIOExtensionStreamFormat]

    private let frameDuration = CMTime(value: 1, timescale: CMTimeScale(CameraConfig.frameRate))

    // MARK: Init

    init(localizedName: String) {
        var formats: [CMIOExtensionStreamFormat] = []
        for spec in CameraConfig.formats {
            var description: CMVideoFormatDescription?
            let status = CMVideoFormatDescriptionCreate(
                allocator: kCFAllocatorDefault,
                codecType: kCVPixelFormatType_32BGRA,
                width: spec.width,
                height: spec.height,
                extensions: nil,
                formatDescriptionOut: &description
            )
            guard status == noErr, let description else {
                fatalError("CameraExtension: cannot create format description (\(spec.width)x\(spec.height)): \(status)")
            }
            formats.append(
                CMIOExtensionStreamFormat(
                    formatDescription: description,
                    // maxFrameDuration = slowest rate (30 fps),
                    // minFrameDuration = fastest rate (60 fps).
                    maxFrameDuration: CMTime(value: 1, timescale: CMTimeScale(CameraConfig.frameRate)),
                    minFrameDuration: CMTime(value: 1, timescale: CMTimeScale(CameraConfig.maxFrameRate)),
                    validFrameDurations: nil // continuous range 30–60 fps
                )
            )
        }
        streamFormats = formats

        super.init()

        device = CMIOExtensionDevice(
            localizedName: localizedName,
            deviceID: CameraConfig.deviceUUID,
            legacyDeviceID: CameraConfig.legacyDeviceID,
            source: self
        )

        sourceStreamSource = ExtensionSourceStreamSource(
            localizedName: "AVideos Camera",
            streamID: CameraConfig.sourceStreamUUID,
            streamFormats: streamFormats,
            device: device,
            deviceSource: self
        )
        sinkStreamSource = ExtensionSinkStreamSource(
            localizedName: "AVideos Camera Input",
            streamID: CameraConfig.sinkStreamUUID,
            streamFormats: streamFormats,
            device: device,
            deviceSource: self
        )

        do {
            try device.addStream(sourceStreamSource.stream)
            try device.addStream(sinkStreamSource.stream)
        } catch {
            fatalError("CameraExtension: failed to add streams: \(error.localizedDescription)")
        }
    }

    // MARK: CMIOExtensionDeviceSource

    var availableProperties: Set<CMIOExtensionProperty> {
        [.deviceTransportType, .deviceModel, CameraConfig.sinkConnectedProperty]
    }

    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let deviceProperties = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) {
            deviceProperties.transportType = CameraConfig.virtualTransportType
        }
        if properties.contains(.deviceModel) {
            deviceProperties.model = "AVideos Virtual Camera"
        }
        if properties.contains(CameraConfig.sinkConnectedProperty) {
            let connected = stateQueue.sync { sinkStreamingCounter > 0 }
            deviceProperties.setPropertyState(
                CMIOExtensionPropertyState(value: NSNumber(value: connected)),
                forProperty: CameraConfig.sinkConnectedProperty
            )
        }
        return deviceProperties
    }

    func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {
        // All device-level properties (including 'avst') are read-only.
    }

    // MARK: Source-stream lifecycle (called by ExtensionSourceStreamSource)

    func startSourceStreaming() {
        stateQueue.sync {
            streamingCounter += 1
            extensionLog.info("Source stream start (clients: \(self.streamingCounter))")
            if streamingCounter == 1 {
                startSplashTimerLocked()
            }
        }
    }

    func stopSourceStreaming() {
        stateQueue.sync {
            streamingCounter = max(0, streamingCounter - 1)
            extensionLog.info("Source stream stop (clients: \(self.streamingCounter))")
            if streamingCounter == 0 {
                stopSplashTimerLocked()
            }
        }
    }

    /// Source stream's active format changed; splash follows the new size.
    func setActiveFormatIndex(_ index: Int) {
        stateQueue.sync {
            guard CameraConfig.formats.indices.contains(index) else {
                extensionLog.error("Ignoring out-of-range format index \(index)")
                return
            }
            activeFormatIndex = index
        }
    }

    // MARK: Sink-stream lifecycle (called by ExtensionSinkStreamSource)

    func startSinkStreaming(client: CMIOExtensionClient) {
        stateQueue.sync {
            sinkStreamingCounter += 1
            extensionLog.info("Sink stream start (clients: \(self.sinkStreamingCounter))")
            guard sinkStreamingCounter == 1 else { return }
            sinkClient = client
            lastSinkFrameSeconds = 0
            notifySinkConnectedLocked(true)
            pumpSinkLocked(client: client)
        }
    }

    func stopSinkStreaming() {
        stateQueue.sync {
            sinkStreamingCounter = max(0, sinkStreamingCounter - 1)
            extensionLog.info("Sink stream stop (clients: \(self.sinkStreamingCounter))")
            guard sinkStreamingCounter == 0 else { return }
            sinkClient = nil
            lastSinkFrameSeconds = 0
            notifySinkConnectedLocked(false)
            // The splash timer (if the source is live) takes over on its next
            // tick — no explicit hand-off needed.
        }
    }

    // MARK: Sink pull loop

    /// Async pull loop, Apple's documented pattern for sink streams: request
    /// one buffer, handle it, re-arm. Must be entered on `stateQueue`.
    private func pumpSinkLocked(client: CMIOExtensionClient) {
        sinkStreamSource.stream.consumeSampleBuffer(from: client) { [weak self] sampleBuffer, sequenceNumber, discontinuity, hasMoreSampleBuffers, error in
            guard let self else { return }
            self.stateQueue.async {
                // The sink may have stopped (or switched clients) while the
                // pull was in flight; if so, drop out of the loop.
                guard self.sinkStreamingCounter > 0, self.sinkClient?.pid == client.pid else { return }

                if let sampleBuffer {
                    self.handleSinkBufferLocked(sampleBuffer, sequenceNumber: sequenceNumber)
                    self.pumpSinkLocked(client: client)
                } else if error != nil {
                    // Transient failure with no buffer: back off briefly so a
                    // persistent error can't spin the CPU, then re-arm.
                    self.stateQueue.asyncAfter(deadline: .now() + .milliseconds(20)) { [weak self] in
                        guard let self, self.sinkStreamingCounter > 0, self.sinkClient?.pid == client.pid else { return }
                        self.pumpSinkLocked(client: client)
                    }
                } else {
                    self.pumpSinkLocked(client: client)
                }
            }
        }
    }

    /// Forward one sink frame to the source stream with fresh host-time
    /// timing, then tell the feeding client its buffer was consumed.
    private func handleSinkBufferLocked(_ sampleBuffer: CMSampleBuffer, sequenceNumber: UInt64) {
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        lastSinkFrameSeconds = now.seconds
        let hostNanos = UInt64(now.seconds * Double(NSEC_PER_SEC))

        if streamingCounter > 0 {
            // Re-stamp: the app's PTS domain is its own; consumers get frames
            // timed on the host clock at the moment of forwarding.
            var timing = CMSampleTimingInfo(
                duration: frameDuration,
                presentationTimeStamp: now,
                decodeTimeStamp: .invalid
            )
            var retimed: CMSampleBuffer?
            let status = CMSampleBufferCreateCopyWithNewTiming(
                allocator: kCFAllocatorDefault,
                sampleBuffer: sampleBuffer,
                sampleTimingEntryCount: 1,
                sampleTimingArray: &timing,
                sampleBufferOut: &retimed
            )
            if status == noErr, let retimed {
                sourceStreamSource.stream.send(retimed, discontinuity: [], hostTimeInNanoseconds: hostNanos)
            } else {
                extensionLog.error("Failed to retime sink buffer: \(status)")
            }
        }

        // Always acknowledge consumption so the feeding app can pace/recycle
        // its buffers, even when no consumer is attached to the source stream.
        let output = CMIOExtensionScheduledOutput(sequenceNumber: sequenceNumber, hostTimeInNanoseconds: hostNanos)
        sinkStreamSource.stream.notifyScheduledOutputChanged(output)
    }

    // MARK: Splash timer

    /// Must be called on `stateQueue`.
    private func startSplashTimerLocked() {
        guard splashTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(flags: [], queue: stateQueue)
        timer.schedule(
            deadline: .now(),
            repeating: .nanoseconds(Int(NSEC_PER_SEC) / CameraConfig.frameRate),
            leeway: .milliseconds(5)
        )
        timer.setEventHandler { [weak self] in
            self?.splashTickLocked()
        }
        timer.resume()
        splashTimer = timer
    }

    /// Must be called on `stateQueue`.
    private func stopSplashTimerLocked() {
        splashTimer?.cancel()
        splashTimer = nil
    }

    /// One 30 fps tick: if the sink is live (frame < 1 s old) do nothing —
    /// forwarding happens on the pull loop. Otherwise send the pre-rendered
    /// splash frame for the active format size.
    private func splashTickLocked() {
        guard streamingCounter > 0 else { return }

        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let sinkIsLive = sinkStreamingCounter > 0
            && lastSinkFrameSeconds > 0
            && (now.seconds - lastSinkFrameSeconds) < CameraConfig.sinkStaleInterval
        guard !sinkIsLive else { return }

        let spec = CameraConfig.formats[activeFormatIndex]
        guard let splash = splashGenerator.splash(width: Int(spec.width), height: Int(spec.height)) else {
            extensionLog.error("Splash frame unavailable for \(spec.width)x\(spec.height)")
            return
        }

        var timing = CMSampleTimingInfo(
            duration: frameDuration,
            presentationTimeStamp: now,
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        let status = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: splash.pixelBuffer,
            formatDescription: splash.formatDescription,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        )
        guard status == noErr, let sampleBuffer else {
            extensionLog.error("Failed to wrap splash frame: \(status)")
            return
        }

        sourceStreamSource.stream.send(
            sampleBuffer,
            discontinuity: [],
            hostTimeInNanoseconds: UInt64(now.seconds * Double(NSEC_PER_SEC))
        )
    }

    // MARK: Custom property

    /// Must be called on `stateQueue`.
    private func notifySinkConnectedLocked(_ connected: Bool) {
        let state = CMIOExtensionPropertyState(value: NSNumber(value: connected))
        device.notifyPropertiesChanged([CameraConfig.sinkConnectedProperty: state])
        extensionLog.info("sinkConnected -> \(connected)")
    }
}

// MARK: - Source stream (what Zoom / Meet / Photo Booth consume)

final class ExtensionSourceStreamSource: NSObject, CMIOExtensionStreamSource {

    private(set) var stream: CMIOExtensionStream!
    let device: CMIOExtensionDevice
    private unowned let deviceSource: ExtensionDeviceSource
    private let streamFormats: [CMIOExtensionStreamFormat]

    private var activeFormatIndex = 0
    private var frameDuration = CMTime(value: 1, timescale: CMTimeScale(CameraConfig.frameRate))

    init(localizedName: String,
         streamID: UUID,
         streamFormats: [CMIOExtensionStreamFormat],
         device: CMIOExtensionDevice,
         deviceSource: ExtensionDeviceSource) {
        self.device = device
        self.deviceSource = deviceSource
        self.streamFormats = streamFormats
        super.init()
        stream = CMIOExtensionStream(
            localizedName: localizedName,
            streamID: streamID,
            direction: .source,
            clockType: .hostTime,
            source: self
        )
    }

    var formats: [CMIOExtensionStreamFormat] { streamFormats }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration]
    }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) {
            streamProperties.activeFormatIndex = activeFormatIndex
        }
        if properties.contains(.streamFrameDuration) {
            streamProperties.frameDuration = frameDuration
        }
        return streamProperties
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let index = streamProperties.activeFormatIndex {
            guard streamFormats.indices.contains(index) else {
                extensionLog.error("Client requested invalid source format index \(index)")
                return
            }
            activeFormatIndex = index
            deviceSource.setActiveFormatIndex(index)
        }
        if let duration = streamProperties.frameDuration {
            // Clamp to the advertised 30–60 fps range; the splash generator
            // always paces at 30 fps regardless (forwarded frames pace at
            // whatever rate the host app delivers).
            let fps = duration.timescale > 0 ? Double(duration.timescale) / Double(duration.value) : 0
            if fps >= Double(CameraConfig.frameRate), fps <= Double(CameraConfig.maxFrameRate) {
                frameDuration = duration
            }
        }
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        // Anyone may *watch* the camera.
        true
    }

    func startStream() throws {
        deviceSource.startSourceStreaming()
    }

    func stopStream() throws {
        deviceSource.stopSourceStreaming()
    }
}

// MARK: - Sink stream (the host app's frame input)

final class ExtensionSinkStreamSource: NSObject, CMIOExtensionStreamSource {

    private(set) var stream: CMIOExtensionStream!
    let device: CMIOExtensionDevice
    private unowned let deviceSource: ExtensionDeviceSource
    private let streamFormats: [CMIOExtensionStreamFormat]

    private var activeFormatIndex = 0

    init(localizedName: String,
         streamID: UUID,
         streamFormats: [CMIOExtensionStreamFormat],
         device: CMIOExtensionDevice,
         deviceSource: ExtensionDeviceSource) {
        self.device = device
        self.deviceSource = deviceSource
        self.streamFormats = streamFormats
        super.init()
        stream = CMIOExtensionStream(
            localizedName: localizedName,
            streamID: streamID,
            direction: .sink,
            clockType: .hostTime,
            source: self
        )
    }

    var formats: [CMIOExtensionStreamFormat] { streamFormats }

    var availableProperties: Set<CMIOExtensionProperty> {
        // The sink-specific properties are what legacy C-API clients (our
        // host app) query to size their output buffer queue.
        [.streamActiveFormatIndex,
         .streamFrameDuration,
         .streamSinkBufferQueueSize,
         .streamSinkBuffersRequiredForStartup,
         .streamSinkBufferUnderrunCount,
         .streamSinkEndOfData]
    }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let streamProperties = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) {
            streamProperties.activeFormatIndex = activeFormatIndex
        }
        if properties.contains(.streamFrameDuration) {
            streamProperties.frameDuration = CMTime(value: 1, timescale: CMTimeScale(CameraConfig.frameRate))
        }
        // Compile-pass note: the four sink* setters below are NSNumber/Bool
        // bridged properties on CMIOExtensionStreamProperties (macOS 12.3+).
        // If the SDK exposes them as NSNumber?, wrap the literals in
        // NSNumber(value:).
        if properties.contains(.streamSinkBufferQueueSize) {
            streamProperties.sinkBufferQueueSize = 8
        }
        if properties.contains(.streamSinkBuffersRequiredForStartup) {
            streamProperties.sinkBuffersRequiredForStartup = 1
        }
        if properties.contains(.streamSinkBufferUnderrunCount) {
            streamProperties.sinkBufferUnderrunCount = 0
        }
        if properties.contains(.streamSinkEndOfData) {
            streamProperties.sinkEndOfData = false
        }
        return streamProperties
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let index = streamProperties.activeFormatIndex {
            guard streamFormats.indices.contains(index) else {
                extensionLog.error("Client requested invalid sink format index \(index)")
                return
            }
            activeFormatIndex = index
        }
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        // Only the AVideos Studio host app (and its embedded helpers) may
        // feed frames. CMIOExtensionClient.signingID is the client's
        // code-signing identifier as validated by the system, so this cannot
        // be spoofed by an unsigned/ad-hoc process claiming our bundle id.
        //
        // Note: sink streams never appear in normal capture UIs (AVFoundation
        // only exposes source directions), so this gate is defense in depth,
        // not the only line.
        guard let signingID = client.signingID, !signingID.isEmpty else {
            extensionLog.warning("Rejecting sink start from unidentified client pid=\(client.pid)")
            return false
        }
        let trusted = signingID == CameraConfig.trustedSigningIDPrefix
            || signingID.hasPrefix(CameraConfig.trustedSigningIDPrefix + ".")
        if !trusted {
            extensionLog.warning("Rejecting sink start from \(signingID, privacy: .public) pid=\(client.pid)")
        }
        return trusted
    }

    func startStream() throws {
        guard let client = stream.streamingClients.first else {
            throw NSError(
                domain: "com.aviashkenazi.avideos.cameraextension",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Sink stream started with no streaming client"]
            )
        }
        deviceSource.startSinkStreaming(client: client)
    }

    func stopStream() throws {
        deviceSource.stopSinkStreaming()
    }
}
