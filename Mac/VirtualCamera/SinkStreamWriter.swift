import Foundation
import CoreMediaIO
import CoreMedia
import CoreVideo
import os

/// Feeds composited program frames into the camera extension's sink stream
/// through the legacy CMIO C API — the Apple-sanctioned transport for
/// virtual-camera producers (what OBS 30+ uses).
///
/// Flow: enumerate CMIO devices → find ours by UID → find the sink-direction
/// stream → copy its buffer queue → start the stream → enqueue CMSampleBuffers
/// per program frame. Frames are dropped when the queue is full (no client
/// pulling).
final class SinkStreamWriter {
    enum WriterError: LocalizedError {
        case deviceNotFound
        case sinkStreamNotFound
        case queueUnavailable

        var errorDescription: String? {
            switch self {
            case .deviceNotFound: "streamit Camera device not found (extension installed and approved?)"
            case .sinkStreamNotFound: "streamit Camera has no sink stream"
            case .queueUnavailable: "Couldn't open the sink stream's buffer queue"
            }
        }
    }

    /// Must match CameraConfig.legacyDeviceID in the extension
    /// (CameraExtension/ExtensionDeviceSource.swift).
    static let deviceUID = "com.aviashkenazi.streamit.cameraextension.device"

    private var deviceID: CMIODeviceID = 0
    private var streamID: CMIOStreamID = 0
    private var queue: CMSimpleQueue?
    private var formatDescription: CMVideoFormatDescription?
    private var streaming = false
    private let lock = NSLock()
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "sinkwriter")

    private(set) var enqueuedFrames = 0
    private(set) var droppedFrames = 0

    // MARK: - Connection

    func connect() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !streaming else { return }

        guard let device = Self.findDevice(uid: Self.deviceUID) else {
            throw WriterError.deviceNotFound
        }
        guard let sink = Self.findSinkStream(device: device) else {
            throw WriterError.sinkStreamNotFound
        }

        var queueOut: Unmanaged<CMSimpleQueue>?
        let status = CMIOStreamCopyBufferQueue(sink, { _, _, _ in
            // Queue-altered callback: nothing to do — we push on our own pace.
        }, nil, &queueOut)
        guard status == kCMIOHardwareNoError, let bufferQueue = queueOut?.takeRetainedValue() else {
            throw WriterError.queueUnavailable
        }

        let startStatus = CMIODeviceStartStream(device, sink)
        guard startStatus == kCMIOHardwareNoError else {
            throw WriterError.queueUnavailable
        }

        deviceID = device
        streamID = sink
        queue = bufferQueue
        streaming = true
        log.info("Connected to virtual camera sink stream")
    }

    func disconnect() {
        lock.lock()
        defer { lock.unlock() }
        if streaming {
            CMIODeviceStopStream(deviceID, streamID)
        }
        streaming = false
        queue = nil
        formatDescription = nil
    }

    var isConnected: Bool {
        lock.lock()
        defer { lock.unlock() }
        return streaming
    }

    // MARK: - Frame push (render queue)

    /// Wraps the program buffer in a CMSampleBuffer and enqueues it. Cheap:
    /// the pixel buffer is IOSurface-backed, so this is a zero-copy hand-off.
    func enqueue(pixelBuffer: CVPixelBuffer, at time: CMTime) {
        lock.lock()
        defer { lock.unlock() }
        guard streaming, let queue else { return }

        // Drop when the extension isn't draining (no meeting app pulling).
        guard CMSimpleQueueGetCount(queue) < CMSimpleQueueGetCapacity(queue) else {
            droppedFrames += 1
            return
        }

        // Cache the format description across frames of the same dimensions.
        if formatDescription == nil
            || CMVideoFormatDescriptionGetDimensions(formatDescription!).width != Int32(CVPixelBufferGetWidth(pixelBuffer)) {
            var fd: CMVideoFormatDescription?
            CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil,
                                                         imageBuffer: pixelBuffer,
                                                         formatDescriptionOut: &fd)
            formatDescription = fd
        }
        guard let formatDescription else { return }

        var timing = CMSampleTimingInfo(duration: .invalid,
                                        presentationTimeStamp: time,
                                        decodeTimeStamp: .invalid)
        var sampleBuffer: CMSampleBuffer?
        let status = CMSampleBufferCreateForImageBuffer(allocator: nil,
                                                        imageBuffer: pixelBuffer,
                                                        dataReady: true,
                                                        makeDataReadyCallback: nil,
                                                        refcon: nil,
                                                        formatDescription: formatDescription,
                                                        sampleTiming: &timing,
                                                        sampleBufferOut: &sampleBuffer)
        guard status == noErr, let sampleBuffer else { return }

        // The queue takes ownership of a +1 retain; on enqueue failure we
        // must balance it ourselves or the sample buffer leaks.
        let opaque = Unmanaged.passRetained(sampleBuffer).toOpaque()
        let enqueueStatus = CMSimpleQueueEnqueue(queue, element: opaque)
        if enqueueStatus == noErr {
            enqueuedFrames += 1
        } else {
            Unmanaged<CMSampleBuffer>.fromOpaque(opaque).release()
            droppedFrames += 1
        }
    }

    // MARK: - CMIO enumeration helpers

    private static func findDevice(uid: String) -> CMIODeviceID? {
        var address = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))

        var dataSize: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject),
                                            &address, 0, nil, &dataSize) == kCMIOHardwareNoError,
              dataSize > 0 else { return nil }

        let count = Int(dataSize) / MemoryLayout<CMIODeviceID>.size
        var devices = [CMIODeviceID](repeating: 0, count: count)
        var dataUsed: UInt32 = 0
        guard CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject),
                                        &address, 0, nil, dataSize, &dataUsed, &devices) == kCMIOHardwareNoError
        else { return nil }

        for device in devices {
            if deviceUID(of: device) == uid { return device }
        }
        return nil
    }

    private static func deviceUID(of device: CMIODeviceID) -> String? {
        var address = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceUID),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var dataSize: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(device, &address, 0, nil, &dataSize) == kCMIOHardwareNoError
        else { return nil }
        var uid: CFString = "" as CFString
        var dataUsed: UInt32 = 0
        let status = withUnsafeMutablePointer(to: &uid) { ptr in
            CMIOObjectGetPropertyData(device, &address, 0, nil, dataSize, &dataUsed, ptr)
        }
        guard status == kCMIOHardwareNoError else { return nil }
        return uid as String
    }

    private static func findSinkStream(device: CMIODeviceID) -> CMIOStreamID? {
        // verify on Mac: the scope used to enumerate streams. Input scope may
        // list only capture (device->host) streams on some macOS versions, in
        // which case the sink stream would never be found. If connect() fails
        // with sinkStreamNotFound while the extension is installed, switch to
        // kCMIOObjectPropertyScopeWildcard here — the direction==1 filter
        // below still picks the sink correctly from the full list.
        var address = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyStreams),
            mScope: CMIOObjectPropertyScope(kCMIODevicePropertyScopeInput),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))

        var dataSize: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(device, &address, 0, nil, &dataSize) == kCMIOHardwareNoError,
              dataSize > 0 else { return nil }

        let count = Int(dataSize) / MemoryLayout<CMIOStreamID>.size
        var streams = [CMIOStreamID](repeating: 0, count: count)
        var dataUsed: UInt32 = 0
        guard CMIOObjectGetPropertyData(device, &address, 0, nil, dataSize, &dataUsed, &streams) == kCMIOHardwareNoError
        else { return nil }

        // Sink stream = the one whose direction property reports "input to
        // the device" (value 1); source streams report 0. When only one
        // stream exposes the direction selector as writable-input, prefer it.
        for stream in streams {
            var dirAddress = CMIOObjectPropertyAddress(
                mSelector: CMIOObjectPropertySelector(kCMIOStreamPropertyDirection),
                mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
            var direction: UInt32 = 0
            var used: UInt32 = 0
            if CMIOObjectGetPropertyData(stream, &dirAddress, 0, nil,
                                         UInt32(MemoryLayout<UInt32>.size), &used, &direction) == kCMIOHardwareNoError,
               direction == 1 {
                return stream
            }
        }
        return nil
    }
}
