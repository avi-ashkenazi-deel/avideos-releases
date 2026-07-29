import SwiftUI

/// Hover feedback for the studio's icon and tile buttons.
///
/// `.plain` and `.borderless` draw nothing on hover, so most of the chrome
/// gave no sign it was clickable until you clicked it. These two styles are
/// the standard answer: a soft rounded background for icon buttons, a lift
/// for picture tiles. Both also react to the press so a click feels landed.
struct StudioIconButtonStyle: ButtonStyle {
    /// Icons inside a list row want a tighter box than toolbar icons.
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        StudioIconButton(configuration: configuration, compact: compact)
    }

    private struct StudioIconButton: View {
        let configuration: Configuration
        let compact: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            configuration.label
                .padding(compact ? 3 : 5)
                .background(
                    RoundedRectangle(cornerRadius: compact ? 4 : 6)
                        .fill(background)
                )
                .opacity(isEnabled ? 1 : 0.35)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
                .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
        }

        private var background: Color {
            guard isEnabled else { return .clear }
            if configuration.isPressed { return .white.opacity(0.22) }
            return hovering ? .white.opacity(0.12) : .clear
        }
    }
}

/// For picture tiles (camera strip, scene grid): brightens and lifts slightly
/// rather than drawing a box, so the image stays the subject.
struct StudioTileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        StudioTileButton(configuration: configuration)
    }

    private struct StudioTileButton: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .brightness(configuration.isPressed ? -0.05 : (hovering ? 0.06 : 0))
                .scaleEffect(configuration.isPressed ? 0.98 : (hovering ? 1.02 : 1))
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
                .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
        }
    }
}

extension ButtonStyle where Self == StudioIconButtonStyle {
    static var studioIcon: StudioIconButtonStyle { StudioIconButtonStyle() }
    static var studioIconCompact: StudioIconButtonStyle { StudioIconButtonStyle(compact: true) }
}

extension ButtonStyle where Self == StudioTileButtonStyle {
    static var studioTile: StudioTileButtonStyle { StudioTileButtonStyle() }
}

/// Hover feedback for rows that aren't buttons (list rows, section headers).
struct HoverHighlight: ViewModifier {
    var cornerRadius: CGFloat = 6
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(hovering ? Color.white.opacity(0.06) : .clear)
            )
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

extension View {
    func hoverHighlight(cornerRadius: CGFloat = 6) -> some View {
        modifier(HoverHighlight(cornerRadius: cornerRadius))
    }
}
