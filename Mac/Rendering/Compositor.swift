import Foundation
import Metal
import CoreMedia
import simd

/// Executes a `RenderPlan` for one frame: resolves each item's animated
/// transform, fetches content textures, runs effect chains, draws strokes,
/// and composites with blend modes into the program texture.
///
/// Runs entirely on the render queue inside a single command buffer per frame.
final class Compositor {
    /// Mirrors `ItemUniforms` in Composite.metal — field order and alignment
    /// must match MSL layout (float3x3 = 48B, float4 aligns to 16B).
    /// Mirrors `ItemUniforms` in Composite.metal — field order and types must
    /// match exactly. MSL offsets: transform 0, opacity 48, cornerRadius 52,
    /// itemSizePx 56, strokeWidthPx 64, time 68, fillColorA 80 (float4 aligns
    /// to 16), fillColorB 96, params 112/116, fillKind 120, fitMode 124,
    /// contentAspect 128, zoom 132, pan 136, blurStrength 144 → size 160.
    struct ItemUniforms {
        var transform: simd_float3x3
        var opacity: Float
        var cornerRadius: Float
        var itemSizePx: SIMD2<Float>
        var strokeWidthPx: Float
        var time: Float
        var fillColorA: SIMD4<Float>
        var fillColorB: SIMD4<Float>
        var fillParam0: Float
        var fillParam1: Float
        var fillKind: Int32
        var fitMode: Int32 = FitModeIndex.stretch
        var contentAspect: Float = 0
        var zoom: Float = 1
        var pan: SIMD2<Float> = .zero
        var blurStrength: Float = 0
    }

    /// Shader-side values for `SourceFit`. Contain and cover are the only two
    /// the shader distinguishes; `.blurredBackdrop` is expressed at plan level
    /// as a cover backdrop plus a contain foreground.
    enum FitModeIndex {
        static let contain: Int32 = 0
        static let cover: Int32 = 1
        static let stretch: Int32 = 2

        static func value(for fit: SourceFit) -> Int32 {
            switch fit {
            case .fit, .blurredBackdrop: contain
            case .fill: cover
            case .stretch: stretch
            }
        }
    }

    struct BlendUniforms {
        var mode: Int32
        var pad0: Float = 0
        var pad1: Float = 0
        var pad2: Float = 0
    }

    enum FillKindIndex {
        static let solid: Int32 = 0
        static let textured: Int32 = 100
        static let videoPaint: Int32 = 200
        static func procedural(_ kind: ShaderFill.Kind) -> Int32 {
            switch kind {
            case .linearGradientSweep: 1
            case .plasma: 2
            case .waves: 3
            case .sparkle: 4
            }
        }
    }

    let device: MTLDevice
    let commandQueue: MTLCommandQueue
    let texturePool: TexturePool
    let textRasterizer: TextRasterizer
    let effectRenderer: EffectChainRenderer

    private let contentPipelineNormal: MTLRenderPipelineState
    private let blendPipeline: MTLRenderPipelineState
    private let linearSampler: MTLSamplerState
    private let whiteTexture: MTLTexture

    /// Provides the latest texture for a live source; owned by SourceRegistry.
    typealias SourceTextureProvider = (SourceKey, CMTime) -> MTLTexture?

