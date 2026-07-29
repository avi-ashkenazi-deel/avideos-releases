import SwiftUI

/// The scrolling script column inside the floating panel, driven by the
/// controller's scroll engine via TimelineView — the view samples
/// `currentOffset(at:)` every frame; layout metrics flow back through
/// `updateLayout` so WPM→px/s stays correct as fonts/sizes change.
struct TeleprompterView: View {
    let controller: TeleprompterController
    @State private var controlsHovered = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                TimelineView(.animation) { timeline in
                    scriptColumn(panelSize: geo.size, date: timeline.date)
                }
                .clipped()
                .overlay(alignment: .center) { eyeLine(height: geo.size.height) }
                .overlay(alignment: .top) { fade(.top) }
                .overlay(alignment: .bottom) { fade(.bottom) }

                controlStrip
                    .opacity(controlsVisible ? 1 : 0.05)
                    .animation(.easeInOut(duration: 0.25), value: controlsVisible)
            }
            .onHover { controlsHovered = $0 }
        }
        .frame(minWidth: 320, minHeight: 220)
    }

    private var controlsVisible: Bool {
        controlsHovered || !controller.playing
    }

    // MARK: - Script column

    private func scriptColumn(panelSize: CGSize, date: Date) -> some View {
        let offset = controller.currentOffset(at: date)
        return ScriptTextColumn(controller: controller, panelWidth: panelSize.width)
            .offset(y: panelSize.height / 3 - offset)   // eye line at 1/3 height
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .scaleEffect(x: controller.mirrored ? -1 : 1, y: 1)
            .background(
                // Report layout once per size/content change.
                GeometryReader { _ in Color.clear }
            )
    }

    private func eyeLine(height: CGFloat) -> some View {
        Rectangle()
            .fill(Color.accentColor.opacity(0.35))
            .frame(height: 2)
            .offset(y: -height / 6)   // center of view is h/2; eye line at h/3
            .allowsHitTesting(false)
    }

    private func fade(_ edge: Alignment) -> some View {
        LinearGradient(colors: [Color.black.opacity(0.85), .clear],
                       startPoint: edge == .top ? .top : .bottom,
                       endPoint: edge == .top ? .bottom : .top)
            .frame(height: 60)
            .allowsHitTesting(false)
    }

    // MARK: - Controls

    private var controlStrip: some View {
        HStack(spacing: 10) {
            // Close leads, like a Mac window's traffic lights — it was
            // buried at the far end of the strip.
            Button {
                controller.toggleVisible()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
            }
            .help("Hide the teleprompter (⇧⌘T)")

            Button {
                controller.togglePlay()
            } label: {
                Image(systemName: controller.playing ? "pause.fill" : "play.fill")
            }
            .keyboardShortcut(.space, modifiers: [])

            HStack(spacing: 4) {
                Image(systemName: "tortoise")
                Slider(value: Binding(get: { controller.speed },
                                      set: { controller.setSpeed($0) }),
                       in: 0.4...2.0)
                    .frame(width: 90)
                Image(systemName: "hare")
            }

            Button { controller.adjustFontSize(by: -4) } label: { Image(systemName: "textformat.size.smaller") }
            Button { controller.adjustFontSize(by: 4) } label: { Image(systemName: "textformat.size.larger") }

            if let script = controller.script, script.sections.count > 1 {
                Menu {
                    ForEach(script.sections) { section in
                        Button(section.heading.isEmpty ? "Section" : section.heading) {
                            controller.jump(toSectionID: section.id)
                        }
                    }
                } label: {
                    Image(systemName: "list.bullet")
                }
                .menuStyle(.borderlessButton)
                .frame(width: 30)
            }

            Slider(value: Binding(get: { controller.opacity },
                                  set: { controller.setOpacity($0) }),
                   in: 0.3...1.0)
                .frame(width: 60)

            Toggle(isOn: Binding(get: { controller.mirrored },
                                 set: { _ in controller.toggleMirrored() })) {
                Image(systemName: "arrow.left.and.right.righttriangle.left.righttriangle.right")
            }
            .toggleStyle(.button)

            Toggle(isOn: Binding(get: { controller.clickThrough },
                                 set: { _ in controller.toggleClickThrough() })) {
                Image(systemName: "cursorarrow.slash")
            }
            .toggleStyle(.button)
            .help("Click-through: the panel ignores the mouse while live")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.black.opacity(0.5), in: Capsule())
        .padding(.bottom, 8)
    }
}

/// The static text content, measured so the controller can convert WPM →
/// px/s and map section jump offsets.
private struct ScriptTextColumn: View {
    let controller: TeleprompterController
    let panelWidth: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: controller.fontSize * 0.8) {
            if let script = controller.script {
                ForEach(script.sections) { section in
                    SectionBlock(section: section,
                                 fontSize: controller.fontSize,
                                 isActive: controller.activeSectionID == section.id)
                        .anchorPreference(key: SectionOffsetsKey.self, value: .top) { anchor in
                            [section.id: anchor]
                        }
                }
            } else {
                Text("Open a script from the Teleprompter menu")
                    .font(.system(size: 24))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 40)
        .backgroundPreferenceValue(SectionOffsetsKey.self) { anchors in
            GeometryReader { geo in
                Color.clear
                    .onAppear { report(geo: geo, anchors: anchors) }
                    .onChange(of: geo.size.height) { report(geo: geo, anchors: anchors) }
            }
        }
    }

    private func report(geo: GeometryProxy, anchors: [UUID: Anchor<CGPoint>]) {
        var offsets: [UUID: CGFloat] = [:]
        for (id, anchor) in anchors {
            offsets[id] = geo[anchor].y
        }
        controller.updateLayout(panelWidth: panelWidth,
                                visibleHeight: geo.size.height,
                                contentHeight: geo.size.height,
                                sectionOffsets: offsets)
    }
}

private struct SectionBlock: View {
    let section: ScriptSection
    let fontSize: CGFloat
    let isActive: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.35) {
            if !section.heading.isEmpty {
                Text(section.heading)
                    .font(.system(size: fontSize * 0.6, weight: .bold))
                    .foregroundStyle(isActive ? Color.accentColor : .secondary)
                    .textCase(.uppercase)
            }
            Text(section.body)
                .font(.system(size: fontSize, weight: .semibold))
                .foregroundStyle(.white.opacity(isActive ? 1 : 0.85))
                .lineSpacing(fontSize * 0.3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct SectionOffsetsKey: PreferenceKey {
    static var defaultValue: [UUID: Anchor<CGPoint>] = [:]
    static func reduce(value: inout [UUID: Anchor<CGPoint>], nextValue: () -> [UUID: Anchor<CGPoint>]) {
        value.merge(nextValue()) { $1 }
    }
}
