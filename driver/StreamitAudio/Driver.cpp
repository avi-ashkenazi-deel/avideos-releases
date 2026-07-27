// Driver.cpp — streamit CoreAudio HAL AudioServerPlugIn.
//
// Built on libASPL (https://github.com/gavv/libASPL, MIT, C++17), which owns
// the AudioServerPlugIn boilerplate: property dispatch, zero-timestamp
// generation off mach_absolute_time at the fixed device rate, client
// bookkeeping, and control objects. This file only:
//
//   1. Describes two loopback devices ("streamit Microphone", "streamit Guest
//      Send"), each with one output stream and one input stream at
//      2 ch / 48 kHz / Float32.
//   2. Wires each device's IO to a LoopbackRing so that whatever an app
//      plays INTO the device's output comes back out of the device's input
//      sample-synchronously (BlackHole-style: Zoom/Meet select the device as
//      a microphone and hear the program mix).
//   3. Exports the CFPlugIn factory named in Info.plist.
//
// Loaded by coreaudiod from /Library/Audio/Plug-Ins/HAL/StreamitAudio.driver.
// Everything on the IO path (OnWriteMixedOutput / OnReadClientInput) must be
// allocation-free and lock-free — see LoopbackRing.h.
//
// Info.plist contract (do not break):
//   * CFPlugInFactories maps factory UUID 7A9E4F52-3C81-4D6B-9E2A-51B0A6E24C11
//     to the exported symbol "StreamitAudioDriverFactory" below.
//   * Bundle id com.aviashkenazi.streamit.audiodriver.
//   * Bump CFBundleVersion whenever this file changes — the app's
//     DriverInstaller compares it against the installed copy.

#include "LoopbackRing.h"

#include <aspl/Driver.hpp>

#include <CoreAudio/AudioServerPlugIn.h>
#include <CoreFoundation/CoreFoundation.h>

#include <memory>
#include <string>

namespace {

// ---------------------------------------------------------------------------
// Fixed format: 2 ch, 48 kHz, interleaved native-endian Float32.
//
// We set the stream format explicitly rather than relying on
// AddStreamWithControlsAsync() defaults (libASPL's default stream format is
// not guaranteed to be Float32), so the bytes handed to the IO handler are
// exactly the floats the ring stores — no conversion on the render path.
// ---------------------------------------------------------------------------

constexpr UInt32 kSampleRate = 48000;
constexpr UInt32 kChannelCount = streamit::LoopbackRing::kChannels; // 2
constexpr UInt32 kBytesPerFrame = kChannelCount * sizeof(Float32); // 8

// Documented for grep-ability; the authoritative copy lives in Info.plist's
// CFPlugInFactories dictionary. Changing either side breaks plug-in loading.
constexpr const char* kStreamitDriverFactoryUUID =
    "7A9E4F52-3C81-4D6B-9E2A-51B0A6E24C11";

AudioStreamBasicDescription MakeStreamFormat()
{
    AudioStreamBasicDescription fmt = {};
    fmt.mSampleRate = Float64(kSampleRate);
    fmt.mFormatID = kAudioFormatLinearPCM;
    fmt.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian
        | kAudioFormatFlagIsPacked;
    fmt.mBitsPerChannel = 32;
    fmt.mChannelsPerFrame = kChannelCount;
    fmt.mBytesPerFrame = kBytesPerFrame;
    fmt.mFramesPerPacket = 1;
    fmt.mBytesPerPacket = kBytesPerFrame;
    return fmt;
}

// ---------------------------------------------------------------------------
// IO handler: output -> ring -> input, indexed by absolute sample time.
//
// libASPL 3.x hook points (aspl::IORequestHandler, installed via
// aspl::Device::SetIOHandler):
//
//   * OnWriteMixedOutput(stream, zeroTimestamp, timestamp, bytes, bytesCount)
//     — the mix of all clients playing to the device's output stream, in the
//     stream's format, with `timestamp` in samples on the device timeline.
//   * OnReadClientInput(client, stream, zeroTimestamp, timestamp, bytes,
//     bytesCount) — fill `bytes` for one input client at `timestamp`.
//
// API-UNCERTAINTY (verify on the Mac compile pass against the pinned libASPL
// release, include/aspl/IORequestHandler.hpp):
//   * Exact parameter order/types of the two overrides above — libASPL 3.x
//     passes (Float64 zeroTimestamp, Float64 timestamp, void*/const void*
//     bytes, UInt32 bytesCount); if the pinned tag instead exposes
//     frame-count-based variants (OnProcessClientInput(..., Float32* frames,
//     UInt32 frameCount, UInt32 channelCount)), keep OnWriteMixedOutput for
//     the write side and move the read side to the matching hook — the ring
//     calls stay byte-for-byte the same modulo frames-vs-bytes arithmetic.
//   * `timestamp` here is the device-timeline sample time for the first
//     frame of the buffer, which is exactly what LoopbackRing indexes by.
// ---------------------------------------------------------------------------

class LoopbackIOHandler final : public aspl::IORequestHandler {
public:
    explicit LoopbackIOHandler(std::shared_ptr<streamit::LoopbackRing> ring)
        : ring_(std::move(ring))
    {
    }

    // Mixed program audio played into the device by client apps.
    void OnWriteMixedOutput(const std::shared_ptr<aspl::Stream>& stream,
        Float64 zeroTimestamp,
        Float64 timestamp,
        const void* bytes,
        UInt32 bytesCount) override
    {
        (void)stream;
        (void)zeroTimestamp;
        ring_->Write(SampleTime(timestamp),
            static_cast<const float*>(bytes), bytesCount / kBytesPerFrame);
    }

