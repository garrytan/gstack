// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DebugBridge",
    platforms: [.iOS(.v17)],
    products: [
        .library(
            name: "DebugBridge",
            targets: ["DebugBridge"]
        ),
    ],
    targets: [
        .target(
            name: "DebugBridge",
            dependencies: [],
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug))
            ]
        ),
    ]
)
