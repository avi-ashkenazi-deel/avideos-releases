import Foundation
import CoreGraphics
import CoreImage
import CoreText
import AppKit

/// Caption styling for burned-in subtitles: font, colors, word-by-word
/// karaoke highlighting (free from Whisper word timings), position, and
/// background treatment. Presets cover the popular short-form looks.
struct CaptionStyle: Codable, Sendable, Equatable {
    enum HighlightMode: String, Codable, CaseIterable, Sendable {
        case wordByWord     // active word pops in the highlight color
        case line           // whole current line in the fill color
    }

    enum Position: String, Codable, CaseIterable, Sendable {
        case lowerThird
        case center
        case top
    }

    enum BackgroundStyle: String, Codable, CaseIterable, Sendable {
        case none
        case pill           // rounded capsule behind each line
        case band           // full-width translucent band
    }

    var fontName: String
    /// Point size at 1080p reference height; scales with render size.
    var fontSize: Double
    var fillColorHex: String
    var highlightColorHex: String
    var highlightMode: HighlightMode
    var position: Position
    var backgroundStyle: BackgroundStyle
    var allCaps: Bool
    /// Words emphasized in the highlight color even when inactive
    /// (picked by the clip pass or by hand).
    var emphasisWords: [String]

    init(fontName: String = "",
         fontSize: Double = 52,
         fillColorHex: String = "#FFFFFF",
         highlightColorHex: String = "#FFD60A",
         highlightMode: HighlightMode = .wordByWord,
         position: Position = .lowerThird,
         backgroundStyle: BackgroundStyle = .pill,
         allCaps: Bool = false,
         emphasisWords: [String] = []) {
        self.fontName = fontName
        self.fontSize = fontSize
        self.fillColorHex = fillColorHex
        self.highlightColorHex = highlightColorHex
        self.highlightMode = highlightMode
        self.position = position
        self.backgroundStyle = backgroundStyle
        self.allCaps = allCaps
        self.emphasisWords = emphasisWords
    }

    // MARK: - Presets

    static let karaoke = CaptionStyle()
    static let boxed = CaptionStyle(fontSize: 46,
                                    highlightColorHex: "#4AC0BE",
                                    highlightMode: .wordByWord,
                                    backgroundStyle: .band,
                                    allCaps: true)
    static let minimal = CaptionStyle(fontSize: 40,
                                      highlightColorHex: "#FFFFFF",
                                      highlightMode: .line,
                                      backgroundStyle: .none)

    static let presets: [(name: String, style: CaptionStyle)] = [
        ("Karaoke", .karaoke),
        ("Boxed", .boxed),
        ("Minimal", .minimal),
    ]
}

extension CaptionStyle {
    static func color(fromHex hex: String) -> CGColor {
        var value: UInt64 = 0
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        Scanner(string: cleaned).scanHexInt64(&value)
        let r = CGFloat((value >> 16) & 0xFF) / 255
        let g = CGFloat((value >> 8) & 0xFF) / 255
        let b = CGFloat(value & 0xFF) / 255
        return CGColor(srgbRed: r, green: g, blue: b, alpha: 1)
    }
}

/// Caption data handed to `LayoutVideoCompositor`: word timings already
/// mapped to the *edited* timeline (the compositor's time base) plus the
/// style. A plain value type so it is safe to share with the compositor's
/// render queue.
struct CaptionRenderContext: Sendable {
    struct TimedWord: Sendable {
        var text: String
        /// Edited-timeline seconds.
        var start: Double
        var end: Double
        var trackId: String
    }

    let words: [TimedWord]
    let style: CaptionStyle
}

/// Draws captions for one moment in time into a CGContext (used by the
/// export compositor) and exports SRT/VTT sidecars. Groups words into
/// ~4-word caption lines; the active word gets the highlight treatment.
enum CaptionRenderer {
    struct CaptionLine {
        var words: [Word]
        var start: Double { words.first?.start ?? 0 }
        var end: Double { words.last?.end ?? 0 }
        var text: String { words.map(\.text).joined(separator: " ") }
    }

    /// Groups a transcript's (source-time) words into caption lines.
    static func lines(from words: [Word], maxWordsPerLine: Int = 4) -> [CaptionLine] {
        var lines: [CaptionLine] = []
        var current: [Word] = []
        for word in words where !word.isDisfluency {
            current.append(word)
            // Break on line length or a long inter-word gap (sentence end).
            let gap = current.count >= 2
                ? word.start - current[current.count - 2].end
                : 0
            if current.count >= maxWordsPerLine || gap > 0.8 {
                lines.append(CaptionLine(words: current))
                current = []
            }
        }
        if !current.isEmpty { lines.append(CaptionLine(words: current)) }
        return lines
    }

