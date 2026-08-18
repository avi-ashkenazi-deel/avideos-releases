import SwiftUI
import AVFoundation

/// Preview popover for a Media-shelf item — the "what IS this file" answer
/// before it goes anywhere near the program.
///
/// Video: a Premiere-style hover scrub — the frame under the pointer, live,
/// as the mouse moves across the strip. Audio: the waveform with draggable
/// in/out handles and an audition play. The chosen in/out carries into
/// "Insert at Playhead", so a music track can start at the chorus and end
/// where the edit wants it to.
struct MediaAuditionView: View {
    let item: MediaBinItem
    let waveforms: WaveformStore
    /// Insert over the video at the playhead, playing this source range.
    var onInsert: (ClosedRange<Double>) -> Void
    var onAddAngle: () -> Void

    @State private var inPoint: Double = 0
    @State private var outPoint: Double = 0
    @State private var loaded = false

    // Video hover-scrub state.
    @State private var scrubImage: NSImage?
    @State private var scrubTime: Double?
    @State private var generator: AVAssetImageGenerator?
    @State private var scrubBucket: Int = -1

    // Audio audition state.
    @State private var auditionPlayer: AVPlayer?
    @State private var isAuditioning = false

    private var duration: Double { max(item.duration, 0.1) }
    private var peaksKey: String { "bin:\(item.id.uuidString)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(item.media.displayName).font(.headline).lineLimit(1)
                Spacer()
                Text(Timecode.tenths(duration))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            if item.hasVideo {
                videoScrubStrip
            }
            if item.hasAudio {
                waveformStrip
            } else if item.hasVideo {
                // Video with no sound still needs somewhere to set in/out.
                trimBar
            }

            HStack {
                Text("In \(Timecode.tenths(inPoint))")
                Spacer()
                Text("Uses \(Timecode.tenths(max(0, outPoint - inPoint)))")
                    .foregroundStyle(.secondary)
                Spacer()
                Text("Out \(Timecode.tenths(outPoint))")
            }
            .font(.caption.monospacedDigit())

            HStack {
                if item.hasAudio {
                    Button {
                        toggleAudition()
                    } label: {
                        Label(isAuditioning ? "Stop" : "Play from In",
                              systemImage: isAuditioning ? "stop.fill" : "play.fill")
                    }
                }
                Spacer()
                Button("Insert at Playhead") {
                    stopAudition()
                    onInsert(inPoint...outPoint)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                Button("Add as Angle") {
                    stopAudition()
                    onAddAngle()
                }
                .controlSize(.small)
                .disabled(!item.hasVideo && !item.hasAudio)
            }
            .font(.caption)
        }
        .padding(14)
        .frame(width: 420)
        .onAppear(perform: setUp)
        .onDisappear(perform: stopAudition)
    }

    // MARK: - Video hover scrub

