import XCTest
@testable import Streamit

/// The pure cores of the editor's new audio features: loudness gating
/// (LoudnessMeter), the music bed's edge fades (VolumeAutomation), and the
/// multicam audio-sync correlation (AudioAligner). Everything here runs
/// without media files or hardware.
final class EditorAudioTests: XCTestCase {

    // MARK: - Loudness gating (BS.1770 two-stage)

    /// A block of mean-square `ms` has loudness −0.691 + 10·log10(ms), so
    /// ms = 0.1 ⇒ ≈ −10.7 LUFS.
    func testIntegrateUniformBlocks() throws {
        let lufs = try XCTUnwrap(LoudnessMeter.integrate(blockMeanSquares: Array(repeating: 0.1, count: 100)))
        XCTAssertEqual(lufs, -0.691 + 10 * log10(0.1), accuracy: 0.001)
    }

    func testIntegrateSilenceIsNil() {
        // −100 dB blocks sit far below the −70 LUFS absolute gate.
        XCTAssertNil(LoudnessMeter.integrate(blockMeanSquares: Array(repeating: 1e-10, count: 50)))
        XCTAssertNil(LoudnessMeter.integrate(blockMeanSquares: []))
    }

    /// The relative gate exists to keep long silences and room tone from
    /// dragging the integrated number down: speech at ~−20 LUFS interleaved
    /// with near-silence must measure like the speech, not the average.
    func testRelativeGateIgnoresQuietStretches() throws {
        let speech = Array(repeating: 0.01, count: 50)      // −20.7 LUFS blocks
        let roomTone = Array(repeating: 1e-6, count: 50)    // −60.7 LUFS blocks
        let lufs = try XCTUnwrap(LoudnessMeter.integrate(blockMeanSquares: speech + roomTone))
        XCTAssertEqual(lufs, -0.691 + 10 * log10(0.01), accuracy: 0.1)
    }

    // MARK: - Music-bed edge fades

    func testEdgeFadesReachSilenceAtSpanEdges() {
        let flat = [VolumeAutomation.Point(time: 0, volume: 1),
                    VolumeAutomation.Point(time: 100, volume: 1)]
        let faded = VolumeAutomation.fadedAtEdges(flat, spanStart: 10, spanEnd: 90, fade: 2)

        func volume(at time: Double) -> Float? {
            faded.first { abs($0.time - time) < 0.0001 }?.volume
        }
        XCTAssertEqual(volume(at: 10), 0)          // enters from silence
        XCTAssertEqual(volume(at: 12), 1)          // fully in after the fade
        XCTAssertEqual(volume(at: 88), 1)          // still full before fade-out
        XCTAssertEqual(volume(at: 90), 0)          // leaves to silence
    }

    func testEdgeFadesPreserveDucksInsideTheSpan() {
        // A duck to 0.25 in the middle must survive the fade multiply.
        let points = [VolumeAutomation.Point(time: 0, volume: 1),
                      VolumeAutomation.Point(time: 40, volume: 0.25),
                      VolumeAutomation.Point(time: 60, volume: 0.25),
                      VolumeAutomation.Point(time: 100, volume: 1)]
        let faded = VolumeAutomation.fadedAtEdges(points, spanStart: 0, spanEnd: 100, fade: 5)
        let mid = faded.first { $0.time == 50 } ?? faded.first { abs($0.time - 50) < 6 }
        // Any breakpoint well inside the duck stays at the ducked level.
        let inside = faded.filter { $0.time >= 40 && $0.time <= 60 }
        XCTAssertFalse(inside.isEmpty)
        for point in inside {
            XCTAssertEqual(point.volume, 0.25, accuracy: 0.001)
        }
        _ = mid
    }

