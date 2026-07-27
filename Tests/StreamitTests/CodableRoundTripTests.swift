import XCTest
@testable import Streamit

/// Pins down the persistence and wire contracts: project documents must
/// survive a save/load cycle unchanged, and the podcast manifest decoder must
/// accept exactly what `infra/worker/src/manifest.ts` writes — including the
/// optional fields guests omit.
final class CodableRoundTripTests: XCTestCase {

    // MARK: Studio document

    func testProjectRoundTripsUnchanged() throws {
        var project = Project(name: "Round Trip")
        var scene = SceneModel(name: "Camera", kind: .camera(CameraSceneConfig()))
        var text = Element(name: "Lower third", kind: .text(TextContent(string: "Hello")))
        text.transform = ElementTransform(center: CGPoint(x: 0.25, y: 0.75),
                                          size: CGSize(width: 0.4, height: 0.2),
                                          rotation: 0.2,
                                          opacity: 0.8)
        text.blendMode = .multiply
        scene.elements = [text]
        project.scenes = [scene]
        project.activeSceneID = scene.id

        let decoded = try roundTrip(project)
        XCTAssertEqual(decoded, project)
        XCTAssertEqual(decoded.scenes.first?.elements.first?.transform.opacity, 0.8)
    }

    func testSceneKindsAllRoundTrip() throws {
        let kinds: [SceneKind] = [
            .camera(CameraSceneConfig()),
            .screenShare(ScreenSceneConfig()),
            .movie(MovieSceneConfig()),
            .interview(InterviewSceneConfig()),
        ]
        for kind in kinds {
            let scene = SceneModel(name: "S", kind: kind)
            XCTAssertEqual(try roundTrip(scene), scene,
                           "\(kind.displayName) must survive encoding")
        }
    }

    func testElementKindsRoundTrip() throws {
        let kinds: [ElementKind] = [
            .text(TextContent(string: "Hi")),
            .shape(ShapeContent()),
            .image(MediaReference(url: URL(fileURLWithPath: "/tmp/logo.png"))),
        ]
        for kind in kinds {
            let element = Element(name: kind.displayName, kind: kind)
            XCTAssertEqual(try roundTrip(element), element,
                           "\(kind.displayName) must survive encoding")
        }
    }

    func testBlendModesAllRoundTrip() throws {
        for mode in BlendMode.allCases {
            var element = Element(name: "Shape", kind: .shape(ShapeContent()))
            element.blendMode = mode
            XCTAssertEqual(try roundTrip(element), element, "\(mode) must survive encoding")
        }
    }

    // MARK: Edit project

    func testEditProjectRoundTripsIncludingCuesChaptersAndCaptions() throws {
        var project = EditProject(sessionId: "sess-1",
                                  name: "Episode 1",
                                  tracks: [makeTrack(id: "t1", kind: .video),
                                           makeTrack(id: "t2", kind: .audio)])
        project.edl.deleteRange(10...20, label: .cutFiller)
        project.layoutCues = [LayoutCue(atTime: 0, layout: .grid),
                              LayoutCue(atTime: 30, layout: .fullScreen(participantId: "p1"))]
        project.chapters = [Chapter(title: "Intro", startTime: 0),
                            Chapter(title: "Main", startTime: 45)]
        project.captions = .karaoke

        let decoded = try roundTrip(project)
        XCTAssertEqual(decoded, project)
        XCTAssertEqual(decoded.edl.editedDuration, project.edl.editedDuration, accuracy: 1e-9)
    }

    func testEditProjectRoundTripsCropPaths() throws {
        var project = EditProject(sessionId: "sess-1", name: "Reframed",
                                  tracks: [makeTrack(id: "t1", kind: .video)])
        project.cropPaths = [
            "p1": [CropKeyframe(time: 0, rect: CGRect(x: 0.2, y: 0, width: 0.5625, height: 1),
                                isManual: false),
                   CropKeyframe(time: 2, rect: CGRect(x: 0.3, y: 0, width: 0.5625, height: 1),
                                isManual: true)],
        ]
        let decoded = try roundTrip(project)
        XCTAssertEqual(decoded.cropPaths?["p1"]?.count, 2)
        XCTAssertEqual(decoded.cropPaths?["p1"]?.last?.isManual, true)
        XCTAssertEqual(decoded, project)
    }

