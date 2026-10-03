import Foundation
import CoreGraphics

/// The featured-comment card as render items: a box, the author line
/// (tinted by platform), and the message. Pure layout so it's unit-tested;
/// the studio adds the result as the topmost layer of both canvases.
///
/// Sizes are worked out in pixels so the card fits its text: the message
/// wraps inside the box and the box grows to at most four lines (longer
/// messages are cut with an ellipsis, which is what a viewer can read in a
/// few seconds anyway).
enum CommentCard {
    static let maxLines = 4

    struct Layout: Equatable {
        var box: ElementTransform
        var name: ElementTransform
        var message: ElementTransform
        var messageText: String
        /// The canvas height text is sized against (see `RenderItem`).
        var textReferenceHeight: Double
    }

    static func layout(for comment: LiveComment,
                       style: CommentCardStyle,
                       canvas: CGSize,
                       orientation: StreamOrientation) -> Layout {
        let width = Double(max(canvas.width, 1))
        let height = Double(max(canvas.height, 1))
        // Vertical: size text against the canvas WIDTH, so a 40 pt message
        // reads the same on a phone as on the 1080p design.
        let reference = orientation == .vertical ? width : height
        let messagePx = style.fontSize * reference / 1080
        let namePx = messagePx * 0.72
        let padY = messagePx * 0.55
        let padX = messagePx * 0.8

        let boxWidthFraction: Double
        switch (orientation, style.position) {
        case (.vertical, _): boxWidthFraction = 0.88
        case (.horizontal, .lowerLeft): boxWidthFraction = 0.46
        case (.horizontal, _): boxWidthFraction = 0.58
        }
        let boxWidthPx = boxWidthFraction * width
        let textWidthPx = boxWidthPx - padX * 2

        // ~0.5 em per character is a fair average for the system font.
        let charsPerLine = max(8, Int(textWidthPx / (messagePx * 0.5)))
        var text = comment.text.replacingOccurrences(of: "\n", with: " ")
        if text.count > charsPerLine * maxLines {
            text = String(text.prefix(charsPerLine * maxLines - 1)).trimmingCharacters(in: .whitespaces) + "…"
        }
        let lines = min(maxLines, max(1, Int((Double(text.count) / Double(charsPerLine)).rounded(.up))))

        let nameHeightPx = namePx * 1.45
        let messageHeightPx = Double(lines) * messagePx * 1.3
        let boxHeightPx = padY + nameHeightPx + messageHeightPx + padY

        let boxW = boxWidthPx / width
        let boxH = boxHeightPx / height
        let centerX: Double
        let centerY: Double
        switch (orientation, style.position) {
        case (.horizontal, .lowerLeft):
            centerX = 0.05 + boxW / 2
            centerY = 0.9 - boxH / 2
        case (.horizontal, .lowerCenter):
            centerX = 0.5
            centerY = 0.9 - boxH / 2
        case (.horizontal, .top):
            centerX = 0.5
            centerY = 0.07 + boxH / 2
        case (.vertical, .top):
            centerX = 0.5
            centerY = 0.13 + boxH / 2
        case (.vertical, _):
            // Above the bottom ~22% phones cover with the platform's own UI.
            centerX = 0.5
            centerY = 0.77 - boxH / 2
        }

        let top = centerY - boxH / 2
        let textW = textWidthPx / width
        let nameH = nameHeightPx / height
        let messageH = messageHeightPx / height
        let name = ElementTransform(center: CGPoint(x: centerX, y: top + padY / height + nameH / 2),
                                    size: CGSize(width: textW, height: nameH))
        let message = ElementTransform(center: CGPoint(x: centerX,
                                                       y: top + (padY + nameHeightPx) / height + messageH / 2),
                                       size: CGSize(width: textW, height: messageH))
        let box = ElementTransform(center: CGPoint(x: centerX, y: centerY),
                                   size: CGSize(width: boxW, height: boxH))
        return Layout(box: box, name: name, message: message,
                      messageText: text, textReferenceHeight: reference)
    }

