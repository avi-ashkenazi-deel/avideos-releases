import Foundation
import CoreImage
import AppKit

/// Builds guest invite links and QR codes. The link format is defined by the
/// worker: {PAGES_ORIGIN}/?room=SESSIONID&api=WORKER_ORIGIN — the worker's
/// create-session response returns it ready-made; this type only decorates.
enum InviteLinkBuilder {
    static func qrCode(for url: URL, sidePx: CGFloat = 480) -> NSImage? {
        let data = url.absoluteString.data(using: .utf8)
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }

        let scale = sidePx / output.extent.width
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    static func copyToClipboard(_ url: URL) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }
}
