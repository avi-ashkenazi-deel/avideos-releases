import SwiftUI
import AppKit

/// The Comments window: every platform's chat in one feed, a shortlist to
/// line questions up, a preview of the card, and the one button that puts
/// a comment on air. Nothing reaches the stream unless the host presses
/// Feature on Air (or ↩) here.
///
/// A normal resizable window (Studio → Show Comments, ⌥⌘C) so it can live
/// on a second display through the whole show.
struct CommentsWindow: View {
    @Environment(StudioController.self) private var studio

    @State private var selectedID: String?
    @State private var platformFilter: StreamPlatform?
    @State private var search = ""
    @State private var showsOptions = false

    private var store: CommentsStore { studio.comments }

    var body: some View {
        VStack(spacing: 0) {
            OnAirStrip(store: store)
            Divider()
            HSplitView {
                CommentFeed(store: store,
                            selectedID: $selectedID,
                            platformFilter: $platformFilter,
                            search: $search)
                    .frame(minWidth: 360, idealWidth: 520)
                VStack(spacing: 0) {
                    ShortlistColumn(store: store, selectedID: $selectedID)
                    Divider()
                    FeaturePanel(store: store, selected: selectedComment)
                }
                .frame(minWidth: 300, idealWidth: 340, maxWidth: 460)
            }
        }
        .frame(minWidth: 720, minHeight: 520)
        .toolbar {
            ToolbarItemGroup(placement: .automatic) {
                SourceStatusRow(store: store)
                Button {
                    store.toggleDemo()
                } label: {
                    Label(store.isDemoRunning ? "Stop Demo Chat" : "Demo Chat",
                          systemImage: store.isDemoRunning ? "stop.circle" : "theatermasks")
                }
                .help("Fake YouTube and Twitch comments for rehearsing. Featuring one really shows it on the canvas.")
                Button {
                    showsOptions.toggle()
                } label: {
                    Label("Card Options", systemImage: "slider.horizontal.3")
                }
                .popover(isPresented: $showsOptions, arrowEdge: .bottom) {
                    CommentOptionsView(store: store)
                }
            }
        }
        .navigationTitle("Comments")
    }

    private var selectedComment: LiveComment? {
        guard let selectedID else { return nil }
        return store.comments.first { $0.id == selectedID }
            ?? store.shortlist.first { $0.id == selectedID }
    }
}

// MARK: - On air strip

private struct OnAirStrip: View {
    let store: CommentsStore

