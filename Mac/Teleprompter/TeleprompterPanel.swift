import AppKit
import SwiftUI

/// Floating, translucent HUD panel the host reads from while live.
///
/// INVARIANT — the prompter can never appear in the program output: the
/// program is composited from registered frame sources (cameras, screen
/// sources, media, guests), never from a capture of this Mac's display, so
/// nothing drawn in an app window can leak into the feed. Independently,
/// `sharingType = .none` excludes the panel from the host's own screen-shares
/// (Zoom/Meet window capture, ScreenCaptureKit pickers) so remote guests never
/// see the script either. Do not weaken either property.
@MainActor
final class TeleprompterPanel: NSPanel {
    private static let frameAutosaveKey = "TeleprompterPanel"

    private weak var controller: TeleprompterController?
    private var grip: TeleprompterGripPanel?

    init(controller: TeleprompterController) {
        self.controller = controller
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 640),
            // verify on Mac: .resizable on a borderless panel enables edge-drag
            // resizing on macOS 11+; if it regresses, add an explicit resize
            // handle to the SwiftUI control strip.
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovableByWindowBackground = true
        sharingType = .none
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        animationBehavior = .utilityWindow
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        minSize = NSSize(width: 320, height: 240)

        let effect = NSVisualEffectView()
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 14
        effect.layer?.cornerCurve = .continuous
        effect.layer?.masksToBounds = true

        let hosting = NSHostingView(rootView: TeleprompterView(controller: controller))
        hosting.translatesAutoresizingMaskIntoConstraints = false
        effect.addSubview(hosting)
        NSLayoutConstraint.activate([
            hosting.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
            hosting.topAnchor.constraint(equalTo: effect.topAnchor),
            hosting.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
        ])
        contentView = effect

        // verify on Mac: frame autosave works for borderless panels; the name
        // is registered after restoring so the park position isn't clobbered.
        if !setFrameUsingName(Self.frameAutosaveKey) {
            parkUnderCamera(animated: false)
        }
        setFrameAutosaveName(Self.frameAutosaveKey)
    }

    // Borderless windows refuse key status by default; the panel must accept
    // it so space/sliders work when the host clicks into it.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // MARK: - Park under camera

    /// Snaps to the top-center of the screen the mouse is on (assumed to be
    /// the one with the camera above it) with a small margin, so the host's
    /// eye line stays as close to the lens as possible.
    func parkUnderCamera(animated: Bool = true) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let screen else { return }
        let visible = screen.visibleFrame
        let margin: CGFloat = 8
        let size = frame.size
        let target = NSRect(
            x: (visible.midX - size.width / 2).rounded(),
            y: visible.maxY - size.height - margin,
            width: size.width,
            height: size.height
        )
        setFrame(target, display: true, animate: animated)
    }

    // MARK: - Click-through

    /// In click-through mode the whole panel ignores mouse events so the host
    /// can drive apps underneath it. `ignoresMouseEvents` is all-or-nothing,
    /// so a tiny always-clickable grip child window stays interactive to drag
    /// the panel or exit the mode.
    func setClickThrough(_ enabled: Bool) {
        ignoresMouseEvents = enabled
        if enabled {
            let grip = self.grip ?? TeleprompterGripPanel { [weak self] in
                MainActor.assumeIsolated {
                    self?.controller?.toggleClickThrough()
                }
            }
            self.grip = grip
            positionGrip(grip)
            // verify on Mac: child windows inherit Spaces behavior from the
            // parent and track parent moves automatically.
            if grip.parent == nil { addChildWindow(grip, ordered: .above) }
            grip.orderFront(nil)
        } else if let grip {
            removeChildWindow(grip)
            grip.orderOut(nil)
        }
    }

    private func positionGrip(_ grip: NSPanel) {
        let inset: CGFloat = 10
        grip.setFrameOrigin(NSPoint(
            x: frame.minX + inset,
            y: frame.maxY - grip.frame.height - inset
        ))
    }
}

/// The always-clickable grip shown while the main panel is click-through.
/// Click toggles click-through off; drag moves the parent panel.
@MainActor
private final class TeleprompterGripPanel: NSPanel {
    private let onToggle: () -> Void
    private var dragAnchor: NSPoint = .zero
    private var parentOriginAtDragStart: NSPoint?
    private var dragged = false

    init(onToggle: @escaping () -> Void) {
        self.onToggle = onToggle
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 36, height: 24),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        sharingType = .none // the grip must not leak into screen-shares either
        isReleasedWhenClosed = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false

        let effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 36, height: 24))
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 12
        effect.layer?.masksToBounds = true

        let image = NSImageView(frame: effect.bounds)
        image.image = NSImage(systemSymbolName: "cursorarrow.and.square.on.square.dashed",
                              accessibilityDescription: "Exit click-through")
        image.contentTintColor = .secondaryLabelColor
        image.autoresizingMask = [.width, .height]
        // The image view must not swallow clicks — the window handles them.
        image.unregisterDraggedTypes()
        effect.addSubview(image)
        contentView = effect
        contentView?.toolTip = "Click to make the prompter clickable again; drag to move it"
    }

    override var canBecomeKey: Bool { false }

    override func mouseDown(with event: NSEvent) {
        dragAnchor = NSEvent.mouseLocation
        parentOriginAtDragStart = parent?.frame.origin
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = parentOriginAtDragStart, let parent else { return }
        let location = NSEvent.mouseLocation
        let dx = location.x - dragAnchor.x
        let dy = location.y - dragAnchor.y
        if abs(dx) > 2 || abs(dy) > 2 { dragged = true }
        parent.setFrameOrigin(NSPoint(x: start.x + dx, y: start.y + dy))
    }

    override func mouseUp(with event: NSEvent) {
        if !dragged { onToggle() }
    }
}
