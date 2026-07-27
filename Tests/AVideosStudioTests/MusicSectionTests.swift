import XCTest
@testable import AVideosStudio

/// Sections, open-end resolution, timecode parsing — and the decode cases that
/// protect the host's whole audio configuration.
final class MusicSectionTests: XCTestCase {

    private func section(_ name: String,
                         _ start: Double,
                         _ end: Double? = nil,
                         hotkey: Int? = nil) -> MusicSection {
        MusicSection(name: name, start: start, end: end,
                     colorHex: AudioPalette.colors[0], hotkeyIndex: hotkey)
    }

    // MARK: Open-end resolution

    func testOpenSectionRunsToTheNextOne() {
        // This is what makes tap-to-mark work: three taps give three
        // contiguous sections without mutating any of the earlier ones.
        let ranges = MusicSection.resolvedRanges(
            [section("Intro", 0), section("Verse", 10), section("Chorus", 30)],
            duration: 60)
        XCTAssertEqual(ranges.count, 3)
        XCTAssertEqual(ranges.values.sorted { $0.lowerBound < $1.lowerBound }.map(\.upperBound),
                       [10, 30, 60])
    }

    func testExplicitEndWinsOverTheDerivedOne() {
        let ranges = MusicSection.resolvedRanges(
            [section("Intro", 0, 4), section("Verse", 10)], duration: 60)
        let intro = ranges.first { $0.value.lowerBound == 0 }?.value
        XCTAssertEqual(intro?.upperBound, 4, "an explicit end must not be widened to the next start")
    }

    func testLastOpenSectionRunsToTheEndOfTheFile() {
        let ranges = MusicSection.resolvedRanges([section("Outro", 50)], duration: 60)
        XCTAssertEqual(ranges.values.first?.upperBound, 60)
    }

    func testRangesAreClampedToTheFile() {
        let ranges = MusicSection.resolvedRanges([section("Long", 10, 999)], duration: 60)
        XCTAssertEqual(ranges.values.first?.upperBound, 60)
    }

    func testSectionsTooShortToLoopAreDropped() {
        let ranges = MusicSection.resolvedRanges(
            [section("Blink", 10, 10.05), section("Real", 20)], duration: 60)
        XCTAssertEqual(ranges.count, 1, "a 50ms section is a buzz, not a loop")
    }

    func testNoSectionsResolvesEmpty() {
        XCTAssertTrue(MusicSection.resolvedRanges([], duration: 60).isEmpty)
    }

    // MARK: Hotkey assignment

    func testNextFreeHotkeyFillsGaps() {
        let sections = [section("a", 0, hotkey: 1), section("b", 5, hotkey: 3)]
        XCTAssertEqual(MusicSection.nextFreeHotkeyIndex(in: sections), 2)
    }

    func testNextFreeHotkeyIsNilWhenFull() {
        let sections = (1...9).map { section("s\($0)", Double($0), hotkey: $0) }
        XCTAssertNil(MusicSection.nextFreeHotkeyIndex(in: sections))
    }

    func testHotkeyResolvesByBindingNotPosition() {
        // The reason positional mapping was rejected: sections stay sorted by
        // start, so inserting an earlier marker would otherwise renumber every
        // slot after it and fire the wrong thing on air.
        var track = MusicTrack(url: URL(fileURLWithPath: "/tmp/a.mp3"))
        track.sections = [section("Chorus", 30, hotkey: 3)]
        XCTAssertEqual(track.section(forHotkeyIndex: 3)?.name, "Chorus")

        track.sections = [section("New intro", 0, hotkey: 5),
                          section("Chorus", 30, hotkey: 3)].sorted { $0.start < $1.start }
        XCTAssertEqual(track.section(forHotkeyIndex: 3)?.name, "Chorus",
                       "adding an earlier marker must not move slot 3")
    }

    func testUnboundHotkeySlotResolvesToNothing() {
        var track = MusicTrack(url: URL(fileURLWithPath: "/tmp/a.mp3"))
        track.sections = [section("Chorus", 30, hotkey: 3)]
        XCTAssertNil(track.section(forHotkeyIndex: 7),
                     "a dead key must do nothing, never fire the wrong section")
    }

    // MARK: Track helpers

    func testSortedSectionsOrdersByStart() {
        var track = MusicTrack(url: URL(fileURLWithPath: "/tmp/a.mp3"))
        track.sections = [section("c", 30), section("a", 0), section("b", 10)]
        XCTAssertEqual(track.sortedSections.map(\.name), ["a", "b", "c"])
    }

    func testTrackWithoutSectionsIsInert() {
        let track = MusicTrack(url: URL(fileURLWithPath: "/tmp/a.mp3"))
        XCTAssertTrue(track.sortedSections.isEmpty)
        XCTAssertEqual(track.effectiveStartOffset, 0)
        XCTAssertNil(track.section(withID: nil))
    }

    // MARK: Timecode

    func testTimecodeParsesEveryAcceptedShape() {
        XCTAssertEqual(MusicTimecode.parse("12"), 12)
        XCTAssertEqual(MusicTimecode.parse("12.5"), 12.5)
        XCTAssertEqual(MusicTimecode.parse("1:23"), 83)
        XCTAssertEqual(MusicTimecode.parse("1:23.48")!, 83.48, accuracy: 1e-9)
        XCTAssertEqual(MusicTimecode.parse("1:02:03"), 3723)
        XCTAssertEqual(MusicTimecode.parse("  1:23  "), 83)
    }

