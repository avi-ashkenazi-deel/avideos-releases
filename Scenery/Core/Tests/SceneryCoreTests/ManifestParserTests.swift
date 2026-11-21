import XCTest
@testable import SceneryCore

final class ManifestParserTests: XCTestCase {
    private let remoteBase = URL(string: "https://wallpapers.example.com/scenery/manifest.json")!
    private let localBase = URL(fileURLWithPath: "/Applications/Scenery.app/Contents/Resources/DemoCatalog/manifest.json")

    private func parse(_ json: String, base: URL? = nil) throws -> Catalog {
        try ManifestParser.parse(Data(json.utf8), baseURL: base ?? remoteBase)
    }

    func testParsesWallpapersAndResolvesRelativeURLs() throws {
        let catalog = try parse("""
        {
          "version": 1,
          "defaultWallpaperID": "dune",
          "wallpapers": [
            { "id": "aurora", "title": "Aurora", "url": "images/aurora.jpg" },
            { "id": "dune", "url": "https://cdn.example.com/dune.HEIC", "sha256": " ABCDEF " },
            { "id": "tide", "title": "Tide", "kind": "video", "url": "videos/tide.mp4", "posterURL": "videos/tide.jpg" }
          ]
        }
        """)

        XCTAssertEqual(catalog.wallpapers.map(\.id), ["aurora", "dune", "tide"])
        XCTAssertEqual(catalog.wallpapers[0].url.absoluteString, "https://wallpapers.example.com/scenery/images/aurora.jpg")
        XCTAssertEqual(catalog.wallpapers[0].kind, .image)
        XCTAssertEqual(catalog.wallpapers[1].title, "dune", "a missing title falls back to the id")
        XCTAssertEqual(catalog.wallpapers[1].sha256, "abcdef")
        XCTAssertEqual(catalog.wallpapers[2].kind, .video)
        XCTAssertEqual(catalog.wallpapers[2].posterURL?.absoluteString, "https://wallpapers.example.com/scenery/videos/tide.jpg")
        XCTAssertEqual(catalog.defaultWallpaperID, "dune")
        XCTAssertEqual(catalog.fallbackWallpaper?.id, "dune")
        XCTAssertTrue(catalog.issues.isEmpty)
    }

    func testRejectsInsecureAndUnsupportedFiles() throws {
        let catalog = try parse("""
        {
          "version": 1,
          "wallpapers": [
            { "id": "plain-http", "url": "http://cdn.example.com/a.jpg" },
            { "id": "local-from-remote", "url": "file:///Users/someone/Pictures/a.jpg" },
            { "id": "script", "url": "https://cdn.example.com/a.sh" },
            { "id": "mismatch", "kind": "image", "url": "https://cdn.example.com/a.mp4" },
            { "id": "ok", "url": "https://cdn.example.com/a.png" }
          ]
        }
        """)

        XCTAssertEqual(catalog.wallpapers.map(\.id), ["ok"])
        XCTAssertEqual(catalog.issues.count, 4)
    }

    func testLocalManifestMayUseLocalFiles() throws {
        let catalog = try parse("""
        { "version": 1, "wallpapers": [ { "id": "aurora", "url": "images/aurora.jpg" } ] }
        """, base: localBase)

        XCTAssertEqual(
            catalog.wallpapers.first?.url.path,
            "/Applications/Scenery.app/Contents/Resources/DemoCatalog/images/aurora.jpg"
        )
        XCTAssertTrue(catalog.wallpapers[0].url.isFileURL)
    }

    func testOneBrokenEntryDoesNotBreakTheManifest() throws {
        let catalog = try parse("""
        {
          "version": 1,
          "wallpapers": [
            { "title": "No id or url" },
            { "id": "dup", "url": "a.jpg" },
            { "id": "dup", "url": "b.jpg" },
            { "id": "  ", "url": "c.jpg" },
            42
          ]
        }
        """)

        XCTAssertEqual(catalog.wallpapers.map(\.url.lastPathComponent), ["a.jpg"])
        XCTAssertEqual(catalog.issues.count, 4)
    }

    func testCapsThePickerAtTenButKeepsExtrasForTakeovers() throws {
        let entries = (1...12).map { "{ \"id\": \"w\($0)\", \"url\": \"w\($0).jpg\" }" }.joined(separator: ",")
        let catalog = try parse("""
        {
          "version": 1,
          "wallpapers": [ { "id": "holiday", "url": "holiday.mp4", "selectable": false }, \(entries) ],
          "takeovers": [ { "wallpaperID": "w12" } ]
        }
        """)

        XCTAssertEqual(catalog.wallpapers.count, 13)
        XCTAssertEqual(catalog.selectable.count, Catalog.maxSelectable)
        XCTAssertEqual(catalog.selectable.last?.id, "w10")
        XCTAssertFalse(catalog.selectable.contains { $0.id == "holiday" })
        XCTAssertEqual(catalog.takeovers.map(\.wallpaperID), ["w12"], "hidden wallpapers can still be used by a takeover")
        XCTAssertEqual(catalog.issues.count, 2)
    }

    func testTakeoverDatesAndValidation() throws {
        let catalog = try parse("""
        {
          "version": 1,
          "defaultWallpaperID": "missing",
          "wallpapers": [ { "id": "a", "url": "a.jpg" }, { "id": "b", "url": "b.jpg" } ],
          "takeovers": [
            { "wallpaperID": "b", "startsAt": "2026-12-01", "endsAt": "2027-01-02T09:30:00+02:00", "message": "Happy holidays" },
            { "wallpaperID": "b", "startsAt": "2026-12-01T00:00:00.250Z" },
            { "wallpaperID": "nope" },
            { "wallpaperID": "a", "startsAt": "next tuesday" },
            { "wallpaperID": "a", "endsAt": "12/25/2026" },
            { "wallpaperID": "a", "startsAt": "2026-06-02", "endsAt": "2026-06-01" },
            { "message": "no wallpaper" }
          ]
        }
        """)

        XCTAssertEqual(catalog.takeovers.count, 2)
        let first = try XCTUnwrap(catalog.takeovers.first)
        XCTAssertEqual(first.startsAt, Date(timeIntervalSince1970: 1_796_083_200), "2026-12-01 means midnight UTC")
        XCTAssertEqual(first.endsAt, Date(timeIntervalSince1970: 1_798_875_000))
        XCTAssertEqual(first.message, "Happy holidays")
        XCTAssertEqual(catalog.takeovers[1].startsAt, Date(timeIntervalSince1970: 1_796_083_200.25))
        XCTAssertNil(catalog.defaultWallpaperID)
        XCTAssertEqual(catalog.fallbackWallpaper?.id, "a")
        XCTAssertEqual(catalog.issues.count, 6)
    }

    func testRejectsWholeManifestWhenUnusable() {
        XCTAssertThrowsError(try parse("not json")) { error in
            guard case ManifestError.malformed = error else { return XCTFail("unexpected \(error)") }
        }
        XCTAssertThrowsError(try parse("{ \"version\": 2, \"wallpapers\": [] }")) { error in
            XCTAssertEqual(error as? ManifestError, .unsupportedVersion(2))
        }
        XCTAssertThrowsError(try parse("{ \"version\": 1, \"wallpapers\": [ { \"id\": \"x\", \"url\": \"x.exe\" } ] }")) { error in
            XCTAssertEqual(error as? ManifestError, .noUsableWallpapers)
        }
    }
}
