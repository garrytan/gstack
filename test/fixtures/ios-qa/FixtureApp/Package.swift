// swift-tools-version:5.9
// Test fixture: minimal SwiftUI app + DebugBridge SPM package.
// DebugBridgeCore (Foundation+Network) builds cross-platform.
// DebugBridgeUI (UIKit/SwiftUI) is iOS-only.
// DebugBridgeTouch (Objective-C) is iOS-only — in-process tap synthesis
// derived from KIF (MIT). DEBUG-only.

import PackageDescription

let package = Package(
    name: "FixtureApp",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "DebugBridgeCore", targets: ["DebugBridgeCore"]),
        .library(name: "DebugBridgeUI", targets: ["DebugBridgeUI"]),
        .library(name: "DebugBridgeTouch", targets: ["DebugBridgeTouch"]),
    ],
    targets: [
        .target(
            name: "DebugBridgeCore",
            dependencies: [],
            path: "Sources/DebugBridgeCore",
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ]
        ),
        .target(
            name: "DebugBridgeTouch",
            dependencies: [],
            path: "Sources/DebugBridgeTouch",
            publicHeadersPath: "include",
            cSettings: [
                // DEBUG gate for the Obj-C translation unit. swiftSettings do
                // NOT propagate to .m files, so without this the private
                // UITouch/UIEvent/IOKit SPIs in DebugBridgeTouch.m would
                // compile into Release builds and trip Apple's static API
                // scanner (App Store Guideline 2.1). Pairs with the
                // `#if TARGET_OS_IOS && defined(DEBUG)` gate in the .m file.
                .define("DEBUG", to: "1", .when(configuration: .debug)),
            ],
            linkerSettings: [
                .linkedFramework("UIKit", .when(platforms: [.iOS])),
            ]
        ),
        .target(
            name: "DebugBridgeUI",
            dependencies: ["DebugBridgeCore", "DebugBridgeTouch"],
            path: "Sources/DebugBridgeUI",
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ]
        ),
        .testTarget(
            name: "DebugBridgeCoreTests",
            dependencies: ["DebugBridgeCore"],
            path: "Tests/DebugBridgeCoreTests"
        ),
    ]
)