    func testEdgeFadeTimesAreStrictlyIncreasing() {
        let points = [VolumeAutomation.Point(time: 0, volume: 1),
                      VolumeAutomation.Point(time: 30, volume: 0.5),
                      VolumeAutomation.Point(time: 100, volume: 1)]
        let faded = VolumeAutomation.fadedAtEdges(points, spanStart: 0, spanEnd: 100, fade: 3)
        for (a, b) in zip(faded, faded.dropFirst()) {
            XCTAssertLessThan(a.time, b.time)
        }
    }

    // MARK: - Multicam audio-sync correlation

    /// Builds a speech-like random envelope; both "recordings" see the same
    /// events, the external one delayed by `lag` samples.
    private func syntheticEnvelopes(lag: Int,
                                    referenceLength: Int = 12_000,
                                    seed: UInt64 = 7) -> (external: [Float], reference: [Float]) {
        // Deterministic pseudo-random bursts (no seeded RNG in Foundation).
        var state = seed
        func next() -> Float {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Float(state >> 40) / Float(1 << 24)
        }
        var reference = [Float](repeating: 0, count: referenceLength)
        var i = 0
        while i < referenceLength {
            let burst = 20 + Int(next() * 200)      // 0.4–4.4 s of "speech"
            let level = 0.2 + next() * 0.8
            for j in i..<min(i + burst, referenceLength) { reference[j] = level }
            i += burst + 10 + Int(next() * 100)     // then a pause
        }
        // The external camera hears the same room, quieter, starting later:
        // external[t] = reference[t + lag] scaled — so the external file's
        // t=0 sits at reference time `lag`.
        let externalLength = referenceLength - lag
        var external = [Float](repeating: 0, count: externalLength)
        for t in 0..<externalLength {
            external[t] = reference[t + lag] * 0.6
        }
        return (external, reference)
    }

    func testAlignRecoversKnownOffset() throws {
        let lagSamples = 500   // 10 s at the 20 ms hop
        let (external, reference) = syntheticEnvelopes(lag: lagSamples)
        let alignment = try AudioAligner.alignEnvelopes(external: external, reference: reference)
        XCTAssertEqual(alignment.sourceOffset,
                       Double(lagSamples) * AudioAligner.hopSeconds,
                       accuracy: AudioAligner.hopSeconds * 2)
        XCTAssertGreaterThanOrEqual(alignment.confidence, 4)
    }

    func testAlignRejectsUncorrelatedAudio() {
        let (external, _) = syntheticEnvelopes(lag: 100, seed: 7)
        let (_, otherReference) = syntheticEnvelopes(lag: 100, seed: 99)
        XCTAssertThrowsError(try AudioAligner.alignEnvelopes(external: external,
                                                             reference: otherReference))
    }

    func testAlignRejectsTooShortInput() {
        XCTAssertThrowsError(try AudioAligner.alignEnvelopes(external: [0.1, 0.2],
                                                             reference: [0.1, 0.2]))
    }

    // MARK: - Music bed persistence

    func testProjectDecodesWithoutMusicBedField() throws {
        // The settings-decode rule: a new Optional field must not break
        // documents written before it existed.
        var project = EditProject(sessionId: "s", name: "Bed", tracks: [])
        project.musicBed = nil
        let data = try JSONEncoder().encode(project)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["musicBed"], "nil must not be written, so old and new files agree")
        let decoded = try JSONDecoder().decode(EditProject.self, from: data)
        XCTAssertNil(decoded.musicBed)
    }

    func testMusicBedRoundTrip() throws {
        var project = EditProject(sessionId: "s", name: "Bed", tracks: [])
        project.musicBed = MusicBed(media: MediaReference(url: URL(fileURLWithPath: "/tmp/bed.mp3")),
                                    gainDB: -20, duckAmountDB: 9, loops: false, fadeSeconds: 3)
        let data = try JSONEncoder().encode(project)
        let decoded = try JSONDecoder().decode(EditProject.self, from: data)
        XCTAssertEqual(decoded.musicBed, project.musicBed)
    }
}