    func testEditProjectDecodesWithoutCropPathsField() throws {
        // Projects written before smart reframe existed have no cropPaths key.
        var project = EditProject(sessionId: "s", name: "Old",
                                  tracks: [makeTrack(id: "t1", kind: .audio)])
        project.cropPaths = nil
        let data = try JSONEncoder().encode(project)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertFalse(json.contains("cropPaths"),
                       "a nil optional must not be written, so old and new files agree")
        let decoded = try JSONDecoder().decode(EditProject.self, from: data)
        XCTAssertNil(decoded.cropPaths)
    }

    func testCaptionStylePresetsRoundTrip() throws {
        for preset in CaptionStyle.presets {
            XCTAssertEqual(try roundTrip(preset.style), preset.style, "\(preset.name)")
        }
    }

    func testCaptionTemplateRoundTripsAndBuiltInsMatchPresets() throws {
        let template = CaptionTemplate(name: "Mine", style: .boxed)
        XCTAssertEqual(try roundTrip(template), template)
        XCTAssertEqual(CaptionTemplate.builtIns.count, CaptionStyle.presets.count)
        XCTAssertTrue(CaptionTemplate.builtIns.allSatisfy(\.isBuiltIn))
    }

    // MARK: Podcast manifest (wire contract)

    /// Exactly the shape `manifest.ts` writes: tracks are an ARRAY, takes may
    /// lack `startedAtSession`, guest anchors carry no `uncertaintyMs`, and
    /// guest timeline entries carry no `mediaTimeMs`.
    private let workerManifestJSON = """
    {
      "id": "sess-abc",
      "createdAt": "2026-07-26T10:00:00Z",
      "displayName": "Episode 12",
      "participants": [
        { "id": "host-1", "displayName": "Avi", "role": "host" },
        { "id": "guest-1", "displayName": "Dana", "role": "guest" }
      ],
      "takes": [
        {
          "id": "take-1",
          "startedAtSession": 1200.5,
          "tracks": [
            {
              "participantId": "host-1",
              "kind": "video",
              "anchor": { "mediaTimeMs": 0, "sessionTimeMs": 1200.5, "uncertaintyMs": 8 },
              "chunkCount": 4,
              "chunkTimeline": [
                { "chunkIndex": 0, "mediaTimeMs": 0, "sessionTimeMs": 1200.5 },
                { "chunkIndex": 6, "mediaTimeMs": 30000, "sessionTimeMs": 31200.5 }
              ],
              "finalized": true,
              "mimeType": "video/quicktime",
              "width": 3840,
              "height": 2160
            },
            {
              "participantId": "guest-1",
              "kind": "audio",
              "anchor": { "mediaTimeMs": 0, "sessionTimeMs": 1350 },
              "chunkCount": 2,
              "chunkTimeline": [
                { "chunkIndex": 0, "sessionTimeMs": 1350 },
                { "chunkIndex": 6, "sessionTimeMs": 31350 }
              ],
              "mimeType": "audio/webm;codecs=opus"
            }
          ]
        },
        {
          "id": "take-2",
          "tracks": []
        }
      ]
    }
    """

    func testWorkerManifestDecodes() throws {
        let data = Data(workerManifestJSON.utf8)
        let manifest = try PodcastAPIClient.decoder.decode(RemoteManifest.self, from: data)
        XCTAssertEqual(manifest.resolvedId, "sess-abc")
        XCTAssertEqual(manifest.participants?.count, 2)
        XCTAssertEqual(manifest.takes?.count, 2)
        XCTAssertEqual(manifest.takes?.first?.tracks?.count, 2,
                       "tracks are an array on the wire, not a map")
    }

    func testTakeWithoutStartedAtSessionDecodes() throws {
        let data = Data(workerManifestJSON.utf8)
        let manifest = try PodcastAPIClient.decoder.decode(RemoteManifest.self, from: data)
        let second = try XCTUnwrap(manifest.takes?.last)
        XCTAssertEqual(second.id, "take-2")
        XCTAssertNil(second.startedAtSession,
                     "manifest.ts creates take rows implicitly, without a start time")
    }

    func testGuestTrackOmitsUncertaintyAndMediaTime() throws {
        let data = Data(workerManifestJSON.utf8)
        let manifest = try PodcastAPIClient.decoder.decode(RemoteManifest.self, from: data)
        let tracks = try XCTUnwrap(manifest.takes?.first?.tracks)
        let guest = try XCTUnwrap(tracks.first { $0.participantId == "guest-1" })
        XCTAssertNil(guest.anchor?.uncertaintyMs, "browsers do not estimate this")
        XCTAssertNil(guest.chunkTimeline?.first?.mediaTimeMs, "browsers stamp session time only")
        XCTAssertNil(guest.finalized, "absent while the guest is still uploading")
    }

