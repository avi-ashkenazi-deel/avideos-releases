import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Content and design are deliberately separate: typing never changes artwork.
struct OverlayTemplatesView: View {
    @Environment(StudioController.self) private var studio
    @Environment(\.dismiss) private var dismiss
    @State private var selected = OverlayTemplate.builtIns[0].id
    @State private var activeInstance: UUID?
    @State private var error: String?
    @State private var customFont = "Arial-Black"
    @State private var customName = "My show template"
    @State private var imported: OverlayTemplate?

    private var templates: [OverlayTemplate] { OverlayTemplate.builtIns + (studio.project.overlayTemplates ?? []) }
    private var template: OverlayTemplate { templates.first { $0.id == selected } ?? templates[0] }
    private var elements: [Element] { studio.activeScene?.elements ?? [] }
    private var instanceElements: [Element] { elements.filter { $0.overlayInstanceID == activeInstance && activeInstance != nil } }
    private var instances: [Element] {
        var seen = Set<UUID>()
        return elements.filter { e in
            guard let id = e.overlayInstanceID else { return false }
            return seen.insert(id).inserted
        }
    }
    private var fields: [Element] { instanceElements.filter { $0.overlayField != nil } }
    private var currentDesign: OverlayTemplate { instanceElements.first?.overlayTemplate ?? template }
    private var missingFont: Bool { NSFont(name: currentDesign.fontName, size: 24) == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Show templates").font(.title2.bold())
                Spacer(); Button("Done") { dismiss() }
            }
            Text("Phone and comment templates • native editable text").foregroundStyle(.secondary)
            HStack {
                Picker("Design", selection: $selected) {
                    ForEach(templates) { item in Text(item.name).tag(item.id) }
                }
                Button("Add to scene") { addInstance() }.disabled(studio.activeScene == nil || NSFont(name: template.fontName, size: 24) == nil)
            }
            if !instances.isEmpty {
                Picker("Instance", selection: $activeInstance) {
                    Text("Choose an instance").tag(Optional<UUID>.none)
                    ForEach(instances) { item in
                        Text(item.overlayTemplate?.name ?? item.name).tag(item.overlayInstanceID)
                    }
                }
            }
            if !fields.isEmpty {
                ForEach(fields) { element in
                    TextField(element.overlayField ?? "Text", text: Binding(get: {
                        guard case .text(let content) = studio.findElement(id: element.id)?.kind else { return "" }
                        return content.string
                    }, set: { value in
                        guard var updated = studio.findElement(id: element.id), case .text(var content) = updated.kind else { return }
                        content.string = value; updated.kind = .text(content); studio.updateElement(updated)
                    }), axis: .vertical).lineLimit(1...4)
                }
                HStack {
                    Button("Show") { setVisible(true) }.disabled(missingFont)
                    Button("Hide") { setVisible(false) }
                    Spacer()
                    Button("Duplicate") {
                        let words = fields.compactMap { e -> String? in if case .text(let t) = e.kind { return t.string }; return nil }
                        add(currentDesign, primary: words.first ?? "", secondary: words.dropFirst().first ?? "")
                    }
                }
                Text("Text edits keep the design unchanged. Show and Hide animate the entire template together.").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            if template.kind == .comment {
                HStack {
                    Button("Use design for live comments") { studio.project.liveCommentTemplate = template }
                    Button("Use standard comment style") { studio.project.liveCommentTemplate = nil }
                }
                Text("Live comments: \(studio.project.liveCommentTemplate?.name ?? "standard style")").font(.caption)
            }
            DisclosureGroup("Customize a design copy") {
                VStack(alignment: .leading) {
                    TextField("Design name", text: $customName)
                    Picker("Typeface", selection: $customFont) {
                        ForEach(NSFontManager.shared.availableFonts.sorted(), id: \.self) { Text($0).tag($0) }
                    }
                    Button("Save as new design") {
                        var copy = currentDesign; copy.id = UUID(); copy.name = customName; copy.fontName = customFont
                        studio.project.overlayTemplates = (studio.project.overlayTemplates ?? []) + [copy]
                        selected = copy.id
                    }.disabled(customName.trimmingCharacters(in: .whitespaces).isEmpty)
                    Text("Existing instances and other shows keep their original typeface. Add a new instance to use this design.").font(.caption)
                }.padding(.top, 8)
            }
            HStack {
                Button("Export selected design…") { exportDesign() }
                Button("Import design…") { importDesign() }
            }
            Text("Portable vector/text templates. Current names and messages are excluded. Fonts must be installed on the destination Mac.")
                .font(.caption).foregroundStyle(.secondary)
            if missingFont { Text("Missing typeface: \(currentDesign.fontName). Choose an installed typeface in a design copy before showing it.").foregroundStyle(.orange) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        }
        .padding(24).frame(width: 620).textFieldStyle(.roundedBorder)
        .onAppear {
            if let selectedID = studio.selectedElementID, let e = studio.findElement(id: selectedID) {
                activeInstance = e.overlayInstanceID
            }
        }
        .confirmationDialog("Import \(imported?.name ?? "design")?", isPresented: Binding(get: { imported != nil }, set: { if !$0 { imported = nil } })) {
            Button("Keep original design") {
                guard let item = imported else { return }
                studio.project.overlayTemplates = (studio.project.overlayTemplates ?? []) + [item]
                selected = item.id; imported = nil
            }
        } message: {
            Text("This adds a separate design to this show. Existing templates and content will not change. Typeface: \(imported?.fontName ?? "").")
        }
    }
    private func addInstance() {
        add(template, primary: template.kind == .phone ? "Caller name" : "Type your comment", secondary: template.kind == .phone ? "INCOMING CALL" : "Author")
    }
    private func add(_ design: OverlayTemplate, primary: String, secondary: String) {
        let layers = design.elements(primary: primary, secondary: secondary)
        for layer in layers { studio.addElement(layer) }
        activeInstance = layers.first?.overlayInstanceID
    }
    private func setVisible(_ visible: Bool) {
        for element in instanceElements where element.isVisible != visible { studio.toggleElementVisibility(id: element.id) }
    }
    private func exportDesign() {
        let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "\(template.name.replacingOccurrences(of: "/", with: "-" )).streamit-template.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try template.exported().write(to: url, options: .atomic); error = nil } catch { self.error = error.localizedDescription }
    }
    private func importDesign() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 64_000 else { throw OverlayTemplate.Invalid.malformed }
            imported = try OverlayTemplate.imported(Data(contentsOf: url)); error = nil
        } catch { self.error = error.localizedDescription }
    }
}
