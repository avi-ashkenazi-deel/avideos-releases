import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import Metal
import VideoToolbox
import os

/// A tiny lock-guarded fan-out list: encoders emit on their own threads, and
/// destinations join and leave mid-show.
final class Subscribers<Value>: @unchecked Sendable {
    private var handlers: [UUID: (Value) -> Void] = [:]
    private var lock = os_unfair_lock()

    @discardableResult
    func add(_ handler: @escaping (Value) -> Void) -> UUID {
        let id = UUID()
        os_unfair_lock_lock(&lock)
        handlers[id] = handler
        os_unfair_lock_unlock(&lock)
        return id
    }

    func remove(_ id: UUID) {
        os_unfair_lock_lock(&lock)
        handlers.removeValue(forKey: id)
        os_unfair_lock_unlock(&lock)
    }

    var isEmpty: Bool {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return handlers.isEmpty
    }

    func send(_ value: Value) {
        os_unfair_lock_lock(&lock)
        let snapshot = Array(handlers.values)
        os_unfair_lock_unlock(&lock)
        for handler in snapshot { handler(value) }
    }
}

// MARK: - Video

/// One hardware H.264 encode of one canvas at one quality tier, shared by
/// every destination that wants it — five destinations cost two encodes
/// (horizontal + vertical), not five.
///
/// Attached to a `RenderEngine` as an ordinary program-frame consumer.
final class VideoStreamEncoder: ProgramFrameConsumer, @unchecked Sendable {
    struct Settings: Hashable, Sendable {
        var width: Int
        var height: Int
        var framesPerSecond: Int
        var bitsPerSecond: Int
        var keyframeIntervalSeconds: Double = 2
    }

    struct EncodedFrame: Sendable {
        /// AVCC: 4-byte big-endian NAL lengths, as RTMP's FLV body wants.
        let avcc: Data
        /// Host-clock presentation time (same timeline as the audio).
        let presentationTime: CMTime
        let isKeyframe: Bool
    }

    let settings: Settings
    let frames = Subscribers<EncodedFrame>()

    /// The AVCDecoderConfigurationRecord, once the encoder has produced its
    /// first frame. Publishers send it as the sequence header.
    var decoderConfiguration: Data? {
        os_unfair_lock_lock(&stateLock)
        defer { os_unfair_lock_unlock(&stateLock) }
        return avcC
    }

