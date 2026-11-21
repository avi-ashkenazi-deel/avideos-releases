// swift-tools-version:5.9
import PackageDescription

// Pure-Foundation rules engine for Scenery: manifest parsing, validation and
// "which wallpaper goes on which display" resolution. No AppKit, so it can be
// unit-tested anywhere with `swift test`.
let package = Package(
    name: "SceneryCore",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SceneryCore", targets: ["SceneryCore"]),
    ],
    targets: [
        .target(name: "SceneryCore"),
        .testTarget(name: "SceneryCoreTests", dependencies: ["SceneryCore"]),
    ]
)
