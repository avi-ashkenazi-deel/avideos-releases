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
            }
        }
    }

    /// Generous for a looping video, small enough to stop a mistake.
    static let maxAssetBytes: Int64 = 400 * 1024 * 1024

    private let assetsDirectory: URL
    private let postersDirectory: URL
    private var downloads: [URL: Task<URL, Error>] = [:]

    init(supportDirectory: URL) {
        assetsDirectory = supportDirectory.appendingPathComponent("Assets", isDirectory: true)
        postersDirectory = supportDirectory.appendingPathComponent("Posters", isDirectory: true)
        try? FileManager.default.createDirectory(at: assetsDirectory, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: postersDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Public

    /// The image or video file for a wallpaper, downloading it if needed.
    func file(for wallpaper: Wallpaper) async throws -> URL {
        try await localCopy(of: wallpaper.url, id: wallpaper.id, sha256: wallpaper.sha256)
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
        }
    }

    /// Deletes downloaded files that the current catalog no longer mentions.
    func prune(keeping catalog: Catalog) {
        var keep: Set<String> = []
        for wallpaper in catalog.wallpapers {
            keep.insert(cachedFile(for: wallpaper.url, id: wallpaper.id).lastPathComponent)
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

        // Written to a scratch file first and then moved into place, so a
        // half-written poster can never be picked up as a wallpaper.
        let scratch = postersDirectory.appendingPathComponent(UUID().uuidString + ".tmp")
        defer { try? FileManager.default.removeItem(at: scratch) }
        guard let destination = CGImageDestinationCreateWithURL(
            scratch as CFURL, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw AssetError.posterFailed
        }
        let options = [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary
        CGImageDestinationAddImage(destination, frame, options)
        guard CGImageDestinationFinalize(destination) else {
            throw AssetError.posterFailed
        }
        if !FileManager.default.fileExists(atPath: poster.path) {
            try FileManager.default.moveItem(at: scratch, to: poster)
        }
        return poster
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
