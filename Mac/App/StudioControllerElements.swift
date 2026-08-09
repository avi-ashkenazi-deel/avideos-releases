import AppKit
import AVFoundation
import ImageIO

/// Element factories — the add-row in the Overlays palette and the inspector.
/// Split out of StudioController.swift purely for size: that file is the hub
/// every feature touches and had crossed a thousand lines. Same type, same
/// isolation (the class is @MainActor); only the text moved.
extension StudioController {

    // MARK: - Element factories (inspector add-bar + overlays palette)

    func addTextElement() {
        addElement(Element(name: "Text",
                           kind: .text(TextContent(string: "Your text")),
                           transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.8),
                                                       size: CGSize(width: 0.5, height: 0.12)),
                           fill: .solid(.white),
                           entryAnimation: .styled(.slideFromBottom)))
    }

    func addShapeElement() {
        addElement(Element(name: "Shape",
                           kind: .shape(ShapeContent(shape: .roundedRectangle)),
                           transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.82),
                                                       size: CGSize(width: 0.55, height: 0.16)),
                           fill: .shader(ShaderFill()),
                           entryAnimation: .styled(.slideFromLeft)))
    }

    func addImageElement(url: URL) {
        addElement(Element(name: url.lastPathComponent,
                           kind: .image(MediaReference(url: url)),
                           transform: mediaTransform(forPixelSize: Self.imagePixelSize(url: url)),
                           entryAnimation: .styled(.fade)))
    }

    func addVideoElement(url: URL) {
        // Natural size loads async; the element appears once probed so its
        // bounding box starts at the video's real shape, not a default square.
        Task { @MainActor in
            let pixelSize = await Self.videoPixelSize(url: url)
            addElement(Element(name: url.lastPathComponent,
                               kind: .video(VideoContent(media: MediaReference(url: url))),
                               transform: mediaTransform(forPixelSize: pixelSize),
                               entryAnimation: .styled(.fade)))
        }
    }

    func addWebElement() {
        addElement(Element(name: "Web Overlay",
                           kind: .web(WebContent(urlString: "https://example.com")),
                           transform: .fullCanvas,
                           entryAnimation: .styled(.fade)))
    }

    /// Text with a background box (lower-third style).
    func addTextBoxElement() {
        addElement(Element(name: "Text Box",
                           kind: .text(TextContent(string: "Your text",
                                                   boxFill: .solid(RGBAColor(red: 0, green: 0, blue: 0, alpha: 0.55)),
                                                   boxCornerRadius: 0.04)),
                           transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.8),
                                                       size: CGSize(width: 0.5, height: 0.14)),
                           fill: .solid(.white),
                           entryAnimation: .styled(.slideFromBottom)))
    }

    /// Countdown overlay; the count starts the moment it's added.
    func addTimerElement() {
        let element = Element(name: "Timer",
                              kind: .timer(TimerContent()),
                              transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.5),
                                                          size: CGSize(width: 0.4, height: 0.22)),
                              fill: .solid(.white),
                              entryAnimation: .styled(.fade))
        timerStarts[element.id] = Date()
        addElement(element)
    }

    /// A camera PiP tile — the host small over a screen share, or a second
    /// angle. Tile in the lower-right, like an interview inset. `nil` device
    /// = the system default camera; the inspector picks a specific one after
    /// placing it, so adding an overlay is a single click.
    func addCameraElement(deviceUniqueID: String? = nil, name: String? = nil) {
        addElement(Element(name: name ?? "Camera",
                           kind: .source(.camera(deviceUniqueID: CameraID(uid: deviceUniqueID))),
                           transform: ElementTransform(center: CGPoint(x: 0.82, y: 0.76),
                                                       size: CGSize(width: 0.28, height: 0.28)),
                           entryAnimation: .styled(.fade)))
    }

    /// A guest tile as a freely placeable element (beyond the interview grid).
    func addGuestElement(identity: String, name: String) {
        addElement(Element(name: name,
                           kind: .source(.guest(identity: identity)),
                           transform: ElementTransform(center: CGPoint(x: 0.82, y: 0.76),
                                                       size: CGSize(width: 0.28, height: 0.28)),
                           entryAnimation: .styled(.fade)))
    }

    /// A guest's shared screen as a placeable element. Starts large and
    /// centered — a screen is content, not a face in a corner — and renders
    /// letterboxed (RenderPlan gives `.guestScreen` bindings `.fit`).
    func addGuestScreenElement(identity: String, name: String) {
        addElement(Element(name: "\(name)'s Screen",
                           kind: .source(.guestScreen(identity: identity)),
                           transform: ElementTransform(center: CGPoint(x: 0.5, y: 0.44),
                                                       size: CGSize(width: 0.78, height: 0.78)),
                           entryAnimation: .styled(.fade)))
    }

    /// Element transform matching the media's real pixels: 1:1 with canvas
    /// pixels when it fits, scaled down at its own aspect when it doesn't.
    private func mediaTransform(forPixelSize pixelSize: CGSize?) -> ElementTransform {
        guard let pixelSize, pixelSize.width > 0, pixelSize.height > 0 else {
            return ElementTransform()
        }
        let canvas = project.canvasSize
        let scale = min(1, canvas.width / pixelSize.width, canvas.height / pixelSize.height)
        return ElementTransform(center: CGPoint(x: 0.5, y: 0.5),
                                size: CGSize(width: pixelSize.width * scale / canvas.width,
                                             height: pixelSize.height * scale / canvas.height))
    }

    private static func imagePixelSize(url: URL) -> CGSize? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Double,
              let height = properties[kCGImagePropertyPixelHeight] as? Double else { return nil }
        // EXIF orientations 5-8 are 90°-rotated; the displayed shape swaps.
        let orientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
        return orientation >= 5 ? CGSize(width: height, height: width)
                                : CGSize(width: width, height: height)
    }

    private static func videoPixelSize(url: URL) async -> CGSize? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (size, transform) = try? await track.load(.naturalSize, .preferredTransform)
        else { return nil }
        let rect = CGRect(origin: .zero, size: size).applying(transform)
        return CGSize(width: abs(rect.width), height: abs(rect.height))
    }
}
