import XCTest
@testable import AVideosStudio

/// Pins down per-track level control in the editor: the dB→linear conversion,
/// how mute and solo resolve against each other, and the storage rule that
/// keeps unity tracks out of the document.
final class TrackMixTests: XCTestCase {

    private func project(trackCount: Int = 3) -> EditProject {
        let tracks = (0..<trackCount).map { i in
            EditTrack(id: "t\(i)",
                      participantId: "p\(i)",
                      participantName: "Speaker \(i)",
                      kind: .audio,
                      url: URL(fileURLWithPath: "/tmp/t\(i).mov"),
                      duration: 60)
        }
        return EditProject(sessionId: "s", name: "Mix", tracks: tracks)
    }

    // MARK: dB → linear

    func testUnityIsZeroDBAndGainOfOne() {
        XCTAssertEqual(TrackMix.unity.gainDB, 0, accuracy: 1e-9)
        XCTAssertEqual(TrackMix.unity.linearGain, 1, accuracy: 1e-6)
    }

    func testMinusSixDBIsAboutHalfAmplitude() {
        let mix = TrackMix(gainDB: -6)
        XCTAssertEqual(mix.linearGain, 0.501, accuracy: 0.005)
    }

    func testPlusSixDBIsAboutDoubleAmplitude() {
        XCTAssertEqual(TrackMix(gainDB: 6).linearGain, 1.995, accuracy: 0.01)
    }

    func testMinusTwentyFourDBIsQuietButNotSilent() {
        let gain = TrackMix(gainDB: -24).linearGain
        XCTAssertGreaterThan(gain, 0)
        XCTAssertEqual(gain, 0.063, accuracy: 0.002)
    }

    func testMuteIsSilentRegardlessOfGain() {
        XCTAssertEqual(TrackMix(gainDB: 12, isMuted: true).linearGain, 0, accuracy: 1e-9,
                       "mute wins over any trim")
    }

    // MARK: Solo

    func testNoSoloMeansEveryTrackPlaysAtItsOwnGain() {
        var p = project()
        p.setMix(TrackMix(gainDB: -6), for: "t1")
        XCTAssertFalse(p.isAnyTrackSoloed)
        XCTAssertEqual(p.linearGain(for: "t0"), 1, accuracy: 1e-6)
        XCTAssertEqual(p.linearGain(for: "t1"), 0.501, accuracy: 0.005)
    }

    func testSoloSilencesEveryoneElse() {
        var p = project()
        p.setMix(TrackMix(isSolo: true), for: "t1")
        XCTAssertTrue(p.isAnyTrackSoloed)
        XCTAssertEqual(p.linearGain(for: "t1"), 1, accuracy: 1e-6, "the soloed track plays")
        XCTAssertEqual(p.linearGain(for: "t0"), 0, accuracy: 1e-9)
        XCTAssertEqual(p.linearGain(for: "t2"), 0, accuracy: 1e-9)
    }

    func testSoloKeepsTheSoloedTracksOwnTrim() {
        var p = project()
        p.setMix(TrackMix(gainDB: -6, isSolo: true), for: "t1")
        XCTAssertEqual(p.linearGain(for: "t1"), 0.501, accuracy: 0.005,
                       "soloing doesn't reset the fader")
    }

    func testSeveralTracksCanBeSoloedTogether() {
        var p = project()
        p.setMix(TrackMix(isSolo: true), for: "t0")
        p.setMix(TrackMix(isSolo: true), for: "t2")
        XCTAssertEqual(p.linearGain(for: "t0"), 1, accuracy: 1e-6)
        XCTAssertEqual(p.linearGain(for: "t2"), 1, accuracy: 1e-6)
        XCTAssertEqual(p.linearGain(for: "t1"), 0, accuracy: 1e-9)
    }

    func testMuteBeatsSoloOnTheSameTrack() {
        var p = project()
        p.setMix(TrackMix(isMuted: true, isSolo: true), for: "t0")
        XCTAssertEqual(p.linearGain(for: "t0"), 0, accuracy: 1e-9,
                       "explicitly muting a track you also soloed keeps it silent")
    }

    // MARK: Storage

    func testUnityIsNotPersisted() {
        var p = project()
        p.setMix(TrackMix(gainDB: -6), for: "t1")
        XCTAssertNotNil(p.trackMix)
        p.setMix(.unity, for: "t1")
        XCTAssertNil(p.trackMix, "a document shouldn't carry rows that say nothing")
    }

    func testUnknownTrackReadsAsUnity() {
        let p = project()
        XCTAssertEqual(p.mix(for: "nope"), .unity)
        XCTAssertEqual(p.linearGain(for: "nope"), 1, accuracy: 1e-6)
    }

    func testMixRoundTrips() throws {
        var p = project()
        p.setMix(TrackMix(gainDB: -3.5, isMuted: false, isSolo: true), for: "t0")
        p.setMix(TrackMix(gainDB: 2, isMuted: true), for: "t2")

        let data = try JSONEncoder().encode(p)
        let decoded = try JSONDecoder().decode(EditProject.self, from: data)
        XCTAssertEqual(decoded.mix(for: "t0"), p.mix(for: "t0"))
        XCTAssertEqual(decoded.mix(for: "t2"), p.mix(for: "t2"))
        XCTAssertEqual(decoded, p)
    }

    func testProjectWithoutAMixKeyDecodes() throws {
        // Projects saved before per-track levels existed.
        let p = project()
        XCTAssertNil(p.trackMix)
        let data = try JSONEncoder().encode(p)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertFalse(json.contains("trackMix"), "nil optionals aren't written")
        let decoded = try JSONDecoder().decode(EditProject.self, from: data)
        XCTAssertEqual(decoded.linearGain(for: "t0"), 1, accuracy: 1e-6,
                       "an old project plays at unity, as it always did")
    }
}
