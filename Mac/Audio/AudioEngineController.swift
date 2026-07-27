import Foundation
import Observation
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

    /// Which section is sounding, and which is waiting to take over.
    private(set) var playingSectionID: UUID?
    private(set) var queuedSectionID: UUID?
    /// Past this point the switch is in AVFoundation's hands and can no longer
    /// be cancelled — the UI stops offering to.
    private(set) var queuedSwitchIsCommitted = false
    private(set) var secondsUntilSwitch: Double?
    /// Live loop state, distinct from `MusicSection.loops`, which is the
    /// authored default. Mid-show you want to kill the loop and let the song
    /// run out *without* editing your sections.
    private(set) var isSectionLooping = false
    /// Last reason a section couldn't play. Set it to nil to dismiss.
    var sectionFailureMessage: String?

    var sectionSwitchMode: SectionSwitchMode = .atLoopEnd {
        didSet {
            musicPlayer?.switchMode = sectionSwitchMode
            settings.sectionSwitchMode = sectionSwitchMode
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
        sectionSwitchMode = settings.sectionSwitchMode ?? .atLoopEnd
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
        // verify on Mac: device pinning after engine.start() — if the HAL
        // rejects switching a running output unit, move this before
        // graph.start() (setMonitorDevice(uid:) mid-session may also need a
        // stop/start cycle).
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
        // A section that can't play says why rather than failing silently —
        // mid-show, a dead pad with no explanation is the worst outcome.
        musicPlayer?.onSectionFailure = { [weak self] reason in
            self?.sectionFailureMessage = reason
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

    /// Flips a strip's mute. Drives the mute hotkey and menu item, where the
    /// caller doesn't want to read the current state first.
    func toggleMute(for strip: StripID) {
        setMuted(!isMuted(strip), for: strip)
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
        // Change-guarded: assigning an unchanged value to an @Observable
        // property still invalidates every SwiftUI view reading it, and this
        // runs up to 15 times a second while a section loops.
        if playlist != player.playlist { playlist = player.playlist }
        if currentTrackID != player.currentTrackID { currentTrackID = player.currentTrackID }
        if isPlayingMusic != player.isPlaying { isPlayingMusic = player.isPlaying }
        if musicPosition != player.position { musicPosition = player.position }
        if musicDuration != player.duration { musicDuration = player.duration }

        if playingSectionID != player.playingSectionID { playingSectionID = player.playingSectionID }
        if isSectionLooping != player.isSectionLooping { isSectionLooping = player.isSectionLooping }
        let queued = player.pending.sectionID
        if queuedSectionID != queued { queuedSectionID = queued }
        if queuedSwitchIsCommitted != player.pending.isCommitted {
            queuedSwitchIsCommitted = player.pending.isCommitted
        }
        let countdown = queued == nil
            ? nil
            : player.framesToBoundary.map(MusicClock.seconds(fromFrames:))
        if secondsUntilSwitch != countdown { secondsUntilSwitch = countdown }
    }

    // MARK: - Music sections

    /// The track a section hotkey or pad acts on.
    ///
    /// Before anything has played, that's the first track in the playlist — so
    /// what the pad row shows is always what a hotkey fires, and hitting ⌃⌥1
    /// pre-show starts the set on the chorus.
    var sectionHostTrackID: UUID? { currentTrackID ?? playlist.first?.id }

    var sectionHostTrack: MusicTrack? {
        playlist.first { $0.id == sectionHostTrackID }
    }

    /// Sections of the host track, in play order.
    var musicSections: [MusicSection] { sectionHostTrack?.sortedSections ?? [] }

    // MARK: Firing sections

    /// Plays a section now or at the next loop boundary, per the sticky mode
    /// unless `mode` overrides it for this press — so a bound pad can mean
    /// "chorus, hard cut" without changing the global setting.
    func playSection(id: UUID, mode: SectionSwitchMode? = nil) {
        guard let track = sectionHostTrack,
              let section = track.section(withID: id) else { return }
        musicPlayer?.playSection(section, in: track, mode: mode)
        syncMusicState()
    }

    /// Fires the section bound to a hotkey slot. A slot with no binding does
    /// nothing at all — never stop the music, never start the wrong thing.
    func playSection(hotkeyIndex: Int, mode: SectionSwitchMode? = nil) {
        guard let track = sectionHostTrack,
              let section = track.section(forHotkeyIndex: hotkeyIndex) else { return }
        musicPlayer?.playSection(section, in: track, mode: mode)
        syncMusicState()
    }

    func queueSection(id: UUID) {
        playSection(id: id, mode: .atLoopEnd)
    }

    func cancelQueuedSection() {
        _ = musicPlayer?.cancelQueuedSection()
        syncMusicState()
    }

    func setSectionLoopEnabled(_ enabled: Bool) {
        musicPlayer?.setSectionLoopEnabled(enabled)
        syncMusicState()
    }

    func toggleSectionLoop() {
        setSectionLoopEnabled(!isSectionLooping)
    }

    func toggleSectionSwitchMode() {
        // Two-way toggle: crossfade is chosen deliberately from the picker, not
        // cycled into by accident mid-show.
        sectionSwitchMode = sectionSwitchMode == .hardCut ? .atLoopEnd : .hardCut
    }

    /// Starts a track from its saved start point without engaging any loop.
    func startFromSection(id: UUID) {
        playSection(id: id, mode: .hardCut)
        setSectionLoopEnabled(false)
    }

    /// Decodes every section of a track up front, so a live switch finds its
    /// buffer resident rather than waiting on the disk.
    func prepareSections(forTrackID trackID: UUID) {
        guard let track = playlist.first(where: { $0.id == trackID }),
              let url = track.resolve(),
              let player = musicPlayer else { return }
        let duration = track.id == currentTrackID && musicDuration > 0
            ? musicDuration
            : LoopRegion.maximumSeconds
        let ranges = MusicSection.resolvedRanges(track.sortedSections, duration: duration)
        for (sectionID, range) in ranges {
            player.regions.prepare(
                key: MusicRegionCache.Key(trackID: trackID, sectionID: sectionID),
                url: url,
                startSeconds: range.lowerBound,
                endSeconds: range.upperBound)
        }
    }

    // MARK: Authoring

    /// Whole-value replace — the only section writer, so the clamping and
    /// ordering rules live in exactly one place.
    func setSection(_ section: MusicSection, inTrackID trackID: UUID) {
        guard var track = playlist.first(where: { $0.id == trackID }) else { return }
        let duration = trackDuration(for: track)
        var updated = section
        updated.start = max(0, min(section.start, max(0, duration - MusicSection.minimumLength)))
        if let end = section.end {
            updated.end = min(max(end, updated.start + MusicSection.minimumLength), duration)
        }

        var sections = track.sections ?? []
        if let index = sections.firstIndex(where: { $0.id == section.id }) {
            sections[index] = updated
        } else {
            sections.append(updated)
        }
        track.sections = sections.sorted { $0.start < $1.start }
        commit(track)
    }

    @discardableResult
    func addSection(toTrackID trackID: UUID,
                    start: Double,
                    end: Double? = nil,
                    name: String? = nil) -> UUID? {
        guard let track = playlist.first(where: { $0.id == trackID }) else { return nil }
        let existing = track.sections ?? []
        let section = MusicSection(
            name: name ?? "Section \(existing.count + 1)",
            start: start,
            end: end,
            colorHex: AudioPalette.color(forIndex: existing.count),
            hotkeyIndex: MusicSection.nextFreeHotkeyIndex(in: existing),
            loops: true)
        setSection(section, inTrackID: trackID)
        return section.id
    }

    func removeSection(id: UUID, fromTrackID trackID: UUID) {
        guard var track = playlist.first(where: { $0.id == trackID }) else { return }
        track.sections = (track.sections ?? []).filter { $0.id != id }
        if track.armedSectionID == id { track.armedSectionID = nil }
        commit(track)
    }

    func setStartOffset(_ seconds: Double, forTrackID trackID: UUID) {
        guard var track = playlist.first(where: { $0.id == trackID }) else { return }
        track.startOffset = max(0, min(seconds, trackDuration(for: track)))
        commit(track)
    }

    func setArmedSection(id: UUID?, forTrackID trackID: UUID) {
        guard var track = playlist.first(where: { $0.id == trackID }) else { return }
        track.armedSectionID = id
        commit(track)
    }

    func renameTrack(id: UUID, to title: String) {
        guard var track = playlist.first(where: { $0.id == id }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        track.title = trimmed
        commit(track)
    }

    /// Drops an open-ended marker at the live playhead — the tap-to-mark path.
    /// Returns the new section's id so the editor can focus its name field.
    @discardableResult
    func dropMarkerAtPlayhead() -> UUID? {
        guard let trackID = sectionHostTrackID else { return nil }
        return addSection(toTrackID: trackID, start: musicPosition)
    }

    /// Best duration we know for a track. The playing track reports its real
    /// one; others fall back to the last section's end so clamping still
    /// behaves before the file has ever been opened.
    private func trackDuration(for track: MusicTrack) -> Double {
        if track.id == currentTrackID, musicDuration > 0 { return musicDuration }
        let ends = (track.sections ?? []).compactMap { $0.end ?? $0.start }
        return max(ends.max() ?? 0, track.startOffset ?? 0) + 3600
    }

    private func commit(_ track: MusicTrack) {
        musicPlayer?.update(track: track)
        syncMusicState()
        settings.playlist = playlist
        persist()
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

    // DeviceInfo (not tuples): the UI does `ForEach(..., id: \.uid)` and key
    // paths can't refer to tuple elements — real properties are required.
    var outputDevices: [AudioDeviceManager.DeviceInfo] {
        deviceManager.outputDevices()
    }

    var inputDevices: [AudioDeviceManager.DeviceInfo] {
        deviceManager.inputDevices()
            .filter { $0.uid != DriverInstaller.microphoneUID && $0.uid != DriverInstaller.guestSendUID }
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