    init?(device: MTLDevice) {
        guard let queue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary() else { return nil }
        self.device = device
        self.commandQueue = queue
        self.texturePool = TexturePool(device: device)
        self.textRasterizer = TextRasterizer(device: device)

        guard let vertexFn = library.makeFunction(name: "composite_vertex"),
              let fragmentFn = library.makeFunction(name: "composite_fragment"),
              let blendVertexFn = library.makeFunction(name: "blend_vertex"),
              let blendFragmentFn = library.makeFunction(name: "blend_fragment") else { return nil }

        // Content pipeline with premultiplied source-over blending (the
        // BlendMode.normal fast path, and how items land on scratch layers).
        let contentDesc = MTLRenderPipelineDescriptor()
        contentDesc.vertexFunction = vertexFn
        contentDesc.fragmentFunction = fragmentFn
        contentDesc.colorAttachments[0].pixelFormat = .bgra8Unorm
        contentDesc.colorAttachments[0].isBlendingEnabled = true
        contentDesc.colorAttachments[0].sourceRGBBlendFactor = .one           // premultiplied
        contentDesc.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        contentDesc.colorAttachments[0].sourceAlphaBlendFactor = .one
        contentDesc.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha

        // Blend (ping-pong) pipeline writes the combined result directly.
        let blendDesc = MTLRenderPipelineDescriptor()
        blendDesc.vertexFunction = blendVertexFn
        blendDesc.fragmentFunction = blendFragmentFn
        blendDesc.colorAttachments[0].pixelFormat = .bgra8Unorm
        blendDesc.colorAttachments[0].isBlendingEnabled = false

        let samplerDesc = MTLSamplerDescriptor()
        samplerDesc.minFilter = .linear
        samplerDesc.magFilter = .linear
        samplerDesc.sAddressMode = .clampToEdge
        samplerDesc.tAddressMode = .clampToEdge

        do {
            self.contentPipelineNormal = try device.makeRenderPipelineState(descriptor: contentDesc)
            self.blendPipeline = try device.makeRenderPipelineState(descriptor: blendDesc)
        } catch {
            return nil
        }
        guard let sampler = device.makeSamplerState(descriptor: samplerDesc) else { return nil }
        self.linearSampler = sampler

        // 1×1 white texture bound as glyphTex when an item has no glyph mask.
        let whiteDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
        whiteDesc.usage = [.shaderRead]
        guard let white = device.makeTexture(descriptor: whiteDesc) else { return nil }
        var whitePixel: UInt32 = 0xFFFFFFFF
        white.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0,
                      withBytes: &whitePixel, bytesPerRow: 4)
        self.whiteTexture = white