    func testTimecodeRejectsNonsenseRatherThanGuessing() {
        // A wrong number silently moves a cue; nil lets the field revert.
        for bad in ["", "abc", "1:2:3:4", "-5", "1:-2", "x:12"] {
            XCTAssertNil(MusicTimecode.parse(bad), "\(bad) should not parse")
        }
    }

    func testTimecodeFormatsAndRoundTrips() {
        XCTAssertEqual(MusicTimecode.string(from: 83.48), "1:23.480")
        XCTAssertEqual(MusicTimecode.string(from: 3723), "1:02:03.000")
        XCTAssertEqual(MusicTimecode.shortString(from: 83.48), "1:23")
        for seconds in [0.0, 7.25, 83.48, 3723.0] {
            let text = MusicTimecode.string(from: seconds)
            XCTAssertEqual(MusicTimecode.parse(text)!, seconds, accuracy: 0.001, text)
        }
    }

    func testTimecodeClampsNegatives() {
        XCTAssertEqual(MusicTimecode.string(from: -5), "0:00.000")
    }

    // MARK: Persistence — the cases that protect everything else

    /// Encodes real settings, then strips the keys this feature introduced —
    /// producing exactly what a pre-feature file looks like without
    /// hand-guessing how nested types like `MixerStripID` encode.
    private func legacySettingsJSON() throws -> Data {
        var settings = AudioSettings()
        settings.stripVolumes["music"] = 0.8
        settings.loopMode = .all
        settings.playlist = [MusicTrack(url: URL(fileURLWithPath: "/tmp/neon.mp3"))]
        settings.playlist[0].title = "Neon Dusk"

        let data = try JSONEncoder().encode(settings)
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        object.removeValue(forKey: "sectionSwitchMode")
        if var playlist = object["playlist"] as? [[String: Any]] {
            for index in playlist.indices {
                playlist[index].removeValue(forKey: "sections")
                playlist[index].removeValue(forKey: "startOffset")
                playlist[index].removeValue(forKey: "armedSectionID")
            }
            object["playlist"] = playlist
        }
        return try JSONSerialization.data(withJSONObject: object)
    }

    func testLegacySettingsWithNoSectionKeysStillLoad() throws {
        // The real guarantee. A settings file written before this feature has
        // none of the new keys; if decoding threw, AudioSettingsStore would
        // return blank settings and the host would lose devices, faders,
        // ducker, inserts, pads and playlist — not just the playlist.
        let decoded = try JSONDecoder().decode(AudioSettings.self,
                                               from: legacySettingsJSON())
        XCTAssertEqual(decoded.playlist.count, 1)
        XCTAssertEqual(decoded.playlist[0].title, "Neon Dusk")
        XCTAssertEqual(decoded.stripVolumes["music"], 0.8)
        XCTAssertEqual(decoded.loopMode, .all)
        XCTAssertNil(decoded.playlist[0].sections)
        XCTAssertEqual(decoded.playlist[0].effectiveStartOffset, 0)
        XCTAssertNil(decoded.sectionSwitchMode)
    }

    func testNilSectionFieldsAreNotWritten() throws {
        // So a file written by this build and one written before it agree,
        // and adding the feature doesn't rewrite every existing entry.
        let track = MusicTrack(url: URL(fileURLWithPath: "/tmp/a.mp3"))
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(track), encoding: .utf8))
        XCTAssertFalse(json.contains("sections"))
        XCTAssertFalse(json.contains("startOffset"))
        XCTAssertFalse(json.contains("armedSectionID"))
    }

    func testTrackWithSectionsRoundTrips() throws {
        var track = MusicTrack(url: URL(fileURLWithPath: "/tmp/a.mp3"))
        let chorus = section("Chorus", 30, 45, hotkey: 3)
        track.sections = [chorus]
        track.startOffset = 12
        track.armedSectionID = chorus.id

        let data = try JSONEncoder().encode(track)
        let decoded = try JSONDecoder().decode(MusicTrack.self, from: data)
        XCTAssertEqual(decoded, track)
        XCTAssertEqual(decoded.section(withID: decoded.armedSectionID)?.name, "Chorus")
    }

    func testAnUnknownSwitchModeInsideSettingsDoesNotSinkTheWholeFile() throws {
        // A future build's value, or a hand-edited file. Throwing here would
        // discard the entire mixer, so it falls back instead.
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: legacySettingsJSON()) as? [String: Any])
        object["sectionSwitchMode"] = "quantizedToBar"
        let data = try JSONSerialization.data(withJSONObject: object)

        let decoded = try JSONDecoder().decode(AudioSettings.self, from: data)
        XCTAssertEqual(decoded.sectionSwitchMode, .atLoopEnd)
        XCTAssertEqual(decoded.playlist.count, 1, "the rest of the file must survive")
    }

    func testAnUnknownLoopModeInsideSettingsDoesNotSinkTheWholeFile() throws {
        var object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: legacySettingsJSON()) as? [String: Any])
        object["loopMode"] = "shuffle"
        let data = try JSONSerialization.data(withJSONObject: object)

        let decoded = try JSONDecoder().decode(AudioSettings.self, from: data)
        XCTAssertEqual(decoded.loopMode, .off)
        XCTAssertEqual(decoded.playlist.count, 1)
    }
}