    // Zoom/Meet (or any input client) pulling from the virtual microphone.
    void OnReadClientInput(const std::shared_ptr<aspl::Client>& client,
        const std::shared_ptr<aspl::Stream>& stream,
        Float64 zeroTimestamp,
        Float64 timestamp,
        void* bytes,
        UInt32 bytesCount) override
    {
        (void)client;
        (void)stream;
        (void)zeroTimestamp;
        ring_->Read(SampleTime(timestamp),
            static_cast<float*>(bytes), bytesCount / kBytesPerFrame);
    }

private:
    static uint64_t SampleTime(Float64 timestamp) noexcept
    {
        // Device sample times are integral frame counts >= 0; clamp defensively.
        return timestamp > 0.0 ? uint64_t(timestamp) : 0;
    }

    const std::shared_ptr<streamit::LoopbackRing> ring_;
};

// ---------------------------------------------------------------------------
// Device construction
// ---------------------------------------------------------------------------

std::shared_ptr<aspl::Device> MakeLoopbackDevice(
    const std::shared_ptr<aspl::Context>& context,
    const std::string& name,
    const std::string& uid,
    bool canBeDefaultDevice)
{
    aspl::DeviceParameters params;
    params.Name = name;
    params.Manufacturer = "streamit";
    params.DeviceUID = uid;
    params.ModelUID = uid + ".model";
    params.SampleRate = kSampleRate;
    params.ChannelCount = kChannelCount;

    // Multiple apps may play into the device at once; let libASPL mix them
    // before OnWriteMixedOutput.
    params.EnableMixing = true;

    // "streamit Microphone" may be picked as the user's default input;
    // "streamit Guest Send" is plumbing and should never be auto-selected.
    params.CanBeDefaultDevice = canBeDefaultDevice;

    // Never eligible for system sounds / alerts (sound-effects routing).
    // API-UNCERTAINTY: field spelling `CanBeDefaultSystemDevice` — verify
    // against include/aspl/DeviceParameters.hpp on the Mac pass.
    params.CanBeDefaultSystemDevice = false;

    auto device = std::make_shared<aspl::Device>(context, params);

    // Transport type: libASPL reports kAudioDeviceTransportTypeVirtual by
    // default for aspl::Device. If the pinned release exposes it as a
    // parameter/setter instead, set it to Virtual explicitly here.

    // One output stream (apps render program audio in) and one input stream
    // (conferencing apps capture it back out), both with volume/mute
    // controls, added async-safely before the device is published.
    //
    // API-UNCERTAINTY: aspl::StreamParameters field names (Direction,
    // StartingChannel, Format) and the AddStreamWithControlsAsync(
    // const StreamParameters&) overload — verify against
    // include/aspl/Stream.hpp / Device.hpp. Fallback if only the
    // AddStreamWithControlsAsync(aspl::Direction) overload exists: use it,
    // then stream->SetPhysicalFormatAsync(MakeStreamFormat()).
    aspl::StreamParameters outParams;
    outParams.Direction = aspl::Direction::Output;
    outParams.StartingChannel = 1;
    outParams.Format = MakeStreamFormat();
    device->AddStreamWithControlsAsync(outParams);

    aspl::StreamParameters inParams;
    inParams.Direction = aspl::Direction::Input;
    inParams.StartingChannel = 1;
    inParams.Format = MakeStreamFormat();
    device->AddStreamWithControlsAsync(inParams);

    // The ring is owned by the handler; the handler is owned by the device.
    device->SetIOHandler(std::make_shared<LoopbackIOHandler>(
        std::make_shared<streamit::LoopbackRing>()));

    return device;
}

std::shared_ptr<aspl::Driver> CreateDriver()
{
    auto context = std::make_shared<aspl::Context>();
    auto plugin = std::make_shared<aspl::Plugin>(context);

    plugin->AddDevice(MakeLoopbackDevice(context,
        "streamit Microphone", "com.aviashkenazi.streamit.vmic",
        /*canBeDefaultDevice=*/true));

    plugin->AddDevice(MakeLoopbackDevice(context,
        "streamit Guest Send", "com.aviashkenazi.streamit.gsend",
        /*canBeDefaultDevice=*/false));

    return std::make_shared<aspl::Driver>(context, plugin);
}

} // namespace

// ---------------------------------------------------------------------------
// CFPlugIn factory — the symbol named in Info.plist CFPlugInFactories under
// factory UUID kStreamitDriverFactoryUUID (7A9E4F52-3C81-4D6B-9E2A-51B0A6E24C11).
//
// coreaudiod resolves the AudioServerPlugIn type UUID
// (443ABAB8-E7B3-491A-B985-BEB9187030DB) to this factory and calls it once;
// we hand back libASPL's AudioServerPlugInDriverRef. The driver instance is
// a function-local static so it is created exactly once, lazily, and lives
// for the whole coreaudiod session (HAL plug-ins are never unloaded).
// ---------------------------------------------------------------------------

extern "C" void* StreamitAudioDriverFactory(
    CFAllocatorRef allocator, CFUUIDRef typeUUID)
{
    (void)allocator;
    (void)kStreamitDriverFactoryUUID;

    if (typeUUID == nullptr
        || !CFEqual(typeUUID, kAudioServerPlugInTypeUUID)) {
        return nullptr;
    }

    static std::shared_ptr<aspl::Driver> driver = CreateDriver();

    return driver->GetReference();
}