    var body: some View {
        HStack(spacing: 12) {
            Text("ON AIR")
                .font(.caption.weight(.heavy))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(store.featured == nil ? Color.secondary.opacity(0.25) : Color.red,
                            in: RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(.white)
            if let featured = store.featured {
                PlatformBadge(platform: featured.platform)
                VStack(alignment: .leading, spacing: 1) {
                    Text(featured.author).font(.callout.weight(.semibold))
                    Text(featured.text).font(.callout).lineLimit(1).foregroundStyle(.secondary)
                }
                Spacer()
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let remaining = store.autoHideRemaining(at: context.date) {
                        Text("hides in \(Int(remaining.rounded(.up)))s")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                Button("Hide") { store.hideFeatured() }
                    .keyboardShortcut(.cancelAction)
            } else {
                Text("Nothing on air. Select a comment, check the preview, then Feature on Air.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(store.featured == nil ? Color.clear : Color.red.opacity(0.08))
    }
}

// MARK: - Feed

private struct CommentFeed: View {
    let store: CommentsStore
    @Binding var selectedID: String?
    @Binding var platformFilter: StreamPlatform?
    @Binding var search: String

    @State private var isAtBottom = true
    @State private var unseen = 0

    private var visible: [LiveComment] {
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        return store.comments.filter { comment in
            (platformFilter == nil || comment.platform == platformFilter)
                && (query.isEmpty
                    || comment.text.lowercased().contains(query)
                    || comment.author.lowercased().contains(query))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            Divider()
            ScrollViewReader { proxy in
                ZStack(alignment: .bottom) {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if visible.isEmpty {
                                emptyState
                            }
                            ForEach(visible) { comment in
                                CommentRow(comment: comment,
                                           store: store,
                                           isSelected: selectedID == comment.id)
                                    .id(comment.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture { selectedID = comment.id }
                            }
                            Color.clear.frame(height: 1).id("feed-bottom")
                                .onAppear { isAtBottom = true; unseen = 0 }
                                .onDisappear { isAtBottom = false }
                        }
                        .padding(8)
                    }
                    if unseen > 0 {
                        Button {
                            withAnimation { proxy.scrollTo("feed-bottom", anchor: .bottom) }
                            unseen = 0
                        } label: {
                            Label("\(unseen) new", systemImage: "arrow.down")
                                .font(.callout.weight(.semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(.tint, in: Capsule())
                                .foregroundStyle(.white)
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 10)
                    }
                }
                // Follow the chat while reading the newest; hold still (and
                // count) while scrolled up reading something older.
                .onChange(of: store.comments.count) { old, new in
                    if isAtBottom {
                        proxy.scrollTo("feed-bottom", anchor: .bottom)
                    } else if new > old {
                        unseen += new - old
                    }
                }
            }
        }
    }

    private var filterBar: some View {
        HStack(spacing: 6) {
            FilterChip(title: "All", isOn: platformFilter == nil) { platformFilter = nil }
            ForEach(chipPlatforms, id: \.self) { platform in
                let reason = platform.commentsUnavailableReason
                FilterChip(title: platform.displayName,
                           tintHex: platform.tintHex,
                           isOn: platformFilter == platform,
                           isDisabled: reason != nil) {
                    platformFilter = platformFilter == platform ? nil : platform
                }
                .help(reason ?? "Only \(platform.displayName) comments")
            }
            Spacer(minLength: 8)
            TextField("Search", text: $search)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 180)
        }
        .padding(8)
    }

    /// YouTube and Twitch always (they have readable chat), plus whatever
    /// else is live right now, greyed out with the reason.
    private var chipPlatforms: [StreamPlatform] {
        var platforms: [StreamPlatform] = [.youtube, .twitch]
        for platform in store.livePlatforms where !platforms.contains(platform) {
            platforms.append(platform)
        }
        return platforms
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No comments yet")
                .font(.headline)
            Text("Comments from YouTube and Twitch appear here while you're live. LinkedIn, X, Instagram and TikTok don't let apps read live comments yet.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Press Demo Chat in the toolbar to rehearse with fake comments.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(16)
    }
}

private struct CommentRow: View {
    let comment: LiveComment
    let store: CommentsStore
    let isSelected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            PlatformBadge(platform: comment.platform)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(comment.author)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(comment.authorColorHex.map { Color(hex: $0) } ?? .primary)
                    if comment.isOwner { Tag(text: "HOST", color: .orange) }
                    if comment.isModerator { Tag(text: "MOD", color: .green) }
                    if let amount = comment.amount { Tag(text: amount, color: .yellow) }
                    Text(comment.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    if store.shownIDs.contains(comment.id) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .help("Already featured")
                    }
                }
                Text(comment.text)
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Button {
                store.toggleShortlist(comment)
            } label: {
                Image(systemName: store.isShortlisted(comment) ? "star.fill" : "star")
                    .foregroundStyle(store.isShortlisted(comment) ? Color.yellow : Color.secondary)
            }
            .buttonStyle(.plain)
            .help("Keep for later")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(isSelected ? Color.accentColor.opacity(0.18) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 6))
        .contextMenu {
            Button("Feature on Air") { store.feature(comment) }
            Button(store.isShortlisted(comment) ? "Remove from Shortlist" : "Add to Shortlist") {
                store.toggleShortlist(comment)
            }
            Divider()
            Button("Copy Text") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(comment.text, forType: .string)
            }
        }
    }
}

// MARK: - Shortlist

private struct ShortlistColumn: View {
    let store: CommentsStore
    @Binding var selectedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Shortlist", systemImage: "star.fill")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Spacer()
                Text("\(store.shortlist.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            if store.shortlist.isEmpty {
                Text("Star comments to line them up for a quiet moment.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                Spacer(minLength: 0)
            } else {
                List(selection: $selectedID) {
                    ForEach(store.shortlist) { comment in
                        HStack(alignment: .top, spacing: 6) {
                            PlatformBadge(platform: comment.platform)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(comment.author).font(.caption.weight(.semibold))
                                Text(comment.text).font(.callout).lineLimit(3)
                            }
                            Spacer(minLength: 0)
                            if store.shownIDs.contains(comment.id) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .tag(comment.id)
                        .contextMenu {
                            Button("Feature on Air") { store.feature(comment) }
                            Button("Remove") { store.removeFromShortlist(id: comment.id) }
                        }
                    }
                    .onMove { store.moveShortlist(fromOffsets: $0, toOffset: $1) }
                    .onDelete { offsets in
                        for index in offsets { store.removeFromShortlist(id: store.shortlist[index].id) }
                    }
                }
                .listStyle(.inset)
            }
        }
        .frame(minHeight: 180)
    }
}

// MARK: - Preview + Feature

private struct FeaturePanel: View {
    @Environment(StudioController.self) private var studio
    let store: CommentsStore
    let selected: LiveComment?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Preview")
                .font(.headline)
            if let selected {
                HStack(alignment: .bottom, spacing: 10) {
                    CommentCardPreview(comment: selected,
                                       style: store.style,
                                       canvas: studio.project.canvasSize,
                                       orientation: .horizontal)
                        .frame(height: 120)
                    CommentCardPreview(comment: selected,
                                       style: store.style,
                                       canvas: studio.project.resolvedVerticalCanvasSize,
                                       orientation: .vertical)
                        .frame(height: 120)
                }
                HStack {
                    Button {
                        store.toggleShortlist(selected)
                    } label: {
                        Label(store.isShortlisted(selected) ? "Starred" : "Star",
                              systemImage: store.isShortlisted(selected) ? "star.fill" : "star")
                    }
                    Spacer()
                    Button {
                        store.feature(selected)
                    } label: {
                        Label(store.featured?.id == selected.id ? "On Air" : "Feature on Air",
                              systemImage: "dot.radiowaves.left.and.right")
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(store.featured?.id == selected.id)
                }
                if store.shownIDs.contains(selected.id), store.featured?.id != selected.id {
                    Text("Already featured once.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Select a comment to see how it will look on air.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
            }
        }
        .padding(12)
    }
}

/// The card exactly where and how `CommentCard` will draw it, on a
/// miniature canvas: same layout math, same colors, fonts scaled down.
struct CommentCardPreview: View {
    let comment: LiveComment
    let style: CommentCardStyle
    let canvas: CGSize
    let orientation: StreamOrientation

