import Foundation

#if canImport(Vision) && os(iOS)
import Vision
import UIKit

/// Produces a short spoken description of an email image using Apple's on-device
/// Vision classifier. It still needs to *download* the image (so it requires a
/// connection for remote images), but the classification itself is offline and
/// free. Returns nil when there's nothing usable, so the player can fall back to
/// the image's alt text / "there's an image here".
@MainActor
final class ImageDescriber {

    private var cache: [String: String] = [:]

    func describe(_ image: InlineImage) async -> String? {
        guard let url = image.remoteURL else { return nil }
        let key = url.absoluteString
        if let cached = cache[key] { return cached }

        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let cgImage = UIImage(data: data)?.cgImage else {
            return nil
        }
        let labels = await classify(cgImage)
        guard !labels.isEmpty else { return nil }

        let phrase = "Image of \(Self.naturalList(labels))."
        cache[key] = phrase
        return phrase
    }

    private func classify(_ cgImage: CGImage) async -> [String] {
        await withCheckedContinuation { (cont: CheckedContinuation<[String], Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let request = VNClassifyImageRequest()
                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                try? handler.perform([request])
                let labels = (request.results ?? [])
                    .filter { $0.confidence > 0.6 }
                    .prefix(3)
                    .map { $0.identifier.replacingOccurrences(of: "_", with: " ") }
                cont.resume(returning: Array(labels))
            }
        }
    }

    /// ["beach","ocean","sky"] -> "beach, ocean and sky".
    private static func naturalList(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        default: return items.dropLast().joined(separator: ", ") + " and " + items.last!
        }
    }
}

#else

@MainActor
final class ImageDescriber {
    func describe(_ image: InlineImage) async -> String? { nil }
}

#endif
