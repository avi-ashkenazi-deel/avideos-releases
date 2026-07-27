import AVFoundation
import Darwin
import os

/// The one interior format for the audio subsystem: everything inside
/// `AudioEngineController`'s graph, every ring buffer, and both virtual-device
/// feeders speak 48 kHz / Float32 / stereo. The HAL driver is fixed at the
/// same rate, so the feeder side never resamples.
enum CanonicalAudio {
    static let sampleRate: Double = 48_000
    static let channelCount: AVAudioChannelCount = 2

    /// Deinterleaved Float32 stereo @ 48 kHz ("standard" format).
    static var format: AVAudioFormat {
        AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channelCount)!
    }
}

/// Lock-free single-producer / single-consumer ring of interleaved stereo
/// Float32 frames.
///
/// This is the joint between two CoreAudio clock domains (e.g. the mic
/// device's input callback and the mix engine's render thread). The two
/// clocks are nominally both 48 kHz but free-run against each other, so the
/// ring also carries the drift policy: underruns zero-fill (reader keeps
/// real time), and a sustained overrun (writer's clock running fast) is
/// corrected by skipping frames at a read boundary rather than letting
/// latency creep up to the full ring depth.
///
/// Real-time safety: `write`/`read`/`occupancy` never allocate, never lock,
/// and never call into the Swift runtime beyond pointer arithmetic. Counters
/// live in manually allocated memory so concurrent access can't trip Swift's
/// exclusivity checking on stored properties.
final class RingBuffer: @unchecked Sendable {

    /// Capacity in frames; always a power of two.
    let capacityFrames: Int

    private let mask: Int64
    private let storage: UnsafeMutablePointer<Float>          // interleaved L R L R …
    private let writeCounter: UnsafeMutablePointer<Int64>     // monotonic frames written
    private let readCounter: UnsafeMutablePointer<Int64>      // monotonic frames read
    private let droppedByCorrection: UnsafeMutablePointer<Int64>
    private let rejectedOnOverflow: UnsafeMutablePointer<Int64>

    // Drift correction (reader-thread state; the reader is the only mutator).
    private let highWatermarkFrames: Int
    private let correctionTargetFrames: Int
    private var overWatermarkStreak: Int = 0
    private static let sustainedReadsBeforeCorrection = 32

    private static let signpostLog = OSLog(subsystem: "com.aviashkenazi.streamit",
                                           category: "audio-ring")

    /// - Parameter duration: requested depth in seconds; rounded up to a
    ///   power-of-two frame count. Default ~200 ms.
    init(duration: TimeInterval = 0.2, sampleRate: Double = CanonicalAudio.sampleRate) {
        let requested = max(256, Int(duration * sampleRate))
        var capacity = 256
        while capacity < requested { capacity <<= 1 }
        capacityFrames = capacity
        mask = Int64(capacity - 1)
        highWatermarkFrames = (capacity * 3) / 4
        correctionTargetFrames = capacity / 2

        storage = .allocate(capacity: capacity * 2)
        storage.initialize(repeating: 0, count: capacity * 2)
        writeCounter = .allocate(capacity: 1)
        readCounter = .allocate(capacity: 1)
        droppedByCorrection = .allocate(capacity: 1)
        rejectedOnOverflow = .allocate(capacity: 1)
        writeCounter.initialize(to: 0)
        readCounter.initialize(to: 0)
        droppedByCorrection.initialize(to: 0)
        rejectedOnOverflow.initialize(to: 0)
    }

    deinit {
        storage.deallocate()
        writeCounter.deallocate()
        readCounter.deallocate()
        droppedByCorrection.deallocate()
        rejectedOnOverflow.deallocate()
    }

    // MARK: - Atomics
    // SPSC needs only acquire/release on two 64-bit counters. Aligned 64-bit
    // loads/stores are single-copy-atomic on arm64/x86_64; OSMemoryBarrier
    // supplies the fence. It is deprecated but lock-free and correct.
    // verify on Mac: swap for swift-atomics `ManagedAtomic<Int64>` if the
    // package is ever added to project.yml.

    @inline(__always)
    private func loadAcquire(_ p: UnsafeMutablePointer<Int64>) -> Int64 {
        let v = p.pointee
        OSMemoryBarrier()
        return v
    }

    @inline(__always)
    private func storeRelease(_ v: Int64, into p: UnsafeMutablePointer<Int64>) {
        OSMemoryBarrier()
        p.pointee = v
    }

    // MARK: - Introspection

    /// Frames currently buffered (approximate under concurrency, exact from
    /// either the producer or consumer thread).
    func occupancy() -> Int {
        let w = loadAcquire(writeCounter)
        let r = loadAcquire(readCounter)
        return max(0, Int(w - r))
    }

    /// Monotonic total frames ever written / read (drift-corrected skips
    /// count as read).
    var totalFramesWritten: Int64 { loadAcquire(writeCounter) }
    var totalFramesRead: Int64 { loadAcquire(readCounter) }
    /// Frames discarded by the drift-correction hook.
    var framesDroppedByCorrection: Int64 { loadAcquire(droppedByCorrection) }
    /// Frames the producer offered that didn't fit.
    var framesRejectedOnOverflow: Int64 { loadAcquire(rejectedOnOverflow) }

    /// Discards all buffered audio (call only while producer & consumer are
    /// quiescent, e.g. between engine starts).
    func reset() {
        storeRelease(loadAcquire(writeCounter), into: readCounter)
        overWatermarkStreak = 0
    }

