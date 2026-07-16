// AUTO-GENERATED from gstack/ios-qa/templates/DebugBridgeManager.swift.template
//
// Bootstraps StateServer on app launch. Lives in DebugBridgeCore (no UIKit
// dependency). The DebugOverlay install is wired separately by the consuming
// app — it lives in DebugBridgeUI which depends on DebugBridgeCore (not the
// other way around). Everything is #if DEBUG-gated; this file does not exist
// in Release builds.

#if DEBUG

import Foundation

@MainActor
public final class DebugBridgeManager {
    public static let shared = DebugBridgeManager()

    /// Register app-owned generated accessors, then start the server. The
    /// registration closure is passed in from the consuming app because the
    /// DebugBridgeCore package cannot import app-target types. On UIKit apps,
    /// call DebugBridgeUIWiring.installAll() before this method so a warm
    /// daemon cannot reach uninitialized resolvers during listener startup.
    public func start<State>(appState: State, register: (State) -> Void) {
        register(appState)

        // Boot only after registration so the first snapshot has a real build
        // id, schema hash, and key set.
        StateServer.shared.start()

        // 3. The consuming app installs DebugOverlayWindow separately. See
        //    the example in DebugBridgeWiring.swift.template:
        //
        //      #if canImport(UIKit)
        //      DebugOverlayWindow.shared.install(recording: recording)
        //      #endif
    }
}

#endif // DEBUG
