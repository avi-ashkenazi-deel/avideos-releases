import XCTest
import AVFoundation
@testable import Streamit

/// Pins down the SPSC `RingBuffer` that joins the audio subsystem's clock
/// domains: frame accounting, wrap-around, the zero-fill underrun policy,
/// overflow rejection, and the sustained-overrun drift correction.
final class RingBufferTests: XCTestCase {

    // MARK: Geometry

    func testCapacityRoundsUpToAPowerOfTwo() {
        // 0.2s @ 48kHz = 9600 frames → 16384.
        let ring = RingBuffer(duration: 0.2, sampleRate: 48_000)
        XCTAssertEqual(ring.capacityFrames, 16_384)
        XCTAssertEqual(ring.capacityFrames & (ring.capacityFrames - 1), 0,
                       "capacity must be a power of two for the mask to work")
    }

    func testCapacityHasAFloor() {
        let ring = RingBuffer(duration: 0.0001, sampleRate: 48_000)
        XCTAssertEqual(ring.capacityFrames, 256)
    }

    func testStartsEmpty() {
        let ring = makeRing()
        XCTAssertEqual(ring.occupancy(), 0)
        XCTAssertEqual(ring.totalFramesWritten, 0)
        XCTAssertEqual(ring.totalFramesRead, 0)
    }

    // MARK: Round trip

