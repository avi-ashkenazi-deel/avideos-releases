import XCTest
@testable import SceneryCore

final class DayCycleTests: XCTestCase {
    private func utc(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    // MARK: - Sun

    func testSunIsOverheadAtTheEquatorAtTheEquinox() {
        let noon = Sun.position(at: utc(2026, 3, 20, 12), latitude: 0, longitude: 0)
        XCTAssertGreaterThan(noon.elevation, 87)
        let midnight = Sun.position(at: utc(2026, 3, 20, 0), latitude: 0, longitude: 0)
        XCTAssertLessThan(midnight.elevation, -87)
    }

    func testLondonNoonFollowsTheSeasons() {
        // Textbook values: 90 - latitude ± 23.44 at the solstices.
        let winter = Sun.position(at: utc(2026, 12, 21, 12), latitude: 51.5, longitude: -0.13)
        XCTAssertEqual(winter.elevation, 15.1, accuracy: 0.7)
        let summer = Sun.position(at: utc(2026, 6, 21, 12), latitude: 51.5, longitude: -0.13)
        XCTAssertEqual(summer.elevation, 61.9, accuracy: 0.7)
    }

    func testSunriseAndSunsetLandAtTheRightTimes() {
        // London, 21 December 2026: sunrise about 08:04 UTC, sunset about 15:53 UTC.
        func elevation(_ hour: Int, _ minute: Int) -> SunPosition {
            Sun.position(at: utc(2026, 12, 21, hour, minute), latitude: 51.5, longitude: -0.13)
        }
        XCTAssertLessThan(elevation(7, 40).elevation, -1)
        XCTAssertGreaterThan(elevation(8, 30).elevation, 0)
        XCTAssertTrue(elevation(8, 30).isRising)
        XCTAssertGreaterThan(elevation(15, 30).elevation, 0)
        XCTAssertFalse(elevation(15, 30).isRising)
        XCTAssertLessThan(elevation(16, 20).elevation, -1)
    }

    func testLongitudeShiftsTheDay() {
        // 03:00 UTC is mid-afternoon in Sydney and the middle of the night in London.
        let moment = utc(2026, 1, 15, 3)
        XCTAssertGreaterThan(Sun.position(at: moment, latitude: -33.87, longitude: 151.21).elevation, 40)
        XCTAssertLessThan(Sun.position(at: moment, latitude: 51.5, longitude: -0.13).elevation, -40)
    }

    func testApproximateCoordinatesComeFromTheTimeZone() throws {
        let newYork = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        // Standard time is UTC-5 in both seasons, whatever the clock says.
        XCTAssertEqual(Sun.approximateCoordinates(for: newYork, at: utc(2026, 1, 15, 12)).longitude, -75, accuracy: 0.01)
        XCTAssertEqual(Sun.approximateCoordinates(for: newYork, at: utc(2026, 7, 15, 12)).longitude, -75, accuracy: 0.01)
        XCTAssertEqual(Sun.approximateCoordinates(for: newYork, at: utc(2026, 7, 15, 12)).latitude, 0)

        // With only the time zone, local noon is still broad daylight and
        // local midnight is still night.
        let tokyo = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        let place = Sun.approximateCoordinates(for: tokyo, at: utc(2026, 5, 1, 3))
        XCTAssertGreaterThan(Sun.position(at: utc(2026, 5, 1, 3), latitude: place.latitude, longitude: place.longitude).elevation, 60)
        XCTAssertLessThan(Sun.position(at: utc(2026, 5, 1, 15), latitude: place.latitude, longitude: place.longitude).elevation, -60)
    }

    // MARK: - Colours

    func testHexColours() {
        XCTAssertEqual(RGB(hex: "#FF8000"), RGB(red: 1, green: 128.0 / 255, blue: 0))
        XCTAssertEqual(RGB(hex: " 0a0b0c "), RGB(red: 10.0 / 255, green: 11.0 / 255, blue: 12.0 / 255))
        XCTAssertNil(RGB(hex: "#FFF"))
        XCTAssertNil(RGB(hex: "#GGGGGG"))
        XCTAssertNil(RGB(hex: "+12345"))
        XCTAssertNil(RGB(hex: ""))
    }

    private let black = RGB(red: 0, green: 0, blue: 0)
    private let white = RGB(red: 1, green: 1, blue: 1)
    private let orange = RGB(red: 1, green: 0.5, blue: 0)
    private let pink = RGB(red: 1, green: 0, blue: 0.5)

    private var palette: DayPalette {
        DayPalette(night: [black, black], dawn: [orange, orange], day: [white, white], dusk: [pink, pink])!
    }

    func testPaletteNeedsMatchingStops() {
        XCTAssertNil(DayPalette(night: [black], dawn: [black], day: [black], dusk: [black]))
        XCTAssertNil(DayPalette(night: [black, black], dawn: [black], day: [black, black], dusk: [black, black]))
        XCTAssertNil(DayPalette(
            night: Array(repeating: black, count: 5), dawn: Array(repeating: black, count: 5),
            day: Array(repeating: black, count: 5), dusk: Array(repeating: black, count: 5)
        ))
        XCTAssertNotNil(DayPalette(
            night: Array(repeating: black, count: 4), dawn: Array(repeating: black, count: 4),
            day: Array(repeating: black, count: 4), dusk: Array(repeating: black, count: 4)
        ))
    }

    func testColoursFollowTheSun() {
        XCTAssertEqual(palette.colors(for: SunPosition(elevation: -40, isRising: true)), [black, black])
        XCTAssertEqual(palette.colors(for: SunPosition(elevation: -12, isRising: false)), [black, black])
        XCTAssertEqual(palette.colors(for: SunPosition(elevation: 12, isRising: true)), [white, white])
        XCTAssertEqual(palette.colors(for: SunPosition(elevation: 70, isRising: false)), [white, white])

        // On the horizon the twilight colour is at full strength, and morning
        // and evening differ.
        XCTAssertEqual(palette.colors(for: SunPosition(elevation: 0, isRising: true)), [orange, orange])
        XCTAssertEqual(palette.colors(for: SunPosition(elevation: 0, isRising: false)), [pink, pink])
    }

    func testColoursChangeSmoothly() {
        // Half-way up from the horizon is an even mix of twilight and day.
        let half = palette.colors(for: SunPosition(elevation: 6, isRising: true))[0]
        XCTAssertEqual(half.red, 1, accuracy: 1e-9)
        XCTAssertEqual(half.green, 0.75, accuracy: 1e-9)
        XCTAssertEqual(half.blue, 0.5, accuracy: 1e-9)

        // No jump anywhere: a tenth of a degree never moves a channel far.
        var previous = palette.colors(for: SunPosition(elevation: -15, isRising: false))[0]
        for step in 1...300 {
            let next = palette.colors(for: SunPosition(elevation: -15 + Double(step) * 0.1, isRising: false))[0]
            XCTAssertLessThan(abs(next.red - previous.red), 0.02)
            XCTAssertLessThan(abs(next.green - previous.green), 0.02)
            XCTAssertLessThan(abs(next.blue - previous.blue), 0.02)
            previous = next
        }
    }
}
