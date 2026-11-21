import Foundation
import SceneryCore

/// Loads the approved catalog, either from IT's manifest URL or from the demo
/// catalog bundled inside the app.
///
/// Remote manifests are fetched with an ETag, so a "has anything changed?"
/// check is a tiny request that normally comes back empty. The last good
/// manifest is kept on disk so the app starts instantly and works offline.
struct CatalogService {
    enum Source: Equatable {
        case bundledDemo
        case manifest(URL)

        static var current: Source {
            if let url = Prefs.manifestURL { return .manifest(url) }
            return .bundledDemo
        }
    }

    enum ServiceError: LocalizedError {
        case demoCatalogMissing
        case badResponse(Int)
        case tooLarge

        var errorDescription: String? {
            switch self {
            case .demoCatalogMissing:
                return "The built-in demo catalog is missing from the app."
            case .badResponse(let status):
                return "The wallpaper server answered with status \(status)."
            case .tooLarge:
                return "The wallpaper manifest is unexpectedly large."
            }
        }
    }

    static let maxManifestBytes = 1_000_000

    let source: Source
    private let cacheFile: URL

    init(source: Source, supportDirectory: URL) {
        self.source = source
        self.cacheFile = supportDirectory.appendingPathComponent("manifest.json")
    }

    /// The catalog that can be shown immediately, without the network.
    func loadImmediately() -> Catalog? {
        switch source {
        case .bundledDemo:
            guard let url = Self.bundledManifestURL, let data = try? Data(contentsOf: url) else { return nil }
            return try? ManifestParser.parse(data, baseURL: url)
        case .manifest(let url):
            if url.isFileURL {
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? ManifestParser.parse(data, baseURL: url)
            }
            guard Prefs.defaults.string(forKey: Prefs.Key.manifestCachedFrom) == url.absoluteString,
                  let data = try? Data(contentsOf: cacheFile) else {
                return nil
            }
            return try? ManifestParser.parse(data, baseURL: url)
        }
    }

    /// Checks the source. Returns `nil` when nothing changed since last time.
    func fetch() async throws -> Catalog? {
        switch source {
        case .bundledDemo:
            guard let url = Self.bundledManifestURL else { throw ServiceError.demoCatalogMissing }
            return try ManifestParser.parse(try Data(contentsOf: url), baseURL: url)

        case .manifest(let url) where url.isFileURL:
            return try ManifestParser.parse(try Data(contentsOf: url), baseURL: url)

        case .manifest(let url):
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
            let cachedForThisURL = Prefs.defaults.string(forKey: Prefs.Key.manifestCachedFrom) == url.absoluteString
                && FileManager.default.fileExists(atPath: cacheFile.path)
            if cachedForThisURL, let etag = Prefs.defaults.string(forKey: Prefs.Key.manifestETag) {
                request.setValue(etag, forHTTPHeaderField: "If-None-Match")
            }

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ServiceError.badResponse(-1) }
            if http.statusCode == 304 { return nil }
            guard (200..<300).contains(http.statusCode) else { throw ServiceError.badResponse(http.statusCode) }
            guard data.count <= Self.maxManifestBytes else { throw ServiceError.tooLarge }

            // Only a manifest that parses is allowed to replace the cached one,
            // so a bad publish never wipes out a working catalog.
            let catalog = try ManifestParser.parse(data, baseURL: url)
            try? data.write(to: cacheFile, options: .atomic)
            Prefs.defaults.set(url.absoluteString, forKey: Prefs.Key.manifestCachedFrom)
            Prefs.defaults.set(http.value(forHTTPHeaderField: "ETag"), forKey: Prefs.Key.manifestETag)
            return catalog
        }
    }

    private static var bundledManifestURL: URL? {
        Bundle.main.url(forResource: "manifest", withExtension: "json", subdirectory: "DemoCatalog")
    }
}
