import SwiftUI

/// Transparent direct-manipulation layer over the Metal preview: hit-testing,
/// selection chrome, drag-to-move, handle-resize, and rotation. Mutates the
/// document through StudioController; the render plan republishes on change.
struct CanvasEditorOverlay: View {
    @Environment(StudioController.self) private var studio
    /// Focus lands here when a click selects an element, so Delete reaches
    /// `onDeleteCommand` below — and never fires while an inspector text
    /// field is being edited, because then the field has focus, not us.
    @FocusState private var canvasFocused: Bool

    var body: some View {
        GeometryReader { geo in
            let transform = CanvasTransform(viewSize: geo.size,
                                            canvasSize: studio.project.canvasSize)
            ZStack {
                // Full-area hit target for click-to-select / click-empty-to-deselect.
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        studio.selectedElementID = hitTest(at: location, transform: transform)
                        canvasFocused = studio.selectedElementID != nil
                    }

                if let selectedID = studio.selectedElementID,
                   let element = studio.findElement(id: selectedID),
                   !element.isLocked {
                    SelectionChrome(element: element, canvas: transform)
                }
            }
            .focusable()
            .focusEffectDisabled()
            .focused($canvasFocused)
            .onDeleteCommand {
                // Delete on the canvas HIDES (exit animation, recoverable
                // from the Overlays palette). Only the palette's remove
                // actually deletes — asked for explicitly.
                if let id = studio.selectedElementID,
                   studio.findElement(id: id)?.isVisible == true {
                    studio.toggleElementVisibility(id: id)
                }
            }
        }
    }

    /// Top-down z-order hit test with rotation-aware point-in-rect.
    private func hitTest(at point: CGPoint, transform: CanvasTransform) -> UUID? {
        guard let elements = studio.activeScene?.elements else { return nil }
        let unit = transform.toUnit(point)
        for element in elements.reversed() where element.isVisible && !element.isLocked {
            let t = element.transform
            // Rotate the point into the element's local frame.
            let dx = unit.x - t.center.x
            let dy = unit.y - t.center.y
            let cosA = cos(-t.rotation)
            let sinA = sin(-t.rotation)
            let localX = dx * cosA - dy * sinA
            let localY = dx * sinA + dy * cosA
            if abs(localX) <= t.size.width / 2, abs(localY) <= t.size.height / 2 {
                return element.id
            }
        }
        return nil
    }
}

/// Selection rectangle + resize handles + rotation grip for one element.
private struct SelectionChrome: View {
    @Environment(StudioController.self) private var studio
    @Environment(\.openWindow) private var openWindow
    let element: Element
    let canvas: CanvasTransform

    /// Gesture-start snapshot so drags are absolute, not incremental.
    @State private var dragStart: ElementTransform?

    private enum Handle: CaseIterable {
        case topLeft, top, topRight, left, right, bottomLeft, bottom, bottomRight

        var unitOffset: CGPoint {
            switch self {
            case .topLeft: CGPoint(x: -0.5, y: -0.5)
            case .top: CGPoint(x: 0, y: -0.5)
            case .topRight: CGPoint(x: 0.5, y: -0.5)
            case .left: CGPoint(x: -0.5, y: 0)
            case .right: CGPoint(x: 0.5, y: 0)
            case .bottomLeft: CGPoint(x: -0.5, y: 0.5)
            case .bottom: CGPoint(x: 0, y: 0.5)
            case .bottomRight: CGPoint(x: 0.5, y: 0.5)
            }
        }
    }

    var body: some View {
        let rect = canvas.viewRect(for: element.transform)

        ZStack {
            // Move gesture on the body.
            Rectangle()
                .stroke(Color.accentColor, lineWidth: 1.5)
                .background(Color.white.opacity(0.001))   // hit-testable interior
                .frame(width: rect.width, height: rect.height)
                .contentShape(Rectangle())
                .gesture(moveGesture)

            // Resize handles.
            ForEach(Handle.allCases, id: \.self) { handle in
                Circle()
                    .fill(Color.white)
                    .overlay(Circle().stroke(Color.accentColor, lineWidth: 1.5))
                    .frame(width: 10, height: 10)
                    .offset(x: handle.unitOffset.x * rect.width,
                            y: handle.unitOffset.y * rect.height)
                    .gesture(resizeGesture(handle: handle))
            }

            // Rotation grip above the top edge.
            Circle()
                .fill(Color.accentColor)
                .frame(width: 10, height: 10)
                .offset(y: -rect.height / 2 - 22)
                .gesture(rotateGesture(rect: rect))

            // Pencil at the left edge (Ecamm-style): opens the inspector
            // window on this element for radius, opacity, stroke, effects,
            // text styling.
            Button {
                studio.selectedElementID = element.id
                openWindow(id: "palette", value: PaletteKind.inspector)
            } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(.black.opacity(0.65), in: Circle())
                    .overlay(Circle().strokeBorder(.white.opacity(0.35)))
            }
            .buttonStyle(.plain)
            .offset(x: -rect.width / 2 - 18)
            .help("Edit this element")
        }
        .rotationEffect(.radians(element.transform.rotation))
        .position(x: rect.midX, y: rect.midY)
        .animation(nil, value: element.transform)
    }

    private var moveGesture: some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                if dragStart == nil { dragStart = element.transform }
                guard let start = dragStart else { return }
                let delta = canvas.toUnitDelta(CGSize(width: value.translation.width,
                                                      height: value.translation.height))
                var element = element
                element.transform = start
                element.transform.center.x = min(max(start.center.x + delta.width, 0), 1)
                element.transform.center.y = min(max(start.center.y + delta.height, 0), 1)
                studio.updateElement(element)
            }
            .onEnded { _ in dragStart = nil }
    }

    private func resizeGesture(handle: Handle) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                if dragStart == nil { dragStart = element.transform }
                guard let start = dragStart else { return }
                let delta = canvas.toUnitDelta(CGSize(width: value.translation.width,
                                                      height: value.translation.height))
                var element = element
                var t = start
                let dirX = handle.unitOffset.x * 2   // -1, 0, 1
                let dirY = handle.unitOffset.y * 2
                // Resize about the opposite edge: grow size and shift center.
                let dw = Double(delta.width) * dirX
                let dh = Double(delta.height) * dirY
                t.size.width = max(0.02, start.size.width + dw)
                t.size.height = max(0.02, start.size.height + dh)
                t.center.x = start.center.x + delta.width * abs(dirX) / 2
                t.center.y = start.center.y + delta.height * abs(dirY) / 2
                element.transform = t
                studio.updateElement(element)
            }
            .onEnded { _ in dragStart = nil }
    }

    private func rotateGesture(rect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named("canvas"))
            .onChanged { value in
                if dragStart == nil { dragStart = element.transform }
                let center = CGPoint(x: rect.midX, y: rect.midY)
                let angle = atan2(value.location.y - center.y, value.location.x - center.x) + .pi / 2
                var element = element
                var snapped = angle
                // Snap to 15° increments near them.
                let step = Double.pi / 12
                let nearest = (angle / step).rounded() * step
                if abs(angle - nearest) < 0.04 { snapped = nearest }
                element.transform.rotation = snapped
                studio.updateElement(element)
            }
            .onEnded { _ in dragStart = nil }
    }
}