    /// Draws the caption visible at `time` (source-time seconds) into `ctx`
    /// (pixel space, origin bottom-left as CoreGraphics expects).
    static func draw(at time: Double,
                     lines: [CaptionLine],
                     style: CaptionStyle,
                     in ctx: CGContext,
                     size: CGSize) {
        guard let line = lines.first(where: { time >= $0.start && time <= $0.end + 0.15 }) else { return }

        let scale = size.height / 1080.0
        let fontSize = CGFloat(style.fontSize) * scale
        let font: NSFont = style.fontName.isEmpty
            ? NSFont.systemFont(ofSize: fontSize, weight: .heavy)
            : (NSFont(name: style.fontName, size: fontSize) ?? NSFont.systemFont(ofSize: fontSize, weight: .heavy))

        let fillColor = CaptionStyle.color(fromHex: style.fillColorHex)
        let highlightColor = CaptionStyle.color(fromHex: style.highlightColorHex)
        let emphasis = Set(style.emphasisWords.map { $0.lowercased() })

        // Build the attributed line with per-word colors.
        let attributed = NSMutableAttributedString()
        for (index, word) in line.words.enumerated() {
            var text = word.text
            if style.allCaps { text = text.uppercased() }
            if index < line.words.count - 1 { text += " " }

            let isActive = time >= word.start && time <= word.end
            let isEmphasis = emphasis.contains(ScriptAligner.normalizeToken(word.text))
            let color: CGColor = switch style.highlightMode {
            case .wordByWord: (isActive || isEmphasis) ? highlightColor : fillColor
            case .line: fillColor
            }

            attributed.append(NSAttributedString(string: text, attributes: [
                .font: font,
                .foregroundColor: NSColor(cgColor: color) ?? .white,
                .strokeColor: NSColor.black,
                .strokeWidth: -3.0,   // negative = stroke + fill
            ]))
        }

        let ctLine = CTLineCreateWithAttributedString(attributed)
        let bounds = CTLineGetBoundsWithOptions(ctLine, [.useOpticalBounds])
        let x = (size.width - bounds.width) / 2

        let y: CGFloat = switch style.position {
        case .lowerThird: size.height * 0.12
        case .center: size.height * 0.5 - bounds.height / 2
        case .top: size.height * 0.82
        }

        // Background treatment.
        switch style.backgroundStyle {
        case .none:
            break
        case .pill:
            let padding = fontSize * 0.4
            let rect = CGRect(x: x - padding,
                              y: y - padding * 0.6,
                              width: bounds.width + padding * 2,
                              height: bounds.height + padding * 1.1)
            let path = CGPath(roundedRect: rect, cornerWidth: rect.height / 2,
                              cornerHeight: rect.height / 2, transform: nil)
            ctx.setFillColor(CGColor(gray: 0, alpha: 0.65))
            ctx.addPath(path)
            ctx.fillPath()
        case .band:
            let padding = fontSize * 0.5
            ctx.setFillColor(CGColor(gray: 0, alpha: 0.55))
            ctx.fill(CGRect(x: 0, y: y - padding * 0.6,
                            width: size.width, height: bounds.height + padding * 1.2))
        }

        ctx.textPosition = CGPoint(x: x, y: y)
        CTLineDraw(ctLine, ctx)
    }

    /// Compositor entry point: renders the caption visible at `time`
    /// (edited-timeline seconds, matching the TimedWords) into a CIImage the
    /// size of the canvas. Returns nil when no caption is on screen.
    ///
    /// Lines are regrouped per call; at 30fps with typical transcripts this
    /// is cheap relative to the CoreImage compositing around it.
    static func image(at time: Double,
                      words: [CaptionRenderContext.TimedWord],
                      style: CaptionStyle,
                      canvasSize: CGSize) -> CIImage? {
        let mapped = words.map {
            Word(text: $0.text, start: $0.start, end: $0.end, confidence: 1, trackId: $0.trackId)
        }
        let captionLines = lines(from: mapped)
        guard captionLines.contains(where: { time >= $0.start && time <= $0.end + 0.15 }) else {
            return nil
        }

        let width = Int(canvasSize.width.rounded())
        let height = Int(canvasSize.height.rounded())
        guard width > 0, height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil,
                                  width: width,
                                  height: height,
                                  bitsPerComponent: 8,
                                  bytesPerRow: 0,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return nil
        }
        draw(at: time, lines: captionLines, style: style, in: ctx, size: canvasSize)
        guard let cgImage = ctx.makeImage() else { return nil }
        return CIImage(cgImage: cgImage)
    }

    // MARK: - Sidecar export

    /// Times are edited-timeline seconds — map the words through the EDL
    /// before calling for post-cut exports.
    static func srt(lines: [CaptionLine]) -> String {
        lines.enumerated().map { index, line in
            "\(index + 1)\n\(srtStamp(line.start)) --> \(srtStamp(line.end))\n\(line.text)\n"
        }
        .joined(separator: "\n")
    }

    static func vtt(lines: [CaptionLine]) -> String {
        "WEBVTT\n\n" + lines.map { line in
            "\(vttStamp(line.start)) --> \(vttStamp(line.end))\n\(line.text)\n"
        }
        .joined(separator: "\n")
    }

    private static func srtStamp(_ seconds: Double) -> String {
        stamp(seconds, millisecondSeparator: ",")
    }

    private static func vttStamp(_ seconds: Double) -> String {
        stamp(seconds, millisecondSeparator: ".")
    }

    private static func stamp(_ seconds: Double, millisecondSeparator: String) -> String {
        let total = max(0, seconds)
        let hours = Int(total) / 3600
        let minutes = (Int(total) % 3600) / 60
        let secs = Int(total) % 60
        let millis = Int((total - floor(total)) * 1000)
        return String(format: "%02d:%02d:%02d%@%03d", hours, minutes, secs, millisecondSeparator, millis)
    }
}
