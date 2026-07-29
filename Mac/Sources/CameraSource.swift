import Foundation
import AVFoundation
import CoreMedia
import CoreMediaIO
import Metal
import os

/// Live camera via AVCaptureSession, delivered as BGRA for the uniform
/// compositing domain (one VideoToolbox conversion at the edge beats YCbCr
/// sampling paths through every shader).
final class CameraSource: NSObject, FrameSource, AVCaptureVideoDataOutputSampleBufferDelegate {
    let key: SourceKey
    private(set) var state: FrameSourceState = .idle

    private let deviceUniqueID: String?
    private let mailbox = FrameMailbox()
    private let converter: PixelBufferTextureConverter
    private let session = AVCaptureSession()
    private let outputQueue = DispatchQueue(label: "com.aviashkenazi.streamit.camera", qos: .userInteractive)
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "camera")

    /// Optional tap for podcast-mode local recording and segmentation:
    /// receives every raw frame on the capture queue.
    var frameTap: ((CMSampleBuffer) -> Void)?

    init(key: SourceKey, deviceUniqueID: String?, metalDevice: MTLDevice) {
        self.key = key
        self.deviceUniqueID = deviceUniqueID
        self.converter = PixelBufferTextureConverter(device: metalDevice)
        super.init()
    }

    static func device(uniqueID: String?) -> AVCaptureDevice? {
        if let uniqueID, let device = AVCaptureDevice(uniqueID: uniqueID) {
            return device
        }
        return AVCaptureDevice.default(for: .video)
    }

    /// Opts this process into CoreMediaIO's screen-capture devices — the flag
    /// QuickTime/Ecamm set so a plugged-in iPhone or iPad shows up as a
    /// presentable capture device (its screen, not its camera). Set once;
    /// devices arrive asynchronously after it flips.
    /// verify on Mac: a USB iPhone appears in the camera menu a moment after
    /// first launch (unlock the phone; "Trust This Computer" must be done).
    private static let allowScreenCaptureDevices: Void = {
        var allow: UInt32 = 1
        var address = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address,
                                  0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
        var wireless = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowWirelessScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &wireless,
                                  0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
    }()

    static func availableCameras() -> [AVCaptureDevice] {
        _ = allowScreenCaptureDevices
        // Cameras (built-in, USB/UVC — Android phones presenting as webcams
        // land here — and Continuity iPhones)…
        let cameras = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video,
            position: .unspecified
        ).devices
        // …plus iOS screen-capture devices, which present as MUXED external
        // devices, not video ones.
        let screens = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external],
            mediaType: .muxed,
            position: .unspecified
        ).devices
        var seen = Set<String>()
        return (cameras + screens).filter { seen.insert($0.uniqueID).inserted }
    }

    func start() {
        guard state == .idle || state.isFailure else { return }
        state = .starting
        outputQueue.async { [weak self] in
            self?.configureAndRun()
        }
    }

    private func configureAndRun() {
        guard let device = Self.device(uniqueID: deviceUniqueID) else {
            state = .failed("Camera not found")
            return
        }
        do {
            session.beginConfiguration()
            // iOS screen-capture (muxed) devices reject the .high preset.
            if session.canSetSessionPreset(.high) {
                session.sessionPreset = .high
            }
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else {
                session.commitConfiguration()
                state = .failed("Camera is in use by another configuration")
                return
            }
            session.addInput(input)

            let output = AVCaptureVideoDataOutput()
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: outputQueue)
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                state = .failed("Cannot attach camera output")
                return
            }
            session.addOutput(output)
            session.commitConfiguration()
            session.startRunning()
            state = .running
        } catch {
            state = .failed(error.localizedDescription)
            log.error("Camera start failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        outputQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning { self.session.stopRunning() }
            self.session.inputs.forEach(self.session.removeInput)
            self.session.outputs.forEach(self.session.removeOutput)
            self.mailbox.clear()
            self.state = .idle
        }
    }

    func latestFrame(at time: CMTime) -> SourceFrame? {
        mailbox.latest()
    }

    // MARK: AVCaptureVideoDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        frameTap?(sampleBuffer)
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let converted = converter.texture(from: pixelBuffer) else { return }
        mailbox.put(SourceFrame(pixelBuffer: pixelBuffer,
                                texture: converted.texture,
                                presentationTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
                                textureRef: converted.textureRef))
    }
}

private extension FrameSourceState {
    var isFailure: Bool {
        if case .failed = self { return true }
        return false
    }
}
