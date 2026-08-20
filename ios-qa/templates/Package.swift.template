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
// Release-build guards, in order of reliability:
//
//   1. SOURCE. Every file is `#if DEBUG` guarded, including DebugBridgeTouch.m,
//      which holds regardless of how the package is integrated. This is the one
//      that actually protects you.
//   2. `.when(configuration: .debug)` on the consuming target's dependency. This
//      works for SwiftPM consumers ONLY. An app integrating this as a local
//      package inside an .xcodeproj CANNOT express it — Xcode's Filters column in
//      Frameworks/Libraries offers platform conditions, never configuration — so
//      do not rely on it alone.
//
// Guard 1 was added 2026-08-15 after a measured failure: DebugBridgeTouch.m was
// guarded only by `#if TARGET_OS_IOS`, so a Release iOS build of a real app linked
// it, and `nm -j` returned 15 DebugBridge symbols plus IOHIDEventCreateDigitizer,
// AXSSetAutomationEnabled and IOKit.framework strings. Guideline 2.5.1 exposure in
// a shippable binary, with guard 2 present and doing nothing.
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
            cSettings: [
                // Explicit, because the source guard depends on it. SwiftPM's
                // implicit DEBUG for C-family targets is not something to bet a
                // private-API exposure on — the two Swift targets already declare
                // it, and this target is the one that actually links private API.
                .define("DEBUG", .when(configuration: .debug)),
            ],
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
