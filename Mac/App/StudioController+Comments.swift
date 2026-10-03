import Foundation
import CoreMedia

/// Live comments: which chat to read for each destination that goes live,
/// and the featured card on both canvases.
///
/// Nothing here puts a comment on air by itself. `CommentsStore.feature(_:)`
/// is the only way in, and only the Comments window calls it.
extension StudioController {
    /// Called once from `wireSubsystems`.
    func wireLiveComments() {
        live.broadcastPreparer = { destination in
            try await YouTubeLiveService.prepare(destination: destination)
        }
        live.onDestinationLive = { [weak self] destination, liveChatID in
            self?.startComments(for: destination, liveChatID: liveChatID)
        }
        live.onDestinationStopped = { [weak self] id in
            self?.comments.detach(destinationID: id)
        }
        comments.onFeaturedChanged = { [weak self] in
            self?.featuredCommentDidChange()
        }
    }

    /// Picks the chat reader for a destination that just went live.
    private func startComments(for destination: StreamDestination, liveChatID: String?) {
        switch destination.platform {
        case .youtube:
            comments.attach(YouTubeChatSource(liveChatID: liveChatID, destinationID: destination.id),
                            destinationID: destination.id)
        case .twitch:
            if let channel = destination.twitchChannel,
               let source = TwitchChatSource(channel: channel, destinationID: destination.id) {
                comments.attach(source, destinationID: destination.id)
            } else {
                comments.setStatus(.failed("Add your Twitch channel name to this destination to read chat."),
                                   platform: .twitch, destinationID: destination.id)
            }
        default:
            comments.noteUnsupported(platform: destination.platform, destinationID: destination.id)
        }
    }

    /// The card items for one canvas: the one leaving (if a new comment
    /// just replaced it, or it was hidden) and the one on air.
    func commentOverlayItems(for orientation: StreamOrientation) -> [RenderItem] {
        let canvas = orientation == .vertical ? project.resolvedVerticalCanvasSize : project.canvasSize
        var items: [RenderItem] = []
        if let exiting = exitingCommentCard {
            items += CommentCard.items(for: exiting.comment,
                                       style: comments.style,
                                       canvas: canvas,
                                       orientation: orientation,
                                       animation: .exiting(startSeconds: exiting.startSeconds))
        }
        if let card = commentCard {
            items += CommentCard.items(for: card,
                                       style: comments.style,
                                       canvas: canvas,
                                       orientation: orientation,
                                       animation: commentCardAnimation)
        }
        return items
    }

    /// The scene is about to switch: clear the card if the host asked for that.
    func commentSceneWillChange() {
        guard comments.hidesOnSceneChange, comments.featured != nil else { return }
        comments.hideFeatured()
    }

    /// Feature/hide/replace: animates the old card out and the new one in
    /// on every canvas, then settles.
    private func featuredCommentDidChange() {
        let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
        let next = comments.featured
        if next?.id != commentCard?.id {
            if let current = commentCard {
                exitingCommentCard = (current, now)
            }
            commentCard = next
            commentCardAnimation = next == nil ? .resting : .entering(startSeconds: now)
        }
        recompileAndPublish()
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.45))
            guard let self else { return }
            let settled = CMClockGetTime(CMClockGetHostTimeClock()).seconds
            if let exiting = self.exitingCommentCard, settled - exiting.startSeconds >= 0.35 {
                self.exitingCommentCard = nil
            }
            if case .entering(let start) = self.commentCardAnimation, settled - start >= 0.35 {
                self.commentCardAnimation = .resting
            }
            self.recompileAndPublish()
        }
    }
}
