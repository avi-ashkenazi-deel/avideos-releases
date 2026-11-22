import Foundation

public enum ManifestError: Error, Equatable, LocalizedError {
    case malformed(String)
    case unsupportedVersion(Int)
    case noUsableWallpapers

    public var errorDescription: String? {
        switch self {
        case .malformed(let detail):
            return "The wallpaper manifest could not be read (\(detail))."
        case .unsupportedVersion(let version):
            return "The wallpaper manifest uses version \(version), which this app does not understand yet."
        case .noUsableWallpapers:
            return "The wallpaper manifest does not contain any usable wallpapers."
        }
    }
}

/// Turns manifest JSON into a validated `Catalog`.
///
/// The parser is deliberately forgiving about single bad entries (they are
/// dropped and reported in `Catalog.issues`) and strict about anything that
/// would be unsafe: plain `http`, unknown file types, unknown versions.
public enum ManifestParser {
    public static let supportedVersion = 1

    static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "heic"]
    static let videoExtensions: Set<String> = ["mp4", "mov", "m4v"]

    public static func parse(_ data: Data, baseURL: URL) throws -> Catalog {
        let raw: RawManifest
        do {
            raw = try JSONDecoder().decode(RawManifest.self, from: data)
        } catch {
            throw ManifestError.malformed(String(describing: error))
        }
        guard raw.version == supportedVersion else {
            throw ManifestError.unsupportedVersion(raw.version)
        }

        var issues: [String] = []
        var wallpapers: [Wallpaper] = []
        var seenIDs: Set<String> = []
        var selectableCount = 0

        for (index, entry) in raw.wallpapers.enumerated() {
            guard let item = entry.value else {
                issues.append("Wallpaper #\(index + 1) is missing an id or is not written correctly and was skipped.")
                continue
            }
            let id = item.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else {
                issues.append("Wallpaper #\(index + 1) has an empty id and was skipped.")
                continue
            }
            guard !seenIDs.contains(id) else {
                issues.append("Wallpaper id \"\(id)\" is used more than once; only the first is kept.")
                continue
            }
            let kind: Wallpaper.Kind
            var url: URL?
            var palette: DayPalette?
            if item.kind?.lowercased() == Wallpaper.Kind.live.rawValue {
                // A live wallpaper is drawn from colours, so it has no file.
                guard let parsed = item.palette?.value?.palette else {
                    issues.append("Live wallpaper \"\(id)\" needs a palette with night, dawn, day and dusk, each with the same number (2 to 4) of #RRGGBB colours, and was skipped.")
                    continue
                }
                kind = .live
                palette = parsed
            } else {
                guard let text = item.url else {
                    issues.append("Wallpaper \"\(id)\" has no url and was skipped.")
                    continue
                }
                guard let resolved = resolve(text, baseURL: baseURL) else {
                    issues.append("Wallpaper \"\(id)\" has a url that is not allowed (use https) and was skipped.")
                    continue
                }
                guard let fileKind = self.kind(declared: item.kind, url: resolved) else {
                    issues.append("Wallpaper \"\(id)\" is not a supported image or video file and was skipped.")
                    continue
                }
                kind = fileKind
                url = resolved
            }

            var posterURL: URL?
            if kind == .video, let poster = item.posterURL {
                if let resolved = resolve(poster, baseURL: baseURL),
                   imageExtensions.contains(resolved.pathExtension.lowercased()) {
                    posterURL = resolved
                } else {
                    issues.append("Wallpaper \"\(id)\" has a posterURL that is not allowed; the first video frame is used instead.")
                }
            }

            var selectable = item.selectable ?? true
            if selectable {
                if selectableCount >= Catalog.maxSelectable {
                    selectable = false
                    issues.append("Wallpaper \"\(id)\" is over the limit of \(Catalog.maxSelectable) selectable wallpapers and is hidden from the picker.")
                } else {
                    selectableCount += 1
                }
            }

            seenIDs.insert(id)
            let title = item.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            let sha256 = item.sha256?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            wallpapers.append(
                Wallpaper(
                    id: id,
                    title: (title?.isEmpty == false ? title : nil) ?? id,
                    kind: kind,
                    url: url,
                    posterURL: posterURL,
                    sha256: (sha256?.isEmpty == false) ? sha256 : nil,
                    selectable: selectable,
                    palette: palette
                )
            )
        }

        guard !wallpapers.isEmpty else {
            throw ManifestError.noUsableWallpapers
        }

        var takeovers: [Takeover] = []
        for (index, entry) in (raw.takeovers ?? []).enumerated() {
            let label = "Takeover #\(index + 1)"
            guard let item = entry.value else {
                issues.append("\(label) is missing a wallpaperID and was skipped.")
                continue
            }
            guard seenIDs.contains(item.wallpaperID) else {
                issues.append("\(label) points at unknown wallpaper \"\(item.wallpaperID)\" and was skipped.")
                continue
            }
            // A date that is present but unreadable must never silently turn
            // into "no limit", so the whole takeover is dropped instead.
            var startsAt: Date?
            if let text = item.startsAt {
                guard let date = parseDate(text) else {
                    issues.append("\(label) has an unreadable startsAt (\"\(text)\") and was skipped.")
                    continue
                }
                startsAt = date
            }
            var endsAt: Date?
            if let text = item.endsAt {
                guard let date = parseDate(text) else {
                    issues.append("\(label) has an unreadable endsAt (\"\(text)\") and was skipped.")
                    continue
                }
                endsAt = date
            }
            if let startsAt, let endsAt, endsAt <= startsAt {
                issues.append("\(label) ends before it starts and was skipped.")
                continue
            }
            takeovers.append(
                Takeover(wallpaperID: item.wallpaperID, startsAt: startsAt, endsAt: endsAt, message: item.message)
            )
        }

        var defaultID = raw.defaultWallpaperID
        if let id = defaultID, !seenIDs.contains(id) {
            issues.append("defaultWallpaperID \"\(id)\" is not in the list; the first wallpaper is used instead.")
            defaultID = nil
        }

        return Catalog(wallpapers: wallpapers, defaultWallpaperID: defaultID, takeovers: takeovers, issues: issues)
    }

    // MARK: - Helpers

    /// Resolves `text` against the manifest's own URL, so IT can use short
    /// relative paths. Remote manifests may only point at `https` files. Local
    /// files are only allowed when the manifest itself is a local file (the
    /// bundled demo catalog, or a designer testing on their own Mac).
    static func resolve(_ text: String, baseURL: URL) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed, relativeTo: baseURL)?.absoluteURL else {
            return nil
        }
        switch url.scheme?.lowercased() {
        case "https":
            return url.host?.isEmpty == false ? url : nil
        case "file":
            return baseURL.isFileURL ? url : nil
        default:
            return nil
        }
    }

    static func kind(declared: String?, url: URL) -> Wallpaper.Kind? {
        let ext = url.pathExtension.lowercased()
        let inferred: Wallpaper.Kind?
        if imageExtensions.contains(ext) {
            inferred = .image
        } else if videoExtensions.contains(ext) {
            inferred = .video
        } else {
            inferred = nil
        }
        guard let inferred else { return nil }
        if let declared, let declaredKind = Wallpaper.Kind(rawValue: declared.lowercased()), declaredKind != inferred {
            // The file extension decides how the file is opened, so a
            // mismatch means the entry is wrong.
            return nil
        }
        return inferred
    }

    /// Accepts `2026-12-01T09:00:00Z`, the same with fractional seconds or a
    /// UTC offset, and a bare `2026-12-01` (midnight UTC).
    static func parseDate(_ text: String) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let formatter = ISO8601DateFormatter()
        for options: ISO8601DateFormatter.Options in [
            [.withInternetDateTime],
            [.withInternetDateTime, .withFractionalSeconds],
        ] {
            formatter.formatOptions = options
            if let date = formatter.date(from: trimmed) { return date }
        }
        // Bare dates are checked by shape first so that odd strings are not
        // half-parsed into a date.
        let parts = trimmed.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isNumber) }) else {
            return nil
        }
        formatter.formatOptions = [.withFullDate]
        return formatter.date(from: trimmed)
    }
}