    private var session: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var avcC: Data?
    private var keyframeRequested = true
    private var stateLock = os_unfair_lock()
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "stream-encoder")

    init?(settings: Settings) {
        self.settings = settings

        let spec: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
        ]
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil,
                                                width: Int32(settings.width),
                                                height: Int32(settings.height),
                                                codecType: kCMVideoCodecType_H264,
                                                encoderSpecification: spec as CFDictionary,
                                                imageBufferAttributes: nil,
                                                compressedDataAllocator: nil,
                                                outputCallback: nil,
                                                refcon: nil,
                                                compressionSessionOut: &created)
        guard status == noErr, let created else { return nil }
        session = created

        // verify on Mac: every property below is accepted by the hardware
        // H.264 encoder (VTSessionSetProperty returns noErr). DataRateLimits
        // is [bytes, seconds] pairs.
        let bytesPerSecondCap = settings.bitsPerSecond / 8 * 3 / 2
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
            kVTCompressionPropertyKey_H264EntropyMode: kVTH264EntropyMode_CABAC,
            // No B-frames: DTS == PTS, so the FLV composition time is 0 and
            // every RTMP server's demuxer is happy.
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_AverageBitRate: settings.bitsPerSecond,
            kVTCompressionPropertyKey_DataRateLimits: [bytesPerSecondCap, 1] as CFArray,
            kVTCompressionPropertyKey_ExpectedFrameRate: settings.framesPerSecond,
            kVTCompressionPropertyKey_MaxKeyFrameInterval:
                Int(Double(settings.framesPerSecond) * settings.keyframeIntervalSeconds),
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: settings.keyframeIntervalSeconds,
            kVTCompressionPropertyKey_ColorPrimaries: kCVImageBufferColorPrimaries_ITU_R_709_2,
            kVTCompressionPropertyKey_TransferFunction: kCVImageBufferTransferFunction_ITU_R_709_2,
            kVTCompressionPropertyKey_YCbCrMatrix: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ]
        for (key, value) in properties {
            let result = VTSessionSetProperty(created, key: key, value: value as CFTypeRef)
            if result != noErr {
                log.warning("VT property \(key as String, privacy: .public) rejected: \(result)")
            }
        }
        VTCompressionSessionPrepareToEncodeFrames(created)

        var pixelTransfer: VTPixelTransferSession?
        if VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &pixelTransfer) == noErr {
            transfer = pixelTransfer
        }
    }

    deinit {
        invalidate()
    }

    func invalidate() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        transfer = nil
    }

    /// The next frame will be an IDR — a destination that just (re)connected
    /// can't start decoding mid-GOP.
    func requestKeyframe() {
        os_unfair_lock_lock(&stateLock)
        keyframeRequested = true
        os_unfair_lock_unlock(&stateLock)
    }

    // MARK: ProgramFrameConsumer (render queue)

    func consumeProgramFrame(_ pixelBuffer: CVPixelBuffer, texture: MTLTexture, at time: CMTime) {
        guard let session, !frames.isEmpty else { return }

        let input = scaledIfNeeded(pixelBuffer, session: session) ?? pixelBuffer

        os_unfair_lock_lock(&stateLock)
        let forceKey = keyframeRequested
        keyframeRequested = false
        os_unfair_lock_unlock(&stateLock)

        let frameProperties: CFDictionary? = forceKey
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
            : nil
        let duration = CMTime(value: 1, timescale: CMTimeScale(max(settings.framesPerSecond, 1)))

        VTCompressionSessionEncodeFrame(session,
                                        imageBuffer: input,
                                        presentationTimeStamp: time,
                                        duration: duration,
                                        frameProperties: frameProperties,
                                        infoFlagsOut: nil) { [weak self] status, _, sampleBuffer in
            guard let self, status == noErr, let sampleBuffer else { return }
            self.handleEncoded(sampleBuffer)
        }
    }

    /// Program canvas → this tier's size (e.g. 1080p → 720p), into the
    /// encoder's own pool so the color conversion happens here too.
    private func scaledIfNeeded(_ source: CVPixelBuffer, session: VTCompressionSession) -> CVPixelBuffer? {
        guard CVPixelBufferGetWidth(source) != settings.width
                || CVPixelBufferGetHeight(source) != settings.height,
              let transfer,
              let pool = VTCompressionSessionGetPixelBufferPool(session) else { return nil }
        var destination: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &destination) == kCVReturnSuccess,
              let destination,
              VTPixelTransferSessionTransferImage(transfer, from: source, to: destination) == noErr
        else { return nil }
        return destination
    }

    private func handleEncoded(_ sampleBuffer: CMSampleBuffer) {
        if let format = CMSampleBufferGetFormatDescription(sampleBuffer),
           let config = Self.decoderConfigurationRecord(from: format) {
            os_unfair_lock_lock(&stateLock)
            if avcC != config { avcC = config }
            os_unfair_lock_unlock(&stateLock)
        }

        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let length = CMBlockBufferGetDataLength(block)
        var data = Data(count: length)
        let copied = data.withUnsafeMutableBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
        }
        guard copied == kCMBlockBufferNoErr else { return }

        frames.send(EncodedFrame(avcc: data,
                                 presentationTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
                                 isKeyframe: Self.isKeyframe(sampleBuffer)))
    }

    static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[String: Any]],
              let first = attachments.first else { return true }
        return !((first[kCMSampleAttachmentKey_NotSync as String] as? Bool) ?? false)
    }

    /// The `avcC` atom VideoToolbox attaches to its format description — byte
    /// for byte the AVCDecoderConfigurationRecord FLV wants.
    static func decoderConfigurationRecord(from format: CMFormatDescription) -> Data? {
        guard let atoms = CMFormatDescriptionGetExtension(
                format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms)
                as? [String: Any] else { return nil }
        return atoms["avcC"] as? Data
    }
}

// MARK: - Audio

/// One AAC-LC encode of the program mix, shared by every destination.
///
/// Fed from the program-bus tap (via `AudioEngineController
/// .addProgramAudioConsumer`); the tap buffer is copied and the encode runs
/// on a private queue so the tap thread never waits on the codec.
final class AACStreamEncoder: @unchecked Sendable {
    struct Packet: Sendable {
        let data: Data
        /// Host-clock presentation time.
        let presentationTime: CMTime
    }

    static let sampleRate: Double = 48_000
    static let samplesPerPacket = 1024
    /// Apple's AAC-LC encoder emits this many priming samples before the
    /// first real one; subtracting it keeps audio aligned with video.
    /// verify on Mac: clap test against the stream preview.
    static let encoderPrimingSamples = 2112

