import Foundation
import CoreMedia
import Metal
import os

/// Owns the live `FrameSource` instances, keyed by `SourceKey`. Camera and
/// screen sessions are expensive, so only the active scene's sources run —
/// plus both scenes' during a transition. Guest sources live as long as the
/// guest is connected regardless of scene (their frames also feed podcast
/// recording).
final class SourceRegistry {
    private let device: MTLDevice
    private var sources: [SourceKey: FrameSource] = [:]
    private let lock = NSLock()
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "sources")

    /// Program frame rate for screen sources (was hardcoded 30). Set by
    /// StudioController from the project; applies to sources created after.
    var framesPerSecond = 30

    /// Resolves document-level media/config for a key. Set by StudioController.
    var mediaResolver: ((SourceKey) -> URL?)?
    var webContentResolver: ((SourceKey) -> WebContent?)?
    /// The camera-scene primary tap (segmentation + host local recording).
    var cameraFrameTap: ((CMSampleBuffer) -> Void)?

    init(device: MTLDevice) {
        self.device = device
    }

    /// The compositor's texture provider — called on the render thread.
    func texture(for key: SourceKey, at time: CMTime) -> MTLTexture? {
        lock.lock()
        let source = sources[key]
        lock.unlock()
        return source?.latestFrame(at: time)?.texture
    }

    /// The camera scene's latest raw pixel buffer (for segmentation).
    func latestPixelBuffer(for key: SourceKey) -> CVPixelBuffer? {
        lock.lock()
        let source = sources[key]
        lock.unlock()
        return source?.latestFrame(at: .zero)?.pixelBuffer
    }

    func source(for key: SourceKey) -> FrameSource? {
        lock.lock()
        defer { lock.unlock() }
        return sources[key]
    }

    /// Registers an externally-managed source (guests are created by the
    /// guest session controller when a participant publishes video).
    func register(_ source: FrameSource) {
        lock.lock()
        sources[source.key] = source
        lock.unlock()
        source.start()
    }

    func unregister(key: SourceKey) {
        lock.lock()
        let source = sources.removeValue(forKey: key)
        lock.unlock()
        source?.stop()
    }

    /// Drops all display/window screen sources so the next `activate` (or
    /// recompile) rebuilds them — they capture their frame rate at creation.
    func unregisterScreenSources() {
        lock.lock()
        let screenKeys = sources.keys.filter { key in
            if case .display = key { return true }
            if case .window = key { return true }
            return false
        }
        lock.unlock()
        screenKeys.forEach { unregister(key: $0) }
    }

    /// Reconciles running sources with the set a plan (or transition) needs:
    /// starts missing ones, stops orphans. Guest sources are exempt from
    /// stopping (session-scoped, not scene-scoped).
    func activate(keys: Set<SourceKey>) {
        lock.lock()
        let existing = Set(sources.keys)
        lock.unlock()

        for key in keys.subtracting(existing) {
            if let source = makeSource(for: key) {
                register(source)
            }
        }

        for key in existing.subtracting(keys) {
            if case .guest = key { continue }
            unregister(key: key)
        }
    }

    private func makeSource(for key: SourceKey) -> FrameSource? {
        switch key {
        case .camera(let uid):
            let source = CameraSource(key: key, deviceUniqueID: uid, metalDevice: device)
            source.frameTap = cameraFrameTap
            return source
        case .display(let displayID):
            return ScreenSource(key: key, target: .display(displayID: displayID),
                                framesPerSecond: framesPerSecond, showsCursor: true, metalDevice: device)
        case .window(let windowID):
            return ScreenSource(key: key, target: .window(windowID: windowID),
                                framesPerSecond: framesPerSecond, showsCursor: true, metalDevice: device)
        case .movie(let elementID):
            guard let url = mediaResolver?(key) else {
                log.warning("No media for movie element \(elementID)")
                return nil
            }
            return MovieSource(key: key, url: url, loops: true, muted: true, metalDevice: device)
        case .fillVideo(let elementID):
            guard let url = mediaResolver?(key) else {
                log.warning("No media for fill video \(elementID)")
                return nil
            }
            return MovieSource(key: key, url: url, loops: true, muted: true, metalDevice: device)
        case .web:
            guard let content = webContentResolver?(key) else { return nil }
            return WebSource(key: key, content: content, metalDevice: device)
        case .image:
            guard let url = mediaResolver?(key) else { return nil }
            return ImageSource(key: key, url: url, metalDevice: device)
        case .guest:
            // Guest sources are registered by GuestSessionController, never
            // fabricated here.
            return nil
        case .scenePrimary:
            // Scene-primary sources (movie scene player, picker-chosen screen)
            // are created and registered by StudioController with the concrete
            // configuration; nothing to fabricate from the key alone.
            return nil
        }
    }

    /// Every source key a plan references.
    static func keys(in plan: RenderPlan) -> Set<SourceKey> {
        var keys = Set<SourceKey>()
        for item in plan.items {
            switch item.content {
            case .source(let key):
                keys.insert(key)
            case .fill(let fill), .text(_, let fill):
                if case .video = fill {
                    keys.insert(.fillVideo(elementID: item.id))
                }
            }
            if let stroke = item.stroke, case .video = stroke.fill {
                keys.insert(.fillVideo(elementID: item.id))
            }
        }
        return keys
    }

    func stopAll() {
        lock.lock()
        let all = sources.values
        sources.removeAll()
        lock.unlock()
        all.forEach { $0.stop() }
    }
}
