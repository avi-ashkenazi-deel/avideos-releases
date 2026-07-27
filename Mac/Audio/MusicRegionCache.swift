import Foundation
import AVFoundation
import Observation
import os

/// Decoded, canonical-format PCM for the parts of a track the host loops live.
///
/// Sections are scheduled as buffers rather than file segments so the wrap can
/// use `AVAudioPlayerNodeBufferOptions.loops` — the loop then happens inside
/// AVFoundation's render loop, bit-exact, with no completion handler per pass
/// and no work of ours in the audible path. That is also what gives
/// `.interrupts` / `.interruptsAtLoop` for switching.
///
/// The cost is memory: canonical Float32 stereo at 48 kHz is ~23 MB per minute.
/// Hence the length cap on a single region and the LRU budget across all of
/// them.
@MainActor
@Observable
final class MusicRegionCache {
    /// Total resident audio before eviction starts. Generous, but this runs
    /// alongside a video compositor and a LiveKit stack.
    static let byteBudget = 256 * 1024 * 1024
    /// Never evict below this many regions: whatever is playing, plus whatever
    /// is queued to play next. Honoured even when it exceeds the budget —
    /// dropping the buffer you are about to switch to is worse than being fat.
    static let residentFloor = 2

    struct Key: Hashable, Sendable {
        let trackID: UUID
        let sectionID: UUID
    }

    enum Failure: Error, Equatable {
        case missingFile
        case unreadable
        case regionInvalid(LoopRegion.Invalid)

        var reason: String {
            switch self {
            case .missingFile: "That music file has moved or been deleted."
            case .unreadable: "That file couldn't be decoded."
            case .regionInvalid(let why): why.reason
            }
        }
    }

    private struct Entry {
        let buffer: AVAudioPCMBuffer
        let region: LoopRegion
        var lastUsed: UInt64
    }

