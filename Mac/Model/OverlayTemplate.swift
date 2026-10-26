import Foundation

/// Portable native designs. Content belongs to scene instances, never exports.
/// Version one is self-contained vector/text artwork: no external files or code.
struct OverlayTemplate: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, CaseIterable, Sendable { case phone, comment }
    var schemaVersion = 1
    var id = UUID()
    var name: String
    var kind: Kind
    var fontName = "Arial-Black"
    var fontSize: Double = 64
    var foreground = RGBAColor.white
    var background = RGBAColor(red: 0.396, green: 0, blue: 0.851)
    var accent = RGBAColor(red: 0.796, green: 1, blue: 0.157)
    var animation = EntryAnimation.styled(.riseUp)

    static let builtIns: [OverlayTemplate] = [
        OverlayTemplate(id: UUID(uuidString: "B0A00000-0000-4000-8000-000000000001")!, name: "Violet / Incoming call", kind: .phone),
        OverlayTemplate(id: UUID(uuidString: "B0A00000-0000-4000-8000-000000000002")!, name: "Acid / Audience comment", kind: .comment,
                        fontSize: 48, foreground: RGBAColor(red: 0.149, green: 0, blue: 0.298),
                        background: RGBAColor(red: 0.796, green: 1, blue: 0.157))
    ]

    enum Invalid: LocalizedError {
        case unsupported, malformed
        var errorDescription: String? {
            switch self {
            case .unsupported: "This template needs a newer version of streamit."
            case .malformed: "This is not a supported overlay template."
            }
        }
    }
    func validate() throws {
        guard schemaVersion == 1 else { throw Invalid.unsupported }
        guard !name.isEmpty, name.count <= 120, fontName.count <= 200,
              fontSize.isFinite, (16...160).contains(fontSize),
              animation.duration.isFinite, (0...5).contains(animation.duration)
        else { throw Invalid.malformed }
        for color in [foreground, background, accent] {
            guard [color.red, color.green, color.blue, color.alpha].allSatisfy({ $0.isFinite && (0...1).contains($0) })
            else { throw Invalid.malformed }
        }
    }
    static func imported(_ data: Data) throws -> OverlayTemplate {
        guard data.count <= 64_000 else { throw Invalid.malformed }
        var template = try JSONDecoder().decode(Self.self, from: data)
        try template.validate()
        template.id = UUID() // imports never overwrite another show's design
        return template
    }
    func exported() throws -> Data {
        try validate()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }

    /// Fresh identity on every use; changing words cannot mutate the design.
    func elements(primary: String, secondary: String) -> [Element] {
        let instance = UUID()
        func text(_ slot: String, _ value: String, _ x: Double, _ y: Double,
                  _ w: Double, _ h: Double, _ size: Double, _ color: RGBAColor,
                  _ box: RGBAColor?) -> Element {
            var e = Element(name: "\(name) / \(slot)", kind: .text(TextContent(string: value,
                fontName: fontName, fontSize: size, alignment: .leading,
                lineSpacing: 1.05, boxFill: box.map { .solid($0) }, boxCornerRadius: 0)),
                transform: ElementTransform(center: CGPoint(x: x, y: y), size: CGSize(width: w, height: h)),
                fill: .solid(color), entryAnimation: animation, isVisible: false)
            e.overlayInstanceID = instance; e.overlayTemplate = self; e.overlayField = slot
            return e
        }
        if kind == .comment {
            return [text("Message", primary, 0.32, 0.80, 0.54, 0.19, fontSize, foreground, background),
                    text("Author", secondary, 0.32, 0.675, 0.54, 0.055, 26, foreground, background)]
        }
        // The phone remains editable vector artwork, not part of the name text.
        var phone = Element(name: "\(name) / Phone artwork", kind: .shape(ShapeContent(shape: .roundedRectangle)),
                            transform: ElementTransform(center: CGPoint(x: 0.61, y: 0.77), size: CGSize(width: 0.065, height: 0.21)),
                            fill: .solid(accent), entryAnimation: animation, isVisible: false, isLocked: true)
        phone.cornerRadius = 0.012; phone.overlayInstanceID = instance; phone.overlayTemplate = self
        var camera = Element(name: "\(name) / Camera pill", kind: .shape(ShapeContent(shape: .roundedRectangle)),
                             transform: ElementTransform(center: CGPoint(x: 0.61, y: 0.683), size: CGSize(width: 0.026, height: 0.009)),
                             fill: .solid(RGBAColor(red: 0.08, green: 0.02, blue: 0.13)), entryAnimation: animation,
                             isVisible: false, isLocked: true)
        camera.cornerRadius = 0.004; camera.overlayInstanceID = instance; camera.overlayTemplate = self
        return [phone, camera,
                text("Caller", primary, 0.8, 0.80, 0.30, 0.12, fontSize, foreground, background),
                text("Subtitle", secondary, 0.8, 0.705, 0.30, 0.055, 26, RGBAColor(red: 0.149, green: 0, blue: 0.298), accent)]
    }

    var commentStyle: CommentCardStyle {
        var style = CommentCardStyle()
        style.fontName = fontName; style.fontSize = fontSize
        style.boxColor = background; style.textColor = foreground
        style.usesPlatformTint = false; style.cornerRadius = 0
        return style
    }
}
