import XCTest
@testable import SceneryCore

final class SpanGeometryTests: XCTestCase {
    private let left = CGRect(x: 0, y: 0, width: 1920, height: 1080)
    private let right = CGRect(x: 1920, y: 0, width: 1920, height: 1080)

    func testNothingToSpanWithOneDisplay() {
        XCTAssertNil(SpanGeometry.canvas(for: []))
        XCTAssertNil(SpanGeometry.canvas(for: [left]))
        XCTAssertNil(SpanGeometry.canvas(for: [left, .zero]))
    }

    func testCanvasCoversEveryDisplay() {
        XCTAssertEqual(SpanGeometry.canvas(for: [left, right]), CGRect(x: 0, y: 0, width: 3840, height: 1080))
        // A display arranged to the left of, and above, the main one.
        let upperLeft = CGRect(x: -1280, y: 1080, width: 1280, height: 720)
        XCTAssertEqual(SpanGeometry.canvas(for: [left, upperLeft]), CGRect(x: -1280, y: 0, width: 3200, height: 1800))
    }

    func testSideBySideDisplaysSplitTheImageInTwo() throws {
        let canvas = try XCTUnwrap(SpanGeometry.canvas(for: [left, right]))
        let image = CGSize(width: 3840, height: 1080)
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: left),
            CGRect(x: 0, y: 0, width: 1920, height: 1080)
        )
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: right),
            CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        )
    }

    func testTallerImageIsCroppedEvenlyTopAndBottom() throws {
        let canvas = try XCTUnwrap(SpanGeometry.canvas(for: [left, right]))
        // A normal 16:10 wallpaper spread over a 32:9 desk.
        let image = CGSize(width: 3840, height: 2400)
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: right),
            CGRect(x: 1920, y: 660, width: 1920, height: 1080)
        )
    }

    func testSmallerImageIsScaledUp() throws {
        let canvas = try XCTUnwrap(SpanGeometry.canvas(for: [left, right]))
        let image = CGSize(width: 1920, height: 1200)
        // Each image pixel covers two points; the middle 540 rows are used.
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: left),
            CGRect(x: 0, y: 330, width: 960, height: 540)
        )
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: right),
            CGRect(x: 960, y: 330, width: 960, height: 540)
        )
    }

    func testStackedDisplaysUseTopLeftImageCoordinates() throws {
        // The upper display sits at a larger y on the desk but must get the
        // top of the image.
        let lower = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let upper = CGRect(x: 0, y: 1080, width: 1920, height: 1080)
        let canvas = try XCTUnwrap(SpanGeometry.canvas(for: [lower, upper]))
        let image = CGSize(width: 1920, height: 2160)
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: upper),
            CGRect(x: 0, y: 0, width: 1920, height: 1080)
        )
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: lower),
            CGRect(x: 0, y: 1080, width: 1920, height: 1080)
        )
    }

    func testMixedSizesKeepTheirArrangement() throws {
        // A laptop next to a larger monitor, raised 200 points off the desk.
        let laptop = CGRect(x: 1920, y: 200, width: 1280, height: 720)
        let canvas = try XCTUnwrap(SpanGeometry.canvas(for: [left, laptop]))
        XCTAssertEqual(canvas, CGRect(x: 0, y: 0, width: 3200, height: 1080))
        let image = CGSize(width: 3200, height: 1080)
        XCTAssertEqual(
            SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: laptop),
            CGRect(x: 1920, y: 160, width: 1280, height: 720)
        )
    }

    func testCropNeverLeavesTheImage() throws {
        let canvas = try XCTUnwrap(SpanGeometry.canvas(for: [left, right]))
        let image = CGSize(width: 1001, height: 333)
        for display in [left, right] {
            let crop = SpanGeometry.cropRect(imageSize: image, canvas: canvas, display: display)
            XCTAssertTrue(CGRect(origin: .zero, size: image).contains(crop))
            XCTAssertGreaterThan(crop.width, 0)
            XCTAssertGreaterThan(crop.height, 0)
        }
    }
}
