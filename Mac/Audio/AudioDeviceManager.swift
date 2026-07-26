import Foundation
import CoreAudio
import AVFoundation
import os

/// CoreAudio device enumeration and selection. Devices are always identified
/// by **UID** in settings (AudioDeviceIDs change across boots/hotplug); this
/// type resolves UID ↔ ID and watches the device list so feeders and capture
/// can reconnect when a device (re)appears.
final class AudioDeviceManager {
    struct DeviceInfo: Hashable, Identifiable {
        let uid: String
        let name: String
        let hasInput: Bool
        let hasOutput: Bool
        var id: String { uid }
    }

    /// Called on the main queue whenever the device list changes.
    var onDevicesChanged: (() -> Void)?

    private var listenerBlock: AudioObjectPropertyListenerBlock?
    private let log = Logger(subsystem: "com.aviashkenazi.avideos", category: "audiodevices")

    init() {
        installListener()
    }

    deinit {
        removeListener()
    }

    // MARK: - Enumeration

    func allDevices() -> [DeviceInfo] {
        deviceIDs().compactMap { info(for: $0) }
    }

    func inputDevices() -> [DeviceInfo] { allDevices().filter(\.hasInput) }
    func outputDevices() -> [DeviceInfo] { allDevices().filter(\.hasOutput) }

    func deviceID(forUID uid: String) -> AudioDeviceID? {
        deviceIDs().first { deviceUID(of: $0) == uid }
    }

    func isDevicePresent(uid: String) -> Bool {
        deviceID(forUID: uid) != nil
    }

    private func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject),
                                             &address, 0, nil, &dataSize) == noErr else { return [] }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject),
                                         &address, 0, nil, &dataSize, &ids) == noErr else { return [] }
        return ids
    }

    private func info(for id: AudioDeviceID) -> DeviceInfo? {
        guard let uid = deviceUID(of: id), let name = deviceName(of: id) else { return nil }
        return DeviceInfo(uid: uid,
                          name: name,
                          hasInput: channelCount(of: id, scope: kAudioDevicePropertyScopeInput) > 0,
                          hasOutput: channelCount(of: id, scope: kAudioDevicePropertyScopeOutput) > 0)
    }

    private func deviceUID(of id: AudioDeviceID) -> String? {
        stringProperty(of: id, selector: kAudioDevicePropertyDeviceUID)
    }

    private func deviceName(of id: AudioDeviceID) -> String? {
        stringProperty(of: id, selector: kAudioObjectPropertyName)
    }

    private func stringProperty(of id: AudioDeviceID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var value: CFString = "" as CFString
        var dataSize = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, ptr)
        }
        guard status == noErr else { return nil }
        return value as String
    }

    private func channelCount(of id: AudioDeviceID, scope: AudioObjectPropertyScope) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &dataSize) == noErr,
              dataSize > 0 else { return 0 }
        let listPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(dataSize),
                                                       alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { listPtr.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, listPtr) == noErr else { return 0 }
        let list = listPtr.assumingMemoryBound(to: AudioBufferList.self)
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    // MARK: - Engine device pinning

    /// Pins an AVAudioEngine's output to a device (nil = system default).
    /// One engine serves one device — that's why the graph uses three engines.
    func setOutputDevice(uid: String?, on engine: AVAudioEngine) -> Bool {
        guard let uid else { return true }
        guard var deviceID = deviceID(forUID: uid) else { return false }
        let unit = engine.outputNode.audioUnit
        guard let unit else { return false }
        let status = AudioUnitSetProperty(unit,
                                          kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global,
                                          0,
                                          &deviceID,
                                          UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr {
            log.error("Failed to pin output device \(uid): \(status)")
        }
        return status == noErr
    }

    /// Pins an AVAudioEngine's input to a device (nil = system default).
    func setInputDevice(uid: String?, on engine: AVAudioEngine) -> Bool {
        guard let uid else { return true }
        guard var deviceID = deviceID(forUID: uid) else { return false }
        guard let unit = engine.inputNode.audioUnit else { return false }
        let status = AudioUnitSetProperty(unit,
                                          kAudioOutputUnitProperty_CurrentDevice,
                                          kAudioUnitScope_Global,
                                          1,
                                          &deviceID,
                                          UInt32(MemoryLayout<AudioDeviceID>.size))
        if status != noErr {
            log.error("Failed to pin input device \(uid): \(status)")
        }
        return status == noErr
    }

    // MARK: - Device-list listener

    private func installListener() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.onDevicesChanged?()
            }
        }
        listenerBlock = block
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),
                                            &address, .main, block)
    }

    private func removeListener() {
        guard let block = listenerBlock else { return }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject),
                                               &address, .main, block)
    }
}
