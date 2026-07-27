import Foundation

/// One imported file, available to be used more than once.
///
/// The bin earns its place on four counts: the same clip often gets used
/// several times, the probe result has to be cached somewhere, relinking needs
/// one place to fix a moved file from — and `BRollSuggester.suggest` already
/// takes a `mediaLibrary` it has never been given anything but the session's
/// own recordings. The bin is that missing input.
struct MediaBinItem: Identifiable, Codable, Hashable {
    let id: UUID
    var media: MediaReference
    /// Cached so the UI never re-probes to draw a row.
    var duration: Double
    var hasVideo: Bool
    var hasAudio: Bool
    /// True when the file was converted on import, so the row can say so.
    var wasConverted: Bool

    init(id: UUID = UUID(),
         media: MediaReference,
         duration: Double,
         hasVideo: Bool,
         hasAudio: Bool,
         wasConverted: Bool = false) {
        self.id = id
        self.media = media
        self.duration = duration
        self.hasVideo = hasVideo
        self.hasAudio = hasAudio
        self.wasConverted = wasConverted
    }

    var isStill: Bool { duration == 0 && hasVideo }
}

extension EditProject {
    var binItems: [MediaBinItem] { mediaBin ?? [] }

    mutating func addToBin(_ item: MediaBinItem) {
        var all = mediaBin ?? []
        // Dedupe by resolved path: many cutaways may share one bin item, which
        // is the point, but the same file shouldn't appear twice.
        if let existing = all.first(where: { $0.media.path == item.media.path }) {
            _ = existing
            return
        }
        all.append(item)
        mediaBin = all
    }

    mutating func removeFromBin(id: UUID) {
        mediaBin = (mediaBin ?? []).filter { $0.id != id }
        if mediaBin?.isEmpty == true { mediaBin = nil }
    }

    func binItem(id: UUID) -> MediaBinItem? {
        mediaBin?.first { $0.id == id }
    }

    /// Natural length of whatever media a cutaway points at, when the bin
    /// knows it. Feeds the inspector's "start inside clip" bound.
    func mediaDuration(forPath path: String) -> Double? {
        mediaBin?.first { $0.media.path == path }?.duration
    }

    /// Every piece of media the project references that can no longer be
    /// resolved — bin items, cutaways, and (later) external tracks.
    var missingMedia: [MediaReference] {
        var found: [MediaReference] = []
        for item in binItems where item.media.resolve() == nil { found.append(item.media) }
        for overlay in overlays ?? [] where overlay.media.resolve() == nil {
            found.append(overlay.media)
        }
        return found
    }

    /// Points every reference that lived in the same old folder at the new
    /// one.
    ///
    /// This is the difference between relinking one file and relinking twenty:
    /// media almost always moves as a folder, so fixing one sibling should fix
    /// the rest without twenty more trips through an open panel.
    @discardableResult
    mutating func relink(oldPath: String, to newURL: URL) -> Int {
        let oldParent = (oldPath as NSString).deletingLastPathComponent
        let newParent = newURL.deletingLastPathComponent()
        var relinked = 0

        func rewrite(_ reference: inout MediaReference) {
            let parent = (reference.path as NSString).deletingLastPathComponent
            guard parent == oldParent else { return }
            let candidate = newParent
                .appendingPathComponent((reference.path as NSString).lastPathComponent)
            guard FileManager.default.fileExists(atPath: candidate.path) else { return }
            reference = MediaReference(url: candidate)
            relinked += 1
        }

        if var bin = mediaBin {
            for index in bin.indices { rewrite(&bin[index].media) }
            mediaBin = bin
        }
        if var all = overlays {
            for index in all.indices { rewrite(&all[index].media) }
            overlays = all
        }
        return relinked
    }
}
