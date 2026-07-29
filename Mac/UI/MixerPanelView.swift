import SwiftUI

/// The Sound Levels panel, Ecamm-style: one horizontal row per source —
/// name, MUTE, and a slider whose track doubles as the live level meter —
/// plus the sidechain ducker below.
struct MixerPanelView: View {
    @Environment(AudioEngineController.self) private var audio

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(audio.strips, id: \.self) { strip in
                LevelRow(strip: strip)
            }
            HStack {
                Menu {
                    ForEach(audio.addableInputDevices, id: \.uid) { device in
                        Button(device.name) { audio.addInputStrip(deviceUID: device.uid) }
                    }
                } label: {
                    Label("Add Input", systemImage: "plus")
                        .font(.caption)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .help("Add another microphone or input device to the mix")
                Spacer()
            }
            Divider().padding(.vertical, 4)
            DuckerSection()
        }
        .padding(12)
    }
}

// MARK: - Level row

private struct LevelRow: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID

    @State private var showsInserts = false

    var body: some View {
        HStack(spacing: 10) {
            Text(audio.displayName(for: strip))
                .font(.callout)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 120, alignment: .trailing)

            muteButton

            MeterSlider(
                value: Binding(
                    get: { Double(audio.volume(for: strip)) },
                    set: { audio.setVolume(Float($0), for: strip) }),
                levels: { audio.levels(for: strip) },
                dimmed: audio.isMuted(strip)
            )
            .frame(height: 18)

            fxButton
        }
        .padding(.vertical, 3)
        .contextMenu {
            if case .input(let uid) = strip {
                Button("Remove Input", role: .destructive) {
                    audio.removeInputStrip(deviceUID: uid)
                }
            }
        }
    }

    private var muteButton: some View {
        let muted = audio.isMuted(strip)
        return Button {
            audio.setMuted(!muted, for: strip)
        } label: {
            Text("MUTE")
                .font(.system(size: 9, weight: .bold))
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .foregroundStyle(muted ? Color.white : Color.secondary)
                .background(
                    muted ? AnyShapeStyle(Color.red.opacity(0.85))
                          : AnyShapeStyle(Color.white.opacity(0.1)),
                    in: RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .help(muted ? "Unmute" : "Mute")
    }

    private var fxButton: some View {
        let count = audio.insertChain(for: strip).count
        return Button {
            showsInserts.toggle()
        } label: {
            Text(count > 0 ? "FX\u{2009}\(count)" : "FX")
                .font(.system(size: 9, weight: .bold))
                .frame(width: 30, height: 20)
                .foregroundStyle(count > 0 ? Color.accentColor : Color.secondary)
                .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .help("Insert effects")
        .popover(isPresented: $showsInserts, arrowEdge: .bottom) {
            InsertChainView(strip: strip)
        }
    }
}

/// A horizontal volume slider whose track is also the live meter: the green
/// level plays inside the groove, the knob sets the fader. Double-click
/// resets to unity.
private struct MeterSlider: View {
    @Binding var value: Double
    let levels: () -> AudioLevels
    var dimmed = false

    var body: some View {
        TimelineView(.animation) { _ in
            GeometryReader { geo in
                let width = geo.size.width
                let level = CGFloat(min(max(levels().rms, 0), 1))
                let knobX = min(max(width * CGFloat(min(max(value, 0), 1)), 7), width - 7)

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.black.opacity(0.55))
                        .frame(height: 6)
                    // Live level inside the groove, capped at the fader so
                    // the picture matches what's audible.
                    Capsule()
                        .fill(LinearGradient(colors: [.green, .green, .yellow],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, width * level * CGFloat(min(max(value, 0), 1))),
                               height: 6)
                        .opacity(dimmed ? 0.25 : 0.9)
                    Circle()
                        .fill(Color(white: 0.92))
                        .frame(width: 14, height: 14)
                        .shadow(color: .black.opacity(0.5), radius: 1, y: 1)
                        .position(x: knobX, y: geo.size.height / 2)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { drag in
                            value = min(max(drag.location.x / width, 0), 1)
                        }
                )
                .onTapGesture(count: 2) { value = 1 }
            }
        }
    }
}

// MARK: - Insert chain popover

