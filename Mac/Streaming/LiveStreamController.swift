import Foundation
import CoreGraphics
import Observation
import os

/// What a connected-account destination resolves to at go-live: the ingest
/// to publish to, plus the chat to read. (YouTube account mode creates the
/// broadcast through the API and returns these.)
struct PreparedBroadcast: Sendable {
    var serverURL: String
    var streamKey: String
    var liveChatID: String?
    var watchURL: URL?
}

/// Owns going live: the destination list, the shared encoders, one RTMP
/// publisher per live destination, and their status for the UI.
///
/// Encoders are created per (orientation, quality tier) actually in use and
/// shared by every destination on that pair; they're torn down as soon as
/// nothing subscribes to them.
@MainActor
@Observable
final class LiveStreamController {
    struct EncoderKey: Hashable {
        var orientation: StreamOrientation
        var tier: StreamQualityTier
    }

    // MARK: Observable state

    private(set) var destinations: [StreamDestination]
    private(set) var isLive = false
    private(set) var startedAt: Date?
    private(set) var states: [UUID: RTMPPublisher.State] = [:]
    private(set) var stats: [UUID: RTMPPublisher.Stats] = [:]
    /// Last go-live problem per destination (missing key, API error…).
    private(set) var problems: [UUID: String] = [:]
    /// Viewer links the platforms handed back (YouTube account mode).
    private(set) var watchURLs: [UUID: URL] = [:]

    var liveDestinationIDs: Set<UUID> { Set(publishers.keys) }

    /// Sum of every live destination's outgoing kbps.
    var totalKilobitsPerSecond: Int {
        stats.filter { publishers[$0.key] != nil }.values.reduce(0) { $0 + $1.kilobitsPerSecond }
    }

    /// True if any live destination is struggling.
    var hasProblem: Bool {
        states.values.contains {
            if case .reconnecting = $0 { return true }
            if case .failed = $0 { return true }
            return false
        }
    }

    var needsVerticalCanvas: Bool {
        publishers.keys.contains { id in
            destinations.first { $0.id == id }?.orientation == .vertical
        }
    }

    // MARK: Wiring (set by StudioController)

    /// The engine rendering a canvas; the vertical one is created on demand.
    var engineProvider: ((StreamOrientation) -> RenderEngine?)?
    var canvasSizeProvider: ((StreamOrientation) -> CGSize)?
    var frameRateProvider: (() -> Int)?
    weak var audio: AudioEngineController?
    /// YouTube account mode (see `YouTubeLiveService`).
    var broadcastPreparer: ((StreamDestination) async throws -> PreparedBroadcast)?
    /// Comments wiring: a destination went live (with the chat id, if any) or stopped.
    var onDestinationLive: ((StreamDestination, String?) -> Void)?
    var onDestinationStopped: ((UUID) -> Void)?
    /// Live state flipped (the studio releases the vertical engine).
    var onLiveChanged: ((Bool) -> Void)?

    // MARK: Private

    private let store = StreamDestinationStore()
    private var audioEncoder: AACStreamEncoder?
    private var audioConsumerID: UUID?
    private var encoders: [EncoderKey: VideoStreamEncoder] = [:]
    private var encoderEngines: [EncoderKey: RenderEngine] = [:]
    private var publishers: [UUID: RTMPPublisher] = [:]
    private let log = Logger(subsystem: "com.aviashkenazi.streamit", category: "live")

    init() {
        destinations = store.load()
    }

    // MARK: - Destination editing

    func add(_ destination: StreamDestination) {
        destinations.append(destination)
        store.save(destinations)
    }

    func update(_ destination: StreamDestination) {
        guard let index = destinations.firstIndex(where: { $0.id == destination.id }) else { return }
        destinations[index] = destination
        store.save(destinations)
    }

    func remove(id: UUID) {
        guard publishers[id] == nil else { return }   // can't delete while it's on air
        destinations.first { $0.id == id }?.deleteStreamKey()
        destinations.removeAll { $0.id == id }
        store.save(destinations)
    }

