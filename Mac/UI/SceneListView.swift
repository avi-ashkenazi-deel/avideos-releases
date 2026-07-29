import SwiftUI

/// The Scenes palette: every scene with a PREVIEW of how it last looked on
/// program, as a list or as big tiles (Ecamm's two modes), each with its ⌘N.
/// Click = switch live (with the scene's transition).
struct SceneListView: View {
    @Environment(StudioController.self) private var studio
    /// "list" or "grid" — window furniture, remembered across launches.
    @AppStorage("scenesDisplayMode") private var displayMode = "list"

    var body: some View {
        Group {
            if displayMode == "grid" {
                sceneGrid
            } else {
                sceneList
            }
        }
        .safeAreaInset(edge: .top) {
            Picker("", selection: $displayMode) {
                Image(systemName: "list.bullet").tag("list")
                Image(systemName: "square.grid.2x2").tag("grid")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 90)
            .padding(.vertical, 6)
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

    // MARK: - The two display modes

    private var sceneList: some View {
        List(selection: Binding(
            get: { studio.project.activeSceneID },
            set: { id in if let id { studio.switchScene(to: id) } }
        )) {
            // No "Scenes" section header: the list lives in a palette window
            // whose title bar already says Scenes.
            Section {
                ForEach(studio.project.scenes) { scene in
                    SceneRow(scene: scene,
                             isActive: scene.id == studio.project.activeSceneID,
                             thumbnail: studio.sceneThumbnails[scene.id])
                        .tag(scene.id)
                        .contextMenu { sceneContextMenu(scene) }
                }
                .onMove { from, to in
                    studio.project.scenes.move(fromOffsets: from, toOffset: to)
                }
            }
        }
    }

    /// Ecamm's tile mode: one big preview per scene, green border on the
    /// live one, name below.
    private var sceneGrid: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                ForEach(studio.project.scenes) { scene in
                    let isActive = scene.id == studio.project.activeSceneID
                    Button {
                        studio.switchScene(to: scene.id)
                    } label: {
                        VStack(spacing: 4) {
                            SceneThumbnail(image: studio.sceneThumbnails[scene.id],
                                           kindIcon: icon(for: scene))
                                .aspectRatio(16 / 9, contentMode: .fit)
                                .frame(maxWidth: .infinity)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .strokeBorder(isActive ? Color.green : .white.opacity(0.15),
                                                      lineWidth: isActive ? 2.5 : 1)
                                )
                            HStack(spacing: 6) {
                                Text(scene.name)
                                    .font(.callout.weight(isActive ? .semibold : .regular))
                                    .lineLimit(1)
                                if let number = studio.project.shortcutNumber(for: scene.id) {
                                    Text("⌘\(number)")
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .buttonStyle(.studioTile)
                    .contextMenu { sceneContextMenu(scene) }
                }
            }
            .padding(10)
        }
    }

    /// One context menu for both modes.
    @ViewBuilder
    private func sceneContextMenu(_ scene: SceneModel) -> some View {
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
        // ⌘D lives on the Studio menu (duplicates the active scene);
        // binding it here too would fire twice.
        Button("Duplicate") { studio.duplicateScene(id: scene.id) }
        Button("Rename…") { renameTarget = scene }
        Button("Delete", role: .destructive) {
            studio.removeScene(id: scene.id)
        }
    }

    private func icon(for scene: SceneModel) -> String {
        switch scene.kind {
        case .camera: "video"
        case .screenShare: "rectangle.on.rectangle"
        case .movie: "film"
        case .interview: "person.2"
        }
    }

    private var addSceneMenu: some View {
        // Primary click adds the preferred kind (Video preferences);
        // the menu still offers every kind.
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
        } primaryAction: {
            studio.addDefaultScene()
        }
        .menuStyle(.borderlessButton)
    }

    private func replace(scene: SceneModel) {
        guard let index = studio.project.scenes.firstIndex(where: { $0.id == scene.id }) else { return }
        studio.project.scenes[index] = scene
    }
}

/// A scene's last program look — or its kind icon until it has one.
struct SceneThumbnail: View {
    let image: CGImage?
    let kindIcon: String

    var body: some View {
        GeometryReader { geo in
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFill()
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
            } else {
                ZStack {
                    Color.black.opacity(0.5)
                    Image(systemName: kindIcon)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct SceneRow: View {
    @Environment(StudioController.self) private var studio
    let scene: SceneModel
    let isActive: Bool
    let thumbnail: CGImage?

    var body: some View {
        HStack(spacing: 8) {
            SceneThumbnail(image: thumbnail, kindIcon: icon)
                .frame(width: 52, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(isActive ? Color.green : .white.opacity(0.12),
                                      lineWidth: isActive ? 1.5 : 1)
                )
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
        .hoverHighlight(cornerRadius: 4)
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