private struct InsertChainView: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID

    @State private var thirdPartyEffects: [AudioEngineController.AudioUnitComponentInfo] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Inserts — \(audio.displayName(for: strip))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                addMenu
            }

            let chain = audio.insertChain(for: strip)
            if chain.isEmpty {
                Text("No effects")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 14)
            } else {
                VStack(spacing: 6) {
                    ForEach(chain) { insert in
                        InsertRow(strip: strip, insert: insert)
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 320)
        .onAppear { thirdPartyEffects = audio.availableThirdPartyEffects() }
    }

    private var addMenu: some View {
        // Quick built-ins first, then the full AU catalog grouped by
        // manufacturer (Apple's AUGraphicEQ/AUDistortion/… included), the way
        // Ecamm's Add Plugin reads. Every added unit opens its own native
        // plug-in window from the row.
        Menu {
            Section("Quick") {
                Button("Compressor") { audio.addInsert(kind: .compressor, to: strip) }
                Button("EQ") { audio.addInsert(kind: .eq, to: strip) }
                Button("Delay") { audio.addInsert(kind: .delay, to: strip) }
                Button("Reverb") { audio.addInsert(kind: .reverb, to: strip) }
            }
            ForEach(manufacturers, id: \.self) { manufacturer in
                Menu(manufacturer) {
                    ForEach(thirdPartyEffects.filter { $0.manufacturerName == manufacturer }) { component in
                        Button(component.name) {
                            audio.addThirdPartyInsert(component: component, to: strip)
                        }
                    }
                }
            }
        } label: {
            Label("Add Plugin", systemImage: "plus")
                .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    /// Apple first, then everyone else alphabetically.
    private var manufacturers: [String] {
        let names = Set(thirdPartyEffects.map(\.manufacturerName))
        return names.sorted { a, b in
            if a == "Apple" { return true }
            if b == "Apple" { return false }
            return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
    }
}

private struct InsertRow: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID
    let insert: AudioEngineController.InsertEffect

    private var isEQ: Bool {
        if case .eq = insert.kind { return true }
        return false
    }

    var body: some View {
        HStack(spacing: 8) {
            Button {
                audio.setBypassed(!insert.bypassed, insertID: insert.id, strip: strip)
            } label: {
                Image(systemName: "power")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(insert.bypassed ? Color.secondary : Color.accentColor)
                    .frame(width: 20, height: 20)
                    .background(Color.white.opacity(0.06), in: Circle())
            }
            .buttonStyle(.plain)
            .help(insert.bypassed ? "Enable" : "Bypass")

            VStack(alignment: .leading, spacing: 2) {
                Text(insert.displayName)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                if isEQ {
                    // An EQ is bands, not a volume-looking macro slider —
                    // the band editor lives right here in the row.
                    EQBandEditor(strip: strip, insert: insert)
                } else {
                    Slider(value: Binding(
                        get: { insert.macroAmount },
                        set: { audio.setMacro($0, insertID: insert.id, strip: strip) }
                    ), in: 0...1)
                    .controlSize(.mini)
                    .help("Macro amount")
                }
            }
            .opacity(insert.bypassed ? 0.45 : 1)

            // Every insert opens its native AU window (Ecamm-style) — the
            // four quick built-ins included; they're Apple AUs underneath.
            Button {
                audio.showPluginUI(insertID: insert.id, strip: strip)
            } label: {
                Image(systemName: "macwindow")
                    .font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Open plug-in window")

            Button {
                audio.removeInsert(id: insert.id, from: strip)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tertiary)
            .help("Remove effect")
        }
        .padding(6)
        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - EQ band editor

/// Six bipolar band faders (−12…+12 dB) over the fixed band layout in
/// `InsertEffect.eqBands`. Drag a band to set it; double-click zeroes it.
/// The first touch replaces the macro "presence" curve with explicit bands.
private struct EQBandEditor: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID
    let insert: AudioEngineController.InsertEffect

    private static let range: ClosedRange<Double> = -12...12

    private var gains: [Double] {
        insert.eqBandGains ?? Array(repeating: 0, count: InsertEffect.eqBands.count)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            ForEach(Array(InsertEffect.eqBands.enumerated()), id: \.offset) { index, band in
                VStack(spacing: 2) {
                    Text(gainLabel(gains[safe: index] ?? 0))
                        .font(.system(size: 8).monospacedDigit())
                        .foregroundStyle(.secondary)
                    BipolarFader(value: Binding(
                        get: { gains[safe: index] ?? 0 },
                        set: { setGain($0, at: index) }
                    ), range: Self.range)
                    .frame(width: 16, height: 64)
                    Text(band.label)
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 2)
    }

    private func gainLabel(_ value: Double) -> String {
        value == 0 ? "0" : String(format: "%+.0f", value)
    }

    private func setGain(_ value: Double, at index: Int) {
        var updated = gains
        while updated.count < InsertEffect.eqBands.count { updated.append(0) }
        updated[index] = min(max(value, Self.range.lowerBound), Self.range.upperBound)
        audio.setEQBandGains(updated, insertID: insert.id, strip: strip)
    }
}

/// A tiny vertical fader centered on zero, for dB-style bipolar values.
private struct BipolarFader: View {
    @Binding var value: Double
    let range: ClosedRange<Double>

    var body: some View {
        GeometryReader { geo in
            let height = geo.size.height
            let span = range.upperBound - range.lowerBound
            let normalized = (value - range.lowerBound) / span   // 0…1, bottom-up
            let thumbY = height * (1 - CGFloat(normalized))
            let zeroY = height * (1 - CGFloat((0 - range.lowerBound) / span))

            ZStack(alignment: .top) {
                Capsule()
                    .fill(Color.black.opacity(0.6))
                    .frame(width: 3)
                    .frame(maxWidth: .infinity)
                // Fill from the zero line to the thumb, either direction.
                Rectangle()
                    .fill(Color.accentColor.opacity(0.75))
                    .frame(width: 3, height: abs(zeroY - thumbY))
                    .offset(y: min(zeroY, thumbY))
                    .frame(maxWidth: .infinity)
                Rectangle()
                    .fill(.white.opacity(0.35))
                    .frame(height: 1)
                    .offset(y: zeroY)
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color(white: 0.88))
                    .frame(width: 12, height: 7)
                    .shadow(color: .black.opacity(0.5), radius: 1, y: 1)
                    .offset(y: min(max(thumbY - 3.5, 0), height - 7))
                    .frame(maxWidth: .infinity)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        let fraction = 1 - min(max(drag.location.y / height, 0), 1)
                        value = range.lowerBound + Double(fraction) * span
                    }
            )
            .onTapGesture(count: 2) { value = 0 }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

// MARK: - Ducker

private struct DuckerSection: View {
    @Environment(AudioEngineController.self) private var audio

    var body: some View {
        @Bindable var audio = audio
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: $audio.duckerConfig.enabled) {
                Label("Ducker", systemImage: "waveform.path")
                    .font(.caption.weight(.semibold))
            }
            .toggleStyle(.switch)
            .controlSize(.mini)

            if audio.duckerConfig.enabled {
                HStack(spacing: 8) {
                    Text("Trigger")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Picker("Trigger", selection: $audio.duckerConfig.triggerStrip) {
                        ForEach(audio.strips, id: \.self) { strip in
                            Text(audio.displayName(for: strip)).tag(strip)
                        }
                    }
                    .labelsHidden()
                    .controlSize(.small)
                    .fixedSize()
                    Spacer()
                }

                HStack(spacing: 6) {
                    Text("Duck")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    ForEach(audio.strips.filter { $0 != audio.duckerConfig.triggerStrip },
                            id: \.self) { strip in
                        targetChip(for: strip)
                    }
                    Spacer()
                }

                HStack(spacing: 8) {
                    Text("Amount")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Slider(value: $audio.duckerConfig.amountDB, in: 0...36)
                        .controlSize(.mini)
                    Text("−\(Int(audio.duckerConfig.amountDB.rounded())) dB")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 44, alignment: .trailing)
                }
            }
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// A small toggle chip for ducker target multi-select.
    private func targetChip(for strip: AudioEngineController.StripID) -> some View {
        let isOn = audio.duckerConfig.targetStrips.contains(strip)
        return Button {
            var config = audio.duckerConfig
            if isOn {
                config.targetStrips.remove(strip)
            } else {
                config.targetStrips.insert(strip)
            }
            audio.duckerConfig = config
        } label: {
            Text(audio.displayName(for: strip))
                .font(.caption2.weight(.medium))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .foregroundStyle(isOn ? Color.white : Color.secondary)
                .background(
                    isOn ? AnyShapeStyle(Color.accentColor.opacity(0.8))
                         : AnyShapeStyle(Color.white.opacity(0.08)),
                    in: Capsule())
        }
        .buttonStyle(.plain)
    }
}
