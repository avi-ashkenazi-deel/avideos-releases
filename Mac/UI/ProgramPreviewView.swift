import SwiftUI
import MetalKit
import simd

/// The live program preview: an MTKView that displays the latest composited
/// frame aspect-fit. Display-only — it never re-composites; the render engine
/// produces frames on its own clock regardless of what this view does.
struct ProgramPreviewView: NSViewRepresentable {
    let previewStore: PreviewFrameStore
    let device: MTLDevice
    /// The render engine's target rate. Drawing faster than frames arrive just
    /// re-presents identical pixels while blocking the main thread in
    /// `currentDrawable` — which a first-run stack sample showed to be the
    /// single largest consumer of main-thread time in the app.
    let framesPerSecond: Int

    func makeCoordinator() -> Renderer {
        Renderer(device: device, previewStore: previewStore)
    }

    func makeNSView(context: Context) -> MTKView {
        let view = MTKView(frame: .zero, device: device)
        view.colorPixelFormat = .bgra8Unorm
        view.preferredFramesPerSecond = max(1, framesPerSecond)
        view.delegate = context.coordinator
        view.layer?.backgroundColor = NSColor.black.cgColor
        return view
    }

    func updateNSView(_ nsView: MTKView, context: Context) {
        // Follow a project frame-rate change without rebuilding the view.
        let target = max(1, framesPerSecond)
        if nsView.preferredFramesPerSecond != target {
            nsView.preferredFramesPerSecond = target
        }
    }

    final class Renderer: NSObject, MTKViewDelegate {
        private let device: MTLDevice
        private let previewStore: PreviewFrameStore
        private let commandQueue: MTLCommandQueue?
        private var pipeline: MTLRenderPipelineState?
        private let sampler: MTLSamplerState?

        struct PreviewUniforms {
            var scale: SIMD2<Float>
            var pad: SIMD2<Float> = .zero
        }

        init(device: MTLDevice, previewStore: PreviewFrameStore) {
            self.device = device
            self.previewStore = previewStore
            self.commandQueue = device.makeCommandQueue()

            let samplerDesc = MTLSamplerDescriptor()
            samplerDesc.minFilter = .linear
            samplerDesc.magFilter = .linear
            self.sampler = device.makeSamplerState(descriptor: samplerDesc)

            if let library = device.makeDefaultLibrary(),
               let vertex = library.makeFunction(name: "preview_vertex"),
               let fragment = library.makeFunction(name: "preview_fragment") {
                let desc = MTLRenderPipelineDescriptor()
                desc.vertexFunction = vertex
                desc.fragmentFunction = fragment
                desc.colorAttachments[0].pixelFormat = .bgra8Unorm
                self.pipeline = try? device.makeRenderPipelineState(descriptor: desc)
            }
            super.init()
        }

        func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        func draw(in view: MTKView) {
            guard let pipeline,
                  let commandQueue,
                  let texture = previewStore.latestTexture,
                  let descriptor = view.currentRenderPassDescriptor,
                  let drawable = view.currentDrawable,
                  let commandBuffer = commandQueue.makeCommandBuffer(),
                  let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor)
            else { return }

            // Aspect-fit scale: expand UVs on the axis that must letterbox.
            let viewAspect = Float(view.drawableSize.width / max(view.drawableSize.height, 1))
            let texAspect = Float(texture.width) / Float(max(texture.height, 1))
            var uniforms = PreviewUniforms(scale: viewAspect > texAspect
                ? SIMD2(viewAspect / texAspect, 1)
                : SIMD2(1, texAspect / viewAspect))

            encoder.setRenderPipelineState(pipeline)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<PreviewUniforms>.stride, index: 0)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<PreviewUniforms>.stride, index: 0)
            encoder.setFragmentTexture(texture, index: 0)
            if let sampler { encoder.setFragmentSamplerState(sampler, index: 0) }
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            encoder.endEncoding()
            commandBuffer.present(drawable)
            commandBuffer.commit()
        }
    }
}