    func testInterleavedWriteThenReadReturnsTheSameSamples() {
        let ring = makeRing()
        let frames = 128
        let source = ramp(frames: frames)

        let written = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: frames)
        }
        XCTAssertEqual(written, frames)
        XCTAssertEqual(ring.occupancy(), frames)

        var destination = [Float](repeating: -1, count: frames * 2)
        let read = destination.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: frames)
        }
        XCTAssertEqual(read, frames)
        XCTAssertEqual(destination, source)
        XCTAssertEqual(ring.occupancy(), 0, "a full read drains the ring")
    }

    func testDeinterleavedWriteInterleavesIntoTheRing() {
        let ring = makeRing()
        let frames = 64
        let left = (0..<frames).map { Float($0) }
        let right = (0..<frames).map { Float($0) + 1_000 }

        let written = left.withUnsafeBufferPointer { l in
            right.withUnsafeBufferPointer { r in
                ring.write(left: l.baseAddress!, right: r.baseAddress!, frameCount: frames)
            }
        }
        XCTAssertEqual(written, frames)

        var out = [Float](repeating: 0, count: frames * 2)
        _ = out.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: frames)
        }
        for i in 0..<frames {
            XCTAssertEqual(out[i * 2], left[i], "L channel at frame \(i)")
            XCTAssertEqual(out[i * 2 + 1], right[i], "R channel at frame \(i)")
        }
    }

    func testDeinterleavedReadSplitsChannelsBack() {
        let ring = makeRing()
        let frames = 32
        let source = ramp(frames: frames)
        _ = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: frames)
        }

        var left = [Float](repeating: 0, count: frames)
        var right = [Float](repeating: 0, count: frames)
        let read = left.withUnsafeMutableBufferPointer { l in
            right.withUnsafeMutableBufferPointer { r in
                ring.read(intoLeft: l.baseAddress!, right: r.baseAddress!, frameCount: frames)
            }
        }
        XCTAssertEqual(read, frames)
        for i in 0..<frames {
            XCTAssertEqual(left[i], source[i * 2])
            XCTAssertEqual(right[i], source[i * 2 + 1])
        }
    }

    // MARK: Accounting

    func testCountersAreMonotonic() {
        let ring = makeRing()
        let frames = 100
        let source = ramp(frames: frames)
        for _ in 0..<3 {
            _ = source.withUnsafeBufferPointer {
                ring.write(interleaved: $0.baseAddress!, frameCount: frames)
            }
        }
        XCTAssertEqual(ring.totalFramesWritten, Int64(frames * 3))
        XCTAssertEqual(ring.occupancy(), frames * 3)

        var out = [Float](repeating: 0, count: frames * 2)
        _ = out.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: frames)
        }
        XCTAssertEqual(ring.totalFramesRead, Int64(frames))
        XCTAssertEqual(ring.occupancy(), frames * 2)
    }

    func testPartialReadLeavesTheRemainderInOrder() {
        let ring = makeRing()
        let frames = 64
        let source = ramp(frames: frames)
        _ = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: frames)
        }

        var first = [Float](repeating: 0, count: 20 * 2)
        _ = first.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: 20)
        }
        XCTAssertEqual(first, Array(source[0..<40]))

        var rest = [Float](repeating: 0, count: 44 * 2)
        let read = rest.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: 44)
        }
        XCTAssertEqual(read, 44)
        XCTAssertEqual(rest, Array(source[40..<128]))
    }

    // MARK: Wrap-around

    func testWritesWrapAroundTheEndOfStorage() {
        let ring = RingBuffer(duration: 0.0001, sampleRate: 48_000)   // 256 frames
        XCTAssertEqual(ring.capacityFrames, 256)

        // Advance the write head near the end, then drain so there's room.
        let filler = ramp(frames: 200)
        _ = filler.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: 200)
        }
        var drain = [Float](repeating: 0, count: 200 * 2)
        _ = drain.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: 200)
        }

        // This write starts at frame 200 and must wrap past 256.
        let frames = 100
        let source = ramp(frames: frames, offset: 5_000)
        let written = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: frames)
        }
        XCTAssertEqual(written, frames)

        var out = [Float](repeating: 0, count: frames * 2)
        let read = out.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: frames)
        }
        XCTAssertEqual(read, frames)
        XCTAssertEqual(out, source, "samples must survive the wrap intact")
    }

    func testDeinterleavedWriteAlsoWraps() {
        let ring = RingBuffer(duration: 0.0001, sampleRate: 48_000)
        let filler = ramp(frames: 200)
        _ = filler.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: 200)
        }
        var drain = [Float](repeating: 0, count: 200 * 2)
        _ = drain.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: 200)
        }

        let frames = 100
        let left = (0..<frames).map { Float($0) }
        let right = (0..<frames).map { Float($0) + 500 }
        _ = left.withUnsafeBufferPointer { l in
            right.withUnsafeBufferPointer { r in
                ring.write(left: l.baseAddress!, right: r.baseAddress!, frameCount: frames)
            }
        }

        var outL = [Float](repeating: 0, count: frames)
        var outR = [Float](repeating: 0, count: frames)
        _ = outL.withUnsafeMutableBufferPointer { l in
            outR.withUnsafeMutableBufferPointer { r in
                ring.read(intoLeft: l.baseAddress!, right: r.baseAddress!, frameCount: frames)
            }
        }
        XCTAssertEqual(outL, left)
        XCTAssertEqual(outR, right)
    }

    // MARK: Underrun

    func testReadingAnEmptyRingZeroFillsAndReportsZeroRealFrames() {
        let ring = makeRing()
        var out = [Float](repeating: 42, count: 64 * 2)
        let read = out.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: 64)
        }
        XCTAssertEqual(read, 0, "no real frames were available")
        XCTAssertTrue(out.allSatisfy { $0 == 0 },
                      "the shortfall must be silence, not stale samples")
    }

    func testPartialUnderrunZeroFillsOnlyTheTail() {
        let ring = makeRing()
        let available = 10
        let source = ramp(frames: available, offset: 1)
        _ = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: available)
        }

        var out = [Float](repeating: 99, count: 32 * 2)
        let read = out.withUnsafeMutableBufferPointer {
            ring.read(into: $0.baseAddress!, frameCount: 32)
        }
        XCTAssertEqual(read, available)
        XCTAssertEqual(Array(out[0..<(available * 2)]), source)
        XCTAssertTrue(out[(available * 2)...].allSatisfy { $0 == 0 })
    }

    func testDeinterleavedUnderrunZeroFillsBothChannels() {
        let ring = makeRing()
        var left = [Float](repeating: 7, count: 16)
        var right = [Float](repeating: 7, count: 16)
        let read = left.withUnsafeMutableBufferPointer { l in
            right.withUnsafeMutableBufferPointer { r in
                ring.read(intoLeft: l.baseAddress!, right: r.baseAddress!, frameCount: 16)
            }
        }
        XCTAssertEqual(read, 0)
        XCTAssertTrue(left.allSatisfy { $0 == 0 })
        XCTAssertTrue(right.allSatisfy { $0 == 0 })
    }

    // MARK: Overflow

    func testOverflowWritesWhatFitsAndCountsTheRest() {
        let ring = RingBuffer(duration: 0.0001, sampleRate: 48_000)   // 256 frames
        let frames = 400
        let source = ramp(frames: frames)
        let written = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: frames)
        }
        XCTAssertEqual(written, 256, "only capacity frames fit")
        XCTAssertEqual(ring.framesRejectedOnOverflow, Int64(frames - 256))
        XCTAssertEqual(ring.occupancy(), 256)
    }

    func testWritingToAFullRingWritesNothing() {
        let ring = RingBuffer(duration: 0.0001, sampleRate: 48_000)
        let fill = ramp(frames: 256)
        _ = fill.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: 256)
        }
        let more = ramp(frames: 10)
        let written = more.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: 10)
        }
        XCTAssertEqual(written, 0)
        XCTAssertEqual(ring.framesRejectedOnOverflow, 10)
    }

    // MARK: Reset

    func testResetDiscardsBufferedAudioWithoutRewindingCounters() {
        let ring = makeRing()
        let source = ramp(frames: 100)
        _ = source.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: 100)
        }
        XCTAssertEqual(ring.occupancy(), 100)

        ring.reset()
        XCTAssertEqual(ring.occupancy(), 0)
        XCTAssertEqual(ring.totalFramesWritten, 100, "totals stay monotonic across a reset")
        XCTAssertEqual(ring.totalFramesRead, 100, "the reader is fast-forwarded to the writer")
    }

    // MARK: Drift correction

    func testSustainedOverrunTriggersOneSkipDownToTheTargetDepth() {
        // 256-frame ring: high watermark 192, correction target 128.
        let ring = RingBuffer(duration: 0.0001, sampleRate: 48_000)
        let block = 4

        // Keep occupancy above the watermark while reading small blocks, so
        // the reader observes a sustained overrun rather than a transient.
        var out = [Float](repeating: 0, count: block * 2)
        let refill = ramp(frames: block)

        // Prime above the watermark.
        let prime = ramp(frames: 240)
        _ = prime.withUnsafeBufferPointer {
            ring.write(interleaved: $0.baseAddress!, frameCount: 240)
        }
        XCTAssertGreaterThan(ring.occupancy(), 192)

        // 32 sustained over-watermark reads are needed before a correction.
        for _ in 0..<RingBufferTests.sustainedReads {
            _ = out.withUnsafeMutableBufferPointer {
                ring.read(into: $0.baseAddress!, frameCount: block)
            }
            // Producer keeps up, so occupancy stays high.
            _ = refill.withUnsafeBufferPointer {
                ring.write(interleaved: $0.baseAddress!, frameCount: block)
            }
        }

        XCTAssertGreaterThan(ring.framesDroppedByCorrection, 0,
                             "a sustained overrun must be corrected, not left as permanent latency")
        XCTAssertLessThanOrEqual(ring.occupancy(), 192,
                                 "occupancy is pulled back toward the target depth")
    }

    func testNoCorrectionWhenOccupancyStaysHealthy() {
        let ring = makeRing()
        let frames = 64
        let source = ramp(frames: frames)
        var out = [Float](repeating: 0, count: frames * 2)
        for _ in 0..<200 {
            _ = source.withUnsafeBufferPointer {
                ring.write(interleaved: $0.baseAddress!, frameCount: frames)
            }
            _ = out.withUnsafeMutableBufferPointer {
                ring.read(into: $0.baseAddress!, frameCount: frames)
            }
        }
        XCTAssertEqual(ring.framesDroppedByCorrection, 0)
        XCTAssertEqual(ring.framesRejectedOnOverflow, 0)
    }

    // MARK: Canonical format

    func testCanonicalFormatIs48kStereoFloat() {
        let format = CanonicalAudio.format
        XCTAssertEqual(format.sampleRate, 48_000)
        XCTAssertEqual(format.channelCount, 2)
        XCTAssertEqual(format.commonFormat, .pcmFormatFloat32)
        XCTAssertFalse(format.isInterleaved, "the graph speaks deinterleaved 'standard' format")
    }

    // MARK: Helpers

    /// Mirrors `RingBuffer.sustainedReadsBeforeCorrection` (private).
    private static let sustainedReads = 32

    private func makeRing() -> RingBuffer {
        RingBuffer(duration: 0.2, sampleRate: 48_000)
    }

    /// Interleaved stereo ramp: L = i, R = -i (offset to keep runs distinct).
    private func ramp(frames: Int, offset: Int = 0) -> [Float] {
        var out = [Float](repeating: 0, count: frames * 2)
        for i in 0..<frames {
            out[i * 2] = Float(offset + i)
            out[i * 2 + 1] = Float(-(offset + i))
        }
        return out
    }
}
