import SwiftUI

/// The Effects menu: camera filters on the active scene's primary source (or
/// on a selected element). Toggle rows + parameter sliders, composable.
struct EffectsPanel: View {
    @Binding var chain: EffectChain

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            utilityScreens
            Divider()
            chromaKeySection
            Divider()
            virtualBackgroundSection
            Divider()
            adjustmentRow(name: "Contrast", caseName: "contrast", range: -1...1, neutral: 0) {
                .contrast($0)
            } value: {
                if case .contrast(let v) = $0 { return v } else { return nil }
            }
            adjustmentRow(name: "Sharpen", caseName: "sharpen", range: 0...1, neutral: 0.3) {
                .sharpen($0)
            } value: {
                if case .sharpen(let v) = $0 { return v } else { return nil }
            }
            adjustmentRow(name: "Beautify", caseName: "beautify", range: 0...1, neutral: 0.5) {
                .beautify($0)
            } value: {
                if case .beautify(let v) = $0 { return v } else { return nil }
            }
        }
        .padding(12)
    }

    // MARK: - Utility screens (mutually exclusive)

    private var utilityScreens: some View {
        HStack {
            utilityButton("White", spec: .whiteScreen)
            utilityButton("Green", spec: .greenScreen)
            utilityButton("Black", spec: .blackScreen)
        }
    }

    private func utilityButton(_ label: String, spec: VideoEffectSpec) -> some View {
        let isOn = chain.effects.contains { $0.caseName == spec.caseName }
        return Button(label) {
            chain.effects.removeAll {
                ["whiteScreen", "greenScreen", "blackScreen"].contains($0.caseName)
                    && $0.caseName != spec.caseName
            }
            if isOn {
                chain.effects.removeAll { $0.caseName == spec.caseName }
            } else {
                chain.effects.append(spec)
            }
        }
        .buttonStyle(.bordered)
        .tint(isOn ? .accentColor : nil)
    }

    // MARK: - Chroma key

    private var chromaKeySection: some View {
        let current: ChromaKeyParams? = chain.effects.lazy.compactMap {
            if case .chromaKey(let p) = $0 { return p } else { return nil }
        }.first

        return VStack(alignment: .leading, spacing: 6) {
            Toggle("Chroma Key", isOn: Binding(
                get: { current != nil },
                set: { on in
                    chain.effects.removeAll { $0.caseName == "chromaKey" }
                    if on { chain.effects.append(.chromaKey(ChromaKeyParams())) }
                }
            ))
            if let params = current {
                ColorPicker("Key Color", selection: Binding(
                    get: { params.keyColor.swiftUIColor },
                    set: { update(.chromaKey(modified(params) { $0.keyColor = RGBAColor($1) } ($0))) }
                ))
                LabeledSlider(label: "Similarity", value: chromaBinding(\.similarity, params), range: 0...1)
                LabeledSlider(label: "Smoothness", value: chromaBinding(\.smoothness, params), range: 0...0.5)
                LabeledSlider(label: "Spill Fix", value: chromaBinding(\.spillSuppression, params), range: 0...1)
            }
        }
    }

    private func chromaBinding(_ keyPath: WritableKeyPath<ChromaKeyParams, Double>,
                               _ params: ChromaKeyParams) -> Binding<Double> {
        Binding(
            get: { params[keyPath: keyPath] },
            set: { newValue in
                var p = params
                p[keyPath: keyPath] = newValue
                update(.chromaKey(p))
            }
        )
    }

    // MARK: - Virtual background

    private var virtualBackgroundSection: some View {
        let current: VirtualBackgroundParams? = chain.effects.lazy.compactMap {
            if case .virtualBackground(let p) = $0 { return p } else { return nil }
        }.first

        return VStack(alignment: .leading, spacing: 6) {
            Toggle("Virtual Background", isOn: Binding(
                get: { current != nil },
                set: { on in
                    chain.effects.removeAll { $0.caseName == "virtualBackground" }
                    if on { chain.effects.append(.virtualBackground(VirtualBackgroundParams())) }
                }
            ))
            if let params = current {
                Picker("Background", selection: Binding(
                    get: { BackgroundChoice(params.background) },
                    set: { choice in
                        var p = params
                        switch choice {
                        case .blur: p.background = .blur(radius: 0.5)
                        case .color: p.background = .color(RGBAColor(red: 0.1, green: 0.1, blue: 0.12))
                        case .image: pickMedia(images: true) { p.background = .image($0); update(.virtualBackground(p)) }; return
                        case .video: pickMedia(images: false) { p.background = .video($0); update(.virtualBackground(p)) }; return
                        }
                        update(.virtualBackground(p))
                    }
                )) {
                    Text("Blur").tag(BackgroundChoice.blur)
                    Text("Color").tag(BackgroundChoice.color)
                    Text("Image").tag(BackgroundChoice.image)
                    Text("Video").tag(BackgroundChoice.video)
                }
                .pickerStyle(.segmented)

                LabeledSlider(label: "Edge Soft",
                              value: Binding(get: { params.edgeSoftness },
                                             set: { var p = params; p.edgeSoftness = $0; update(.virtualBackground(p)) }),
                              range: 0...1)
            }
        }
    }

    private enum BackgroundChoice: Hashable {
        case blur, color, image, video

        init(_ background: VirtualBackgroundParams.Background) {
            switch background {
            case .blur: self = .blur
            case .color: self = .color
            case .image: self = .image
            case .video: self = .video
            }
        }
    }

    // MARK: - Simple adjustments

    private func adjustmentRow(name: String,
                               caseName: String,
                               range: ClosedRange<Double>,
                               neutral: Double,
                               make: @escaping (Double) -> VideoEffectSpec,
                               value: @escaping (VideoEffectSpec) -> Double?) -> some View {
        let current = chain.effects.lazy.compactMap(value).first
        return VStack(alignment: .leading, spacing: 4) {
            Toggle(name, isOn: Binding(
                get: { current != nil },
                set: { on in
                    chain.effects.removeAll { $0.caseName == caseName }
                    if on { chain.effects.append(make(neutral)) }
                }
            ))
            if let v = current {
                LabeledSlider(label: "Amount",
                              value: Binding(get: { v },
                                             set: { newValue in
                                                 chain.effects = chain.effects.map {
                                                     $0.caseName == caseName ? make(newValue) : $0
                                                 }
                                             }),
                              range: range)
            }
        }
    }

    // MARK: - Helpers

    private func update(_ spec: VideoEffectSpec) {
        chain.effects = chain.effects.map { $0.caseName == spec.caseName ? spec : $0 }
    }

    private func modified<T>(_ value: T, _ mutate: @escaping (inout T, Color) -> Void) -> (Color) -> T {
        { color in
            var copy = value
            mutate(&copy, color)
            return copy
        }
    }

    private func pickMedia(images: Bool, completion: @escaping (MediaReference) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = images ? [.image] : [.movie]
        if panel.runModal() == .OK, let url = panel.url {
            completion(MediaReference(url: url))
        }
    }
}
