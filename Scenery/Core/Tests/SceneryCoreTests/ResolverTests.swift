import XCTest
@testable import SceneryCore

final class ResolverTests: XCTestCase {
    private let left = "display-left"
    private let right = "display-right"

    private func wallpaper(_ id: String, selectable: Bool = true) -> Wallpaper {
        Wallpaper(id: id, title: id, kind: .image, url: URL(string: "https://example.com/\(id).jpg")!, selectable: selectable)
    }

    private func date(_ day: Int) -> Date {
        Date(timeIntervalSince1970: TimeInterval(day) * 86_400)
    }

    private func catalog(takeovers: [Takeover] = []) -> Catalog {
        Catalog(
            wallpapers: [wallpaper("a"), wallpaper("b"), wallpaper("c"), wallpaper("holiday", selectable: false)],
            defaultWallpaperID: "b",
            takeovers: takeovers
        )
    }

    private func resolve(
        _ catalog: Catalog,
        _ selection: SelectionState = SelectionState(),
        forced: String? = nil,
        day: Int = 100
    ) -> [String: Resolution] {
        Resolver.resolve(
            catalog: catalog,
            selection: selection,
            displayIDs: [left, right],
            forcedWallpaperID: forced,
            now: date(day)
        )
    }

    func testFallsBackToDefaultBeforeAnyChoice() {
        let result = resolve(catalog())
        XCTAssertEqual(result[left]?.wallpaper.id, "b")
        XCTAssertEqual(result[left]?.source, .fallback)
        XCTAssertEqual(result[right]?.wallpaper.id, "b")
        XCTAssertEqual(result[left]?.isLocked, false)
    }

    func testSameChoiceOnAllDisplays() {
        var selection = SelectionState()
        selection.select("c", forDisplay: left)
        let result = resolve(catalog(), selection)
        XCTAssertEqual(result[left]?.wallpaper.id, "c")
        XCTAssertEqual(result[right]?.wallpaper.id, "c")
        XCTAssertEqual(result[right]?.source, .user)
    }

    func testDifferentChoicePerDisplay() {
        var selection = SelectionState()
        selection.select("a", forDisplay: nil)
        selection.sameOnAllDisplays = false
        selection.select("c", forDisplay: right)

        let result = resolve(catalog(), selection)
        XCTAssertEqual(result[left]?.wallpaper.id, "a", "a display without its own choice keeps the shared one")
        XCTAssertEqual(result[right]?.wallpaper.id, "c")

        // Going back to "same on all displays" uses the shared choice again.
        selection.sameOnAllDisplays = true
        XCTAssertEqual(resolve(catalog(), selection)[right]?.wallpaper.id, "a")
    }

    func testRetiredOrHiddenChoiceFallsBack() {
        var selection = SelectionState()
        selection.select("retired-last-quarter", forDisplay: nil)
        XCTAssertEqual(resolve(catalog(), selection)[left]?.wallpaper.id, "b")

        selection.select("holiday", forDisplay: nil)
        let result = resolve(catalog(), selection)
        XCTAssertEqual(result[left]?.wallpaper.id, "b", "a hidden wallpaper cannot be kept as a personal choice")
        XCTAssertEqual(result[left]?.source, .fallback)
    }

    func testTakeoverWinsOnlyInsideItsWindow() {
        let takeover = Takeover(wallpaperID: "holiday", startsAt: date(100), endsAt: date(110), message: "Happy holidays")
        var selection = SelectionState()
        selection.select("a", forDisplay: nil)
        let scheduled = catalog(takeovers: [takeover])

        XCTAssertEqual(resolve(scheduled, selection, day: 99)[left]?.wallpaper.id, "a")

        let during = resolve(scheduled, selection, day: 100)
        XCTAssertEqual(during[left]?.wallpaper.id, "holiday")
        XCTAssertEqual(during[right]?.source, .takeover(takeover))
        XCTAssertEqual(during[left]?.isLocked, true)

        XCTAssertEqual(resolve(scheduled, selection, day: 110)[left]?.wallpaper.id, "a", "the end date is exclusive, and the person's choice comes back")
    }

    func testFirstActiveTakeoverWinsAndOpenEndedOnesWork() {
        let scheduled = catalog(takeovers: [
            Takeover(wallpaperID: "holiday", startsAt: date(200), endsAt: date(210)),
            Takeover(wallpaperID: "c"),
        ])
        XCTAssertEqual(resolve(scheduled, day: 100)[left]?.wallpaper.id, "c")
        XCTAssertEqual(resolve(scheduled, day: 205)[left]?.wallpaper.id, "holiday")
    }

    func testManagedSettingBeatsEverything() {
        let scheduled = catalog(takeovers: [Takeover(wallpaperID: "holiday")])
        let result = resolve(scheduled, forced: "a")
        XCTAssertEqual(result[left]?.wallpaper.id, "a")
        XCTAssertEqual(result[right]?.source, .managed)
        XCTAssertEqual(result[left]?.isLocked, true)

        // A forced id that is not in the catalog is ignored rather than
        // leaving displays without a wallpaper.
        XCTAssertEqual(resolve(scheduled, forced: "typo")[left]?.wallpaper.id, "holiday")
    }

    func testNextBoundary() {
        let scheduled = catalog(takeovers: [
            Takeover(wallpaperID: "holiday", startsAt: date(100), endsAt: date(110)),
            Takeover(wallpaperID: "c", startsAt: date(105)),
        ])
        XCTAssertEqual(Resolver.nextBoundary(in: scheduled, after: date(90)), date(100))
        XCTAssertEqual(Resolver.nextBoundary(in: scheduled, after: date(100)), date(105))
        XCTAssertEqual(Resolver.nextBoundary(in: scheduled, after: date(107)), date(110))
        XCTAssertNil(Resolver.nextBoundary(in: scheduled, after: date(110)))
    }

    func testSelectionSurvivesEncoding() throws {
        var selection = SelectionState(sameOnAllDisplays: false, sharedWallpaperID: "a")
        selection.select("c", forDisplay: right)
        let decoded = try JSONDecoder().decode(SelectionState.self, from: JSONEncoder().encode(selection))
        XCTAssertEqual(decoded, selection)
    }

    func testEmptyCatalogResolvesNothing() {
        XCTAssertTrue(resolve(.empty).isEmpty)
    }
}
