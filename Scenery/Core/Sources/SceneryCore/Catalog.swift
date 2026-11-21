import Foundation

/// One approved wallpaper, with every URL already resolved to an absolute URL.
public struct Wallpaper: Identifiable, Hashable, Sendable {
    public enum Kind: String, Sendable {
        case image
        case video
    }

    public let id: String
    public let title: String
    public let kind: Kind
    /// The image or video file.
    public let url: URL
    /// Optional still for a video. If missing, the app grabs the first frame.
    public let posterURL: URL?
    /// Optional lowercase hex SHA-256 of the file at `url`.
    public let sha256: String?
    /// `false` hides the wallpaper from the picker (e.g. a seasonal takeover
    /// that people should not be able to keep all year).
    public let selectable: Bool

    public init(
        id: String,
        title: String,
        kind: Kind,
        url: URL,
        posterURL: URL? = nil,
        sha256: String? = nil,
        selectable: Bool = true
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.url = url
        self.posterURL = posterURL
        self.sha256 = sha256
        self.selectable = selectable
    }
}

/// A window of time during which IT pins one wallpaper on every display.
public struct Takeover: Hashable, Sendable {
    public let wallpaperID: String
    /// `nil` means "already started".
    public let startsAt: Date?
    /// `nil` means "until removed from the manifest".
    public let endsAt: Date?
    /// Shown to people in the picker, e.g. "Happy holidays from the team".
    public let message: String?

    public init(wallpaperID: String, startsAt: Date? = nil, endsAt: Date? = nil, message: String? = nil) {
        self.wallpaperID = wallpaperID
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.message = message
    }

    public func isActive(at now: Date) -> Bool {
        if let startsAt, now < startsAt { return false }
        if let endsAt, now >= endsAt { return false }
        return true
    }
}

/// The validated result of reading a manifest.
public struct Catalog: Equatable, Sendable {
    /// People only ever choose from a short approved list.
    public static let maxSelectable = 10

    public let wallpapers: [Wallpaper]
    public let defaultWallpaperID: String?
    public let takeovers: [Takeover]
    /// Human-readable notes about anything that was dropped while validating.
    /// Meant for IT when a manifest does not behave as expected.
    public let issues: [String]

    public static let empty = Catalog(wallpapers: [], defaultWallpaperID: nil, takeovers: [], issues: [])

    public init(wallpapers: [Wallpaper], defaultWallpaperID: String?, takeovers: [Takeover], issues: [String] = []) {
        self.wallpapers = wallpapers
        self.defaultWallpaperID = defaultWallpaperID
        self.takeovers = takeovers
        self.issues = issues
    }

    /// What the picker shows.
    public var selectable: [Wallpaper] {
        wallpapers.filter(\.selectable)
    }

    public func wallpaper(id: String?) -> Wallpaper? {
        guard let id else { return nil }
        return wallpapers.first { $0.id == id }
    }

    /// Used when someone has not chosen yet, or their choice was retired.
    public var fallbackWallpaper: Wallpaper? {
        if let wallpaper = wallpaper(id: defaultWallpaperID), wallpaper.selectable {
            return wallpaper
        }
        return selectable.first ?? wallpapers.first
    }
}