    private var videoScrubStrip: some View {
        GeometryReader { geo in
            ZStack {
                if let scrubImage {
                    Image(nsImage: scrubImage)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    RoundedRectangle(cornerRadius: 6).fill(.black.opacity(0.4))
                    Text("Move the pointer across to scrub")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let scrubTime {
                    Text(Timecode.tenths(scrubTime))
                        .font(.caption2.monospacedDigit())
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(.black.opacity(0.6), in: Capsule())
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity,
                               alignment: .bottomTrailing)
                        .padding(6)
                }
            }
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let point):
                    scrub(fraction: point.x / max(geo.size.width, 1))
                case .ended:
                    scrubTime = nil
                }
            }
        }
        .frame(height: 170)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    /// Requests are quantized to ~120 buckets across the file so a fast mouse
    /// doesn't queue hundreds of decodes; stale completions are dropped.
    private func scrub(fraction: CGFloat) {
        let clamped = min(max(Double(fraction), 0), 1)
        let time = clamped * duration
        scrubTime = time
        let bucket = Int(clamped * 120)
        guard bucket != scrubBucket, let generator else { return }
        scrubBucket = bucket

        let requested = CMTime(seconds: time, preferredTimescale: 600)
        generator.generateCGImageAsynchronously(for: requested) { cgImage, _, _ in
            guard let cgImage else { return }
            Task { @MainActor in
                // A newer bucket may have landed first; last write wins is
                // fine for a scrub, so no ordering bookkeeping.
                scrubImage = NSImage(cgImage: cgImage,
                                     size: NSSize(width: cgImage.width, height: cgImage.height))
            }
        }
    }

    // MARK: - Audio waveform + trim

    private var waveformStrip: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let peaks = waveforms.peaks[peaksKey] ?? []
            ZStack(alignment: .topLeading) {
                Canvas { context, size in
                    let inX = CGFloat(inPoint / duration) * size.width
                    let outX = CGFloat(outPoint / duration) * size.width
                    context.fill(
                        Path(roundedRect: CGRect(x: inX, y: 0, width: max(0, outX - inX),
                                                 height: size.height), cornerRadius: 3),
                        with: .color(.green.opacity(0.15)))
                    guard !peaks.isEmpty else { return }
                    let barWidth = size.width / CGFloat(peaks.count)
                    for (index, peak) in peaks.enumerated() {
                        let centerX = CGFloat(index) * barWidth + barWidth / 2
                        let amp = max(1.5, CGFloat(peak) * size.height * 0.9)
                        let inWindow = centerX >= inX && centerX <= outX
                        context.fill(
                            Path(CGRect(x: centerX - barWidth * 0.35,
                                        y: (size.height - amp) / 2,
                                        width: barWidth * 0.7, height: amp)),
                            with: .color(.green.opacity(inWindow ? 0.9 : 0.3)))
                    }
                }
                trimHandle(atX: CGFloat(inPoint / duration) * width, height: geo.size.height)
                    .gesture(trimGesture(width: width, isIn: true))
                trimHandle(atX: CGFloat(outPoint / duration) * width, height: geo.size.height)
                    .gesture(trimGesture(width: width, isIn: false))
            }
        }
        .frame(height: 64)
    }

    /// In/out without a waveform (silent video): the same handles on a bar.
    private var trimBar: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .topLeading) {
                Capsule().fill(.white.opacity(0.12)).frame(height: 6)
                    .frame(maxHeight: .infinity)
                Capsule().fill(Color.accentColor.opacity(0.6)).frame(height: 6)
                    .frame(width: max(0, CGFloat((outPoint - inPoint) / duration) * width))
                    .offset(x: CGFloat(inPoint / duration) * width)
                    .frame(maxHeight: .infinity)
                trimHandle(atX: CGFloat(inPoint / duration) * width, height: geo.size.height)
                    .gesture(trimGesture(width: width, isIn: true))
                trimHandle(atX: CGFloat(outPoint / duration) * width, height: geo.size.height)
                    .gesture(trimGesture(width: width, isIn: false))
            }
        }
        .frame(height: 26)
    }

    private func trimHandle(atX x: CGFloat, height: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(.white)
                .frame(width: 3, height: height)
        }
        .frame(width: 20, height: height)   // fat hit area
        .contentShape(Rectangle())
        .position(x: x, y: height / 2)
    }

    private func trimGesture(width: CGFloat, isIn: Bool) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let seconds = min(max(Double(value.location.x / width), 0), 1) * duration
                if isIn {
                    inPoint = min(seconds, outPoint - 0.1)
                } else {
                    outPoint = max(seconds, inPoint + 0.1)
                }
            }
    }

    // MARK: - Audition

    private func toggleAudition() {
        if isAuditioning {
            stopAudition()
            return
        }
        guard let url = item.media.resolve() else { return }
        let player = AVPlayer(url: url)
        auditionPlayer = player
        player.seek(to: CMTime(seconds: inPoint, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        // Stop at the out point — the audition previews the RANGE.
        player.addBoundaryTimeObserver(
            forTimes: [NSValue(time: CMTime(seconds: outPoint, preferredTimescale: 600))],
            queue: .main) {
            Task { @MainActor in stopAudition() }
        }
        player.play()
        isAuditioning = true
    }

    private func stopAudition() {
        auditionPlayer?.pause()
        auditionPlayer = nil
        isAuditioning = false
    }

    // MARK: - Setup

    private func setUp() {
        guard !loaded else { return }
        loaded = true
        inPoint = 0
        outPoint = duration
        guard let url = item.media.resolve() else { return }
        if item.hasAudio {
            waveforms.ensurePeaks(url: url, key: peaksKey,
                                  cacheURL: WaveformStore.cachedPeaksURL(for: url))
        }
        if item.hasVideo {
            let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: 640, height: 640)
            // Loose tolerance keeps the scrub responsive on long-GOP files;
            // frame-exactness is the timeline's job, not the shelf's.
            gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
            gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
            generator = gen
        }
    }
}
