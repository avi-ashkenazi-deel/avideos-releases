import Foundation
import Metal
import CoreImage
import CoreMedia
import CoreVideo
import simd

/// Applies an `EffectChain` texture-in/texture-out on the render thread, all
/// inside the frame's single command buffer (Core Image renders onto the same
/// buffer — no GPU sync points).
final class EffectChainRenderer {
    private let device: MTLDevice
    private let texturePool: TexturePool
    private let ciContext: CIContext
    private let library: MTLLibrary

    private let chromaKeyPipeline: MTLComputePipelineState?
    private let segmentationPipeline: MTLComputePipelineState?
    private let maskBlurHPipeline: MTLComputePipelineState?
    private let maskBlurVPipeline: MTLComputePipelineState?

    /// Camera-scene segmentation masks; the studio wires the camera source's
    /// frames into the provider, effects read the latest mask here.
    let segmentation: SegmentationProvider

    /// Background media textures for virtual background (image/video), keyed
    /// by effect identity — resolved by the source registry on the app side.
    var backgroundTextureProvider: (VirtualBackgroundParams, CMTime) -> MTLTexture? = { _, _ in nil }

    struct ChromaKeyUniforms {
        var keyColor: SIMD3<Float>
        var similarity: Float
        var smoothness: Float
        var spillSuppression: Float
        var pad: SIMD2<Float> = .zero
    }

    struct SegmentationUniforms {
        var edgeSoftness: Float
        var hasBackground: Float
        var pad: SIMD2<Float> = .zero
        var bgColor: SIMD4<Float>
    }

    init(device: MTLDevice,
         commandQueue: MTLCommandQueue,
         library: MTLLibrary,
         texturePool: TexturePool) {
        self.device = device
        self.texturePool = texturePool
        self.library = library
        self.segmentation = SegmentationProvider(device: device)

        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        self.ciContext = CIContext(mtlCommandQueue: commandQueue, options: [
            .workingColorSpace: srgb,
            .outputColorSpace: srgb,
            .cacheIntermediates: false,
        ])

        func pipeline(_ name: String) -> MTLComputePipelineState? {
            guard let fn = library.makeFunction(name: name) else { return nil }
            return try? device.makeComputePipelineState(function: fn)
        }
        self.chromaKeyPipeline = pipeline("chromaKey")
        self.segmentationPipeline = pipeline("segmentationBlend")
        self.maskBlurHPipeline = pipeline("maskBlurH")
        self.maskBlurVPipeline = pipeline("maskBlurV")
    }

    /// Folds the chain left-to-right: `tex = effect(tex)`.
    func apply(chain: EffectChain,
               to input: MTLTexture,
               at time: CMTime,
               commandBuffer: MTLCommandBuffer) -> MTLTexture {
        var texture = input
        for effect in chain.effects {
            texture = apply(effect: effect, to: texture, at: time, commandBuffer: commandBuffer)
        }
        return texture
    }

    private func apply(effect: VideoEffectSpec,
                       to input: MTLTexture,
                       at time: CMTime,
                       commandBuffer: MTLCommandBuffer) -> MTLTexture {
        switch effect {
        case .whiteScreen:
            return solid(color: SIMD4(1, 1, 1, 1), like: input, commandBuffer: commandBuffer) ?? input
        case .greenScreen:
            return solid(color: SIMD4(0, 0.7, 0.25, 1), like: input, commandBuffer: commandBuffer) ?? input
        case .blackScreen:
            return solid(color: SIMD4(0, 0, 0, 1), like: input, commandBuffer: commandBuffer) ?? input
        case .chromaKey(let params):
            return chromaKey(params, input: input, commandBuffer: commandBuffer)
        case .virtualBackground(let params):
            return virtualBackground(params, input: input, at: time, commandBuffer: commandBuffer)
        case .contrast(let amount):
            return coreImage(input: input, commandBuffer: commandBuffer) { image in
                image.applyingFilter("CIColorControls", parameters: [
                    kCIInputContrastKey: 1.0 + amount * 0.6,
                ])
            }
        case .sharpen(let amount):
            return coreImage(input: input, commandBuffer: commandBuffer) { image in
                image.applyingFilter("CISharpenLuminance", parameters: [
                    kCIInputSharpnessKey: amount * 1.2,
                ])
            }
        case .beautify(let strength):
            return beautify(strength: strength, input: input, commandBuffer: commandBuffer)
        }
    }