        self.effectRenderer = EffectChainRenderer(device: device,
                                                  commandQueue: queue,
                                                  library: library,
                                                  texturePool: texturePool)
    }

    /// Renders `plan` into `target` (the program texture) and commits the
    /// command buffer. `onComplete` is registered as a completion handler
    /// *before* the commit — Metal forbids adding handlers to an already
    /// committed buffer — so use it for buffer hand-off once the GPU
    /// finishes the frame.
    @discardableResult
    func render(plan: RenderPlan,
                at time: CMTime,
                into target: MTLTexture,
                sourceTextures: SourceTextureProvider,
                onComplete: ((MTLCommandBuffer) -> Void)? = nil) -> MTLCommandBuffer? {
        guard let commandBuffer = commandQueue.makeCommandBuffer() else { return nil }
        // Recycling before the GPU finishes is safe: pooled textures are only
        // ever written/read by command buffers on this queue, which execute
        // in commit order — next frame's reuse is ordered after this frame.
        defer { texturePool.recycleAll() }

        let now = time.seconds
        let canvasW = target.width
        let canvasH = target.height

        // Accumulators for ping-pong; A starts as the cleared canvas.
        guard var accum = texturePool.texture(width: canvasW, height: canvasH) else { return nil }
        clear(accum, color: plan.backgroundColor, in: commandBuffer)

        for item in plan.items {
            // 1. Animation lifecycle → final transform (nil = fully exited).
            guard let progress = item.animation.progress(at: now, duration: item.entryAnimation.duration)
            else { continue }
            let transform = progress >= 1
                ? item.transform
                : item.entryAnimation.apply(progress: progress, to: item.transform)
            guard transform.opacity > 0.001 else { continue }

            // 2. Content texture (+ optional glyph mask), effect chain applied.
            let resolved = resolveContent(item: item,
                                          at: time,
                                          canvasSize: CGSize(width: canvasW, height: canvasH),
                                          transform: transform,
                                          sourceTextures: sourceTextures)
            guard let resolved else { continue }
            var contentTexture = resolved.content
            if !item.effects.isEmpty, let content = contentTexture {
                contentTexture = effectRenderer.apply(chain: item.effects,
                                                      to: content,
                                                      at: time,
                                                      commandBuffer: commandBuffer)
            }

            // 3. Composite the content quad.
            var uniforms = makeUniforms(item: item,
                                        transform: transform,
                                        fillKind: resolved.fillKind,
                                        paint: resolved.paint,
                                        canvasW: canvasW, canvasH: canvasH,
                                        strokeWidthPx: 0,
                                        time: Float(now.truncatingRemainder(dividingBy: 3600)))
            applyFraming(&uniforms, item: item, texture: contentTexture)

            if item.blendMode.needsDestinationSample {
                // Render the item alone onto a cleared layer, then blend pass.
                guard let layer = texturePool.texture(width: canvasW, height: canvasH),
                      let blended = texturePool.texture(width: canvasW, height: canvasH)
                else { continue }
                clear(layer, color: .clear, in: commandBuffer)
                drawQuad(uniforms: uniforms,
                         content: contentTexture,
                         glyph: resolved.glyph,
                         onto: layer,
                         in: commandBuffer)
                runBlendPass(mode: item.blendMode, dst: accum, src: layer,
                             into: blended, in: commandBuffer)
                accum = blended
            } else {
                drawQuad(uniforms: uniforms,
                         content: contentTexture,
                         glyph: resolved.glyph,
                         onto: accum,
                         in: commandBuffer)
            }

            // 4. Stroke ring on top of the content (normal blending).
            if let stroke = item.stroke, stroke.width > 0 {
                let strokeResolved = resolvePaint(fill: stroke.fill,
                                                  itemID: item.id,
                                                  at: time,
                                                  sourceTextures: sourceTextures)
                var strokeUniforms = makeUniforms(item: item,
                                                  transform: transform,
                                                  fillKind: strokeResolved.fillKind,
                                                  paint: strokeResolved.paint,
                                                  canvasW: canvasW, canvasH: canvasH,
                                                  strokeWidthPx: Float(stroke.width * Double(canvasW)),
                                                  time: Float(now.truncatingRemainder(dividingBy: 3600)))
                if let radius = stroke.cornerRadius {
                    strokeUniforms.cornerRadius = Float(radius)
                }
                drawQuad(uniforms: strokeUniforms,
                         content: strokeResolved.texture,
                         glyph: nil,
                         onto: accum,
                         in: commandBuffer)
            }
        }

        // Final blit into the program texture.
        if let blit = commandBuffer.makeBlitCommandEncoder() {
            blit.copy(from: accum, sourceSlice: 0, sourceLevel: 0,
                      sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                      sourceSize: MTLSize(width: canvasW, height: canvasH, depth: 1),
                      to: target, destinationSlice: 0, destinationLevel: 0,
                      destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0))
            blit.endEncoding()
        }

        if let onComplete {
            commandBuffer.addCompletedHandler { onComplete($0) }
        }
        commandBuffer.commit()
        return commandBuffer
    }

    // MARK: - Content resolution

    private struct ResolvedContent {
        var content: MTLTexture?
        var glyph: MTLTexture?
        var fillKind: Int32
        var paint: PaintParams
    }

    struct PaintParams {
        var colorA: SIMD4<Float> = SIMD4(1, 1, 1, 1)
        var colorB: SIMD4<Float> = SIMD4(1, 1, 1, 1)
        var param0: Float = 1
        var param1: Float = 1
    }

    private struct ResolvedPaint {
        var texture: MTLTexture?
        var fillKind: Int32
        var paint: PaintParams
    }

    private func resolveContent(item: RenderItem,
                                at time: CMTime,
                                canvasSize: CGSize,
                                transform: ElementTransform,
                                sourceTextures: SourceTextureProvider) -> ResolvedContent? {
        switch item.content {
        case .source(let key):
            guard let texture = sourceTextures(key, time) else { return nil }
            return ResolvedContent(content: texture, glyph: nil,
                                   fillKind: FillKindIndex.textured, paint: PaintParams())
        case .fill(let fill):
            let paint = resolvePaint(fill: fill, itemID: item.id, at: time,
                                     sourceTextures: sourceTextures)
            return ResolvedContent(content: paint.texture, glyph: nil,
                                   fillKind: paint.fillKind, paint: paint.paint)
        case .text(let text, let colorFill):
            let pixelSize = CGSize(width: transform.size.width * canvasSize.width,
                                   height: transform.size.height * canvasSize.height)
            guard let glyphs = textRasterizer.texture(for: text, pixelSize: pixelSize,
                                                      canvasHeight: canvasSize.height)
            else { return nil }
            let paint = resolvePaint(fill: colorFill, itemID: item.id, at: time,
                                     sourceTextures: sourceTextures)
            return ResolvedContent(content: paint.texture, glyph: glyphs,
                                   fillKind: paint.fillKind, paint: paint.paint)
        }
    }

    private func resolvePaint(fill: Fill,
                              itemID: UUID,
                              at time: CMTime,
                              sourceTextures: SourceTextureProvider) -> ResolvedPaint {
        switch fill {
        case .solid(let color):
            var p = PaintParams()
            p.colorA = color.simd
            return ResolvedPaint(texture: nil, fillKind: FillKindIndex.solid, paint: p)
        case .shader(let shader):
            var p = PaintParams()
            p.colorA = shader.colorA.simd
            p.colorB = shader.colorB.simd
            p.param0 = Float(shader.speed)
            p.param1 = Float(shader.scale)
            return ResolvedPaint(texture: nil,
                                 fillKind: FillKindIndex.procedural(shader.kind),
                                 paint: p)
        case .video:
            let texture = sourceTextures(.fillVideo(elementID: itemID), time)
            return ResolvedPaint(texture: texture,
                                 fillKind: texture == nil ? FillKindIndex.solid : FillKindIndex.videoPaint,
                                 paint: PaintParams())
        }
    }

    // MARK: - Draw helpers

    private func makeUniforms(item: RenderItem,
                              transform: ElementTransform,
                              fillKind: Int32,
                              paint: PaintParams,
                              canvasW: Int, canvasH: Int,
                              strokeWidthPx: Float,
                              time: Float) -> ItemUniforms {
        let matrix = Self.quadToNDC(transform: transform,
                                    canvasSize: CGSize(width: canvasW, height: canvasH))
        return ItemUniforms(
            transform: matrix,
            opacity: Float(transform.opacity),
            cornerRadius: Float(item.cornerRadius),
            itemSizePx: SIMD2(Float(transform.size.width * Double(canvasW)),
                              Float(transform.size.height * Double(canvasH))),
            strokeWidthPx: strokeWidthPx,
            time: time,
            fillColorA: paint.colorA,
            fillColorB: paint.colorB,
            fillParam0: paint.param0,
            fillParam1: paint.param1,
            fillKind: fillKind
        )
    }

    /// Fills in the framing fields for textured content, using the *actual*
    /// source texture dimensions — the shader can't know a shared window is 4:3
    /// any other way. Non-source content (solid/procedural paint, text glyphs)
    /// keeps `stretch`, which samples the quad directly as before.
    private func applyFraming(_ uniforms: inout ItemUniforms,
                              item: RenderItem,
                              texture: MTLTexture?) {
        guard case .source = item.content, let texture, texture.height > 0 else { return }
        // A 1×1 placeholder carries no usable aspect.
        guard texture.width > 1 || texture.height > 1 else { return }

        let presentation = item.presentation.sanitized
        uniforms.fitMode = FitModeIndex.value(for: presentation.fit)
        uniforms.contentAspect = Float(texture.width) / Float(texture.height)
        uniforms.zoom = Float(presentation.zoom)
        uniforms.pan = SIMD2(Float(presentation.pan.x), Float(presentation.pan.y))
        uniforms.blurStrength = item.isBackdrop ? Float(presentation.backdropBlur) : 0
    }

    /// Unit quad (0…1, y-down) → NDC, with rotation performed in pixel space
    /// so rotated elements don't skew on non-square canvases.
    static func quadToNDC(transform: ElementTransform, canvasSize: CGSize) -> simd_float3x3 {
        let cw = Float(canvasSize.width)
        let ch = Float(canvasSize.height)
        let sizePx = SIMD2(Float(transform.size.width) * cw,
                           Float(transform.size.height) * ch)
        let centerPx = SIMD2(Float(transform.center.x) * cw,
                             Float(transform.center.y) * ch)
        let angle = Float(transform.rotation)
        let cosA = cos(angle), sinA = sin(angle)

        // corner(0..1) -> centered px -> rotated -> translated (still y-down px).
        let toCentered = simd_float3x3(columns: (
            SIMD3(sizePx.x, 0, 0),
            SIMD3(0, sizePx.y, 0),
            SIMD3(-sizePx.x / 2, -sizePx.y / 2, 1)
        ))
        let rotate = simd_float3x3(columns: (
            SIMD3(cosA, sinA, 0),
            SIMD3(-sinA, cosA, 0),
            SIMD3(0, 0, 1)
        ))
        let translate = simd_float3x3(columns: (
            SIMD3(1, 0, 0),
            SIMD3(0, 1, 0),
            SIMD3(centerPx.x, centerPx.y, 1)
        ))
        // px -> NDC (flip y).
        let toNDC = simd_float3x3(columns: (
            SIMD3(2 / cw, 0, 0),
            SIMD3(0, -2 / ch, 0),
            SIMD3(-1, 1, 1)
        ))
        return toNDC * translate * rotate * toCentered
    }

    private func drawQuad(uniforms: ItemUniforms,
                          content: MTLTexture?,
                          glyph: MTLTexture?,
                          onto target: MTLTexture,
                          in commandBuffer: MTLCommandBuffer) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .load
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(contentPipelineNormal)
        var u = uniforms
        encoder.setVertexBytes(&u, length: MemoryLayout<ItemUniforms>.stride, index: 0)
        encoder.setFragmentBytes(&u, length: MemoryLayout<ItemUniforms>.stride, index: 0)
        encoder.setFragmentTexture(content ?? whiteTexture, index: 0)
        encoder.setFragmentTexture(glyph ?? whiteTexture, index: 1)
        encoder.setFragmentSamplerState(linearSampler, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
    }

    private func runBlendPass(mode: BlendMode,
                              dst: MTLTexture,
                              src: MTLTexture,
                              into target: MTLTexture,
                              in commandBuffer: MTLCommandBuffer) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(blendPipeline)
        var u = BlendUniforms(mode: Int32(mode.rawValue))
        encoder.setFragmentBytes(&u, length: MemoryLayout<BlendUniforms>.stride, index: 0)
        encoder.setFragmentTexture(dst, index: 0)
        encoder.setFragmentTexture(src, index: 1)
        encoder.setFragmentSamplerState(linearSampler, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    private func clear(_ texture: MTLTexture, color: RGBAColor, in commandBuffer: MTLCommandBuffer) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: color.red * color.alpha,
                                                            green: color.green * color.alpha,
                                                            blue: color.blue * color.alpha,
                                                            alpha: color.alpha)
        commandBuffer.makeRenderCommandEncoder(descriptor: pass)?.endEncoding()
    }
}

extension RGBAColor {
    var simd: SIMD4<Float> {
        SIMD4(Float(red), Float(green), Float(blue), Float(alpha))
    }
}
