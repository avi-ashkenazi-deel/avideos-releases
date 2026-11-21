import SwiftUI

/// A miniature of the person's real desk: every monitor drawn at its true
/// relative size and position, each showing the wallpaper it currently has.
/// Clicking a monitor chooses which one the grid below is editing.
///
/// When a wallpaper spans the displays, the map shows it the same way: one
/// picture laid across the whole desk and visible through each monitor.
struct DisplayMapView: View {
    let displays: [Display]
    /// Display identifier -> the wallpaper that display shows on its own.
    let previews: [String: NSImage]
    /// Set when one wallpaper is stretched across every display.
    let spannedPreview: NSImage?
    let highlighted: Set<String>
    let isInteractive: Bool
    let onSelect: (Display) -> Void

    private let gap: CGFloat = 3
    private let cornerRadius: CGFloat = 5

    var body: some View {
        GeometryReader { proxy in
            let layout = MapLayout(displays: displays, in: proxy.size)
            ZStack(alignment: .topLeading) {
                if let spannedPreview {
                    spannedPicture(spannedPreview, layout: layout, size: proxy.size)
                }
                ForEach(displays) { display in
                    let rect = chipRect(for: display, layout: layout)
                    DisplayChip(
                        name: display.name,
                        image: spannedPreview == nil ? previews[display.id] : nil,
                        showsPlaceholder: spannedPreview == nil,
                        cornerRadius: cornerRadius,
                        isHighlighted: highlighted.contains(display.id),
                        isInteractive: isInteractive
                    ) {
                        onSelect(display)
                    }
                    .frame(width: rect.width, height: rect.height)
                    .offset(x: rect.minX, y: rect.minY)
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .frame(height: 84)
    }

    /// One image filling the whole desk, cut out in the shape of the monitors.
    private func spannedPicture(_ image: NSImage, layout: MapLayout, size: CGSize) -> some View {
        let desk = layout.deskRect
        return ZStack(alignment: .topLeading) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: desk.width, height: desk.height)
                .clipped()
                .offset(x: desk.minX, y: desk.minY)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .mask {
            ZStack(alignment: .topLeading) {
                ForEach(displays) { display in
                    let rect = chipRect(for: display, layout: layout)
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .frame(width: rect.width, height: rect.height)
                        .offset(x: rect.minX, y: rect.minY)
                }
            }
            .frame(width: size.width, height: size.height, alignment: .topLeading)
        }
    }

    /// A display's rectangle on the map, with a small gap around it so that
    /// neighbouring monitors read as separate screens.
    private func chipRect(for display: Display, layout: MapLayout) -> CGRect {
        let rect = layout.rect(for: display)
        return CGRect(
            x: rect.minX + gap,
            y: rect.minY + gap,
            width: max(rect.width - gap * 2, 8),
            height: max(rect.height - gap * 2, 8)
        )
    }

    /// Scales the global desktop down to fit the available space, centred.
    private struct MapLayout {
        let bounds: CGRect
        let scale: CGFloat
        let inset: CGSize

        init(displays: [Display], in size: CGSize) {
            let union = displays.reduce(CGRect.null) { $0.union($1.frame) }
            bounds = union.isNull ? CGRect(x: 0, y: 0, width: 1, height: 1) : union
            let fit = min(size.width / max(bounds.width, 1), size.height / max(bounds.height, 1))
            scale = fit.isFinite && fit > 0 ? fit : 1
            inset = CGSize(
                width: (size.width - bounds.width * scale) / 2,
                height: (size.height - bounds.height * scale) / 2
            )
        }

        /// The whole desk (every display together) on the map.
        var deskRect: CGRect {
            CGRect(x: inset.width, y: inset.height, width: bounds.width * scale, height: bounds.height * scale)
        }

        func rect(for display: Display) -> CGRect {
            // AppKit measures from the bottom-left, SwiftUI from the top-left.
            CGRect(
                x: (display.frame.minX - bounds.minX) * scale + inset.width,
                y: (bounds.maxY - display.frame.maxY) * scale + inset.height,
                width: display.frame.width * scale,
                height: display.frame.height * scale
            )
        }
    }
}

private struct DisplayChip: View {
    let name: String
    let image: NSImage?
    /// `false` leaves the chip see-through, for when a spanned picture is
    /// drawn behind all the chips.
    let showsPlaceholder: Bool
    let cornerRadius: CGFloat
    let isHighlighted: Bool
    let isInteractive: Bool
    let action: () -> Void

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    var body: some View {
        Button(action: action) {
            Color.clear
                .overlay {
                    if let image {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFill()
                    } else if showsPlaceholder {
                        Rectangle().fill(.quaternary)
                    }
                }
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(
                        isHighlighted ? Color.accentColor : Color.primary.opacity(0.15),
                        lineWidth: isHighlighted ? 2 : 1
                    )
                }
                .opacity(isHighlighted ? 1 : 0.6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isInteractive)
        .animation(.easeInOut(duration: 0.18), value: isHighlighted)
        .help(name)
        .accessibilityLabel(name)
        .accessibilityAddTraits(isHighlighted ? .isSelected : [])
    }
}