    // MARK: - Metal effects

    private func chromaKey(_ params: ChromaKeyParams,
                           input: MTLTexture,
                           commandBuffer: MTLCommandBuffer) -> MTLTexture {
        guard let pipeline = chromaKeyPipeline,
              let output = texturePool.texture(width: input.width, height: input.height),
              let encoder = commandBuffer.makeComputeCommandEncoder() else { return input }
        var uniforms = ChromaKeyUniforms(
            keyColor: SIMD3(Float(params.keyColor.red),
                            Float(params.keyColor.green),
                            Float(params.keyColor.blue)),
            similarity: Float(params.similarity),
            smoothness: Float(params.smoothness),
            spillSuppression: Float(params.spillSuppression))
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(input, index: 0)
        encoder.setTexture(output, index: 1)
        encoder.setBytes(&uniforms, length: MemoryLayout<ChromaKeyUniforms>.stride, index: 0)
        dispatch(encoder, pipeline: pipeline, width: input.width, height: input.height)
        encoder.endEncoding()
        return output
    }

    private func virtualBackground(_ params: VirtualBackgroundParams,
                                   input: MTLTexture,
                                   at time: CMTime,
                                   commandBuffer: MTLCommandBuffer) -> MTLTexture {
        guard let pipeline = segmentationPipeline,
              let rawMask = segmentation.currentMask else { return input }

        // Feather the mask (separable blur at mask resolution).
        var mask = rawMask
        if let blurH = maskBlurHPipeline, let blurV = maskBlurVPipeline,
           let tmp = texturePool.texture(width: rawMask.width, height: rawMask.height, format: .r8Unorm),
           let blurred = texturePool.texture(width: rawMask.width, height: rawMask.height, format: .r8Unorm),
           let encoder = commandBuffer.makeComputeCommandEncoder() {
            encoder.setComputePipelineState(blurH)
            encoder.setTexture(rawMask, index: 0)
            encoder.setTexture(tmp, index: 1)
            dispatch(encoder, pipeline: blurH, width: rawMask.width, height: rawMask.height)
            encoder.setComputePipelineState(blurV)
            encoder.setTexture(tmp, index: 0)
            encoder.setTexture(blurred, index: 1)
            dispatch(encoder, pipeline: blurV, width: rawMask.width, height: rawMask.height)
            encoder.endEncoding()
            mask = blurred
        }

        // Background: media texture, blurred camera, or flat color.
        var background: MTLTexture?
        var bgColor = SIMD4<Float>(0, 0, 0, 1)
        var hasBackgroundTexture: Float = 0
        switch params.background {
        case .blur(let radius):
            background = blurredCopy(of: input, radius: radius * 30, commandBuffer: commandBuffer)
            hasBackgroundTexture = background == nil ? 0 : 1
        case .image, .video:
            background = backgroundTextureProvider(params, time)
            hasBackgroundTexture = background == nil ? 0 : 1
        case .color(let color):
            bgColor = color.simd
        }

        guard let output = texturePool.texture(width: input.width, height: input.height),
              let encoder = commandBuffer.makeComputeCommandEncoder() else { return input }
        var uniforms = SegmentationUniforms(edgeSoftness: Float(params.edgeSoftness),
                                            hasBackground: hasBackgroundTexture,
                                            bgColor: bgColor)
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(input, index: 0)
        encoder.setTexture(mask, index: 1)
        encoder.setTexture(background ?? input, index: 2)
        encoder.setTexture(output, index: 3)
        encoder.setBytes(&uniforms, length: MemoryLayout<SegmentationUniforms>.stride, index: 0)
        dispatch(encoder, pipeline: pipeline, width: input.width, height: input.height)
        encoder.endEncoding()
        return output
    }

    // MARK: - Core Image effects

