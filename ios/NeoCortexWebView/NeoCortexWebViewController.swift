import UIKit
import WebKit

/// NeoCortex kamera webview'ini barındıran ekran.
///
/// Kullanım:
///   let vc = NeoCortexWebViewController(url: NeoCortexConfig.webURL)
///   vc.onResult = { result in /* result.imageURL, result.videoURL */ }
///   present(vc, animated: true)
///
/// Gerekli Info.plist anahtarı: NSCameraUsageDescription
/// Not: getUserMedia güvenli bağlam ister — sayfayı HTTPS üzerinden yükle.
public enum NeoCortexConfig {
    public static var webURL = URL(string: "https://example.com/neocortex/index.html")!
}

public struct NeoCortexResult {
    public let imageURL: URL?
    public let videoURL: URL?
    public let clipCount: Int
}

public final class NeoCortexWebViewController: UIViewController {
    public var onResult: ((NeoCortexResult) -> Void)?
    public var onClose: (() -> Void)?

    private let startURL: URL
    private var webView: WKWebView!
    private let receiver = FileReceiver()

    public init(url: URL, title: String? = nil, hint: String? = nil) {
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var items = comps.queryItems ?? []
        if let title { items.append(URLQueryItem(name: "title", value: title)) }
        if let hint { items.append(URLQueryItem(name: "hint", value: hint)) }
        comps.queryItems = items.isEmpty ? nil : items
        self.startURL = comps.url!
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) kullanılmıyor") }

    public override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }
    public override var prefersStatusBarHidden: Bool { true }

    public override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true          // video tam ekrana atlamasın
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(WeakScriptHandler(self), name: "neocortex")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .black
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        view = webView
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: startURL))
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "neocortex")
    }

    /// Native → Web
    public func reset() { webView.evaluateJavaScript("window.NeoCortex && window.NeoCortex.reset()") }

    fileprivate func handle(_ body: [String: Any]) {
        guard let type = body["type"] as? String else { return }
        switch type {
        case "file.begin", "file.chunk", "file.end":
            receiver.handle(type: type, body: body)
        case "result.complete":
            let imageURL = (body["imageId"] as? String).flatMap { receiver.fileURL(for: $0) }
            let videoURL = (body["videoId"] as? String).flatMap { receiver.fileURL(for: $0) }
            let clips = body["clips"] as? Int ?? 0
            onResult?(NeoCortexResult(imageURL: imageURL, videoURL: videoURL, clipCount: clips))
        case "close":
            if let onClose { onClose() } else { dismiss(animated: true) }
        default:
            break
        }
    }
}

// MARK: - Kamera izni (iOS 15+): sayfa için ikinci izin penceresini atla, yalnız kendi alanımıza ver.
extension NeoCortexWebViewController: WKUIDelegate, WKNavigationDelegate {
    @available(iOS 15.0, *)
    public func webView(_ webView: WKWebView,
                        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                        initiatedByFrame frame: WKFrameInfo,
                        type: WKMediaCaptureType,
                        decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let trusted = origin.host == startURL.host && origin.protocol == startURL.scheme
        decisionHandler(trusted && type == .camera ? .grant : .deny)
    }
}

extension NeoCortexWebViewController: WKScriptMessageHandler {
    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == startURL.host,
              let body = message.body as? [String: Any] else { return }
        handle(body)
    }
}

/// WKUserContentController handler'ı güçlü tutar; döngüyü kırmak için zayıf sarmalayıcı.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// Parça parça gelen base64 dosyaları diske yazar.
final class FileReceiver {
    private struct Pending { let url: URL; let handle: FileHandle; let total: Int; var next: Int }
    private var pending: [String: Pending] = [:]
    private var finished: [String: URL] = [:]
    private let dir: URL = {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("NeoCortex", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    func fileURL(for id: String) -> URL? { finished[id] }

    func handle(type: String, body: [String: Any]) {
        guard let id = body["id"] as? String else { return }
        switch type {
        case "file.begin":
            let mime = body["mimeType"] as? String ?? ""
            let ext = mime.contains("mp4") ? "mp4" : mime.contains("webm") ? "webm" : mime.contains("jpeg") ? "jpg" : "bin"
            let url = dir.appendingPathComponent("\(id).\(ext)")
            FileManager.default.createFile(atPath: url.path, contents: nil)
            guard let h = try? FileHandle(forWritingTo: url) else { return }
            pending[id] = Pending(url: url, handle: h, total: body["chunks"] as? Int ?? 0, next: 0)
        case "file.chunk":
            guard var p = pending[id],
                  let index = body["index"] as? Int, index == p.next,
                  let b64 = body["data"] as? String,
                  let data = Data(base64Encoded: b64) else { return }
            p.handle.write(data)
            p.next += 1
            pending[id] = p
        case "file.end":
            guard let p = pending.removeValue(forKey: id) else { return }
            try? p.handle.close()
            if p.next == p.total { finished[id] = p.url } else { try? FileManager.default.removeItem(at: p.url) }
        default:
            break
        }
    }
}