    private var entries: [Key: Entry] = [:]
    private var inFlight: Set<Key> = []
    /// Monotonic counter rather than a clock: LRU only needs an ordering, and
    /// wall-clock reads here would be pointless work at 15 Hz.
    private var useCounter: UInt64 = 0
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "musicregion")

    /// Serial on purpose: two quick section presses must not decode
    /// concurrently and allocate 140 MB at once.
    private let decodeQueue = DispatchQueue(
        label: "com.aviashkenazi.avideos.music-decode", qos: .userInitiated)

    private(set) var residentBytes = 0

    // MARK: - Lookup

    /// The decoded region, if it is resident. Marks it as recently used.
    func buffer(for key: Key) -> (buffer: AVAudioPCMBuffer, region: LoopRegion)? {
        guard var entry = entries[key] else { return nil }
        useCounter += 1
        entry.lastUsed = useCounter
        entries[key] = entry
        return (entry.buffer, entry.region)
    }

    func isResident(_ key: Key) -> Bool { entries[key] != nil }

    // MARK: - Decode

    /// Decodes a region in the background if it isn't already resident.
    ///
    /// Called at track load rather than at switch time, so a live switch finds
    /// the buffer already there. If it doesn't, the switch waits rather than
    /// glitching — and under `atLoopEnd` that just means landing at a later
    /// boundary.
    func prepare(key: Key,
                 url: URL,
                 startSeconds: Double,
                 endSeconds: Double,
                 completion: ((Result<Void, Failure>) -> Void)? = nil) {
        if entries[key] != nil {
            completion?(.success(()))
            return
        }
        guard !inFlight.contains(key) else { return }

        // Duration is unknown until the file is open, so the length rules are
        // checked against the authored span here and re-checked after decode.
        switch LoopRegion.make(startSeconds: startSeconds,
                               endSeconds: endSeconds,
                               trackDurationSeconds: max(endSeconds, startSeconds) + 1) {
        case .failure(let why):
            completion?(.failure(.regionInvalid(why)))
            return
        case .success:
            break
        }

        inFlight.insert(key)
        decodeQueue.async { [weak self] in
            let result = Self.decode(url: url, startSeconds: startSeconds, endSeconds: endSeconds)
            Task { @MainActor in
                guard let self else { return }
                self.inFlight.remove(key)
                switch result {
                case .success(let decoded):
                    self.store(key: key, buffer: decoded.buffer, region: decoded.region)
                    completion?(.success(()))
                case .failure(let failure):
                    self.log.error("region decode failed: \(failure.reason, privacy: .public)")
                    completion?(.failure(failure))
                }
            }
        }
    }

    /// Extra file frames decoded before the region start and then trimmed away.
    ///
    /// Decoding a mid-file region in isolation can emit a little resampler
    /// priming garbage at the head; with `.loops` that head is the wrap point,
    /// so it would tick once per pass. Trimming makes the question moot whether
    /// or not the artifact is audible.
    private static let guardFrames: AVAudioFramePosition = 2048

    private nonisolated static func decode(
        url: URL,
        startSeconds: Double,
        endSeconds: Double
    ) -> Result<(buffer: AVAudioPCMBuffer, region: LoopRegion), Failure> {
        guard FileManager.default.fileExists(atPath: url.path) else { return .failure(.missingFile) }
        guard let file = try? AVAudioFile(forReading: url) else { return .failure(.unreadable) }

        let fileRate = file.processingFormat.sampleRate
        let duration = Double(file.length) / fileRate
        let region: LoopRegion
        switch LoopRegion.make(startSeconds: startSeconds,
                               endSeconds: endSeconds,
                               trackDurationSeconds: duration) {
        case .success(let made): region = made
        case .failure(let why): return .failure(.regionInvalid(why))
        }

        // Read in FILE frames, with the guard margin, clamped to the file.
        let wantedStart = AVAudioFramePosition((startSeconds * fileRate).rounded())
        let readStart = max(0, wantedStart - guardFrames)
        let readEnd = min(file.length,
                          AVAudioFramePosition((min(endSeconds, duration) * fileRate).rounded()))
        let readLength = readEnd - readStart
        guard readLength > 0 else { return .failure(.regionInvalid(.tooShort)) }

        file.framePosition = readStart
        guard let fileBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                                frameCapacity: AVAudioFrameCount(readLength)),
              (try? file.read(into: fileBuffer, frameCount: AVAudioFrameCount(readLength))) != nil
        else { return .failure(.unreadable) }

        let canonical = CanonicalAudio.format
        let converted: AVAudioPCMBuffer
        if file.processingFormat == canonical {
            converted = fileBuffer
        } else {
            guard let convertor = AVAudioConverter(from: file.processingFormat, to: canonical) else {
                return .failure(.unreadable)
            }
            let ratio = canonical.sampleRate / fileRate
            let capacity = AVAudioFrameCount(Double(readLength) * ratio) + 4096
            guard let output = AVAudioPCMBuffer(pcmFormat: canonical, frameCapacity: capacity) else {
                return .failure(.unreadable)
            }
            var fed = false
            convertor.convert(to: output, error: nil, withInputFrom: { _, status in
                if fed {
                    status.pointee = .endOfStream
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return fileBuffer
            })
            converted = output
        }

        // Trim the guard margin off the head, in CANONICAL frames.
        let leadFrames = AVAudioFramePosition(
            (Double(wantedStart - readStart) / fileRate * CanonicalAudio.sampleRate).rounded())
        guard let trimmed = trim(converted, droppingLeading: leadFrames,
                                 maxLength: region.lengthFrames) else {
            return .failure(.unreadable)
        }

        // `converted.frameLength` is authoritative, never `seconds × 48000`:
        // the convertor returns fewer frames than the capacity, and an
        // off-by-a-few-frames modulus is a loop that slowly drifts.
        let exact = LoopRegion(startFrame: region.startFrame,
                               lengthFrames: AVAudioFramePosition(trimmed.frameLength))
        return .success((trimmed, exact))
    }

    private nonisolated static func trim(_ buffer: AVAudioPCMBuffer,
                                         droppingLeading lead: AVAudioFramePosition,
                                         maxLength: AVAudioFramePosition) -> AVAudioPCMBuffer? {
        let available = AVAudioFramePosition(buffer.frameLength) - lead
        guard available > 0 else { return nil }
        let length = AVAudioFrameCount(min(available, maxLength))
        guard lead > 0 || AVAudioFramePosition(buffer.frameLength) > maxLength else { return buffer }

        guard let output = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: length),
              let source = buffer.floatChannelData,
              let destination = output.floatChannelData else { return nil }
        let channels = Int(buffer.format.channelCount)
        for channel in 0..<channels {
            destination[channel].update(from: source[channel] + Int(lead), count: Int(length))
        }
        output.frameLength = length
        return output
    }

    // MARK: - Residency

    private func store(key: Key, buffer: AVAudioPCMBuffer, region: LoopRegion) {
        useCounter += 1
        entries[key] = Entry(buffer: buffer, region: region, lastUsed: useCounter)
        recomputeBytes()
        evictIfNeeded(protecting: [key])
    }

    /// Drops least-recently-used regions until the budget is met, never going
    /// below the resident floor and never touching a protected key.
    func evictIfNeeded(protecting protected: Set<Key>) {
        guard residentBytes > Self.byteBudget else { return }
        let candidates = entries
            .filter { !protected.contains($0.key) }
            .sorted { $0.value.lastUsed < $1.value.lastUsed }

        for (key, _) in candidates {
            guard residentBytes > Self.byteBudget,
                  entries.count > Self.residentFloor else { break }
            entries.removeValue(forKey: key)
            recomputeBytes()
        }
    }

    /// Everything for one track — call after its sections change or its file
    /// is relinked.
    func invalidate(trackID: UUID) {
        entries = entries.filter { $0.key.trackID != trackID }
        recomputeBytes()
    }

    func invalidate(key: Key) {
        entries.removeValue(forKey: key)
        recomputeBytes()
    }

    private func recomputeBytes() {
        residentBytes = entries.values.reduce(0) { $0 + Self.byteCount(of: $1.buffer) }
    }

    static func byteCount(of buffer: AVAudioPCMBuffer) -> Int {
        Int(buffer.frameLength) * Int(buffer.format.channelCount) * MemoryLayout<Float>.size
    }
}
