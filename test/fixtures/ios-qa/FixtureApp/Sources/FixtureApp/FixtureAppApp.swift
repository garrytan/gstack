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

#if canImport(UIKit)
import UIKit
#endif

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
            #if canImport(UIKit)
            FixtureButton(counter: $counter)
                .frame(minWidth: 120, minHeight: 44)
            #else
            Button("Tap (\(counter))") { counter += 1 }
                .accessibilityIdentifier("tap-button")
            #endif
        }
        .padding()
        .accessibilityIdentifier("fixture-content")
    }
}

#if canImport(UIKit)
/// A real UIKit control inside the SwiftUI fixture. The DebugBridge scanner is
/// intentionally in-process (not XCTest's private accessibility daemon), so a
/// UIViewRepresentable gives the physical-device lane a public, enumerable
/// accessibility element while still exercising SwiftUI state updates.
struct FixtureButton: UIViewRepresentable {
    @Binding var counter: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.configuration = .borderedProminent()
        button.accessibilityIdentifier = "tap-button"
        button.addTarget(context.coordinator, action: #selector(Coordinator.tap), for: .touchUpInside)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.parent = self
        button.setTitle("Tap (\(counter))", for: .normal)
        button.accessibilityLabel = "Tap (\(counter))"
    }

    final class Coordinator: NSObject {
        var parent: FixtureButton
        init(_ parent: FixtureButton) { self.parent = parent }
        @objc func tap() { parent.counter += 1 }
    }
}
#endif
