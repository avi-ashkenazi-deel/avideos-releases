import SwiftUI

/// Controls for the selected cutaway.
///
/// Value-in, closures-out rather than a `@Binding`, because the commit
/// boundary is the whole point: a slider drag must feed the preview live but
/// push exactly one undo step. `onChange` is the live edit, `onCommit` closes
/// the gesture.
///
/// It lives under the preview rather than in the tracks pane because every
/// control here is a *picture* control, and you want the player reacting a
/// couple of hundred points above as you drag.
struct OverlayInspectorView: View {
    let overlay: OverlayClip
    /// Natural length of the cutaway's media, when known — the bound for
    /// "start inside clip".
    let mediaDuration: Double?
    let onChange: (OverlayClip) -> Void
    let onCommit: () -> Void
    let onRemove: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header
                Divider()
                timing
                mediaTrim
                Divider()
                appearance
                Divider()
                audio
                Divider()
                Button("Remove Cutaway", role: .destructive, action: onRemove)
            }
            .padding(10)
        }
    }

    // MARK: Rows

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(overlay.media.displayName).font(.headline).lineLimit(1)
            if let note = overlay.note {
                // What the AI suggestion said, which is what `note` is for.
                Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            if overlay.media.resolve() == nil {
                Label("File missing", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.red)
            }
        }
    }

    private var timing: some View {
        HStack {
            Text("In / out").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text("\(MusicTimecode.shortString(from: overlay.timelineRange.lowerBound)) – \(MusicTimecode.shortString(from: overlay.timelineRange.upperBound))")
                .font(.caption.monospacedDigit())
            Text("(\(String(format: "%.1fs", overlay.duration)))")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }

    /// The control that has never existed: where playback starts *inside* the
    /// cutaway's own media, as distinct from where the cutaway sits on the
    /// program.
    @ViewBuilder
    private var mediaTrim: some View {
        if let mediaDuration, mediaDuration > overlay.duration {
            let maximum = max(0, mediaDuration - overlay.duration)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Start inside clip").font(.caption)
                    Spacer()
                    Text(MusicTimecode.string(from: overlay.sourceStart))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Slider(value: Binding(
                    get: { min(overlay.sourceStart, maximum) },
                    set: { newValue in
                        var updated = overlay
                        updated.sourceStart = newValue
                        onChange(updated)
                    }), in: 0...maximum,
                    onEditingChanged: { if !$0 { onCommit() } })
                Button("Fit to media") {
                    var updated = overlay
                    updated.sourceStart = 0
                    onChange(updated)
                    onCommit()
                }
                .font(.caption)
                .buttonStyle(.link)
            }
        } else {
            Text("Start inside clip is available once the media's length is known, and only when the clip is longer than the slot it fills.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var appearance: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Mode", selection: Binding(
                get: { overlay.mode },
                set: { newValue in
                    var updated = overlay
                    updated.mode = newValue
                    onChange(updated)
                    onCommit()
                })) {
                ForEach(OverlayClip.Mode.allCases, id: \.self) { mode in
                    Text(mode.displayName).tag(mode)
                }
            }
            .pickerStyle(.segmented)

            if overlay.mode == .inset {
                Text("Corner").font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ForEach(Self.corners, id: \.name) { corner in
                        Button(corner.name) {
                            var updated = overlay
                            updated.insetRect = CGRect(x: corner.x, y: corner.y,
                                                       width: overlay.insetRect.width,
                                                       height: overlay.insetRect.height)
                            onChange(updated)
                            onCommit()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }

            HStack {
                Text("Opacity").font(.caption)
                Slider(value: Binding(
                    get: { overlay.opacity },
                    set: { newValue in
                        var updated = overlay
                        updated.opacity = newValue
                        onChange(updated)
                    }), in: 0...1,
                    onEditingChanged: { if !$0 { onCommit() } })
                Text("\(Int(overlay.opacity * 100))%")
                    .font(.caption.monospacedDigit()).frame(width: 40, alignment: .trailing)
            }
        }
    }

    /// Corner presets rather than a freeform draggable rect: the preview is a
    /// plain `VideoPlayer` with no editing affordance over it, and building one
    /// is its own feature.
    private static let corners: [(name: String, x: Double, y: Double)] = [
        ("↖", 0.06, 0.06), ("↗", 0.62, 0.06), ("↙", 0.06, 0.62), ("↘", 0.62, 0.62),
    ]

    private var audio: some View {
        let current = overlay.audio ?? .silent
        return VStack(alignment: .leading, spacing: 8) {
            Toggle("Play this clip's audio", isOn: Binding(
                get: { current.isEnabled },
                set: { newValue in
                    var updated = overlay
                    var audio = current
                    audio.isEnabled = newValue
                    // Turning audio on without ducking usually means the
                    // conversation talks over it, so default to ducking —
                    // unless this is a music clip already dipping under speech.
                    if newValue, audio.ducking == nil, audio.duckUnderSpeechDB == nil {
                        audio.ducking = .standard
                    }
                    updated.audio = audio
                    onChange(updated)
                    onCommit()
                }))

            if current.isEnabled {
                HStack {
                    Text("Level").font(.caption)
                    Slider(value: Binding(
                        get: { current.gainDB },
                        set: { newValue in
                            var updated = overlay
                            var audio = current
                            audio.gainDB = newValue
                            updated.audio = audio
                            onChange(updated)
                        }), in: -24...12,
                        onEditingChanged: { if !$0 { onCommit() } })
                    Text(String(format: "%+.1f", current.gainDB))
                        .font(.caption.monospacedDigit()).frame(width: 44, alignment: .trailing)
                }

                Toggle("Duck the conversation", isOn: Binding(
                    get: { current.ducking != nil },
                    set: { newValue in
                        var updated = overlay
                        var audio = current
                        audio.ducking = newValue ? .standard : nil
                        updated.audio = audio
                        onChange(updated)
                        onCommit()
                    }))

                if let ducking = current.ducking {
                    HStack {
                        Slider(value: Binding(
                            get: { ducking.amountDB },
                            set: { newValue in
                                var updated = overlay
                                var audio = current
                                audio.ducking?.amountDB = newValue
                                updated.audio = audio
                                onChange(updated)
                            }), in: 0...24,
                            onEditingChanged: { if !$0 { onCommit() } })
                        Text(String(format: "−%.0f dB", ducking.amountDB))
                            .font(.caption.monospacedDigit()).frame(width: 60, alignment: .trailing)
                    }
                    Text("The conversation drops while this clip plays, easing down just before it starts.")
                        .font(.caption2).foregroundStyle(.secondary)
                }

                // The opposite direction — music-clip behavior. Both can be
                // off (clip and conversation coexist at full level); having
                // both ON would fight, so switching this on turns that off.
                Toggle("Dip under speech (music)", isOn: Binding(
                    get: { current.duckUnderSpeechDB != nil },
                    set: { newValue in
                        var updated = overlay
                        var audio = current
                        audio.duckUnderSpeechDB = newValue ? 12 : nil
                        if newValue { audio.ducking = nil }
                        updated.audio = audio
                        onChange(updated)
                        onCommit()
                    }))

                if let dip = current.duckUnderSpeechDB {
                    HStack {
                        Slider(value: Binding(
                            get: { dip },
                            set: { newValue in
                                var updated = overlay
                                var audio = current
                                audio.duckUnderSpeechDB = newValue
                                updated.audio = audio
                                onChange(updated)
                            }), in: 0...24,
                            onEditingChanged: { if !$0 { onCommit() } })
                        Text(String(format: "−%.0f dB", dip))
                            .font(.caption.monospacedDigit()).frame(width: 60, alignment: .trailing)
                    }
                    Text("This clip drops while people speak — background-music behavior. Needs a transcript.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}
