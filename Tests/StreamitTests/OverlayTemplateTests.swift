import XCTest
@testable import Streamit

final class OverlayTemplateTests: XCTestCase {
    func testExportExcludesInstanceContentAndImportHasIndependentIdentity() throws {
        let design = OverlayTemplate.builtIns[0]
        let instance = design.elements(primary: "Private caller", secondary: "Private subtitle")
        let data = try design.exported()
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("Private caller"))
        let imported = try OverlayTemplate.imported(data)
        XCTAssertNotEqual(design.id, imported.id)
        XCTAssertEqual(design.fontName, imported.fontName)
        XCTAssertEqual(design.background, imported.background)
        XCTAssertEqual(instance.filter { $0.overlayField != nil }.count, 2)
        XCTAssertTrue(instance.allSatisfy { !$0.isVisible })
    }
    func testInstancesNeverShareLayerOrGroupIdentity() {
        let design = OverlayTemplate.builtIns[1]
        let first = design.elements(primary: "One", secondary: "Author")
        let second = design.elements(primary: "Two", secondary: "Author")
        XCTAssertNotEqual(first[0].overlayInstanceID, second[0].overlayInstanceID)
        XCTAssertTrue(Set(first.map(\.id)).isDisjoint(with: Set(second.map(\.id))))
        XCTAssertEqual(Set(first.compactMap(\.overlayInstanceID)).count, 1)
    }
    func testShowRoundTripKeepsDesignAndTextSeparate() throws {
        let design = OverlayTemplate.builtIns[1]
        var project = Project.starter()
        project.overlayTemplates = [design]; project.liveCommentTemplate = design
        project.scenes[0].elements = design.elements(primary: "Hello", secondary: "A viewer")
        let decoded = try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(project))
        XCTAssertEqual(project, decoded)
        XCTAssertEqual(decoded.liveCommentTemplate?.commentStyle.fontName, design.fontName)
    }
    func testOldProjectWithoutTemplatesStillLoads() throws {
        let original = Project.starter()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Project.self, from: data)
        XCTAssertNil(decoded.overlayTemplates)
        XCTAssertNil(decoded.liveCommentTemplate)
    }
    func testRejectsUnsupportedAndInvalidDesigns() throws {
        var template = OverlayTemplate.builtIns[0]
        template.schemaVersion = 2
        XCTAssertThrowsError(try OverlayTemplate.imported(JSONEncoder().encode(template)))
        template.schemaVersion = 1; template.fontSize = -1
        XCTAssertThrowsError(try template.validate())
        XCTAssertThrowsError(try OverlayTemplate.imported(Data(repeating: 32, count: 64_001)))
    }
}
