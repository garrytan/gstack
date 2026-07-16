// swift-tools-version:5.9
// AUTO-GENERATED from gstack/ios-qa/templates/Package.swift.template
//
// Drop-in SPM package definition for the DebugBridge stack. Three targets:
//
//   - DebugBridgeCore   Swift, cross-platform (Foundation + Network).
//                       Hosts the StateServer + bridge protocols.
//   - DebugBridgeTouch  Objective-C, iOS-only. KIF-derived in-process touch
//                       synthesis (UITouch + IOHIDEvent + iOS 18
//                       _UIHitTestContext for SwiftUI Buttons).
//   - DebugBridgeUI     Swift, iOS-only. ScreenshotBridge, ElementsBridge,
//                       MutationBridge implementations. Depends on the other
//                       two.
//
// The structural Release-build guard is the `.when(configuration: .debug)`
// conditional on every consuming target's dependency. SwiftPM refuses to link
// DebugBridge* in Release config.
//
// CI invariant: `swift build -c release` + `nm -j build/Release/<binary>
// | grep -q DebugBridge && exit 1`.

import PackageDescription

let package = Package(
    name: "DebugBridge",
    platforms: [.iOS(.v16), .macOS(.v13)],
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
            linkerSettings: [
                // IOKit is loaded dynamically via dlopen at runtime (it's a
                // private framework on iOS and can't be linked statically).
                // UIKit links normally.
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
    ]
)
