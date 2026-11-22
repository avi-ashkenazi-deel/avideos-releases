import AVFoundation
import CryptoKit
import Foundation
import ImageIO
import SceneryCore
import UniformTypeIdentifiers

/// Keeps wallpaper files on disk and hands out local file URLs.
///
/// - Files that are already local (the bundled demo catalog) are used in place.
/// - Remote files are downloaded once into Application Support and reused.
/// - If the manifest lists a SHA-256, a download that does not match is thrown
///   away, so only the exact file IT approved can ever be shown.
actor AssetStore {
    enum AssetError: LocalizedError {
        case missingLocalFile(String)
        case badResponse(Int)
        case tooLarge
        case checksumMismatch(String)
        case posterFailed
        case sliceFailed

        var errorDescription: String? {
            switch self {
            case .missingLocalFile(let name):
                return "The wallpaper file \(name) is missing."
            case .badResponse(let status):
                return "A wallpaper could not be downloaded (status \(status))."
            case .tooLarge:
                return "A wallpaper file is larger than the app allows."
            case .checksumMismatch(let id):
                return "The wallpaper \"\(id)\" does not match its approved checksum and was not used."
            case .posterFailed:
                return "A still frame could not be created for a video wallpaper."
            case .sliceFailed:
                return "A wallpaper could not be split across the displays."
            }
        }
    }

    /// Generous for a looping video, small enough to stop a mistake.
    static let maxAssetBytes: Int64 = 400 * 1024 * 1024

    private let assetsDirectory: URL
    private let postersDirectory: URL
    private let slicesDirectory: URL
    private var downloads: [URL: Task<URL, Error>] = [:]

    init(supportDirectory: URL) {
        assetsDirectory = supportDirectory.appendingPathComponent("Assets", isDirectory: true)
        postersDirectory = supportDirectory.appendingPathComponent("Posters", isDirectory: true)
        slicesDirectory = supportDirectory.appendingPathComponent("Slices", isDirectory: true)
        try? FileManager.default.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: postersDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: slicesDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Public

    /// The image or video file for a wallpaper, downloading it if needed.
    func file(for wallpaper: Wallpaper) async throws -> URL {
        guard let url = wallpaper.url else {
            // Live wallpapers are drawn, so they have no file to fetch.
            throw AssetError.missingLocalFile(wallpaper.id)
        }
        return try await localCopy(of: url, id: wallpaper.id, sha256: wallpaper.sha256)
    }

    /// A still image for a wallpaper: the image itself, or a poster for a video.
    func still(for wallpaper: Wallpaper) async throws -> URL {
        switch wallpaper.kind {
        case .image:
            return try await file(for: wallpaper)
        case .video:
            if let posterURL = wallpaper.posterURL,
               let poster = try? await localCopy(of: posterURL, id: wallpaper.id + "-poster", sha256: nil) {
                return poster
            }
            let video = try await file(for: wallpaper)
            return try await generatedPoster(for: video)
        case .live:
            guard let palette = wallpaper.palette else {
                throw AssetError.posterFailed
            }
            return try liveStill(for: palette)
        }
    }

    /// One display's part of a still that is stretched across `canvas`.
    ///
    /// macOS sets wallpapers one display at a time, so spanning a picture
    /// means giving each display its own cropped copy. The copies are cached
    /// by what they were cut from and how the displays were arranged.
    func slice(of still: URL, canvas: CGRect, display: CGRect) throws -> URL {
        let recipe = "\(still.path)|\(canvas.debugDescription)|\(display.debugDescription)"
        let digest = SHA256.hash(data: Data(recipe.utf8))
        let name = digest.prefix(12).map { String(format: "%02x", $0) }.joined()
        let slice = slicesDirectory.appendingPathComponent(name + ".jpg")

        if FileManager.default.fileExists(atPath: slice.path) {
            // Marks the slice as still in use, so `prune` leaves it alone.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: slice.path)
            return slice
        }

        guard let source = CGImageSourceCreateWithURL(still as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw AssetError.sliceFailed
        }
        let crop = SpanGeometry.cropRect(
            imageSize: CGSize(width: image.width, height: image.height),
            canvas: canvas,
            display: display
        )
        guard crop.width >= 1, crop.height >= 1, let cropped = image.cropping(to: crop) else {
            throw AssetError.sliceFailed
        }
        try writeJPEG(cropped, to: slice, in: slicesDirectory, failure: .sliceFailed)
        return slice
    }

    /// Deletes downloaded files that the current catalog no longer mentions.
    func prune(keeping catalog: Catalog) {
        var keep: Set<String> = []
        for wallpaper in catalog.wallpapers {
            if let url = wallpaper.url {
                keep.insert(cachedFile(for: url, id: wallpaper.id).lastPathComponent)
            }
            if let posterURL = wallpaper.posterURL {
                keep.insert(cachedFile(for: posterURL, id: wallpaper.id + "-poster").lastPathComponent)
            }
        }
        let fileManager = FileManager.default
        for name in (try? fileManager.contentsOfDirectory(atPath: assetsDirectory.path)) ?? [] where !keep.contains(name) {
            try? fileManager.removeItem(at: assetsDirectory.appendingPathComponent(name))
        }
        let keptStems = Set(keep.map { ($0 as NSString).deletingPathExtension })
        for name in (try? fileManager.contentsOfDirectory(atPath: postersDirectory.path)) ?? [] {
            let stem = (name as NSString).deletingPathExtension
            // Posters made from bundled files are keyed by a path hash and are
            // tiny, so only posters of removed downloads are cleaned up.
            if stem.hasPrefix("dl-"), !keptStems.contains(String(stem.dropFirst(3))) {
                try? fileManager.removeItem(at: postersDirectory.appendingPathComponent(name))
            }
        }
        // Slices are touched every time they are used, so anything untouched
        // for a month belongs to a retired wallpaper or an old desk setup.
        let cutoff = Date().addingTimeInterval(-30 * 24 * 60 * 60)
        for name in (try? fileManager.contentsOfDirectory(atPath: slicesDirectory.path)) ?? [] {
            let path = slicesDirectory.appendingPathComponent(name).path
            let modified = (try? fileManager.attributesOfItem(atPath: path))?[.modificationDate] as? Date
            if let modified, modified < cutoff {
                try? fileManager.removeItem(atPath: path)
            }
        }
    }

    // MARK: - Files

    private func localCopy(of url: URL, id: String, sha256: String?) async throws -> URL {
        if url.isFileURL {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw AssetError.missingLocalFile(url.lastPathComponent)
            }
            return url
        }

        let destination = cachedFile(for: url, id: id)
        if FileManager.default.fileExists(atPath: destination.path) {
            return destination
        }
        if let running = downloads[url] {
            return try await running.value
        }

        let task = Task<URL, Error> {
            let (temporary, response) = try await URLSession.shared.download(from: url)
            defer { try? FileManager.default.removeItem(at: temporary) }

            guard let http = response as? HTTPURLResponse else { throw AssetError.badResponse(-1) }
            guard (200..<300).contains(http.statusCode) else { throw AssetError.badResponse(http.statusCode) }

            let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
            let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
            guard size > 0, size <= Self.maxAssetBytes else { throw AssetError.tooLarge }

            if let sha256, try Self.sha256(of: temporary) != sha256 {
                throw AssetError.checksumMismatch(id)
            }

            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)
            return destination
        }
        downloads[url] = task
        defer { downloads[url] = nil }
        return try await task.value
    }

    /// The file name contains a hash of the source URL. A wallpaper that is
    /// republished at a new URL therefore lands in a new file, which is also
    /// what makes macOS notice that the picture changed.
    private func cachedFile(for url: URL, id: String) -> URL {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        let hash = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        let safeID = String(id.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }.prefix(48))
        let ext = url.pathExtension.lowercased()
        return assetsDirectory.appendingPathComponent("\(safeID)-\(hash).\(ext)")
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Posters

    private func generatedPoster(for video: URL) async throws -> URL {
        let stem: String
        if video.path.hasPrefix(assetsDirectory.path) {
            stem = "dl-" + video.deletingPathExtension().lastPathComponent
        } else {
            let digest = SHA256.hash(data: Data(video.path.utf8))
            stem = "local-" + digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        }
        let poster = postersDirectory.appendingPathComponent(stem + ".jpg")
        if FileManager.default.fileExists(atPath: poster.path) {
            return poster
        }

        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: video))
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let frame = try await generator.image(at: .zero).image

        try writeJPEG(frame, to: poster, in: postersDirectory, failure: .posterFailed)
        return poster
    }

    /// A still of a live wallpaper in its daytime colours. It is what macOS
    /// shows where the live window cannot go (the lock screen, Mission
    /// Control) and what the picker uses as the preview.
    private func liveStill(for palette: DayPalette) throws -> URL {
        let recipe = palette.day.map { "\($0.red),\($0.green),\($0.blue)" }.joined(separator: "|")
        let digest = SHA256.hash(data: Data(recipe.utf8))
        let name = "live-" + digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        let still = postersDirectory.appendingPathComponent(name + ".jpg")
        if FileManager.default.fileExists(atPath: still.path) {
            return still
        }

        let width = 1920
        let height = 1200
        let colors = palette.day.map {
            CGColor(srgbRed: CGFloat($0.red), green: CGFloat($0.green), blue: CGFloat($0.blue), alpha: 1)
        }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                  space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
              ),
              let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: nil) else {
            throw AssetError.posterFailed
        }
        // Drawing coordinates start bottom-left, so the first colour goes at
        // the top edge.
        context.drawLinearGradient(
            gradient, start: CGPoint(x: 0, y: CGFloat(height)), end: CGPoint(x: 0, y: 0), options: []
        )
        guard let image = context.makeImage() else {
            throw AssetError.posterFailed
        }
        try writeJPEG(image, to: still, in: postersDirectory, failure: .posterFailed)
        return still
    }

    // MARK: - Writing images

    /// Written to a scratch file first and then moved into place, so a
    /// half-written image can never be picked up as a wallpaper.
    private func writeJPEG(_ image: CGImage, to file: URL, in directory: URL, failure: AssetError) throws {
        let scratch = directory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard let destination = CGImageDestinationCreateWithURL(
            scratch as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw failure
        }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else {
            throw failure
        }
        if !FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.moveItem(at: scratch, to: file)
        }
    }
}

/// Small previews for the picker. Decoding straight to thumbnail size keeps
/// memory flat no matter how large the original wallpapers are.
enum Thumbnailer {
    static func thumbnail(of file: URL, maxPixelSize: Int = 520) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}
