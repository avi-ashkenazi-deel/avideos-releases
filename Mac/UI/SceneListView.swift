import SwiftUI

/// The sidebar: scenes are the leading concept. Click = switch live (with the
/// scene's transition). Plus-menu adds a scene of each kind.
struct SceneListView: View {
    @Environment(StudioController.self) private var studio

    var body: some View {
        List(selection: Binding(
            get: { studio.project.activeSceneID },
            set: { id in if let id { studio.switchScene(to: id) } }
        )) {
            // No "Scenes" section header: the list lives in a palette window
            // whose title bar already says Scenes.
            Section {
                ForEach(studio.project.scenes) { scene in
                    SceneRow(scene: scene, isActive: scene.id == studio.project.activeSceneID)
                        .tag(scene.id)
                        .contextMenu {
                            Menu("Transition") {
                                ForEach(SceneTransitionStyle.allCases, id: \.self) { style in
                                    Button {
                                        var updated = scene
                                        updated.transitionStyle = style
                                        replace(scene: updated)
                                    } label: {
                                        HStack {
                                            Text(style.displayName)
                                            if scene.transitionStyle == style {
                                                Image(systemName: "checkmark")
                                            }
                                        }
                                    }
                                }
                            }
                            Menu("Shortcut") {
                                ForEach(1...9, id: \.self) { number in
                                    Button {
                                        var updated = scene
                                        updated.shortcutNumber = number
                                        replace(scene: updated)
                                    } label: {
                                        if studio.project.shortcutNumber(for: scene.id) == number {
                                            Label("⌘\(number)", systemImage: "checkmark")
                                        } else {
                                            Text("⌘\(number)")
                                        }
                                    }
                                }
                                Divider()
                                Button("Automatic (by position)") {
                                    var updated = scene
                                    updated.shortcutNumber = nil
                                    replace(scene: updated)
                                }
                            }
                            // ⌘D lives on the Studio menu (duplicates the
                            // active scene); binding it here too would fire
                            // twice.
                            Button("Duplicate") { studio.duplicateScene(id: scene.id) }
                            Button("Rename…") { renameTarget = scene }
                            Button("Delete", role: .destructive) {
                                studio.removeScene(id: scene.id)
                            }
                        }
                }
                .onMove { from, to in
                    studio.project.scenes.move(fromOffsets: from, toOffset: to)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            addSceneMenu
                .padding(8)
        }
        .alert("Rename Scene", isPresented: Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Rename") {
                if var scene = renameTarget {
                    scene.name = renameText
                    replace(scene: scene)
                }
                renameTarget = nil
            }
            Button("Cancel", role: .cancel) { renameTarget = nil }
        }
        .onChange(of: renameTarget?.id) {
            renameText = renameTarget?.name ?? ""
        }
    }

    @State private var renameTarget: SceneModel?
    @State private var renameText = ""

    private var addSceneMenu: some View {
        Menu {
            Button("Camera Scene") {
                studio.addScene(kind: .camera(CameraSceneConfig()), name: "Camera")
            }
            Button("Screen Share Scene") {
                studio.addScene(kind: .screenShare(ScreenSceneConfig()), name: "Screen Share")
            }
            Button("Movie Scene") {
                studio.addScene(kind: .movie(MovieSceneConfig()), name: "Movie")
            }
            Button("Interview Scene") {
                studio.addScene(kind: .interview(InterviewSceneConfig()), name: "Interview")
            }
        } label: {
            Label("Add Scene", systemImage: "plus")
                .frame(maxWidth: .infinity)
        }
        .menuStyle(.borderlessButton)
    }

    private func replace(scene: SceneModel) {
        guard let index = studio.project.scenes.firstIndex(where: { $0.id == scene.id }) else { return }
        studio.project.scenes[index] = scene
    }
}

private struct SceneRow: View {
    @Environment(StudioController.self) private var studio
    let scene: SceneModel
    let isActive: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(isActive ? Color.red : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(scene.name)
                    .fontWeight(isActive ? .semibold : .regular)
                Text(scene.kind.displayName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            // The scene's live ⌘N, reassignable from the context menu.
            if let number = studio.project.shortcutNumber(for: scene.id) {
                Text("⌘\(number)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
            }
            if isActive {
                Circle().fill(Color.red).frame(width: 7, height: 7)
            }
        }
        .padding(.vertical, 2)
    }

    private var icon: String {
        switch scene.kind {
        case .camera: "video"
        case .screenShare: "rectangle.on.rectangle"
        case .movie: "film"
        case .interview: "person.2"
        }
    }
}
