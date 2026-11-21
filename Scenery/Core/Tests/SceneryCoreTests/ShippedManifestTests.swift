import XCTest
@testable import SceneryCore

/// Keeps the manifests that ship in this repository honest: the bundled demo
/// catalog and the example handed to IT must both parse cleanly.
final class ShippedManifestTests: XCTestCase {
    /// `Scenery/`, found from this file's own location.
    private var sceneryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // SceneryCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // Core
            .deletingLastPathComponent()  // Scenery
    }

    func testBundledDemoCatalogIsCompleteAndClean() throws {
        let manifest = sceneryRoot.appendingPathComponent("DemoCatalog/manifest.json")
        let catalog = try ManifestParser.parse(try Data(contentsOf: manifest), baseURL: manifest)

        XCTAssertEqual(catalog.issues, [])
        XCTAssertGreaterThanOrEqual(catalog.selectable.count, 6)
        XCTAssertLessThanOrEqual(catalog.selectable.count, Catalog.maxSelectable)
        XCTAssertNotNil(catalog.wallpaper(id: catalog.defaultWallpaperID))
        XCTAssertTrue(catalog.wallpapers.contains { $0.kind == .video })
        for wallpaper in catalog.wallpapers {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: wallpaper.url.path),
                "\(wallpaper.id) points at a file that is not in DemoCatalog"
            )
        }
    }

    func testExampleManifestForITIsClean() throws {
        let manifest = sceneryRoot.appendingPathComponent("it-admin/manifest.example.json")
        let hosted = URL(string: "https://wallpapers.example.com/scenery/manifest.json")!
        let catalog = try ManifestParser.parse(try Data(contentsOf: manifest), baseURL: hosted)

        XCTAssertEqual(catalog.issues, [])
        XCTAssertEqual(catalog.selectable.count, 7)
        XCTAssertEqual(catalog.takeovers.count, 2)
        XCTAssertEqual(
            catalog.wallpaper(id: "value-01")?.url.absoluteString,
            "https://wallpapers.example.com/scenery/images/value-01.jpg"
        )

        // Mid-holiday, the takeover wins on every display and nobody can
        // have picked the seasonal wallpaper as their own.
        let midHoliday = try XCTUnwrap(ManifestParser.parseDate("2026-12-25"))
        let resolved = Resolver.resolve(
            catalog: catalog,
            selection: SelectionState(sharedWallpaperID: "value-03"),
            displayIDs: ["one", "two"],
            forcedWallpaperID: nil,
            now: midHoliday
        )
        XCTAssertEqual(resolved["one"]?.wallpaper.id, "holidays-2026")
        XCTAssertEqual(resolved["two"]?.wallpaper.id, "holidays-2026")

        let afterward = try XCTUnwrap(ManifestParser.parseDate("2027-01-04"))
        let later = Resolver.resolve(
            catalog: catalog,
            selection: SelectionState(sharedWallpaperID: "value-03"),
            displayIDs: ["one"],
            forcedWallpaperID: nil,
            now: afterward
        )
        XCTAssertEqual(later["one"]?.wallpaper.id, "value-03")
    }
}
