import SwiftUI
import Observation

/// A named caption look. The three built-ins wrap `CaptionStyle.presets`;
/// anything the user saves lands in `CaptionTemplateStore` alongside the
/// brand kit and shows up in the same gallery.
struct CaptionTemplate: Codable, Identifiable, Equatable {
    var id: UUID
    var name: String
    var style: CaptionStyle
    /// Built-ins are not deletable and are not persisted.
    var isBuiltIn: Bool

    init(id: UUID = UUID(), name: String, style: CaptionStyle, isBuiltIn: Bool = false) {
        self.id = id
        self.name = name
        self.style = style
        self.isBuiltIn = isBuiltIn
    }

    /// The built-in looks, derived from the presets the renderer already ships.
    static var builtIns: [CaptionTemplate] {
        CaptionStyle.presets.map { CaptionTemplate(name: $0.name, style: $0.style, isBuiltIn: true) }
    }
}

/// Persists user-saved templates to
/// `~/Library/Application Support/AVideos/caption-templates.json` — same
/// directory and write discipline as `BrandKitStore`.
@MainActor
@Observable
final class CaptionTemplateStore {
    private(set) var userTemplates: [CaptionTemplate] = []

    private var url: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("AVideos/caption-templates.json")
    }

    init() {
        load()
    }

    /// Built-ins first, then the user's own.
    var allTemplates: [CaptionTemplate] {
        CaptionTemplate.builtIns + userTemplates
    }

    func load() {
        guard let data = try? Data(contentsOf: url),
              let templates = try? JSONDecoder().decode([CaptionTemplate].self, from: data) else {
            userTemplates = []
            return
        }
        userTemplates = templates.map {
            // Defend against a hand-edited file claiming built-in status.
            CaptionTemplate(id: $0.id, name: $0.name, style: $0.style, isBuiltIn: false)
        }
    }

    func save(_ style: CaptionStyle, named name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = trimmed.isEmpty ? "Untitled" : trimmed
        if let index = userTemplates.firstIndex(where: { $0.name == finalName }) {
            userTemplates[index].style = style
        } else {
            userTemplates.append(CaptionTemplate(name: finalName, style: style))
        }
        persist()
    }

    func delete(_ template: CaptionTemplate) {
        guard !template.isBuiltIn else { return }
        userTemplates.removeAll { $0.id == template.id }
        persist()
    }

    private func persist() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(userTemplates) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}

// MARK: - Gallery

/// Template picker with a small live swatch per look. Selecting a template
/// replaces `style` wholesale; the emphasis-word list survives so a clip's
/// AI-picked keywords aren't lost when the look changes.
struct CaptionTemplateGallery: View {
    @Binding var style: CaptionStyle
    var store: CaptionTemplateStore

    @State private var selectedID: UUID?
    @State private var newTemplateName = ""

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 10)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Caption Template")
                .font(.headline)

            ScrollView {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(store.allTemplates) { template in
                        swatch(for: template)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(minHeight: 130, maxHeight: 220)

            Divider()

            styleControls

            HStack {
                TextField("Save current look as…", text: $newTemplateName)
                    .textFieldStyle(.roundedBorder)
                Button("Save") {
                    store.save(style, named: newTemplateName)
                    newTemplateName = ""
                }
                .disabled(newTemplateName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func swatch(for template: CaptionTemplate) -> some View {
        let isSelected = selectedID == template.id
        return VStack(spacing: 6) {
            CaptionSwatch(style: template.style)
                .frame(height: 46)
            HStack(spacing: 4) {
                Text(template.name)
                    .font(.caption)
                    .lineLimit(1)
                if !template.isBuiltIn {
                    Button {
                        store.delete(template)
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption2)
                    .help("Delete this template")
                }
            }
        }
        .padding(6)
        .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(isSelected ? Color.accentColor : Color.secondary.opacity(0.25),
                              lineWidth: isSelected ? 1.5 : 0.5)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            let keepEmphasis = style.emphasisWords
            var applied = template.style
            applied.emphasisWords = keepEmphasis
            style = applied
            selectedID = template.id
        }
    }

    /// Per-look overrides on top of whichever template is selected.
    private var styleControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Size").frame(width: 74, alignment: .leading)
                Slider(value: $style.fontSize, in: 24...96)
                Text("\(Int(style.fontSize))")
                    .font(.caption.monospacedDigit())
                    .frame(width: 28, alignment: .trailing)
            }
            HStack {
                Text("Highlight").frame(width: 74, alignment: .leading)
                Picker("", selection: $style.highlightMode) {
                    ForEach(CaptionStyle.HighlightMode.allCases, id: \.self) { mode in
                        Text(label(for: mode)).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            HStack {
                Text("Position").frame(width: 74, alignment: .leading)
                Picker("", selection: $style.position) {
                    ForEach(CaptionStyle.Position.allCases, id: \.self) { position in
                        Text(label(for: position)).tag(position)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            HStack {
                Text("Background").frame(width: 74, alignment: .leading)
                Picker("", selection: $style.backgroundStyle) {
                    ForEach(CaptionStyle.BackgroundStyle.allCases, id: \.self) { background in
                        Text(label(for: background)).tag(background)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            Toggle("All caps", isOn: $style.allCaps)
                .font(.callout)
        }
    }

    private func label(for mode: CaptionStyle.HighlightMode) -> String {
        switch mode {
        case .wordByWord: return "Word"
        case .line: return "Line"
        }
    }

    private func label(for position: CaptionStyle.Position) -> String {
        switch position {
        case .lowerThird: return "Lower"
        case .center: return "Center"
        case .top: return "Top"
        }
    }

    private func label(for background: CaptionStyle.BackgroundStyle) -> String {
        switch background {
        case .none: return "None"
        case .pill: return "Pill"
        case .band: return "Band"
        }
    }
}

/// A three-word mock caption drawn with the template's own colors, weight,
/// and background treatment — enough to tell the looks apart at a glance.
struct CaptionSwatch: View {
    let style: CaptionStyle

    private var fill: Color { Color(cgColor: CaptionStyle.color(fromHex: style.fillColorHex)) }
    private var highlight: Color { Color(cgColor: CaptionStyle.color(fromHex: style.highlightColorHex)) }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(Color.black.opacity(0.85))
            HStack(spacing: 4) {
                word("THE", color: fill)
                word("BEST", color: highlight)
                word("BIT", color: fill)
            }
            .padding(.horizontal, 6)
            .frame(maxHeight: .infinity, alignment: alignment)
            .padding(.vertical, 6)
        }
    }

    private var alignment: Alignment {
        switch style.position {
        case .lowerThird: return .bottom
        case .center: return .center
        case .top: return .top
        }
    }

    private func word(_ text: String, color: Color) -> some View {
        Text(style.allCaps ? text.uppercased() : text.lowercased())
            .font(.system(size: 11, weight: .heavy))
            .foregroundStyle(color)
            .padding(.horizontal, style.backgroundStyle == .pill ? 4 : 0)
            .padding(.vertical, style.backgroundStyle == .pill ? 1 : 0)
            .background {
                switch style.backgroundStyle {
                case .pill: Capsule().fill(Color.white.opacity(0.16))
                case .band: Rectangle().fill(Color.white.opacity(0.12))
                case .none: Color.clear
                }
            }
    }
}