    var body: some View {
        let layout = CommentCard.layout(for: comment, style: style, canvas: canvas, orientation: orientation)
        let aspect = canvas.height > 0 ? canvas.width / canvas.height : 16.0 / 9.0
        GeometryReader { geometry in
            let size = geometry.size
            // Pixels on the real canvas → points in this preview.
            let scale = size.height / max(canvas.height, 1)
            let messagePt = style.fontSize * layout.textReferenceHeight / 1080 * scale
            let nameColor = style.usesPlatformTint
                ? Color(hex: comment.platform.tintHex)
                : style.textColor.swiftUIColor
            ZStack(alignment: .topLeading) {
                Rectangle().fill(Color.black.opacity(0.85))
                Image(systemName: "person.fill")
                    .font(.system(size: size.height * 0.4))
                    .foregroundStyle(.white.opacity(0.08))
                    .frame(width: size.width, height: size.height)
                RoundedRectangle(cornerRadius: 0.012 * size.width)
                    .fill(style.boxColor.swiftUIColor)
                    .frame(width: layout.box.size.width * size.width,
                           height: layout.box.size.height * size.height)
                    .position(x: layout.box.center.x * size.width, y: layout.box.center.y * size.height)
                Text(CommentCard.nameLine(for: comment))
                    .font(.system(size: max(messagePt * 0.72, 3), weight: .semibold))
                    .foregroundStyle(nameColor)
                    .lineLimit(1)
                    .frame(width: layout.name.size.width * size.width,
                           height: layout.name.size.height * size.height,
                           alignment: .leading)
                    .position(x: layout.name.center.x * size.width, y: layout.name.center.y * size.height)
                Text(layout.messageText)
                    .font(.system(size: max(messagePt, 3), weight: .semibold))
                    .foregroundStyle(style.textColor.swiftUIColor)
                    .frame(width: layout.message.size.width * size.width,
                           height: layout.message.size.height * size.height,
                           alignment: .leading)
                    .position(x: layout.message.center.x * size.width, y: layout.message.center.y * size.height)
            }
            .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .aspectRatio(aspect, contentMode: .fit)
        .overlay(alignment: .topLeading) {
            Text(orientation.shortName)
                .font(.caption2.weight(.bold))
                .padding(3)
                .foregroundStyle(.white.opacity(0.7))
        }
    }
}

// MARK: - Options

private struct CommentOptionsView: View {
    @Bindable var store: CommentsStore