    /// The author line: name, then the platform (and a Super Chat / Bits amount).
    static func nameLine(for comment: LiveComment) -> String {
        var parts = [comment.author, comment.platform.displayName]
        if let amount = comment.amount { parts.append(amount) }
        return parts.joined(separator: "  ·  ")
    }

    static func items(for comment: LiveComment,
                      style: CommentCardStyle,
                      canvas: CGSize,
                      orientation: StreamOrientation,
                      animation: AnimationState) -> [RenderItem] {
        let layout = layout(for: comment, style: style, canvas: canvas, orientation: orientation)
        let ids = identifiers(for: comment.id)
        let entry = EntryAnimation(style: .riseUp, duration: 0.35, curve: .easeOut)
        let nameColor = style.usesPlatformTint
            ? (RGBAColor(hex: comment.platform.tintHex) ?? style.textColor)
            : style.textColor

        let box = RenderItem(id: ids.box,
                             transitionKey: "comment:\(comment.id):box",
                             content: .fill(.solid(style.boxColor)),
                             transform: layout.box,
                             blendMode: .normal,
                             effects: EffectChain(),
                             stroke: nil,
                             cornerRadius: 0.012,
                             entryAnimation: entry,
                             animation: animation)
        var name = RenderItem(id: ids.name,
                              transitionKey: "comment:\(comment.id):name",
                              content: .text(TextContent(string: nameLine(for: comment),
                                                         fontSize: style.fontSize * 0.72,
                                                         alignment: .leading,
                                                         lineSpacing: 1.0),
                                             color: .solid(nameColor)),
                              transform: layout.name,
                              blendMode: .normal,
                              effects: EffectChain(),
                              stroke: nil,
                              cornerRadius: 0,
                              entryAnimation: entry,
                              animation: animation)
        var message = RenderItem(id: ids.message,
                                 transitionKey: "comment:\(comment.id):message",
                                 content: .text(TextContent(string: layout.messageText,
                                                            fontSize: style.fontSize,
                                                            alignment: .leading,
                                                            lineSpacing: 1.1),
                                                color: .solid(style.textColor)),
                                 transform: layout.message,
                                 blendMode: .normal,
                                 effects: EffectChain(),
                                 stroke: nil,
                                 cornerRadius: 0,
                                 entryAnimation: entry,
                                 animation: animation)
        if orientation == .vertical {
            name.textReferenceHeight = layout.textReferenceHeight
            message.textReferenceHeight = layout.textReferenceHeight
        }
        return [box, name, message]
    }

    /// Stable item ids per comment (FNV-1a of the comment id), so a card
    /// keeps its identity across recompiles while it animates.
    static func identifiers(for commentID: String) -> (box: UUID, name: UUID, message: UUID) {
        func uuid(_ salt: String) -> UUID {
            var high: UInt64 = 0xcbf2_9ce4_8422_2325
            var low: UInt64 = 0x8422_2325_cbf2_9ce4
            for byte in (salt + commentID).utf8 {
                high = (high ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
                low = (low ^ UInt64(byte)) &* 0x0000_0100_0000_01b3 &+ 0x9e37
            }
            let h = withUnsafeBytes(of: high.bigEndian) { Array($0) }
            let l = withUnsafeBytes(of: low.bigEndian) { Array($0) }
            return UUID(uuid: (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7],
                               l[0], l[1], l[2], l[3], l[4], l[5], l[6], l[7]))
        }
        return (uuid("box:"), uuid("name:"), uuid("message:"))
    }
}

extension RGBAColor {
    /// "#RRGGBB" or "RRGGBB".
    init?(hex: String) {
        var string = hex.trimmingCharacters(in: .whitespaces)
        if string.hasPrefix("#") { string.removeFirst() }
        guard string.count == 6, let value = UInt32(string, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255,
                  green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}
