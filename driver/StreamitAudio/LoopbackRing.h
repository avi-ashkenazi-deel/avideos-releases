// LoopbackRing.h — per-device loopback ring buffer for the streamit HAL driver.
//
// One ring per virtual device. The device's OUTPUT side (an app playing
// program audio into "streamit Microphone" / "streamit Guest Send") writes
// mixed Float32 frames at an absolute device sample time; the INPUT side
// (Zoom/Meet reading the same device as a microphone) reads frames back at
// the same absolute sample time. Both sides run on the coreaudiod real-time
// IO thread for the same device, i.e. they share one sample clock, so
// indexing by absolute frame count modulo the ring size gives sample-
// synchronous loopback with no rate conversion and no drift handling.
//
// Design constraints (real-time render path):
//   * No allocation after construction.
//   * No locks — a single std::atomic<uint64_t> write head with
//     release/acquire ordering. The HAL delivers output writes for a device
//     serially, and reads only inspect data behind the published head.
//   * Underrun (reader ahead of writer, or no writer at all) => zero-fill,
//     never stale garbage.
//
// Torn-read caveat: if a reader lags the writer by nearly the full ring
// (~1.36 s at 48 kHz) the writer can overwrite frames mid-read. That is the
// classic BlackHole-style trade-off and is inaudible in practice because the
// HAL keeps reader and writer within a few IO cycles of each other.

#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>

namespace streamit {

class LoopbackRing {
public:
    static constexpr uint32_t kFrames = 65536; // power of two (~1.36 s @ 48 kHz)
    static constexpr uint32_t kChannels = 2;
    static constexpr uint32_t kFrameMask = kFrames - 1;

    LoopbackRing()
        : buffer_(new float[size_t(kFrames) * kChannels])
    {
        std::memset(buffer_.get(), 0, size_t(kFrames) * kChannels * sizeof(float));
    }

    LoopbackRing(const LoopbackRing&) = delete;
    LoopbackRing& operator=(const LoopbackRing&) = delete;

    // Store `frames` interleaved stereo Float32 frames whose first frame has
    // absolute sample time `frameTime`. Called from the output IO path.
    void Write(uint64_t frameTime, const float* src, uint32_t frames) noexcept
    {
        if (frames == 0 || src == nullptr) {
            return;
        }

        // A write larger than the ring can only keep its newest kFrames.
        if (frames > kFrames) {
            const uint32_t skip = frames - kFrames;
            src += size_t(skip) * kChannels;
            frameTime += skip;
            frames = kFrames;
        }

        const uint64_t head = writeHead_.load(std::memory_order_relaxed);

        // Gap since the last write (IO stopped/restarted, cycles skipped):
        // clear the skipped region so a reader crossing it gets silence
        // instead of year-old samples.
        if (frameTime > head) {
            const uint64_t gap =
                std::min<uint64_t>(frameTime - head, uint64_t(kFrames));
            ZeroRange(frameTime - gap, uint32_t(gap));
        }

        CopyIn(frameTime, src, frames);

        // Publish. Never move the head backwards (the HAL may legitimately
        // re-render an earlier cycle after an overload).
        const uint64_t newHead = std::max<uint64_t>(head, frameTime + frames);
        writeHead_.store(newHead, std::memory_order_release);
    }

    // Fetch `frames` interleaved stereo Float32 frames whose first frame has
    // absolute sample time `frameTime`, zero-filling anything not (yet, or
    // no longer) available. Called from the input IO path.
    void Read(uint64_t frameTime, float* dst, uint32_t frames) const noexcept
    {
        if (frames == 0 || dst == nullptr) {
            return;
        }

        // Zero-fill first, then overlay whatever slice of the request is
        // actually valid. Keeps every underrun/overrun edge case correct.
        std::memset(dst, 0, size_t(frames) * kChannels * sizeof(float));

        const uint64_t head = writeHead_.load(std::memory_order_acquire);
        const uint64_t oldest = head > kFrames ? head - kFrames : 0;

        const uint64_t begin = std::max<uint64_t>(frameTime, oldest);
        const uint64_t end = std::min<uint64_t>(frameTime + frames, head);
        if (begin >= end) {
            return; // nothing written for this window yet -> silence
        }

        CopyOut(begin, dst + size_t(begin - frameTime) * kChannels,
            uint32_t(end - begin));
    }

private:
    void CopyIn(uint64_t frameTime, const float* src, uint32_t frames) noexcept
    {
        const uint32_t start = uint32_t(frameTime) & kFrameMask;
        const uint32_t first = std::min(frames, kFrames - start);

        std::memcpy(buffer_.get() + size_t(start) * kChannels, src,
            size_t(first) * kChannels * sizeof(float));

        if (first < frames) { // wrapped
            std::memcpy(buffer_.get(), src + size_t(first) * kChannels,
                size_t(frames - first) * kChannels * sizeof(float));
        }
    }

    void CopyOut(uint64_t frameTime, float* dst, uint32_t frames) const noexcept
    {
        const uint32_t start = uint32_t(frameTime) & kFrameMask;
        const uint32_t first = std::min(frames, kFrames - start);

        std::memcpy(dst, buffer_.get() + size_t(start) * kChannels,
            size_t(first) * kChannels * sizeof(float));

        if (first < frames) { // wrapped
            std::memcpy(dst + size_t(first) * kChannels, buffer_.get(),
                size_t(frames - first) * kChannels * sizeof(float));
        }
    }

    void ZeroRange(uint64_t frameTime, uint32_t frames) noexcept
    {
        const uint32_t start = uint32_t(frameTime) & kFrameMask;
        const uint32_t first = std::min(frames, kFrames - start);

        std::memset(buffer_.get() + size_t(start) * kChannels, 0,
            size_t(first) * kChannels * sizeof(float));

        if (first < frames) { // wrapped
            std::memset(buffer_.get(), 0,
                size_t(frames - first) * kChannels * sizeof(float));
        }
    }

    std::unique_ptr<float[]> buffer_;

    // Absolute sample time up to which data has been written (exclusive).
    // Valid window for readers: [writeHead_ - kFrames, writeHead_).
    std::atomic<uint64_t> writeHead_{0};
};

} // namespace streamit
