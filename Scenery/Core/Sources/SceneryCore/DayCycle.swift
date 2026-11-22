import Foundation

/// Where the Sun is in the sky, as far as a wallpaper needs to know.
public struct SunPosition: Equatable, Sendable {
    /// Degrees above the horizon. Negative after sunset.
    public let elevation: Double
    /// `true` from solar midnight to solar noon, `false` afterwards. This is
    /// what tells a sunrise apart from a sunset at the same elevation.
    public let isRising: Bool

    public init(elevation: Double, isRising: Bool) {
        self.elevation = elevation
        self.isRising = isRising
    }
}

/// Works out the Sun's position for a moment and a place.
///
/// This is the standard low-precision solar position formula (the one
/// published by NOAA). It is accurate to a fraction of a degree, which is far
/// more than a wallpaper needs, and it is a few lines of arithmetic: nothing
/// is downloaded and no location service is involved.
public enum Sun {
    public static func position(at date: Date, latitude: Double, longitude: Double) -> SunPosition {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let dayOfYear = Double(utc.ordinality(of: .day, in: .year, for: date) ?? 1)
        let parts = utc.dateComponents([.hour, .minute, .second], from: date)
        let minutes = Double(parts.hour ?? 0) * 60 + Double(parts.minute ?? 0) + Double(parts.second ?? 0) / 60

        // Fraction of the year, in radians.
        let gamma = 2 * Double.pi / 365 * (dayOfYear - 1 + (minutes / 60 - 12) / 24)

        // Equation of time (minutes): how far sundial time is from clock time.
        let equationOfTime = 229.18 * (
            0.000075
                + 0.001868 * cos(gamma) - 0.032077 * sin(gamma)
                - 0.014615 * cos(2 * gamma) - 0.040849 * sin(2 * gamma)
        )
        // The Sun's declination (radians): how far north or south it stands.
        let declination = 0.006918
            - 0.399912 * cos(gamma) + 0.070257 * sin(gamma)
            - 0.006758 * cos(2 * gamma) + 0.000907 * sin(2 * gamma)
            - 0.002697 * cos(3 * gamma) + 0.00148 * sin(3 * gamma)

        // Sundial time at this longitude, in minutes after solar midnight.
        var solarMinutes = (minutes + equationOfTime + 4 * longitude).truncatingRemainder(dividingBy: 1440)
        if solarMinutes < 0 { solarMinutes += 1440 }
        // Degrees from solar noon: negative in the morning.
        let hourAngle = solarMinutes / 4 - 180

        let lat = latitude * .pi / 180
        let cosZenith = sin(lat) * sin(declination) + cos(lat) * cos(declination) * cos(hourAngle * .pi / 180)
        let zenith = acos(min(max(cosZenith, -1), 1)) * 180 / .pi
        return SunPosition(elevation: 90 - zenith, isRising: hourAngle < 0)
    }

    /// A stand-in location for when no coordinates are configured: the middle
    /// of the Mac's time zone, on the equator.
    ///
    /// The longitude makes sunrise and sunset land at sensible clock times.
    /// The equator is used because the time zone says nothing about latitude,
    /// and there the day is about twelve hours long all year, which is never
    /// badly wrong anywhere. Real coordinates give real seasons.
    public static func approximateCoordinates(for timeZone: TimeZone, at date: Date) -> (latitude: Double, longitude: Double) {
        let standardOffset = Double(timeZone.secondsFromGMT(for: date)) - timeZone.daylightSavingTimeOffset(for: date)
        return (0, min(max(standardOffset / 3600 * 15, -180), 180))
    }
}

/// A colour in sRGB, each channel from 0 to 1.
public struct RGB: Hashable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// Reads `#RRGGBB` (the `#` is optional).
    public init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, text.allSatisfy(\.isHexDigit), let value = UInt32(text, radix: 16) else {
            return nil
        }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    func mixed(with other: RGB, amount: Double) -> RGB {
        RGB(
            red: red + (other.red - red) * amount,
            green: green + (other.green - green) * amount,
            blue: blue + (other.blue - blue) * amount
        )
    }
}

/// The colours of a wallpaper that follows the day: one vertical gradient
/// (top to bottom) for each of four moments. The app blends between them
/// continuously as the Sun moves.
public struct DayPalette: Hashable, Sendable {
    public static let allowedStopCounts = 2...4

    public let night: [RGB]
    public let dawn: [RGB]
    public let day: [RGB]
    public let dusk: [RGB]

    /// Fails unless every moment has the same number of colours (2 to 4), so
    /// that any two of them can be blended stop by stop.
    public init?(night: [RGB], dawn: [RGB], day: [RGB], dusk: [RGB]) {
        guard Self.allowedStopCounts.contains(night.count),
              dawn.count == night.count, day.count == night.count, dusk.count == night.count else {
            return nil
        }
        self.night = night
        self.dawn = dawn
        self.day = day
        self.dusk = dusk
    }

    /// The Sun is this far below the horizon when the last light is gone, and
    /// this far above it when the day has its full daytime colour.
    static let twilightSpan = 12.0

    /// The gradient for a given Sun position.
    ///
    /// - Full night below −12°, full day above +12°.
    /// - In between the colours pass through `dawn` (morning) or `dusk`
    ///   (evening), which is at its strongest with the Sun on the horizon.
    public func colors(for sun: SunPosition) -> [RGB] {
        let twilight = sun.isRising ? dawn : dusk
        let span = Self.twilightSpan
        if sun.elevation <= -span { return night }
        if sun.elevation >= span { return day }
        if sun.elevation < 0 {
            return Self.blend(night, twilight, amount: Self.ease((sun.elevation + span) / span))
        }
        return Self.blend(twilight, day, amount: Self.ease(sun.elevation / span))
    }

    private static func blend(_ from: [RGB], _ to: [RGB], amount: Double) -> [RGB] {
        zip(from, to).map { $0.mixed(with: $1, amount: amount) }
    }

    /// Smoothstep: eases in and out so that changes never start abruptly.
    private static func ease(_ value: Double) -> Double {
        let t = min(max(value, 0), 1)
        return t * t * (3 - 2 * t)
    }
}
