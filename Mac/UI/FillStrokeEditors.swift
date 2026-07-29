import SwiftUI

/// Editor for a `Fill` (solid / animated shader / video).
struct FillEditor: View {
    let title: String
    @Binding var fill: Fill

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(title, selection: kindBinding) {
                Text("Solid").tag(FillKindChoice.solid)
                Text("Animated").tag(FillKindChoice.shader)
                Text("Video").tag(FillKindChoice.video)
            }
            .pickerStyle(.segmented)

            switch fill {
            case .solid(let color):
                ColorPicker("Color", selection: Binding(
                    get: { color.swiftUIColor },
                    set: { fill = .solid(RGBAColor($0)) }
                ), supportsOpacity: true)

            case .shader(let shader):
                ShaderFillEditor(shader: Binding(
                    get: { shader },
                    set: { fill = .shader($0) }
                ))

            case .video(let media):
                HStack {
                    Text(media.displayName)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Choose…") { pickVideo() }
                }
            }
        }
    }

    private enum FillKindChoice: Hashable { case solid, shader, video }

    private var kindBinding: Binding<FillKindChoice> {
        Binding(
            get: {
                switch fill {
                case .solid: .solid
                case .shader: .shader
                case .video: .video
                }
            },
            set: { choice in
                switch choice {
                case .solid:
                    if case .solid = fill { return }
                    fill = .solid(.white)
                case .shader:
                    if case .shader = fill { return }
                    fill = .shader(ShaderFill())
                case .video:
                    if case .video = fill { return }
                    pickVideo()
                }
            }
        )
    }

    private func pickVideo() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.movie, .mpeg4Movie, .quickTimeMovie]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            fill = .video(MediaReference(url: url))
        }
    }
}

struct ShaderFillEditor: View {
    @Binding var shader: ShaderFill

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker("Style", selection: $shader.kind) {
                ForEach(ShaderFill.Kind.allCases, id: \.self) { kind in
                    Text(kind.displayName).tag(kind)
                }
            }
            HStack {
                ColorPicker("A", selection: Binding(
                    get: { shader.colorA.swiftUIColor },
                    set: { shader.colorA = RGBAColor($0) }
                ))
                ColorPicker("B", selection: Binding(
                    get: { shader.colorB.swiftUIColor },
                    set: { shader.colorB = RGBAColor($0) }
                ))
            }
            LabeledSlider(label: "Speed", value: $shader.speed, range: 0...4)
            LabeledSlider(label: "Scale", value: $shader.scale, range: 0.1...4)
        }
    }
}

/// Stroke on/off + width + its own fill (strokes are fills too).
struct StrokeEditor: View {
    @Binding var stroke: Stroke?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Stroke", isOn: Binding(
                get: { stroke != nil },
                set: { on in stroke = on ? (stroke ?? Stroke()) : nil }
            ))
            if let current = stroke {
                LabeledSlider(label: "Width",
                              value: Binding(get: { current.width },
                                             set: { stroke?.width = $0 }),
                              range: 0.001...0.03)
                FillEditor(title: "Stroke Paint", fill: Binding(
                    get: { current.fill },
                    set: { stroke?.fill = $0 }
                ))
            }
        }
    }
}

struct LabeledSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>

    var body: some View {
        HStack {
            Text(label)
                .frame(width: 70, alignment: .leading)
                .font(.caption)
            Slider(value: $value, in: range)
            Text(String(format: "%.2f", value))
                .font(.caption.monospacedDigit())
                .frame(width: 40, alignment: .trailing)
        }
    }
}

extension RGBAColor {
    var swiftUIColor: Color {
        Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }

    init(_ color: Color) {
        let ns = NSColor(color).usingColorSpace(.sRGB) ?? .white
        self.init(red: Double(ns.redComponent),
                  green: Double(ns.greenComponent),
                  blue: Double(ns.blueComponent),
                  alpha: Double(ns.alphaComponent))
    }
}
