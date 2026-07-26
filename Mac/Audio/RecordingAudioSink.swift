import Foundation
import AVFoundation
import CoreMedia
import os

/// Bridges the program-bus tap to the recorder: converts (AVAudioPCMBuffer,
/// AVAudioTime) into host-clock-stamped CMSampleBuffers and forwards them to
/// ProgramRecorder.appendAudio. Also supports a standalone .m4a mode for
/// audio-only capture.
final class RecordingAudioSink {
    private weak var recorder: ProgramRecorder?
    private var audioFile: AVAudioFile?
    private var formatDescription: CMAudioFormatDescription?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "audiosink")

    /// Wire to a running program recorder (shared A/V file).
    func attach(recorder: ProgramRecorder) {
        self.recorder = recorder
        audioFile = nil
    }

    /// Standalone audio-only capture instead.
    func attachStandaloneFile(url: URL) throws {
        recorder = nil
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        audioFile = try AVAudioFile(forWriting: url,
                                    settings: [
                                        AVFormatIDKey: kAudioFormatMPEG4AAC,
                                        AVSampleRateKey: CanonicalAudio.sampleRate,
                                        AVNumberOfChannelsKey: 2,
                                        AVEncoderBitRateKey: 256_000,
                                    ])
    }

    func detach() {
        recorder = nil
        audioFile = nil
    }

    var isAttached: Bool { recorder != nil || audioFile != nil }

    /// Called from the program tap (audio thread adjacent — keep it lean).
    func ingest(buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        if let audioFile {
            try? audioFile.write(from: buffer)
            return
        }
        guard let recorder, let sampleBuffer = makeSampleBuffer(from: buffer, at: time) else { return }
        recorder.appendAudio(sampleBuffer)
    }

    /// AVAudioPCMBuffer → CMSampleBuffer with the tap's host time converted
    /// onto the host clock — the same timeline the video frames use, so A/V
    /// sync holds by construction.
    private func makeSampleBuffer(from buffer: AVAudioPCMBuffer, at time: AVAudioTime) -> CMSampleBuffer? {
        let asbd = buffer.format.streamDescription

        if formatDescription == nil {
            var fd: CMAudioFormatDescription?
            CMAudioFormatDescriptionCreate(allocator: nil,
                                           asbd: asbd,
                                           layoutSize: 0,
                                           layout: nil,
                                           magicCookieSize: 0,
                                           magicCookie: nil,
                                           extensions: nil,
                                           formatDescriptionOut: &fd)
            formatDescription = fd
        }
        guard let formatDescription else { return nil }

        // Host time → CMTime on the host clock.
        let seconds = AVAudioTime.seconds(forHostTime: time.hostTime)
        let pts = CMTime(seconds: seconds, preferredTimescale: 1_000_000_000)

        var sampleBuffer: CMSampleBuffer?
        let frameCount = CMItemCount(buffer.frameLength)
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(CanonicalAudio.sampleRate)),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid)

        guard CMSampleBufferCreate(allocator: nil,
                                   dataBuffer: nil,
                                   dataReady: false,
                                   makeDataReadyCallback: nil,
                                   refcon: nil,
                                   formatDescription: formatDescription,
                                   sampleCount: frameCount,
                                   sampleTimingEntryCount: 1,
                                   sampleTimingArray: &timing,
                                   sampleSizeEntryCount: 0,
                                   sampleSizeArray: nil,
                                   sampleBufferOut: &sampleBuffer) == noErr,
              let sampleBuffer else { return nil }

        // The ABL is canonical non-interleaved Float32 stereo (two buffers),
        // matching the format description created from the buffer's own ASBD
        // (kAudioFormatFlagIsNonInterleaved set), as this API requires.
        // verify on Mac: AVAssetWriterInput accepts non-interleaved float
        // LPCM input for AAC encode (it should — the writer converts);
        // if appendAudio ever fails with -12780, pass
        // kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment in
        // `flags` or interleave before appending.
        let status = CMSampleBufferSetDataBufferFromAudioBufferList(
            sampleBuffer,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            bufferList: buffer.audioBufferList)
        guard status == noErr else { return nil }
        return sampleBuffer
    }
}
