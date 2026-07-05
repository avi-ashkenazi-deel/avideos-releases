import SwiftUI
import WebKit

/// A custom in-app browser modelled on X/Twitter's: the web page fills the sheet
/// and a floating rounded toolbar sits near the bottom (close, back, a centered
/// domain pill with a share/copy/open menu, and refresh), with a slim load-
/// progress line up top. Presented as a bottom sheet (drag down to dismiss, drag
/// to the half-height detent to keep it around while you glance at the reader).
struct InAppBrowserView: View {
    @StateObject private var model: BrowserModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    private let startURL: URL

    init(url: URL) {
        self.startURL = url
        _model = StateObject(wrappedValue: BrowserModel(url: url))
    }

    var body: some View {
        WebViewContainer(webView: model.webView)
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .top) { progressLine }
            .overlay(alignment: .bottom) { toolbar }
    }

    // MARK: - Progress

    @ViewBuilder
    private var progressLine: some View {
        if model.isLoading && model.progress < 1 {
            GeometryReader { geo in
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: geo.size.width * model.progress, height: 2.5)
                    .animation(.easeInOut(duration: 0.2), value: model.progress)
            }
            .frame(height: 2.5)
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 12) {
            circleButton("xmark") { dismiss() }
            circleButton("chevron.left") { model.goBack() }
                .disabled(!model.canGoBack)
                .opacity(model.canGoBack ? 1 : 0.35)

            Spacer(minLength: 8)

            Menu {
                Button {
                    openURL(model.currentURL ?? startURL)
                } label: { Label("Open in Safari", systemImage: "safari") }
                Button {
                    UIPasteboard.general.url = model.currentURL ?? startURL
                } label: { Label("Copy Link", systemImage: "doc.on.doc") }
                ShareLink(item: model.currentURL ?? startURL) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
            } label: {
                HStack(spacing: 6) {
                    Text(model.host)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Image(systemName: "ellipsis")
                        .font(.caption.weight(.bold))
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Capsule().fill(.regularMaterial))
            }

            Spacer(minLength: 8)

            circleButton("arrow.clockwise") { model.reload() }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    private func circleButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .background(Circle().fill(.regularMaterial))
        }
    }
}

/// Holds the `WKWebView` and mirrors the bits the toolbar needs (can-go-back,
/// load progress, current host) via KVO. Plain `ObservableObject` — WKWebView KVO
/// is delivered on the main thread, so the published updates land on main.
final class BrowserModel: ObservableObject {
    @Published var canGoBack = false
    @Published var progress: Double = 0
    @Published var isLoading = false
    @Published var host: String

    let webView: WKWebView
    private var observers: [NSKeyValueObservation] = []

    var currentURL: URL? { webView.url }

    init(url: URL) {
        host = url.host ?? url.absoluteString
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true

        observers.append(webView.observe(\.canGoBack, options: [.new]) { [weak self] wv, _ in
            self?.canGoBack = wv.canGoBack
        })
        observers.append(webView.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
            self?.progress = wv.estimatedProgress
        })
        observers.append(webView.observe(\.isLoading, options: [.new]) { [weak self] wv, _ in
            self?.isLoading = wv.isLoading
        })
        observers.append(webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
            if let host = wv.url?.host { self?.host = host }
        })

        webView.load(URLRequest(url: url))
    }

    func goBack() { webView.goBack() }
    func reload() { webView.reload() }
}

/// Hosts the model's `WKWebView` in SwiftUI.
private struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