    func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        destinations.move(fromOffsets: source, toOffset: destination)
        store.save(destinations)
    }

    /// Upload the given selection needs, in Mbps (video tiers + audio,
    /// plus ~10% RTMP/TCP overhead).
    func estimatedUploadMbps(for ids: Set<UUID>) -> Double {
        let bits = destinations
            .filter { ids.contains($0.id) }
            .reduce(0) { $0 + $1.tier.bitsPerSecond + 160_000 }
        return Double(bits) * 1.1 / 1_000_000
    }

    // MARK: - Going live

    /// Starts every given destination. Destinations that can't start get a
    /// `problems` entry; the rest go ahead.
    func goLive(destinationIDs: Set<UUID>) async {
        guard !destinationIDs.isEmpty else { return }
        if !isLive {
            isLive = true
            startedAt = Date()
            onLiveChanged?(true)
        }
        for id in destinationIDs {
            await startDestination(id: id)
        }
        if publishers.isEmpty { endLive() }
    }

    /// Adds one destination to the running show (or starts the show).
    func startDestination(id: UUID) async {
        guard publishers[id] == nil,
              let destination = destinations.first(where: { $0.id == id }) else { return }
        problems[id] = nil

        // Resolve the ingest.
        var server = destination.serverURL
        var key = destination.streamKey ?? ""
        var liveChatID: String?
        if destination.linkedYouTube {
            guard let broadcastPreparer else {
                problems[id] = "Connect your YouTube account in Settings → Streaming."
                return
            }
            states[id] = .connecting
            do {
                let prepared = try await broadcastPreparer(destination)
                server = prepared.serverURL
                key = prepared.streamKey
                liveChatID = prepared.liveChatID
                watchURLs[id] = prepared.watchURL
            } catch {
                states[id] = .failed(error.localizedDescription)
                problems[id] = error.localizedDescription
                return
            }
        } else if let problem = destination.configurationProblem {
            problems[id] = problem
            return
        }

        let url: StreamURL
        do {
            url = try StreamURL.parse(server: server, key: key)
        } catch {
            problems[id] = "The server URL or stream key isn't valid."
            return
        }

        guard let audioEncoder = ensureAudioEncoder(),
              let videoEncoder = ensureVideoEncoder(for: EncoderKey(orientation: destination.orientation,
                                                                     tier: destination.tier)) else {
            problems[id] = "Couldn't start the encoder."
            return
        }

        if !isLive {
            isLive = true
            startedAt = Date()
            onLiveChanged?(true)
        }

        let publisher = RTMPPublisher(url: url, video: videoEncoder, audio: audioEncoder)
        publisher.onStateChange = { [weak self] state in
            MainActor.assumeIsolated {
                self?.states[id] = state
            }
        }
        publisher.onStats = { [weak self] stats in
            MainActor.assumeIsolated {
                self?.stats[id] = stats
            }
        }
        publishers[id] = publisher
        states[id] = .connecting
        publisher.start()
        log.notice("Going live to \(destination.name, privacy: .public) at \(url.redactedDescription, privacy: .public)")
        onDestinationLive?(destination, liveChatID)
    }

    func stopDestination(id: UUID) {
        guard let publisher = publishers.removeValue(forKey: id) else { return }
        publisher.stop()
        states[id] = .stopped
        onDestinationStopped?(id)
        releaseUnusedEncoders()
        if publishers.isEmpty { endLive() }
    }

    /// Ends the show: every destination, every encoder.
    func endLive() {
        for (id, publisher) in publishers {
            publisher.stop()
            states[id] = .stopped
            onDestinationStopped?(id)
        }
        publishers.removeAll()
        releaseUnusedEncoders()
        if isLive {
            isLive = false
            startedAt = nil
            onLiveChanged?(false)
        }
    }

    // MARK: - Encoders

    private func ensureAudioEncoder() -> AACStreamEncoder? {
        if let audioEncoder { return audioEncoder }
        guard let encoder = AACStreamEncoder(), let audio else { return nil }
        audioConsumerID = audio.addProgramAudioConsumer { [weak encoder] buffer, time in
            encoder?.ingest(buffer: buffer, time: time)
        }
        audioEncoder = encoder
        return encoder
    }

    private func ensureVideoEncoder(for key: EncoderKey) -> VideoStreamEncoder? {
        if let existing = encoders[key] { return existing }
        guard let engine = engineProvider?(key.orientation),
              let canvas = canvasSizeProvider?(key.orientation),
              canvas.width > 0, canvas.height > 0 else { return nil }
        let size = key.tier.frameSize(canvasAspect: canvas.width / canvas.height)
        let settings = VideoStreamEncoder.Settings(width: size.width,
                                                   height: size.height,
                                                   framesPerSecond: frameRateProvider?() ?? 30,
                                                   bitsPerSecond: key.tier.bitsPerSecond)
        guard let encoder = VideoStreamEncoder(settings: settings) else { return nil }
        engine.addConsumer(encoder)
        encoders[key] = encoder
        encoderEngines[key] = engine
        return encoder
    }

    /// Drops encoders no live destination uses (and the audio encoder when
    /// nothing is live).
    private func releaseUnusedEncoders() {
        let inUse = Set(publishers.keys.compactMap { id -> EncoderKey? in
            guard let destination = destinations.first(where: { $0.id == id }) else { return nil }
            return EncoderKey(orientation: destination.orientation, tier: destination.tier)
        })
        for (key, encoder) in encoders where !inUse.contains(key) {
            encoderEngines[key]?.removeConsumer(encoder)
            encoder.invalidate()
            encoders.removeValue(forKey: key)
            encoderEngines.removeValue(forKey: key)
        }
        if publishers.isEmpty {
            if let audioConsumerID { audio?.removeProgramAudioConsumer(audioConsumerID) }
            audioConsumerID = nil
            audioEncoder = nil
        }
    }
}