// MARK: - Raw JSON shapes

private struct RawManifest: Decodable {
    let version: Int
    let wallpapers: [Lossy<RawWallpaper>]
    let defaultWallpaperID: String?
    let takeovers: [Lossy<RawTakeover>]?
}

private struct RawWallpaper: Decodable {
    let id: String
    let title: String?
    let kind: String?
    let url: String?
    let posterURL: String?
    let sha256: String?
    let selectable: Bool?
    let palette: Lossy<RawPalette>?
}

private struct RawPalette: Decodable {
    let night: [String]
    let dawn: [String]
    let day: [String]
    let dusk: [String]

    /// `nil` if any colour is unreadable or the four lists differ in length.
    var palette: DayPalette? {
        func colors(_ list: [String]) -> [RGB]? {
            let parsed = list.compactMap { RGB(hex: $0) }
            return parsed.count == list.count ? parsed : nil
        }
        guard let night = colors(night), let dawn = colors(dawn), let day = colors(day), let dusk = colors(dusk) else {
            return nil
        }
        return DayPalette(night: night, dawn: dawn, day: day, dusk: dusk)
    }
}

private struct RawTakeover: Decodable {
    let wallpaperID: String
    let startsAt: String?
    let endsAt: String?
    let message: String?
}

/// Lets one malformed array element fail on its own instead of taking the
/// whole manifest down with it.
private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}
