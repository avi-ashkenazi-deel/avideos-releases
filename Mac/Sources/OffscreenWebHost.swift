import Foundation
import WebKit
import AppKit
import CoreVideo
import CoreMedia
import Metal
import os

/// Hosts a WKWebView in a borderless window positioned far offscreen and
/// snapshots it on a timer. WKWebView must live in a window the window
/// server considers displayable or its render pipeline throttles/never draws.
///
/// Honest limitations (documented in-product): ~10–15fps ceiling, no page
/// audio capture, some <video>/WebGL content may snapshot black. Built for
/// lower-thirds, alerts, and countdowns — not full-motion embeds.
@MainActor
final class OffscreenWebHost: NSObject, WKNavigationDelegate {
    private let window: NSWindow
    private let webView: WKWebView
    private var timer: Timer?
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "web")

    /// Called on the main thread with each fresh snapshot.
    var onSnapshot: ((CGImage) -> Void)?
    private(set) var lastError: String?

    init(pageSize: CGSize) {
        let config = WKWebViewConfiguration()
        // Overlay pages should render with transparency and never play sound.
        config.mediaTypesRequiringUserActionForPlayback = .all

        webView = WKWebView(frame: CGRect(origin: .zero, size: pageSize), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")   // long-stable SPI for alpha snapshots
        if #available(macOS 12.0, *) {
            webView.underPageBackgroundColor = .clear
        }

        window = NSWindow(contentRect: CGRect(origin: CGPoint(x: -16000, y: -16000), size: pageSize),
                          styleMask: [.borderless],
                          backing: .buffered,
                          defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.backgroundColor = .clear
        window.isOpaque = false
        // Never let the offscreen window leak into screen shares either.
        window.sharingType = .none

        super.init()
        webView.navigationDelegate = self
        window.orderBack(nil)
    }

    func load(url: URL) {
        lastError = nil
        webView.load(URLRequest(url: url))
    }

    /// The element's bounding box IS the browser viewport: resizing the box
    /// resizes the page, and it relayouts like any browser window. Deferred
    /// while the interactive window is open (the user drives that size).
    private var pendingSize: CGSize?

    func setPageSize(_ size: CGSize) {
        guard size.width >= 50, size.height >= 50 else { return }
        guard abs(webView.frame.width - size.width) > 1
                || abs(webView.frame.height - size.height) > 1 else { return }
        if interactiveWindow != nil {
            pendingSize = size
            return
        }
        window.setContentSize(size)
        webView.frame = CGRect(origin: .zero, size: size)
    }

    func startSnapshots(fps: Int) {
        stopSnapshots()
        let interval = 1.0 / Double(max(1, min(fps, 15)))
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.takeSnapshot()
            }
        }
    }

    func stopSnapshots() {
        timer?.invalidate()
        timer = nil
    }

    private func takeSnapshot() {
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        webView.takeSnapshot(with: config) { [weak self] image, error in
            guard let self else { return }
            if let error {
                self.lastError = error.localizedDescription
                return
            }
            guard let image,
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            self.onSnapshot?(cg)
        }
    }

    // MARK: - Interactive mode

    /// It IS a browser — this puts the live WKWebView in a normal floating
    /// window so the host can click, scroll, and log in. Closing the window
    /// hands the view back to the offscreen host; snapshots keep flowing to
    /// the canvas the whole time (the view is always in *a* window).
    private var interactiveWindow: NSWindow?

    func openInteractiveWindow(title: String) {
        if let interactiveWindow {
            interactiveWindow.makeKeyAndOrderFront(nil)
            return
        }
        let win = NSWindow(contentRect: CGRect(origin: .zero, size: webView.frame.size),
                           styleMask: [.titled, .closable, .resizable],
                           backing: .buffered,
                           defer: false)
        win.title = title
        win.isReleasedWhenClosed = false
        win.level = .floating
        win.sharingType = .none
        webView.autoresizingMask = [.width, .height]
        win.contentView = webView
        win.center()
        win.makeKeyAndOrderFront(nil)
        interactiveWindow = win
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(interactiveWindowWillClose(_:)),
                                               name: NSWindow.willCloseNotification,
                                               object: win)
    }

    @objc private func interactiveWindowWillClose(_ note: Notification) {
        guard let win = interactiveWindow else { return }
        NotificationCenter.default.removeObserver(self, name: NSWindow.willCloseNotification, object: win)
        interactiveWindow = nil
        // Back to the offscreen window, adopting any resize the canvas
        // requested while the interactive window had the view.
        if let pendingSize {
            window.setContentSize(pendingSize)
            self.pendingSize = nil
        }
        webView.frame = CGRect(origin: .zero, size: window.frame.size)
        window.contentView = webView
    }

    func teardown() {
        stopSnapshots()
        webView.stopLoading()
        interactiveWindow?.close()
        window.close()
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        lastError = error.localizedDescription
        log.error("Web overlay navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        lastError = error.localizedDescription
    }
}