    var body: some View {
        Form {
            Picker("Auto-hide", selection: $store.autoHideSeconds) {
                Text("Off").tag(0.0)
                Text("8 seconds").tag(8.0)
                Text("15 seconds").tag(15.0)
                Text("30 seconds").tag(30.0)
                Text("1 minute").tag(60.0)
            }
            Toggle("Hide when the scene changes", isOn: $store.hidesOnSceneChange)
            Divider()
            Picker("Position", selection: $store.style.position) {
                ForEach(CommentCardStyle.Position.allCases, id: \.self) { position in
                    Text(position.displayName).tag(position)
                }
            }
            Slider(value: $store.style.fontSize, in: 24...72, step: 2) {
                Text("Text size")
            }
            ColorPicker("Card color", selection: Binding(
                get: { store.style.boxColor.swiftUIColor },
                set: { store.style.boxColor = RGBAColor($0) }
            ))
            ColorPicker("Text color", selection: Binding(
                get: { store.style.textColor.swiftUIColor },
                set: { store.style.textColor = RGBAColor($0) }
            ), supportsOpacity: false)
            Toggle("Name in the platform's color", isOn: $store.style.usesPlatformTint)
            Button("Reset Style") { store.style = CommentCardStyle() }
        }
        .formStyle(.grouped)
        .frame(width: 340)
        .padding(.vertical, 4)
    }
}

// MARK: - Bits

private struct SourceStatusRow: View {
    let store: CommentsStore

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(store.sourceStatus.keys).sorted { $0.uuidString < $1.uuidString }, id: \.self) { id in
                if let entry = store.sourceStatus[id] {
                    HStack(spacing: 4) {
                        PlatformBadge(platform: entry.platform)
                        Circle()
                            .fill(color(for: entry.status))
                            .frame(width: 6, height: 6)
                    }
                    .help("\(entry.platform.displayName): \(entry.status.label)")
                }
            }
        }
    }

    private func color(for status: CommentSourceStatus) -> Color {
        switch status {
        case .connected: .green
        case .connecting, .waiting: .yellow
        case .failed: .red
        }
    }
}

struct PlatformBadge: View {
    let platform: StreamPlatform

    var body: some View {
        Image(systemName: platform.symbol)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(Color(hex: platform.tintHex), in: Circle())
            .help(platform.displayName)
    }
}

private struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(color.opacity(0.25), in: RoundedRectangle(cornerRadius: 3))
            .foregroundStyle(color)
    }
}

private struct FilterChip: View {
    let title: String
    var tintHex: String?
    let isOn: Bool
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(isOn ? (tintHex.map { Color(hex: $0) } ?? Color.accentColor).opacity(0.35)
                                 : Color.secondary.opacity(0.12),
                            in: Capsule())
                .foregroundStyle(isDisabled ? Color.secondary.opacity(0.5) : Color.primary)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
    }
}
