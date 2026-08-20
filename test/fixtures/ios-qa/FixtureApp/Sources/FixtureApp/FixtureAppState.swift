// Canonical observable app state for the fixture. Snapshot eligibility is a
// generator-only source marker, not a property wrapper, so it composes with
// Observation's @Observable macro.

import Foundation
import Observation

@Observable
final class FixtureAppState {
    // @Snapshotable
    var isLoggedIn: Bool = false
    // @Snapshotable
    var username: String = ""
    // @Snapshotable
    var tapCounter: Int = 0
    // @Snapshotable
    var nickname: String? = nil
    /// Not snapshotted — ephemeral cache that should never leak via /state/snapshot.
    var ephemeralCache: [String: String] = [:]

    init() {}
}
