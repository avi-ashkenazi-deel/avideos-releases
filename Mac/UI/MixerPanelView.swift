import SwiftUI

/// The broadcast-console mixer: one vertical channel strip per audio strip
/// (mic, pads, music, movie, each connected guest) with fader, mute, live
/// meter and an insert-chain popover, plus the sidechain ducker controls.
struct MixerPanelView: View {
    @Environment(AudioEngineController.self) private var audio

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(audio.strips, id: \.self) { strip in
                        ChannelStripView(strip: strip)
                    }
                }
                .padding(.vertical, 2)
            }
            DuckerSection()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(white: 0.09))
        )
    }
}

// MARK: - Channel strip

private struct ChannelStripView: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID

    @State private var showsInserts = false

    var body: some View {
        VStack(spacing: 8) {
            Text(audio.displayName(for: strip))
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)

            HStack(spacing: 6) {
                VerticalFader(value: Binding(
                    get: { Double(audio.volume(for: strip)) },
                    set: { audio.setVolume(Float($0), for: strip) }))
                LevelMeter(strip: strip)
            }
            .frame(height: 130)

            HStack(spacing: 6) {
                muteButton
                fxButton
            }
        }
        .padding(8)
        .frame(width: 76)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        )
    }

    private var muteButton: some View {
        let muted = audio.isMuted(strip)
        return Button {
            audio.setMuted(!muted, for: strip)
        } label: {
            Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 26, height: 20)
                .foregroundStyle(muted ? Color.white : Color.secondary)
                .background(
                    muted ? AnyShapeStyle(Color.red.opacity(0.85))
                          : AnyShapeStyle(Color.white.opacity(0.08)),
                    in: RoundedRectangle(cornerRadius: 5))
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
                .frame(width: 26, height: 20)
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

// MARK: - Fader

/// Custom vertical fader (0…1 linear gain). Double-click resets to unity.
private struct VerticalFader: View {
    @Binding var value: Double

    var body: some View {
        GeometryReader { geo in
            let height = geo.size.height
            let fill = height * CGFloat(min(max(value, 0), 1))
            let thumbCenter = min(max(fill, 6), height - 6)

            ZStack(alignment: .bottom) {
                Capsule()
                    .fill(Color.black.opacity(0.6))
                    .frame(width: 4)
                    .frame(maxWidth: .infinity)
                Capsule()
                    .fill(Color.accentColor.opacity(0.75))
                    .frame(width: 4, height: fill)
                    .frame(maxWidth: .infinity)
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(white: 0.88))
                    .frame(width: 20, height: 12)
                    .shadow(color: .black.opacity(0.5), radius: 1, y: 1)
                    .offset(y: -(thumbCenter - 6))
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        value = min(max(1 - drag.location.y / height, 0), 1)
                    }
            )
            .onTapGesture(count: 2) { value = 1 }
        }
        .frame(width: 24)
    }
}

// MARK: - Level meter

/// RMS bar with a floating peak tick, redrawn every display frame.
private struct LevelMeter: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID

    var body: some View {
        TimelineView(.animation) { _ in
            GeometryReader { geo in
                let height = geo.size.height
                let levels = audio.levels(for: strip)
                let rms = CGFloat(min(max(levels.rms, 0), 1))
                let peak = CGFloat(min(max(levels.peak, 0), 1))

                ZStack(alignment: .bottom) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.black.opacity(0.6))
                    LinearGradient(colors: [.green, .green, .yellow, .red],
                                   startPoint: .bottom, endPoint: .top)
                        .frame(height: height * rms)
                        .clipShape(RoundedRectangle(cornerRadius: 2))
                    Rectangle()
                        .fill(.white.opacity(0.9))
                        .frame(height: 1.5)
                        .offset(y: -min(height * peak, height - 1.5))
                }
            }
        }
        .frame(width: 6)
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
        Menu {
            Button("Compressor") { audio.addInsert(kind: .compressor, to: strip) }
            Button("EQ") { audio.addInsert(kind: .eq, to: strip) }
            Button("Delay") { audio.addInsert(kind: .delay, to: strip) }
            Button("Reverb") { audio.addInsert(kind: .reverb, to: strip) }
            if !thirdPartyEffects.isEmpty {
                Menu("Audio Units…") {
                    ForEach(thirdPartyEffects) { component in
                        Button("\(component.name) — \(component.manufacturerName)") {
                            audio.addThirdPartyInsert(component: component, to: strip)
                        }
                    }
                }
            }
        } label: {
            Label("Add", systemImage: "plus")
                .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

private struct InsertRow: View {
    @Environment(AudioEngineController.self) private var audio
    let strip: AudioEngineController.StripID
    let insert: AudioEngineController.InsertEffect

    private var isThirdParty: Bool {
        if case .thirdParty = insert.kind { return true }
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
                Slider(value: Binding(
                    get: { insert.macroAmount },
                    set: { audio.setMacro($0, insertID: insert.id, strip: strip) }
                ), in: 0...1)
                .controlSize(.mini)
                .help("Macro amount")
            }
            .opacity(insert.bypassed ? 0.45 : 1)

            if isThirdParty {
                Button {
                    audio.showPluginUI(insertID: insert.id, strip: strip)
                } label: {
                    Image(systemName: "macwindow")
                        .font(.system(size: 10))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Open plug-in window")
            }

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