    let bitsPerSecond: Int
    let packets = Subscribers<Packet>()
    let audioSpecificConfig = FLVTags.audioSpecificConfig(sampleRate: AACStreamEncoder.sampleRate, channels: 2)

    private let queue = DispatchQueue(label: "com.aviashkenazi.streamit.aac", qos: .userInitiated)
    private let outputFormat: AVAudioFormat
    private let converter: AVAudioConverter
    private var pending: [AVAudioPCMBuffer] = []
    /// Host seconds of sample 0 of the encode, re-anchored when the audio
    /// clock drifts from the host clock (the video's timeline).
    private var anchorSeconds: Double?
    private var samplesIn: Int64 = 0
    private var packetsOut: Int64 = 0

    init?(bitsPerSecond: Int = 160_000) {
        self.bitsPerSecond = bitsPerSecond
        var description = AudioStreamBasicDescription(
            mSampleRate: Self.sampleRate,
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: AudioFormatFlags(MPEG4ObjectID.AAC_LC.rawValue),
            mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(Self.samplesPerPacket),
            mBytesPerFrame: 0,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 0,
            mReserved: 0)
        guard let aac = AVAudioFormat(streamDescription: &description),
              let converter = AVAudioConverter(from: CanonicalAudio.format, to: aac) else { return nil }
        converter.bitRate = bitsPerSecond
        self.outputFormat = aac
        self.converter = converter
    }

    /// Tap thread: copy and hand off.
    func ingest(buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        guard !packets.isEmpty, let copy = Self.copy(buffer) else { return }
        let hostSeconds = time.isHostTimeValid
            ? AVAudioTime.seconds(forHostTime: time.hostTime)
            : CMClockGetTime(CMClockGetHostTimeClock()).seconds
        queue.async { [weak self] in
            self?.encode(copy, hostSeconds: hostSeconds)
        }
    }

    private func encode(_ buffer: AVAudioPCMBuffer, hostSeconds: Double) {
        // Re-anchor when the sample clock and host clock disagree by more
        // than ~40 ms (device clocks drift tens of ppm; over an hour that's
        // audible lip-sync error without this).
        let expected = anchorSeconds.map { $0 + Double(samplesIn) / Self.sampleRate }
        if let expected, abs(expected - hostSeconds) <= 0.04 {
            // On time — keep the anchor.
        } else {
            anchorSeconds = hostSeconds - Double(samplesIn) / Self.sampleRate
        }
        samplesIn += Int64(buffer.frameLength)
        pending.append(buffer)
        drain()
    }

    private func drain() {
        while true {
            let output = AVAudioCompressedBuffer(format: outputFormat,
                                                 packetCapacity: 8,
                                                 maximumPacketSize: max(converter.maximumOutputPacketSize, 1536))
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { [weak self] _, inputStatus in
                guard let self, !self.pending.isEmpty else {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                inputStatus.pointee = .haveData
                return self.pending.removeFirst()
            }
            emitPackets(from: output)
            if status != .haveData || output.packetCount == 0 { return }
        }
    }

    private func emitPackets(from buffer: AVAudioCompressedBuffer) {
        guard buffer.packetCount > 0, let anchorSeconds,
              let descriptions = buffer.packetDescriptions else { return }
        let base = buffer.data
        for index in 0..<Int(buffer.packetCount) {
            let description = descriptions[index]
            let bytes = Data(bytes: base.advanced(by: Int(description.mStartOffset)),
                             count: Int(description.mDataByteSize))
            let sampleIndex = packetsOut * Int64(Self.samplesPerPacket) - Int64(Self.encoderPrimingSamples)
            packetsOut += 1
            let seconds = anchorSeconds + Double(sampleIndex) / Self.sampleRate
            packets.send(Packet(data: bytes,
                                presentationTime: CMTime(seconds: seconds, preferredTimescale: 1_000_000)))
        }
    }

    private static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength),
              let source = buffer.floatChannelData,
              let destination = copy.floatChannelData else { return nil }
        copy.frameLength = buffer.frameLength
        let channels = Int(buffer.format.channelCount)
        let bytes = Int(buffer.frameLength) * MemoryLayout<Float>.size
        for channel in 0..<channels {
            memcpy(destination[channel], source[channel], bytes)
        }
        return copy
    }
}
