import Foundation

/// What a person picked. Stored on their Mac.
public struct SelectionState: Codable, Equatable, Sendable {
    /// When `true`, one choice drives every display.
    public var sameOnAllDisplays: Bool
    public var sharedWallpaperID: String?
    /// Display identifier -> wallpaper id, used when displays differ.
    public var perDisplay: [String: String]

    public init(sameOnAllDisplays: Bool = true, sharedWallpaperID: String? = nil, perDisplay: [String: String] = [:]) {
        self.sameOnAllDisplays = sameOnAllDisplays
        self.sharedWallpaperID = sharedWallpaperID
        self.perDisplay = perDisplay
    }

    /// The wallpaper id this person wants on `displayID`, if they chose one.
    public func wallpaperID(forDisplay displayID: String) -> String? {
        if sameOnAllDisplays { return sharedWallpaperID }
        return perDisplay[displayID] ?? sharedWallpaperID
    }

    /// Records a choice. In "same on all displays" mode the display is ignored.
    public mutating func select(_ wallpaperID: String, forDisplay displayID: String?) {
        if sameOnAllDisplays || displayID == nil {
            sharedWallpaperID = wallpaperID
            if sameOnAllDisplays { perDisplay.removeAll() }
        } else if let displayID {
            perDisplay[displayID] = wallpaperID
        }
    }
}

/// The wallpaper a display ends up with, and why.
public struct Resolution: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        /// Pinned by a device-management setting.
        case managed
        /// Pinned by a scheduled takeover in the manifest.
        case takeover(Takeover)
        /// The person's own choice.
        case user
        /// Nothing chosen (or the choice was retired), so the default is used.
        case fallback
    }

    public let wallpaper: Wallpaper
    public let source: Source

    public init(wallpaper: Wallpaper, source: Source) {
        self.wallpaper = wallpaper
        self.source = source
    }

    /// `true` when IT, not the person, decided this wallpaper.
    public var isLocked: Bool {
        switch source {
        case .managed, .takeover: return true
        case .user, .fallback: return false
        }
    }
}

/// Decides which wallpaper goes on which display.
///
/// Order of authority, strongest first:
/// 1. A wallpaper id forced through device management.
/// 2. The first active takeover in the manifest.
/// 3. The person's own choice, if it is still an approved, selectable wallpaper.
/// 4. The manifest default.
public enum Resolver {
    public static func activeTakeover(in catalog: Catalog, at now: Date) -> Takeover? {
        catalog.takeovers.first { $0.isActive(at: now) && catalog.wallpaper(id: $0.wallpaperID) != nil }
    }

    public static func resolve(
        catalog: Catalog,
        selection: SelectionState,
        displayIDs: [String],
        forcedWallpaperID: String?,
        now: Date
    ) -> [String: Resolution] {
        var result: [String: Resolution] = [:]

        if let forced = catalog.wallpaper(id: forcedWallpaperID) {
            for displayID in displayIDs {
                result[displayID] = Resolution(wallpaper: forced, source: .managed)
            }
            return result
        }

        if let takeover = activeTakeover(in: catalog, at: now),
           let wallpaper = catalog.wallpaper(id: takeover.wallpaperID) {
            for displayID in displayIDs {
                result[displayID] = Resolution(wallpaper: wallpaper, source: .takeover(takeover))
            }
            return result
        }

        for displayID in displayIDs {
            if let chosen = catalog.wallpaper(id: selection.wallpaperID(forDisplay: displayID)), chosen.selectable {
                result[displayID] = Resolution(wallpaper: chosen, source: .user)
            } else if let fallback = catalog.fallbackWallpaper {
                result[displayID] = Resolution(wallpaper: fallback, source: .fallback)
            }
        }
        return result
    }

    /// The next moment a takeover starts or ends, so the app can wake up
    /// exactly then instead of polling.
    public static func nextBoundary(in catalog: Catalog, after now: Date) -> Date? {
        catalog.takeovers
            .flatMap { [$0.startsAt, $0.endsAt] }
            .compactMap { $0 }
            .filter { $0 > now }
            .min()
    }
}
