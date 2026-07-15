// Canonical app state for the fixture. Every snapshot-eligible field is
// marked with the @Snapshotable property wrapper that the codegen tool
// detects via attribute scan.
//
// Note: we DON'T use @Observable here because the macro expansion converts
// stored properties into computed ones, which the @Snapshotable wrapper
// can't apply to. In production apps that need both observability AND
// snapshotting, the right pattern is:
//   - Use ObservableObject + @Published (older API), or
//   - Hold all @Snapshotable state in a nested struct + replace it
//     wholesale on restore so SwiftUI sees a single change notification
//     (the canonical-state-struct atomicity strategy from the plan).

import Foundation

public final class FixtureAppState {
    @Snapshotable public var isLoggedIn: Bool = false
    @Snapshotable public var username: String = ""
    @Snapshotable public var tapCounter: Int = 0
    /// Not snapshotted — ephemeral cache that should never leak via /state/snapshot.
    public var ephemeralCache: [String: String] = [:]

    public init() {}
}

/// Property wrapper marker for snapshot-eligible state. The actual wrapper
/// is a no-op at runtime; codegen-tool detection happens via attribute scan.
@propertyWrapper
public struct Snapshotable<Value> {
    public var wrappedValue: Value
    public init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
}
