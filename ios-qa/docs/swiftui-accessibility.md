# SwiftUI accessibility tree — known limitation + escape hatch

## The problem

`GET /elements` walks `UIWindow.subviews` and emits a JSON list of
accessibility nodes. For UIKit-native screens this works fine. For
**SwiftUI screens**, the walker historically returned only the top-level
hosting containers — three entries for a Dashboard, all named some
variation of `_UIHostingView<ModifiedContent<…>>`, with no identifiers,
no labels, no frames you'd want to tap.

Example bug output (Principal's Ear Dashboard, iPhone 12 Pro / iOS 26.x,
before the fix in this PR):

```json
[
  {"class":"_UIHostingView<ModifiedContent<AnyView, …>>", "identifier":"", "label":"", "frame":{"x":0,"y":0,"w":390,"h":844}},
  {"class":"HostingView", "identifier":"", "label":"", "frame":{"x":0,"y":0,"w":390,"h":844}},
  {"class":"FloatingBarHostingView<FloatingBarContainer…>", "identifier":"", "label":"", "frame":{"x":0,"y":0,"w":390,"h":844}}
]
```

The Dashboard had a `CaptureControlCard` button with
`.accessibilityIdentifier("dashboard.captureButton")`, a settings
NavigationLink with `"dashboard.settingsButton"`, and a
`ContentUnavailableView`. None of them surfaced.

## Root cause

SwiftUI doesn't always create a backing `UIView` for declarative views.
Many "views" are synthetic accessibility elements with no
`UIView` representation — they only exist as nodes vended through
`_UIHostingView`'s `accessibilityElement(at:)` indexed accessor, and the
hosting view returns `nil` (or `[]`) for `accessibilityElements`. The
previous walker checked `accessibilityElements` first and only fell
through to the indexed accessor if that returned `nil` — it didn't
handle the empty-array case, which is what SwiftUI actually returns.

Worse: the AX tree is lazy. SwiftUI doesn't populate it until something
(typically VoiceOver) starts asking for nodes. A cold walk gets a sparse
or empty tree.

## What the fix in this PR does

1. **Force materialization.** The walker posts
   `UIAccessibility.layoutChanged` before descending. This is a documented
   public API, no-op when VoiceOver is already running, and nudges SwiftUI
   to populate its tree. It does NOT speak anything aloud.

2. **Always try the indexed accessor.** When
   `accessibilityElements` returns `nil` OR `[]`, the walker falls through
   to `accessibilityElement(at:)` for every index in
   `accessibilityElementCount()`. This is where SwiftUI actually vends
   its leaves.

3. **Read identifiers/labels via KVC.** Synthetic AX elements are
   instances of private SwiftUI classes (`_AXSnapshotElement`,
   `_UIAccessibilityElementMockView`, etc.). They all conform to the
   informal UIAccessibility protocol, so reading
   `accessibilityIdentifier`, `accessibilityLabel`, `accessibilityValue`,
   `accessibilityTraits`, and `accessibilityFrame` via
   `value(forKey:)` over the **documented public property names** is
   safe and version-independent — it would only break if Apple rename
   `UIAccessibility` itself.

4. **Filter empty container nodes.** Synthetic elements with no label,
   identifier, value, or traits are skipped. Previously these clogged the
   output.

## What the fix does NOT do

It does NOT solve the case where SwiftUI views are intentionally hidden
from accessibility (`.accessibilityHidden(true)`, custom `Canvas`
drawings, decorative `Shape` stacks). The AX tree won't list them, and
no amount of walker improvement changes that.

## Escape hatch: `.gstackProbe(_:)`

For views that the agent must see but the AX tree won't surface, use the
SwiftUI ViewModifier shipped in `Bridges.swift.template`:

```swift
Button { startCapture() } label: {
    Image(systemName: "mic.circle.fill")
    Text("Tap to start capturing")
}
.gstackProbe("dashboard.captureButton")
```

`.gstackProbe(_:)` sets `.accessibilityIdentifier(_:)` AND registers
`(identifier, frame)` in `GstackProbeRegistry`, which the
`ElementsBridge` merges into `/elements` output as a synthetic entry
tagged `"source":"gstack-probe"`. Use this ONLY when you've confirmed via
`/elements` that the agent can't see your view through the AX path —
it adds a tiny ongoing cost (one `PreferenceKey`-driven frame update per
view).

## Recommended workflow

1. Annotate your interactive SwiftUI views with
   `.accessibilityIdentifier(_:)` as you would for XCUITest. The fix in
   this PR will surface them.
2. Run the agent against a representative screen. Check `/elements` for
   the identifiers you expect.
3. For any view that didn't surface, switch to `.gstackProbe(_:)`.
4. For purely decorative screens (data viz, canvas, custom drawing), use
   **vision-based tapping**: ask the agent to read the screenshot and
   tap by coordinate. The screenshot path is unaffected by this issue
   and is the supported fallback.

## Prior art

- **WebDriverAgent (Appium)** solves this with `XCAXClient_iOS`, which is
  XCTest-only — not available to an in-process DEBUG bridge.
- **swift-agentation** (Ertem Biyik) invented the same registry +
  ViewModifier pattern `.gstackProbe(_:)` uses; their `agentationTag`
  modifier was the proof-of-concept for this approach.
- Apple developer forums and the Swift Forums thread
  "Is it possible to dump / introspect my own Accessibility tree at
  runtime (SwiftUI)?" both conclude there's no fully public API path —
  the KVC-over-informal-protocol approach in this PR is the best
  available compromise.
