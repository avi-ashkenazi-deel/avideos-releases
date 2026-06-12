import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

/// Two-way link between the iPhone and Watch. Because the two apps run
/// *independent* timer engines, this only carries:
///   1. preset-library sync (so both sides show the same presets), and
///   2. an optional "start this preset now" command for cross-device starts.
///
/// Library sync uses `updateApplicationContext` (latest-wins, survives the other
/// device being offline); commands use `sendMessage` for immediacy when reachable.
@MainActor
final class ConnectivityBridge: NSObject, ObservableObject {

    @Published private(set) var isReachable = false

    /// A preset library arrived from the other device.
    var onPresetsReceived: (([TimerPreset]) -> Void)?
    /// The other device asked to start a preset by id.
    var onStartCommand: ((UUID) -> Void)?

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    #if canImport(WatchConnectivity)
    private var session: WCSession? {
        WCSession.isSupported() ? .default : nil
    }
    #endif

    func activate() {
        #if canImport(WatchConnectivity)
        guard let session else { return }
        session.delegate = self
        session.activate()
        #endif
    }

    // MARK: Sending

    func syncPresets(_ presets: [TimerPreset]) {
        #if canImport(WatchConnectivity)
        guard let session, session.activationState == .activated,
              let data = try? encoder.encode(presets) else { return }
        try? session.updateApplicationContext(["presets": data])
        #endif
    }

    func sendStart(presetID: UUID) {
        #if canImport(WatchConnectivity)
        guard let session, session.activationState == .activated else { return }
        let payload: [String: Any] = ["startPresetID": presetID.uuidString]
        if session.isReachable {
            session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        } else {
            try? session.updateApplicationContext(payload)
        }
        #endif
    }

    // MARK: Receiving

    private func handle(_ dict: [String: Any]) {
        if let data = dict["presets"] as? Data,
           let presets = try? decoder.decode([TimerPreset].self, from: data) {
            onPresetsReceived?(presets)
        }
        if let idString = dict["startPresetID"] as? String, let id = UUID(uuidString: idString) {
            onStartCommand?(id)
        }
    }
}

#if canImport(WatchConnectivity)
extension ConnectivityBridge: WCSessionDelegate {
    nonisolated func session(_ session: WCSession,
                             activationDidCompleteWith state: WCSessionActivationState,
                             error: Error?) {
        Task { @MainActor in self.isReachable = session.isReachable }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.isReachable = session.isReachable }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        Task { @MainActor in self.handle(message) }
    }

    nonisolated func session(_ session: WCSession,
                             didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.handle(applicationContext) }
    }

    #if os(iOS)
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate() // re-activate for the next paired watch
    }
    #endif
}
#endif