    func testManifestConvertsToTheAppModelWithDefaults() throws {
        let data = Data(workerManifestJSON.utf8)
        let manifest = try PodcastAPIClient.decoder.decode(RemoteManifest.self, from: data)
        let session = manifest.toRecordingSession()

        XCTAssertEqual(session.id, "sess-abc")
        XCTAssertEqual(session.participants.count, 2)
        XCTAssertEqual(session.takes.count, 2)

        let take = try XCTUnwrap(session.takes.first { $0.id == "take-1" })
        XCTAssertEqual(take.startedAtSession, 1200.5, accuracy: 1e-9)
        XCTAssertEqual(take.tracks.count, 2)

        let guest = try XCTUnwrap(take.tracks.first { $0.participantId == "guest-1" })
        XCTAssertFalse(guest.finalized, "a missing `finalized` defaults to not-finished")
        XCTAssertEqual(guest.chunkCount, 2)

        let implicit = try XCTUnwrap(session.takes.first { $0.id == "take-2" })
        XCTAssertEqual(implicit.startedAtSession, 0, accuracy: 1e-9,
                       "a missing start time becomes 0 rather than failing the decode")
    }

    func testTracksMissingTheirIdentityPairAreDropped() throws {
        let json = """
        {
          "id": "s",
          "createdAt": "2026-07-26T10:00:00Z",
          "participants": [],
          "takes": [{ "id": "t", "tracks": [
             { "kind": "audio" },
             { "participantId": "p1" },
             { "participantId": "p1", "kind": "audio" }
          ] }]
        }
        """
        let manifest = try PodcastAPIClient.decoder.decode(RemoteManifest.self, from: Data(json.utf8))
        let session = manifest.toRecordingSession()
        XCTAssertEqual(session.takes.first?.tracks.count, 1,
                       "only the fully identified track survives")
    }

    func testEmptyManifestDecodes() throws {
        let json = #"{ "id": "s", "createdAt": "2026-07-26T10:00:00Z", "participants": [], "takes": [] }"#
        let manifest = try PodcastAPIClient.decoder.decode(RemoteManifest.self, from: Data(json.utf8))
        let session = manifest.toRecordingSession()
        XCTAssertTrue(session.takes.isEmpty)
        XCTAssertTrue(session.participants.isEmpty)
    }

    func testRecordingModelsRoundTrip() throws {
        let track = TrackRecord(participantId: "p1",
                                kind: .video,
                                anchor: ClockAnchor(mediaTimeMs: 0, sessionTimeMs: 500,
                                                    uncertaintyMs: 12),
                                chunkCount: 3,
                                chunkTimeline: [ChunkStamp(chunkIndex: 0, mediaTimeMs: 0,
                                                           sessionTimeMs: 500)],
                                finalized: true,
                                mimeType: "video/quicktime",
                                width: 1920,
                                height: 1080,
                                localURL: URL(fileURLWithPath: "/tmp/p1.mov"))
        let take = TakeRecord(id: "take-1", startedAtSession: 500, tracks: [track])
        let session = RecordingSession(id: "s1",
                                       createdAt: Date(timeIntervalSince1970: 1_700_000_000),
                                       livekitRoom: "room-1",
                                       participants: [SessionParticipant(id: "p1",
                                                                         displayName: "Avi",
                                                                         role: .host)],
                                       takes: [take])

        let data = try JSONEncoder().encode(session)
        let decoded = try JSONDecoder().decode(RecordingSession.self, from: data)
        XCTAssertEqual(decoded.id, session.id)
        XCTAssertEqual(decoded.takes.first?.tracks.first?.width, 1920)
        XCTAssertEqual(decoded.takes.first?.tracks.first?.anchor?.uncertaintyMs, 12)
        XCTAssertEqual(decoded.participants.first?.role, .host)
    }

    // MARK: Helpers

    private func roundTrip<T: Codable & Equatable>(_ value: T) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func makeTrack(id: String, kind: TrackKind) -> EditTrack {
        EditTrack(id: id,
                  participantId: "p1",
                  participantName: "Avi",
                  kind: kind,
                  url: URL(fileURLWithPath: "/tmp/\(id).mov"),
                  duration: 120)
    }
}
