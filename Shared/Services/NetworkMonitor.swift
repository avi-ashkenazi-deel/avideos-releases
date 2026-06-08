import Foundation
import Network

/// Lightweight connectivity flag. Used so the caching mail layer can serve cached
/// content *immediately* when offline, instead of waiting ~60s for a network
/// request to time out. It's a hint, not a guarantee — requests still fall back to
/// the cache if they fail while `isOnline` is optimistically true.
final class NetworkMonitor: @unchecked Sendable {
    static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.voiceinbox.network-monitor")
    private let lock = NSLock()
    private var _isOnline = true

    var isOnline: Bool {
        lock.lock(); defer { lock.unlock() }
        return _isOnline
    }

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            self._isOnline = path.status == .satisfied
            self.lock.unlock()
        }
        monitor.start(queue: queue)
    }
}
