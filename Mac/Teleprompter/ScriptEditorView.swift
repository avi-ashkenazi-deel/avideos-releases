import SwiftUI

/// Script management sheet: script list, section editing, plain-text import
/// (headings split sections), per-scene binding, and "Load into Prompter".
struct ScriptEditorView: View {
    let store: ScriptStore
    let controller: TeleprompterController
    /// (sceneID, name) pairs for the per-scene binding picker.
    let scenes: [(id: UUID, name: String)]
    @Environment(\.dismiss) private var dismiss

    @State private var scripts: [ScriptDocument] = []
    @State private var current: ScriptDocument?
    @State private var importText = ""
    @State private var showingImport = false

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(
                get: { current?.id },
                set: { id in
                    saveCurrent()
                    current = scripts.first { $0.id == id }
                }
            )) {
                ForEach(scripts) { script in
                    Text(script.title.isEmpty ? "Untitled" : script.title)
                        .tag(script.id)
                        .contextMenu {
                            Button("Delete", role: .destructive) { delete(script) }
                        }
                }
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 200)
            .toolbar {
                Button {
                    let script = ScriptDocument(title: "New Script",
                                                sections: [ScriptSection(heading: "", body: "")])
                    scripts.insert(script, at: 0)
                    current = script
                } label: {
                    Label("New Script", systemImage: "plus")
                }
            }
        } detail: {
            if current != nil {
                editor
            } else {
                ContentUnavailableView("Select or create a script", systemImage: "doc.text")
            }
        }
        .frame(minWidth: 700, minHeight: 460)
        .onAppear { scripts = store.list() }
        .onDisappear { saveCurrent() }
        .sheet(isPresented: $showingImport) { importSheet }
    }

    // MARK: - Editor

    @ViewBuilder
    private var editor: some View {
        if let script = current {
            VStack(spacing: 0) {
                HStack {
                    TextField("Title", text: binding(\.title))
                        .textFieldStyle(.roundedBorder)
                        .font(.title3)
                    Button("Import Text…") { showingImport = true }
                    Button("Load into Prompter") {
                        saveCurrent()
                        controller.loadScript(script)
                        dismiss()
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding()

                List {
                    ForEach(Array(script.sections.enumerated()), id: \.element.id) { index, _ in
                        sectionEditor(index: index)
                    }
                    .onMove { from, to in
                        current?.sections.move(fromOffsets: from, toOffset: to)
                    }

                    Button {
                        current?.sections.append(ScriptSection(heading: "", body: ""))
                    } label: {
                        Label("Add Section", systemImage: "plus")
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func sectionEditor(index: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                TextField("Section heading", text: binding { $0.sections[index].heading }
                                                 set: { $0.sections[index].heading = $1 })
                    .textFieldStyle(.roundedBorder)
                    .font(.headline)

                Picker("Scene", selection: binding { $0.sections[index].sceneID }
                                             set: { $0.sections[index].sceneID = $1 }) {
                    Text("No scene").tag(UUID?.none)
                    ForEach(scenes, id: \.id) { scene in
                        Text(scene.name).tag(UUID?.some(scene.id))
                    }
                }
                .frame(width: 170)
                .help("Switching to this scene jumps the prompter here")

                Button(role: .destructive) {
                    current?.sections.remove(at: index)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }

            TextEditor(text: binding { $0.sections[index].body }
                             set: { $0.sections[index].body = $1 })
                .font(.system(size: 14))
                .frame(minHeight: 90)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
        }
        .padding(.vertical, 6)
    }

    // MARK: - Import

    private var importSheet: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Paste your script — headings (#, ##, or ALL-CAPS lines) become sections.")
                .font(.callout)
            TextEditor(text: $importText)
                .font(.system(size: 13, design: .monospaced))
                .frame(minWidth: 480, minHeight: 300)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Spacer()
                Button("Cancel") { showingImport = false }
                Button("Split into Sections") {
                    if var script = current {
                        script.sections = ScriptDocument.importing(plainText: importText, title: script.title).sections
                        current = script
                    }
                    importText = ""
                    showingImport = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(importText.isEmpty)
            }
        }
        .padding()
    }

    // MARK: - Helpers

    private func binding(_ keyPath: WritableKeyPath<ScriptDocument, String>) -> Binding<String> {
        Binding(get: { current?[keyPath: keyPath] ?? "" },
                set: { current?[keyPath: keyPath] = $0 })
    }

    private func binding<T>(get: @escaping (ScriptDocument) -> T,
                            set: @escaping (inout ScriptDocument, T) -> Void) -> Binding<T> where T: Equatable {
        Binding(
            get: { current.map(get) ?? get(ScriptDocument(title: "", sections: [])) },
            set: { newValue in
                guard var script = current else { return }
                set(&script, newValue)
                current = script
            }
        )
    }

    private func saveCurrent() {
        guard let script = current else { return }
        try? store.save(script)
        if let index = scripts.firstIndex(where: { $0.id == script.id }) {
            scripts[index] = script
        }
    }

    private func delete(_ script: ScriptDocument) {
        try? store.delete(id: script.id)
        scripts.removeAll { $0.id == script.id }
        if current?.id == script.id { current = nil }
    }
}