    // Orientation: CIImage(mtlTexture:) and render(_:to:commandBuffer:) use
    // the same texel addressing, so the texture → CIImage → texture round
    // trip preserves orientation without an .oriented(.downMirrored) fix (the
    // flip only appears when CI output meets a bottom-left-origin consumer).
    // Every filter used here is per-pixel or symmetric, and the segmentation
    // mask goes through the same wrap, so inputs stay consistent either way.
    // verify on Mac: if effect-chained layers render vertically flipped,
    // apply .oriented(.downMirrored) after the wrap and before the render.
    private func coreImage(input: MTLTexture,
                           commandBuffer: MTLCommandBuffer,
                           transform: (CIImage) -> CIImage) -> MTLTexture {
        guard let output = texturePool.texture(width: input.width, height: input.height),
              var image = CIImage(mtlTexture: input, options: [.colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
        else { return input }
        image = transform(image).cropped(to: CGRect(x: 0, y: 0, width: input.width, height: input.height))
        ciContext.render(image,
                         to: output,
                         commandBuffer: commandBuffer,
                         bounds: CGRect(x: 0, y: 0, width: input.width, height: input.height),
                         colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        return output
    }

    /// Frequency-separation smoothing: smooth = blur + k·(orig − blur), the
    /// detail-preserving skin filter. Masked to the person when a mask exists
    /// so the background stays sharp.
    private func beautify(strength: Double, input: MTLTexture, commandBuffer: MTLCommandBuffer) -> MTLTexture {
        coreImage(input: input, commandBuffer: commandBuffer) { image in
            let s = min(max(strength, 0), 1)
            let radius = 3.0 + s * 6.0
            let blurred = image
                .clampedToExtent()
                .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: radius])
                .cropped(to: image.extent)
            // CIMix: amount 1 → inputImage (the receiver), 0 → background.
            // Blurred over the original, scaled by strength: 0 is a true
            // no-op, 1 is 75% blur — detail always shows through. The first
            // cut had this backwards (max strength = weakest smoothing).
            let smooth = blurred.applyingFilter("CIMix", parameters: [
                kCIInputBackgroundImageKey: image,
                "inputAmount": s * 0.75,
            ])
            if let mask = self.segmentation.currentMask,
               let rawMask = CIImage(mtlTexture: mask, options: nil)?
                   .resized(to: image.extent.size) {
                // The Vision mask is r8Unorm, which samples as (r, 0, 0) —
                // CIBlendWithMask reads grayscale luminance, so a full-person
                // pixel would count as ~21% and mute the whole effect.
                // Broadcast red into RGB first.
                // verify on Mac: confirm CI wraps r8 as red-only (not
                // greyscale); if greyscale, this matrix is a harmless no-op.
                let maskImage = rawMask.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: 1, y: 0, z: 0, w: 0),
                    "inputGVector": CIVector(x: 1, y: 0, z: 0, w: 0),
                    "inputBVector": CIVector(x: 1, y: 0, z: 0, w: 0),
                    "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                    "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                ])
                // Blend smoothed skin over the original only where the person is.
                return smooth.applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: image,
                    kCIInputMaskImageKey: maskImage,
                ])
            }
            return smooth
        }
    }

    private func blurredCopy(of input: MTLTexture, radius: Double, commandBuffer: MTLCommandBuffer) -> MTLTexture? {
        let result = coreImage(input: input, commandBuffer: commandBuffer) { image in
            image.clampedToExtent()
                .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: radius])
                .cropped(to: image.extent)
        }
        return result === input ? nil : result
    }

    private func solid(color: SIMD4<Float>, like input: MTLTexture, commandBuffer: MTLCommandBuffer) -> MTLTexture? {
        guard let output = texturePool.texture(width: input.width, height: input.height) else { return nil }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = output
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: Double(color.x),
                                                            green: Double(color.y),
                                                            blue: Double(color.z),
                                                            alpha: Double(color.w))
        commandBuffer.makeRenderCommandEncoder(descriptor: pass)?.endEncoding()
        return output
    }

    private func dispatch(_ encoder: MTLComputeCommandEncoder,
                          pipeline: MTLComputePipelineState,
                          width: Int, height: Int) {
        let w = pipeline.threadExecutionWidth
        let h = max(1, pipeline.maxTotalThreadsPerThreadgroup / w)
        let threadsPerGroup = MTLSize(width: w, height: h, depth: 1)
        let groups = MTLSize(width: (width + w - 1) / w,
                             height: (height + h - 1) / h,
                             depth: 1)
        encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: threadsPerGroup)
    }
}

private extension CIImage {
    func resized(to size: CGSize) -> CIImage? {
        guard extent.width > 0, extent.height > 0 else { return nil }
        let sx = size.width / extent.width
        let sy = size.height / extent.height
        return transformed(by: CGAffineTransform(scaleX: sx, y: sy))
    }
}
