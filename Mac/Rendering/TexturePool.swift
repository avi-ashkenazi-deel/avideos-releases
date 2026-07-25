import Foundation
import Metal

/// Recycles intermediate render-target textures so the compositor never
/// allocates per frame. Keyed by (width, height, pixelFormat); textures are
/// checked back in at end-of-frame.
final class TexturePool {
    private struct Key: Hashable {
        let width: Int
        let height: Int
        let format: MTLPixelFormat
    }

    private let device: MTLDevice
    private var free: [Key: [MTLTexture]] = [:]
    private var inUse: [MTLTexture] = []
    private let lock = NSLock()

    init(device: MTLDevice) {
        self.device = device
    }

    /// Fetches (or creates) a render-target + shader-readable texture.
    func texture(width: Int, height: Int, format: MTLPixelFormat = .bgra8Unorm) -> MTLTexture? {
        let key = Key(width: width, height: height, format: format)
        lock.lock()
        defer { lock.unlock() }
        if var list = free[key], let tex = list.popLast() {
            free[key] = list
            inUse.append(tex)
            return tex
        }
        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: format, width: width, height: height, mipmapped: false)
        desc.usage = [.renderTarget, .shaderRead, .shaderWrite]
        desc.storageMode = .private
        guard let tex = device.makeTexture(descriptor: desc) else { return nil }
        inUse.append(tex)
        return tex
    }

    /// Returns every checked-out texture to the free lists. Call once per
    /// frame after the command buffer is committed — GPU work retains the
    /// textures it references, so immediate recycling on the CPU is safe.
    func recycleAll() {
        lock.lock()
        defer { lock.unlock() }
        for tex in inUse {
            let key = Key(width: tex.width, height: tex.height, format: tex.pixelFormat)
            free[key, default: []].append(tex)
        }
        inUse.removeAll(keepingCapacity: true)
    }

    /// Drops cached textures (e.g. on canvas-size change).
    func drain() {
        lock.lock()
        defer { lock.unlock() }
        free.removeAll()
        inUse.removeAll()
    }
}