    // MARK: - Producer

    /// Writes interleaved stereo frames. Returns frames actually written
    /// (short on overflow; the remainder is dropped and counted).
    @discardableResult
    func write(interleaved src: UnsafePointer<Float>, frameCount: Int) -> Int {
        let w = loadAcquire(writeCounter)
        let r = loadAcquire(readCounter)
        let free = capacityFrames - Int(w - r)
        let n = min(frameCount, max(0, free))
        if n < frameCount {
            storeRelease(loadAcquire(rejectedOnOverflow) + Int64(frameCount - n),
                         into: rejectedOnOverflow)
        }
        guard n > 0 else { return 0 }

        let start = Int(w & mask)
        let firstSeg = min(n, capacityFrames - start)
        memcpy(storage + start * 2, src, firstSeg * 2 * MemoryLayout<Float>.size)
        if n > firstSeg {
            memcpy(storage, src + firstSeg * 2, (n - firstSeg) * 2 * MemoryLayout<Float>.size)
        }
        storeRelease(w + Int64(n), into: writeCounter)
        return n
    }

    /// Writes from two deinterleaved channel pointers (the canonical
    /// AVAudioPCMBuffer layout), interleaving into the ring.
    @discardableResult
    func write(left: UnsafePointer<Float>, right: UnsafePointer<Float>, frameCount: Int) -> Int {
        let w = loadAcquire(writeCounter)
        let r = loadAcquire(readCounter)
        let free = capacityFrames - Int(w - r)
        let n = min(frameCount, max(0, free))
        if n < frameCount {
            storeRelease(loadAcquire(rejectedOnOverflow) + Int64(frameCount - n),
                         into: rejectedOnOverflow)
        }
        guard n > 0 else { return 0 }

        var pos = Int(w & mask)
        for i in 0..<n {
            let base = pos * 2
            storage[base] = left[i]
            storage[base + 1] = right[i]
            pos = (pos + 1) & Int(mask)
        }
        storeRelease(w + Int64(n), into: writeCounter)
        return n
    }

    // MARK: - Consumer

    /// Reads interleaved stereo frames; zero-fills any shortfall. Returns the
    /// number of *real* frames delivered (< frameCount means underrun).
    @discardableResult
    func read(into dst: UnsafeMutablePointer<Float>, frameCount: Int) -> Int {
        var r = loadAcquire(readCounter)
        r = applyDriftCorrection(read: r)
        let w = loadAcquire(writeCounter)
        let available = Int(w - r)
        let n = min(frameCount, max(0, available))

        if n > 0 {
            let start = Int(r & mask)
            let firstSeg = min(n, capacityFrames - start)
            memcpy(dst, storage + start * 2, firstSeg * 2 * MemoryLayout<Float>.size)
            if n > firstSeg {
                memcpy(dst + firstSeg * 2, storage, (n - firstSeg) * 2 * MemoryLayout<Float>.size)
            }
            storeRelease(r + Int64(n), into: readCounter)
        }
        if n < frameCount {
            memset(dst + n * 2, 0, (frameCount - n) * 2 * MemoryLayout<Float>.size)
        }
        return n
    }

    /// Reads into two deinterleaved channel pointers (for AVAudioSourceNode
    /// output buffer lists); zero-fills any shortfall.
    @discardableResult
    func read(intoLeft left: UnsafeMutablePointer<Float>,
              right: UnsafeMutablePointer<Float>,
              frameCount: Int) -> Int {
        var r = loadAcquire(readCounter)
        r = applyDriftCorrection(read: r)
        let w = loadAcquire(writeCounter)
        let available = Int(w - r)
        let n = min(frameCount, max(0, available))

        if n > 0 {
            var pos = Int(r & mask)
            for i in 0..<n {
                let base = pos * 2
                left[i] = storage[base]
                right[i] = storage[base + 1]
                pos = (pos + 1) & Int(mask)
            }
            storeRelease(r + Int64(n), into: readCounter)
        }
        if n < frameCount {
            let bytes = (frameCount - n) * MemoryLayout<Float>.size
            memset(left + n, 0, bytes)
            memset(right + n, 0, bytes)
        }
        return n
    }

    // MARK: - Drift correction

    /// If the producer clock runs fast, occupancy climbs toward capacity and
    /// stays there — every buffered frame is added latency. After the
    /// occupancy has exceeded the high watermark for a sustained run of read
    /// callbacks, skip forward to the target depth in one jump at this buffer
    /// boundary (one audible click at most, instead of permanent extra
    /// latency followed by a hard overflow). Reader-thread only.
    @inline(__always)
    private func applyDriftCorrection(read r: Int64) -> Int64 {
        let w = loadAcquire(writeCounter)
        let occ = Int(w - r)
        if occ > highWatermarkFrames {
            overWatermarkStreak += 1
            if overWatermarkStreak >= Self.sustainedReadsBeforeCorrection {
                let skip = Int64(occ - correctionTargetFrames)
                let newRead = r + skip
                storeRelease(newRead, into: readCounter)
                storeRelease(loadAcquire(droppedByCorrection) + skip, into: droppedByCorrection)
                overWatermarkStreak = 0
                os_signpost(.event, log: Self.signpostLog, name: "drift-skip",
                            "skipped %lld frames", skip)
                return newRead
            }
        } else {
            overWatermarkStreak = 0
        }
        return r
    }
}
