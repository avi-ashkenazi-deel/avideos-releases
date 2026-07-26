import SwiftUI

/// Right-hand inspector: Element / Effects / Animate tabs for the selected
/// element, or the scene's primary effects when nothing is selected.
struct InspectorView: View {
    @Environment(StudioController.self) private var studio

    private enum Tab: String, CaseIterable {
        case element = "Element"
        case effects = "Effects"
        case animate = "Animate"
    }

    @State private var tab: Tab = .element

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(10)

            ScrollView {
                switch tab {
                case .element: elementTab
                case .effects: effectsTab
                case .animate: animateTab
                }
            }

            Divider()
            addElementBar
        }
    }

    // MARK: - Element tab

    @ViewBuilder
    private var elementTab: some View {
        if let element = selectedElement {
            VStack(alignment: .leading, spacing: 12) {
                labeledRow("Name") {
                    TextField("Name", text: bind(element, \.name))
                        .textFieldStyle(.roundedBorder)
                }

                transformEditor(element)

                Picker("Blend", selection: bind(element, \.blendMode)) {
                    ForEach(BlendMode.allCases, id: \.self) { mode in
                        Text(mode.displayName).tag(mode)
                    }
                }

                if element.fill != nil || isFillable(element) {
                    FillEditor(title: "Fill", fill: Binding(
                        get: { element.fill ?? .solid(.white) },
                        set: { newFill in
                            var updated = element
                            updated.fill = newFill
                            studio.updateElement(updated)
                        }
                    ))
                }

                StrokeEditor(stroke: Binding(
                    get: { element.stroke },
                    set: { newStroke in
                        var updated = element
                        updated.stroke = newStroke
                        studio.updateElement(updated)
                    }
                ))

                if case .text(let content) = element.kind {
                    textEditor(element, content: content)
                }

                HStack {
                    Button(element.isVisible ? "Hide (animated)" : "Show (animated)") {
                        studio.toggleElementVisibility(id: element.id)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        studio.removeElement(id: element.id)
                    } label: {
                        Image(systemName: "trash")
                    }
                }
            }
            .padding(12)
        } else if let scene = studio.activeScene {
            // Nothing selected: this is the place for scene-level settings, and
            // framing is the one people reach for constantly — a shared window
            // is rarely the same shape as the program canvas.
            VStack(alignment: .leading, spacing: 12) {
                Text("Scene — \(scene.name)").font(.headline)
                framingEditor(scene)
                Divider()
                ContentUnavailableView("No element selected",
                                       systemImage: "square.dashed",
                                       description: Text("Click an element on the canvas, or add one below."))
            }
            .padding(12)
        } else {
            ContentUnavailableView("No element selected",
                                   systemImage: "square.dashed",
                                   description: Text("Click an element on the canvas, or add one below."))
                .padding(.top, 30)
        }
    }

    // MARK: - Framing (scene primary source)

    private func framingEditor(_ scene: SceneModel) -> some View {
        let presentation = Binding<SourcePresentation>(
            get: { scene.primaryPresentation },
            set: { new in
                guard let index = studio.project.scenes.firstIndex(where: { $0.id == scene.id })
                else { return }
                studio.project.scenes[index].primaryPresentation = new
            }
        )

        return VStack(alignment: .leading, spacing: 8) {
            Text("Framing")
                .font(.subheadline.bold())
                .foregroundStyle(.secondary)

            Picker("Fit", selection: presentation.fit) {
                ForEach(SourceFit.allCases, id: \.self) { fit in
                    Text(fit.displayName).tag(fit)
                }
            }
            .pickerStyle(.radioGroup)

            Text(presentation.wrappedValue.fit.help)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            LabeledSlider(label: "Zoom", value: presentation.zoom, range: 0.5...4)

            // Panning only does something once content is cropped.
            let canPan = presentation.wrappedValue.fit != .fit
                || presentation.wrappedValue.zoom > 1
            // CGPoint components are CGFloat; LabeledSlider works in Double.
            LabeledSlider(label: "Pan X",
                          value: Binding(get: { Double(presentation.wrappedValue.pan.x) },
                                         set: { presentation.wrappedValue.pan.x = CGFloat($0) }),
                          range: -0.5...0.5)
                .disabled(!canPan)
            LabeledSlider(label: "Pan Y",
                          value: Binding(get: { Double(presentation.wrappedValue.pan.y) },
                                         set: { presentation.wrappedValue.pan.y = CGFloat($0) }),
                          range: -0.5...0.5)
                .disabled(!canPan)
            if !canPan {
                Text("Pan applies once the picture is cropped — zoom in, or choose Fill.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if presentation.wrappedValue.fit == .blurredBackdrop {
                LabeledSlider(label: "Blur", value: presentation.backdropBlur, range: 0...1)
                LabeledSlider(label: "BG Zoom", value: presentation.backdropZoom, range: 1...2)
            }

            Button("Reset Framing") {
                presentation.wrappedValue = .default
            }
            .font(.caption)
            .buttonStyle(.link)
        }
    }

    private func transformEditor(_ element: Element) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledSlider(label: "X", value: bindTransformCG(element, \.center.x), range: 0...1)
            LabeledSlider(label: "Y", value: bindTransformCG(element, \.center.y), range: 0...1)
            LabeledSlider(label: "Width", value: bindTransformCG(element, \.size.width), range: 0.02...1)
            LabeledSlider(label: "Height", value: bindTransformCG(element, \.size.height), range: 0.02...1)
            LabeledSlider(label: "Rotate", value: bindTransform(element, \.rotation), range: -3.14...3.14)
            LabeledSlider(label: "Opacity", value: bindTransform(element, \.opacity), range: 0...1)
        }
    }

    private func textEditor(_ element: Element, content: TextContent) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Text").font(.headline)
            TextEditor(text: Binding(
                get: { content.string },
                set: { newString in
                    var updated = element
                    var text = content
                    text.string = newString
                    updated.kind = .text(text)
                    studio.updateElement(updated)
                }
            ))
            .frame(height: 70)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))

            LabeledSlider(label: "Size", value: Binding(
                get: { content.fontSize },
                set: { newSize in
                    var updated = element
                    var text = content
                    text.fontSize = newSize
                    updated.kind = .text(text)
                    studio.updateElement(updated)
                }
            ), range: 12...240)
        }
    }

    // MARK: - Effects tab (element effects, or scene primary effects)

    @ViewBuilder
    private var effectsTab: some View {
        if let element = selectedElement {
            VStack(alignment: .leading) {
                Text("Effects on \(element.name)").font(.headline).padding(.horizontal, 12).padding(.top, 8)
                EffectsPanel(chain: Binding(
                    get: { element.effects },
                    set: { newChain in
                        var updated = element
                        updated.effects = newChain
                        studio.updateElement(updated)
                    }
                ))
            }
        } else if let scene = studio.activeScene {
            VStack(alignment: .leading) {
                Text("Camera Effects — \(scene.name)").font(.headline).padding(.horizontal, 12).padding(.top, 8)
                EffectsPanel(chain: Binding(
                    get: { scene.primaryEffects },
                    set: { newChain in
                        guard let index = studio.project.scenes.firstIndex(where: { $0.id == scene.id }) else { return }
                        studio.project.scenes[index].primaryEffects = newChain
                    }
                ))
            }
        }
    }

    // MARK: - Animate tab

    @ViewBuilder
    private var animateTab: some View {
        if let element = selectedElement {
            VStack(alignment: .leading, spacing: 10) {
                Picker("Entry", selection: Binding(
                    get: { element.entryAnimation.style },
                    set: { newStyle in
                        var updated = element
                        updated.entryAnimation.style = newStyle
                        studio.updateElement(updated)
                    }
                )) {
                    ForEach(EntryAnimation.Style.allCases, id: \.self) { style in
                        Text(style.displayName).tag(style)
                    }
                }

                LabeledSlider(label: "Duration", value: Binding(
                    get: { element.entryAnimation.duration },
                    set: { newDuration in
                        var updated = element
                        updated.entryAnimation.duration = newDuration
                        studio.updateElement(updated)
                    }
                ), range: 0.1...2)

                Picker("Curve", selection: Binding(
                    get: { element.entryAnimation.curve },
                    set: { newCurve in
                        var updated = element
                        updated.entryAnimation.curve = newCurve
                        studio.updateElement(updated)
                    }
                )) {
                    ForEach(EntryAnimation.Curve.allCases, id: \.self) { curve in
                        Text(String(describing: curve)).tag(curve)
                    }
                }

                Text("Exit plays the same animation reversed.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Button("Preview In/Out") {
                    studio.toggleElementVisibility(id: element.id)
                    Task {
                        try? await Task.sleep(for: .seconds(element.entryAnimation.duration + 0.8))
                        studio.toggleElementVisibility(id: element.id)
                    }
                }
            }
            .padding(12)
        } else {
            ContentUnavailableView("Select an element", systemImage: "sparkles")
                .padding(.top, 30)
        }
    }

    // MARK: - Add-element bar

    private var addElementBar: some View {
        HStack {
            Button { addText() } label: { Image(systemName: "textformat") }
                .help("Add text")
            Button { addShape() } label: { Image(systemName: "square.on.circle") }
                .help("Add shape")
            Button { addMedia(images: true) } label: { Image(systemName: "photo") }
                .help("Add image")
            Button { addMedia(images: false) } label: { Image(systemName: "film") }
                .help("Add video")
            Button { addWeb() } label: { Image(systemName: "globe") }
                .help("Add web page")
            Spacer()
        }
        .buttonStyle(.borderless)
        .padding(8)
    }

    private func addText() {
        studio.addElement(Element(name: "Text",
                                  kind: .text(TextContent(string: "Your text")),
                                  transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.8),
                                                              size: CGSize(width: 0.5, height: 0.12)),
                                  fill: .solid(.white),
                                  entryAnimation: EntryAnimation(style: .slideFromBottom)))
    }

    private func addShape() {
        studio.addElement(Element(name: "Shape",
                                  kind: .shape(ShapeContent(shape: .roundedRectangle)),
                                  transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.82),
                                                              size: CGSize(width: 0.55, height: 0.16)),
                                  fill: .shader(ShaderFill()),
                                  entryAnimation: EntryAnimation(style: .slideFromLeft)))
    }

    private func addMedia(images: Bool) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = images ? [.image] : [.movie, .mpeg4Movie, .quickTimeMovie]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if images {
            studio.addElement(Element(name: url.lastPathComponent,
                                      kind: .image(MediaReference(url: url)),
                                      entryAnimation: EntryAnimation(style: .fade)))
        } else {
            studio.addElement(Element(name: url.lastPathComponent,
                                      kind: .video(VideoContent(media: MediaReference(url: url))),
                                      entryAnimation: EntryAnimation(style: .fade)))
        }
    }

    private func addWeb() {
        studio.addElement(Element(name: "Web Overlay",
                                  kind: .web(WebContent(urlString: "https://example.com")),
                                  transform: .fullCanvas,
                                  entryAnimation: EntryAnimation(style: .fade)))
    }

    // MARK: - Binding helpers

    private var selectedElement: Element? {
        studio.selectedElementID.flatMap { studio.findElement(id: $0) }
    }

    private func bind<T>(_ element: Element, _ keyPath: WritableKeyPath<Element, T>) -> Binding<T> {
        Binding(
            get: { (studio.findElement(id: element.id) ?? element)[keyPath: keyPath] },
            set: { newValue in
                guard var updated = studio.findElement(id: element.id) else { return }
                updated[keyPath: keyPath] = newValue
                studio.updateElement(updated)
            }
        )
    }

    private func bindTransform(_ element: Element,
                               _ keyPath: WritableKeyPath<ElementTransform, Double>) -> Binding<Double> {
        Binding(
            get: { (studio.findElement(id: element.id) ?? element).transform[keyPath: keyPath] },
            set: { newValue in
                guard var updated = studio.findElement(id: element.id) else { return }
                updated.transform[keyPath: keyPath] = newValue
                studio.updateElement(updated)
            }
        )
    }

    /// CGFloat-typed transform fields (CGPoint/CGSize members) bridged to
    /// the Double sliders.
    private func bindTransformCG(_ element: Element,
                                 _ keyPath: WritableKeyPath<ElementTransform, CGFloat>) -> Binding<Double> {
        Binding(
            get: { Double((studio.findElement(id: element.id) ?? element).transform[keyPath: keyPath]) },
            set: { newValue in
                guard var updated = studio.findElement(id: element.id) else { return }
                updated.transform[keyPath: keyPath] = CGFloat(newValue)
                studio.updateElement(updated)
            }
        )
    }

    private func isFillable(_ element: Element) -> Bool {
        switch element.kind {
        case .text, .shape: true
        default: false
        }
    }
}

private func labeledRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
    HStack {
        Text(label).frame(width: 60, alignment: .leading).font(.caption)
        content()
    }
}
