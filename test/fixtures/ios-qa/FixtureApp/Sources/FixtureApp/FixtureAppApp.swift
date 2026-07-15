// FixtureApp — minimal SwiftUI app used by the ios-qa device-path E2E test.
//
// On launch:
//   1. Boot StateServer (loopback :::1/127.0.0.1 + 9999)
//   2. Log boot token to os_log so devicectl + the Mac daemon can scrape it
//   3. Render a single ContentView so the app stays foreground
//
// Everything ios-qa-related is gated #if DEBUG. Release builds compile this
// to a no-op app (no StateServer, no DebugBridge import, no overlay).

import SwiftUI

#if DEBUG
import DebugBridgeCore
#endif

#if DEBUG && canImport(UIKit)
import DebugBridgeUI
#endif

@main
struct FixtureAppApp: App {
    init() {
        #if DEBUG
        StateServer.shared.start()
        // Wire the three UIKit-backed bridges so /screenshot, /elements,
        // /tap, /type, /swipe actually do something on the device.
        #if canImport(UIKit)
        DebugBridgeUIWiring.installAll()
        #endif
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    @State private var counter: Int = 0

    var body: some View {
        VStack(spacing: 24) {
            Text("ios-qa fixture")
                .font(.largeTitle.bold())
            Text("StateServer should be on :9999")
                .font(.subheadline)
                .foregroundColor(.secondary)
            Button("Tap (\(counter))") {
                counter += 1
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("tap-button")
        }
        .padding()
        .accessibilityIdentifier("fixture-content")
    }
}
