import Foundation
import AVFoundation
import AppKit
import os

/// The audio facade: everything the UI and StudioController touch. Owns the
/// three engines (mic capture, mix hub, virtual-device feeders), the sound
/// library, ducker, insert chains, driver install, and persistence.
@MainActor
@Observable
final class AudioEngineController {
    // Names the UI references as nested types.
    typealias StripID = MixerStripID
    typealias AudioUnitComponentInfo = AudioUnitHost.ComponentInfo
    // Module-qualified: a bare `typealias InsertEffect = InsertEffect` would
    // be a circular reference inside this scope. (Module name = target name
    // in project.yml.)
    typealias InsertEffect = AVideosStudio.InsertEffect

    // MARK: - Subcomponents

    let deviceManager = AudioDeviceManager()
    let graph = AudioGraph()
    let micCapture: MicCapture
    let auHost = AudioUnitHost()
    private let ducker = SidechainDucker()
    private let settingsStore = AudioSettingsStore()
    private var settings: AudioSettings

    private(set) var padPlayer: SoundPadPlayer?
    private(set) var musicPlayer: MusicPlayer?
    private var micFeeder: VirtualDeviceFeeder?
    private var guestSendFeeder: VirtualDeviceFeeder?
    private var movieTap: MovieAudioTap?
    private var driverInstaller: DriverInstaller?

    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "audio")

    // MARK: - Observable state (UI-facing)

    private(set) var strips: [StripID] = [.mic, .pads, .music, .movie]
    private(set) var pads: [SoundPad] = []
    private(set) var padProgress: [UUID: Double] = [:]
    private(set) var playlist: [MusicTrack] = []
    private(set) var currentTrackID: UUID?
    private(set) var isPlayingMusic = false
    private(set) var musicPosition: Double = 0
    private(set) var musicDuration: Double = 0
    var loopMode: LoopMode = .off {
        didSet {
            musicPlayer?.loopMode = loopMode
            settings.loopMode = loopMode
            persist()
        }
    }
    var duckerConfig = DuckerConfig() {
        didSet {
            ducker.config = duckerConfig
            settings.duckerConfig = duckerConfig
            persist()
        }
    }
    private(set) var driverStatus: DriverInstaller.Status = .notInstalled
    private(set) var insertChainsByStrip: [StripID: [InsertEffect]] = [:]

    var voiceProcessingEnabled: Bool {
        get { settings.voiceProcessingEnabled }
        set {
            settings.voiceProcessingEnabled = newValue
            micCapture.setVoiceProcessing(newValue)
            persist()
        }
    }
    var monitorDeviceUID: String? { settings.monitorDeviceUID }
    var micDeviceUID: String? { settings.micDeviceUID }

    // MARK: - Lifecycle

    init() {
        self.settings = settingsStore.load()
        self.micCapture = MicCapture(deviceManager: deviceManager)
    }

    func start() {
        graph.build(micRing: micCapture.ring)
        padPlayer = SoundPadPlayer(engine: graph.engine, padsMixer: graph.padsBus)
        musicPlayer = MusicPlayer(engine: graph.engine, musicMixer: graph.musicBus)
        movieTap = MovieAudioTap(ring: graph.movieRing)
        driverInstaller = DriverInstaller(deviceManager: deviceManager)

        // Apply persisted state.
        loopMode = settings.loopMode
        duckerConfig = settings.duckerConfig
        for strip in strips {
            let key = AudioSettings.key(for: strip)
            if let volume = settings.stripVolumes[key] {
                graph.strip(strip)?.userVolume = volume
            }
            if let muted = settings.stripMutes[key] {
                graph.strip(strip)?.isMuted = muted
            }
        }
        pads = settings.pads
        playlist = settings.playlist
        musicPlayer?.setPlaylist(playlist)

        do {
            try graph.start()
        } catch {
            log.error("Mix engine failed to start: \(error.localizedDescription)")
        }
        _ = deviceManager.setOutputDevice(uid: settings.monitorDeviceUID, on: graph.engine)
        micCapture.start(deviceUID: settings.micDeviceUID,
                         voiceProcessing: settings.voiceProcessingEnabled)

        // Decode pads, wire callbacks.
        for pad in pads {
            try? padPlayer?.load(pad: pad)
        }
        padPlayer?.onProgressChanged = { [weak self] in
            self?.padProgress = self?.padPlayer?.progress ?? [:]
        }
        musicPlayer?.onStateChanged = { [weak self] in
            self?.syncMusicState()
        }

        // Ducker wiring: trigger level from the trigger strip's meter.
        ducker.triggerLevel = { [weak self] in
            guard let self else { return 0 }
            if self.ducker.config.triggerStrip == .mic {
                return self.micCapture.levels.rms
            }
            return self.graph.strip(self.ducker.config.triggerStrip)?.readLevels().rms ?? 0
        }
        ducker.applyGain = { [weak self] gain, targets in
            guard let self else { return }
            for target in targets {
                self.graph.strip(target)?.duckGain = gain
            }
            // Non-target strips recover.
            for (id, strip) in self.graph.strips where !targets.contains(id) {
                if strip.duckGain != 1 { strip.duckGain = 1 }
            }
        }
        ducker.start()

        // Restore insert chains.
        Task { await restoreInsertChains() }

        // Virtual-device feeders come up when the driver's devices exist.
        micFeeder = VirtualDeviceFeeder(deviceUID: DriverInstaller.microphoneUID,
                                        ring: graph.programRing,
                                        deviceManager: deviceManager)
        guestSendFeeder = VirtualDeviceFeeder(deviceUID: DriverInstaller.guestSendUID,
                                              ring: graph.mixMinusRing,
                                              deviceManager: deviceManager)
        micFeeder?.startIfAvailable()
        guestSendFeeder?.startIfAvailable()
        deviceManager.onDevicesChanged = { [weak self] in
            self?.micFeeder?.reconcile()
            self?.guestSendFeeder?.reconcile()
            self?.refreshDriverStatus()
        }
        refreshDriverStatus()
    }

    func shutdown() {
        ducker.stop()
        micCapture.stop()
        micFeeder?.stop()
        guestSendFeeder?.stop()
        graph.stop()
        persist(immediately: true)
    }

    // MARK: - Strips

    func displayName(for strip: StripID) -> String { strip.displayName }

    func volume(for strip: StripID) -> Float {
        graph.strip(strip)?.userVolume ?? 1
    }

    func setVolume(_ volume: Float, for strip: StripID) {
        graph.strip(strip)?.userVolume = volume
        settings.stripVolumes[AudioSettings.key(for: strip)] = volume
        persist()
    }

    func isMuted(_ strip: StripID) -> Bool {
        graph.strip(strip)?.isMuted ?? false
    }

    func setMuted(_ muted: Bool, for strip: StripID) {
        graph.strip(strip)?.isMuted = muted
        settings.stripMutes[AudioSettings.key(for: strip)] = muted
        persist()
    }

    func levels(for strip: StripID) -> AudioLevels {
        if strip == .mic {
            return micCapture.levels
        }
        return graph.strip(strip)?.readLevels() ?? AudioLevels()
    }

    // MARK: - Guests

    func attachGuest(identity: String) -> RingBuffer {
        let ring = graph.addGuestStrip(identity: identity)
        strips = ([.mic, .pads, .music, .movie] + graph.strips.keys.filter {
            if case .guest = $0 { return true } else { return false }
        }).sorted()
        return ring
    }

    func detachGuest(identity: String) {
        graph.removeGuestStrip(identity: identity)
        strips.removeAll { $0 == .guest(identity) }
    }

    // MARK: - Sound pads

    func playPad(_ pad: SoundPad) {
        padPlayer?.play(pad)
    }

    func addPad(fileURL: URL) {
        var pad = SoundPad(url: fileURL)
        pad.hotkeyIndex = pads.count < 9 ? pads.count + 1 : nil
        do {
            try padPlayer?.load(pad: pad)
            pads.append(pad)
            settings.pads = pads
            persist()
        } catch {
            log.error("Couldn't load pad: \(error.localizedDescription)")
        }
    }

    func removePad(id: UUID) {
        padPlayer?.unload(padID: id)
        pads.removeAll { $0.id == id }
        settings.pads = pads
        persist()
    }

    func renamePad(id: UUID, to name: String) {
        guard let index = pads.firstIndex(where: { $0.id == id }) else { return }
        pads[index].name = name
        settings.pads = pads
        persist()
    }

    /// Global hotkey entry (⌥1…⌥9 registered by the UI layer).
    func playPad(hotkeyIndex: Int) {
        guard let pad = pads.first(where: { $0.hotkeyIndex == hotkeyIndex }) else { return }
        playPad(pad)
    }

    // MARK: - Music

    func musicPlayPause() { musicPlayer?.playPause() }
    func musicNext() { musicPlayer?.next() }
    func musicPrevious() { musicPlayer?.previous() }
    func musicSeek(to seconds: Double) { musicPlayer?.seek(to: seconds) }
    func playTrack(id: UUID) {
        guard let track = playlist.first(where: { $0.id == id }) else { return }
        musicPlayer?.play(track: track)
    }

    func addSongs(urls: [URL]) {
        musicPlayer?.add(urls: urls)
        syncMusicState()
        settings.playlist = playlist
        persist()
    }

    func removeSong(id: UUID) {
        musicPlayer?.remove(id: id)
        syncMusicState()
        settings.playlist = playlist
        persist()
    }

    func moveSong(from offsets: IndexSet, to destination: Int) {
        musicPlayer?.move(from: offsets, to: destination)
        syncMusicState()
        settings.playlist = playlist
        persist()
    }

    private func syncMusicState() {
        guard let player = musicPlayer else { return }
        playlist = player.playlist
        currentTrackID = player.currentTrackID
        isPlayingMusic = player.isPlaying
        musicPosition = player.position
        musicDuration = player.duration
    }

    // MARK: - Inserts

    func insertChain(for strip: StripID) -> [InsertEffect] {
        insertChainsByStrip[strip] ?? []
    }

    func addInsert(kind: InsertEffect.Kind, to strip: StripID) {
        Task {
            do {
                let node = try await auHost.instantiate(kind: kind)
                let effect = InsertEffect(kind: kind)
                graph.strip(strip)?.inserts?.add(effect, node: node)
                syncInsertState(for: strip)
            } catch {
                log.error("Couldn't add insert: \(error.localizedDescription)")
            }
        }
    }

    func addThirdPartyInsert(component: AudioUnitComponentInfo, to strip: StripID) {
        addInsert(kind: .thirdParty(componentType: component.componentType,
                                    subType: component.subType,
                                    manufacturer: component.manufacturer,
                                    name: component.name),
                  to: strip)
    }

    func removeInsert(id: UUID, from strip: StripID) {
        auHost.closePluginUI(insertID: id)
        graph.strip(strip)?.inserts?.remove(id: id)
        syncInsertState(for: strip)
    }

    func setBypassed(_ bypassed: Bool, insertID: UUID, strip: StripID) {
        graph.strip(strip)?.inserts?.setBypassed(bypassed, id: insertID)
        syncInsertState(for: strip)
    }

    func setMacro(_ amount: Double, insertID: UUID, strip: StripID) {
        graph.strip(strip)?.inserts?.setMacro(amount, id: insertID)
        syncInsertState(for: strip)
    }

    func showPluginUI(insertID: UUID, strip: StripID) {
        guard let chain = graph.strip(strip)?.inserts,
              let node = chain.node(for: insertID),
              let effect = chain.effects.first(where: { $0.id == insertID }) else { return }
        auHost.showPluginUI(for: node, insertID: insertID, title: effect.displayName)
    }

    func availableThirdPartyEffects() -> [AudioUnitComponentInfo] {
        auHost.availableThirdPartyEffects()
    }

    private func syncInsertState(for strip: StripID) {
        let effects = graph.strip(strip)?.inserts?.capturedEffects() ?? []
        insertChainsByStrip[strip] = effects
        settings.insertChains[AudioSettings.key(for: strip)] = effects
        persist()
    }

    private func restoreInsertChains() async {
        for strip in strips {
            let key = AudioSettings.key(for: strip)
            guard let saved = settings.insertChains[key], !saved.isEmpty,
                  let chain = graph.strip(strip)?.inserts else { continue }
            var instantiated: [UUID: AVAudioUnit] = [:]
            for effect in saved {
                if let node = try? await auHost.instantiate(kind: effect.kind) {
                    auHost.restoreState(effect.fullStateData, on: node)
                    instantiated[effect.id] = node
                }
            }
            chain.setEffects(saved.filter { instantiated[$0.id] != nil }, instantiated: instantiated)
            insertChainsByStrip[strip] = chain.effects
        }
    }

    // MARK: - Devices

    var outputDevices: [(uid: String, name: String)] {
        deviceManager.outputDevices().map { ($0.uid, $0.name) }
    }

    var inputDevices: [(uid: String, name: String)] {
        deviceManager.inputDevices()
            .filter { $0.uid != DriverInstaller.microphoneUID && $0.uid != DriverInstaller.guestSendUID }
            .map { ($0.uid, $0.name) }
    }

    func setMonitorDevice(uid: String?) {
        settings.monitorDeviceUID = uid
        _ = deviceManager.setOutputDevice(uid: uid, on: graph.engine)
        persist()
    }

    func setMicDevice(uid: String?) {
        settings.micDeviceUID = uid
        micCapture.setDevice(uid: uid)
        persist()
    }

    // MARK: - Movie audio

    func attachMoviePlayer(_ player: AVPlayer) {
        movieTap?.attach(to: player)
    }

    func detachMoviePlayer() {
        movieTap?.detach()
    }

    // MARK: - Recording

    func startRecordingSink(recorder: ProgramRecorder) {
        graph.recordingSink.attach(recorder: recorder)
    }

    func stopRecordingSink() {
        graph.recordingSink.detach()
    }

    // MARK: - Driver

    func refreshDriverStatus() {
        driverStatus = driverInstaller?.status() ?? .notInstalled
    }

    func installDriver() async {
        guard let installer = driverInstaller else { return }
        driverStatus = await installer.install()
        micFeeder?.reconcile()
        guestSendFeeder?.reconcile()
    }

    func uninstallDriver() async {
        guard let installer = driverInstaller else { return }
        driverStatus = await installer.uninstall()
        micFeeder?.reconcile()
        guestSendFeeder?.reconcile()
    }

    // MARK: - Persistence

    private func persist(immediately: Bool = false) {
        settingsStore.saveDebounced(settings, delay: immediately ? 0 : 0.5)
    }
}
