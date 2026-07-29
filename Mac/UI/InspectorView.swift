import SwiftUI
import AVFoundation   // the video-source picker enumerates capture devices

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

                if case .shape(let content) = element.kind {
                    shapeEditor(element, content: content)
                }

                if case .timer(let content) = element.kind {
                    timerEditor(element, content: content)
                }

                if case .source(let binding) = element.kind {
                    sourceBindingEditor(element, binding: binding)
                    tileShapeEditor(element)
                }

                if case .web(let content) = element.kind {
                    WebURLEditor(element: element, content: content)
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
            // Corner radius for EVERYTHING — images, videos, tiles, shapes.
            LabeledSlider(label: "Radius", value: Binding(
                get: { element.cornerRadius ?? 0 },
                set: { newValue in
                    guard var updated = studio.findElement(id: element.id) else { return }
                    updated.cornerRadius = newValue > 0.001 ? newValue : nil
                    studio.updateElement(updated)
                }
            ), range: 0...0.5)

            depthEditor(element)
        }
    }

    /// 3D-ish placement: a gimbal pad you drag to tilt the element in
    /// perspective, plus skew, extrusion depth and lens strength.
    private func depthEditor(_ element: Element) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("3D").font(.headline).padding(.top, 4)
            HStack(alignment: .top, spacing: 12) {
                GimbalPad(tiltX: bindTransform(element, \.tiltXNonOptional),
                          tiltY: bindTransform(element, \.tiltYNonOptional))
                    .frame(width: 92, height: 92)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Drag to tilt. Double-click to reset.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    LabeledSlider(label: "Lens",
                                  value: bindTransform(element, \.perspectiveNonOptional),
                                  range: 0.6...8)
                    LabeledSlider(label: "Depth",
                                  value: bindTransform(element, \.depthNonOptional),
                                  range: 0...0.06)
                }
            }
            LabeledSlider(label: "Skew X",
                          value: bindTransform(element, \.skewXNonOptional),
                          range: -1...1)
            LabeledSlider(label: "Skew Y",
                          value: bindTransform(element, \.skewYNonOptional),
                          range: -1...1)
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

            // The "text box" look: a painted box behind the glyphs.
            Toggle("Background box", isOn: Binding(
                get: { content.boxFill != nil },
                set: { on in
                    updateText(element, content) { text in
                        text.boxFill = on ? .solid(RGBAColor(red: 0, green: 0, blue: 0, alpha: 0.55)) : nil
                    }
                }
            ))
            if let boxFill = content.boxFill {
                FillEditor(title: "Box Fill", fill: Binding(
                    get: { boxFill },
                    set: { newFill in
                        updateText(element, content) { $0.boxFill = newFill }
                    }
                ))
                LabeledSlider(label: "Box Radius", value: Binding(
                    get: { content.boxCornerRadius ?? 0.04 },
                    set: { newValue in
                        updateText(element, content) { $0.boxCornerRadius = newValue }
                    }
                ), range: 0...0.3)
            }
        }
    }

    private func updateText(_ element: Element, _ content: TextContent,
                            _ mutate: (inout TextContent) -> Void) {
        var updated = element
        var text = content
        mutate(&text)
        updated.kind = .text(text)
        studio.updateElement(updated)
    }

    /// Shape controls — the picker and radius Ecamm shows for a shape overlay.
    private func shapeEditor(_ element: Element, content: ShapeContent) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Shape").font(.headline)
            Picker("Shape", selection: Binding(
                get: { content.shape },
                set: { newShape in
                    var updated = element
                    var shape = content
                    shape.shape = newShape
                    updated.kind = .shape(shape)
                    studio.updateElement(updated)
                }
            )) {
                Text("Rectangle").tag(ShapeContent.Shape.rectangle)
                Text("Rounded Rectangle").tag(ShapeContent.Shape.roundedRectangle)
                Text("Ellipse").tag(ShapeContent.Shape.ellipse)
                Text("Line").tag(ShapeContent.Shape.line)
            }
            // Radius lives on the generic transform editor above — it
            // applies to every element kind, shapes included.
        }
    }

    /// Countdown controls: duration, size, restart.
    private func timerEditor(_ element: Element, content: TimerContent) -> some View {
        let minutes = Int(content.durationSeconds) / 60
        let seconds = Int(content.durationSeconds) % 60

        func setDuration(minutes: Int, seconds: Int) {
            var updated = element
            var timer = content
            timer.durationSeconds = Double(max(0, minutes) * 60 + max(0, seconds))
            updated.kind = .timer(timer)
            studio.updateElement(updated)
            studio.restartTimer(id: element.id)
        }

        return VStack(alignment: .leading, spacing: 6) {
            Text("Countdown").font(.headline)
            HStack {
                Stepper("\(minutes) min", value: Binding(
                    get: { minutes },
                    set: { setDuration(minutes: $0, seconds: seconds) }
                ), in: 0...180)
                Stepper("\(seconds) sec", value: Binding(
                    get: { seconds },
                    set: { setDuration(minutes: minutes, seconds: $0) }
                ), in: 0...59)
            }
            LabeledSlider(label: "Size", value: Binding(
                get: { content.fontSize },
                set: { newSize in
                    var updated = element
                    var timer = content
                    timer.fontSize = newSize
                    updated.kind = .timer(timer)
                    studio.updateElement(updated)
                }
            ), range: 24...400)
            Button("Restart Countdown") {
                studio.restartTimer(id: element.id)
            }
        }
    }

    /// Which camera (or guest) a source overlay shows — chosen here, after
    /// placing it, so the add-row's camera button is a single click.
    private func sourceBindingEditor(_ element: Element,
                                     binding: SourceBinding) -> some View {
        // Tag by a string so cameras, guests and "system default" can share
        // one picker (SourceBinding itself carries associated values).
        let cameras = CameraSource.availableCameras()
        let guests = studio.guests?.guests ?? []

        func tag(for binding: SourceBinding) -> String {
            switch binding {
            case .camera(let uid): "camera:\(uid ?? "")"
            case .guest(let identity): "guest:\(identity)"
            case .display(let id): "display:\(id)"
            case .window(let id): "window:\(id)"
            }
        }

        return VStack(alignment: .leading, spacing: 6) {
            Text("Video Source").font(.headline)
            Picker("Source", selection: Binding(
                get: { tag(for: binding) },
                set: { newTag in
                    guard var updated = studio.findElement(id: element.id) else { return }
                    if newTag == "camera:" {
                        updated.kind = .source(.camera(deviceUniqueID: nil))
                    } else if newTag.hasPrefix("camera:") {
                        updated.kind = .source(.camera(deviceUniqueID: String(newTag.dropFirst(7))))
                    } else if newTag.hasPrefix("guest:") {
                        updated.kind = .source(.guest(identity: String(newTag.dropFirst(6))))
                    }
                    studio.updateElement(updated)
                }
            )) {
                Text("System Default Camera").tag("camera:")
                ForEach(cameras, id: \.uniqueID) { device in
                    Text(device.localizedName).tag("camera:\(device.uniqueID)")
                }
                if !guests.isEmpty {
                    Divider()
                    ForEach(guests) { guest in
                        Text(guest.displayName).tag("guest:\(guest.identity)")
                    }
                }
            }
        }
    }

    /// Tile shape for camera/guest insets — aspect preset + mask.
    private func tileShapeEditor(_ element: Element) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tile Shape").font(.headline)
            Picker("Shape", selection: Binding(
                get: { element.tileShape ?? .wide },
                set: { newShape in
                    var updated = element
                    updated.tileShape = newShape
                    // The preset rewrites the tile's aspect around its width.
                    let canvas = studio.project.canvasSize
                    updated.transform.size.height = updated.transform.size.width
                        * (canvas.width / canvas.height) / newShape.aspect
                    studio.updateElement(updated)
                }
            )) {
                ForEach(SourceTileShape.allCases, id: \.self) { shape in
                    Text(shape.displayName).tag(shape)
                }
            }
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
                // Grouped by family: 21 styles in one flat list is a wall of
                // names. Picking a style also adopts the duration that suits
                // it, so a bounce doesn't inherit a fade's 0.35s.
                Picker("Entry", selection: Binding(
                    get: { element.entryAnimation.style },
                    set: { newStyle in
                        var updated = element
                        updated.entryAnimation.style = newStyle
                        updated.entryAnimation.duration = newStyle.suggestedDuration
                        studio.updateElement(updated)
                    }
                )) {
                    ForEach(EntryAnimation.Style.Category.allCases, id: \.self) { category in
                        let styles = EntryAnimation.Style.styles(in: category)
                        if styles.count == 1, let only = styles.first {
                            Text(only.displayName).tag(only)
                        } else {
                            Section(category.rawValue) {
                                ForEach(styles, id: \.self) { style in
                                    Text(style.displayName).tag(style)
                                }
                            }
                        }
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

                if element.entryAnimation.style.definesOwnTiming {
                    Text("This style carries its own timing, so the curve below has no effect on it.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }

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

                HStack {
                    // Replays the entry alone — the fast way to compare styles.
                    Button("Play Entry") {
                        studio.replayEntryAnimation(id: element.id)
                    }
                    Button("Preview In/Out") {
                        studio.toggleElementVisibility(id: element.id)
                        Task {
                            try? await Task.sleep(for: .seconds(element.entryAnimation.duration + 0.8))
                            studio.toggleElementVisibility(id: element.id)
                        }
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
        // Element creation lives on StudioController — the overlays palette
        // shares the same factories.
        AddElementButtons()
            .padding(8)
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
        case .text, .shape, .timer: true
        default: false
        }
    }
}

/// A web overlay IS a browser: the URL commits on Enter and navigates the
/// live page (editing the document alone never reloaded it), and the page
/// opens in a real window to click/scroll/log in — the canvas keeps
/// rendering it throughout.
private struct WebURLEditor: View {
    @Environment(StudioController.self) private var studio
    let element: Element
    let content: WebContent

    @State private var draft = ""
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("URL").font(.headline)
            TextField("https://…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .onSubmit(commit)
            HStack {
                Button("Go") { commit() }
                Button("Open Browser…") {
                    studio.openWebElementBrowser(id: element.id)
                }
                .help("Interact with the live page — click, scroll, log in. The canvas keeps showing it.")
            }
            .controlSize(.small)
        }
        .onAppear {
            guard !loaded else { return }
            loaded = true
            draft = content.urlString
        }
    }

    private func commit() {
        var urlString = draft.trimmingCharacters(in: .whitespaces)
        // Typing "airbnb.com" should just work.
        if !urlString.isEmpty, !urlString.contains("://") {
            urlString = "https://" + urlString
            draft = urlString
        }
        guard var updated = studio.findElement(id: element.id),
              case .web(var web) = updated.kind else { return }
        web.urlString = urlString
        updated.kind = .web(web)
        studio.updateElement(updated)
        studio.reloadWebElement(id: element.id)
    }
}

/// A gimbal: drag anywhere in the pad to tilt the element in two axes at
/// once (right = turn right, up = lean back), with a drawn horizon so the
/// current attitude is readable at a glance. Double-click resets to flat.
private struct GimbalPad: View {
    @Binding var tiltX: Double
    @Binding var tiltY: Double

    /// ±50° of travel across the pad — past that a quad is edge-on and the
    /// perspective divide gets ugly.
    private static let limit = 50.0 * .pi / 180.0

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            // Normalized -1…1 knob position.
            let nx = tiltY / Self.limit
            let ny = -tiltX / Self.limit

            ZStack {
                Circle()
                    .fill(Color.black.opacity(0.35))
                Circle()
                    .strokeBorder(.white.opacity(0.15))
                // Horizon + meridian, tilted by the current attitude, so the
                // pad shows the plane's orientation rather than just a dot.
                Path { path in
                    path.move(to: CGPoint(x: 6, y: size / 2))
                    path.addLine(to: CGPoint(x: size - 6, y: size / 2))
                }
                .stroke(.white.opacity(0.5), lineWidth: 1)
                .offset(y: CGFloat(ny) * size * 0.32)
                Path { path in
                    path.move(to: CGPoint(x: size / 2, y: 6))
                    path.addLine(to: CGPoint(x: size / 2, y: size - 6))
                }
                .stroke(.white.opacity(0.25), lineWidth: 1)
                .offset(x: CGFloat(nx) * size * 0.32)
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 11, height: 11)
                    .position(x: size / 2 + CGFloat(nx) * size * 0.42,
                              y: size / 2 + CGFloat(ny) * size * 0.42)
            }
            .frame(width: size, height: size)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let dx = (value.location.x - size / 2) / (size * 0.42)
                        let dy = (value.location.y - size / 2) / (size * 0.42)
                        tiltY = min(max(Double(dx), -1), 1) * Self.limit
                        tiltX = -min(max(Double(dy), -1), 1) * Self.limit
                    }
            )
            .onTapGesture(count: 2) {
                tiltX = 0
                tiltY = 0
            }
        }
    }
}

private func labeledRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
    HStack {
        Text(label).frame(width: 60, alignment: .leading).font(.caption)
        content()
    }
}
