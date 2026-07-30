// AUTO-GENERATED from gstack/ios-qa/templates/Bridges.swift.template
//
// Real UIKit-backed implementations of the three bridges StateServer
// declares: ScreenshotBridge (PNG capture), ElementsBridge (accessibility
// tree), MutationBridge (tap/swipe/type via accessibility actions + hit
// testing). Everything #if DEBUG && canImport(UIKit) so Release builds
// don't link UIKit or carry any of this code.
//
// Wire from the consuming app:
//
//   #if DEBUG && canImport(UIKit)
//   import DebugBridgeUI
//   DebugBridgeUIWiring.installAll()
//   #endif

#if DEBUG && canImport(UIKit)

import DebugBridgeCore
import DebugBridgeTouch
import Foundation
import SwiftUI
import UIKit

@MainActor
public enum DebugBridgeUIWiring {
    /// Install all three bridge resolvers. Idempotent — calling multiple
    /// times reinstalls the same closures. Must be called on @MainActor
    /// because every UIKit access requires the main actor.
    public static func installAll() {
        ScreenshotBridge.resolver = { ScreenshotBridgeImpl.capturePNG() }
        ElementsBridge.resolver = { ElementsBridgeImpl.snapshot() }
        MutationBridge.resolver = { op, payload in MutationBridgeImpl.dispatch(op: op, payload: payload) }
    }
}

// MARK: - ScreenshotBridge implementation

@MainActor
enum ScreenshotBridgeImpl {
    /// Capture a PNG of the active window. Uses UIGraphicsImageRenderer
    /// (modern API, replaces UIGraphicsBeginImageContext). Returns nil if
    /// no key window is available (e.g., app backgrounded).
    static func capturePNG() -> Data? {
        guard let scene = activeScene() else { return nil }
        let windows = orderedWindows(in: scene)
        guard let bounds = windows.first?.bounds else { return nil }
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let image = renderer.image { _ in
            // drawHierarchy is the documented way to snapshot real UIKit
            // layers including layer-backed views. afterScreenUpdates: false
            // because we want the CURRENT visible state, not a forced layout.
            //
            // Back-to-front across every window: a UIMenu, alert or action
            // sheet lives in its OWN window, so drawing only the key window
            // silently drops it from the screenshot.
            for window in windows.reversed() {
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
        }
        return image.pngData()
    }

    static func activeScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)
    }

    static func activeKeyWindow(in scene: UIWindowScene) -> UIWindow? {
        scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
    }

    /// Visible windows, front-most first: higher `windowLevel` wins, and within
    /// a level the later window sits on top. Menus, alerts and action sheets
    /// get their own window, so `isKeyWindow` alone does not find them.
    static func orderedWindows(in scene: UIWindowScene) -> [UIWindow] {
        scene.windows
            .filter { !$0.isHidden && $0.alpha > 0.01 && !$0.bounds.isEmpty }
            .enumerated()
            .sorted {
                ($0.element.windowLevel.rawValue, Double($0.offset))
                    > ($1.element.windowLevel.rawValue, Double($1.offset))
            }
            .map(\.element)
    }

    /// The window the user is actually touching — front-most, not merely key.
    static func frontmostWindow() -> UIWindow? {
        guard let scene = activeScene() else { return nil }
        return orderedWindows(in: scene).first ?? activeKeyWindow(in: scene)
    }

    /// Roots to search, front-most first: for each window, the top-most
    /// presented view controller's view before the window itself.
    ///
    /// Tree order is NOT front-most order. A presented sheet sits *after* the
    /// screen it covers in `window.subviews`, so a walk rooted at the window
    /// emits the covered screen first and a client taking the first match for a
    /// label gets a control the user cannot reach.
    static func searchRoots() -> [UIView] {
        guard let scene = activeScene() else { return [] }
        var roots: [UIView] = []
        for window in orderedWindows(in: scene) {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            if let view = controller?.view, view !== window { roots.append(view) }
            roots.append(window)
        }
        return roots
    }
}

// MARK: - ElementsBridge implementation

@MainActor
enum ElementsBridgeImpl {
    /// Walk the accessibility hierarchy + emit a flat list of elements.
    /// Each entry has frame (in window coords), accessibility label,
    /// identifier, traits as a bitmask, and a parent path. Skips
    /// non-accessible / hidden views.
    /// Front-most content first, so a client taking the first match for a label
    /// gets the element the user can actually reach.
    static func snapshot() -> [JSONDict] {
        let roots = ScreenshotBridgeImpl.searchRoots()
        guard let windowBounds = roots.first?.window?.bounds ?? roots.first?.bounds else { return [] }
        var elements: [JSONDict] = []
        var seen = Set<ObjectIdentifier>()
        for root in roots {
            collect(view: root, parentPath: "", windowBounds: windowBounds, into: &elements, seen: &seen)
        }
        return elements
    }

    private static func collect(view: UIView, parentPath: String, windowBounds: CGRect,
                                into elements: inout [JSONDict], seen: inout Set<ObjectIdentifier>) {
        // A presented view is also reachable through its window, so the roots
        // overlap by design — emit each view once, at its front-most position.
        guard seen.insert(ObjectIdentifier(view)).inserted else { return }
        // Skip hidden / zero-size / off-screen subtrees early.
        if view.isHidden || view.alpha < 0.01 { return }

        let frameInWindow = view.convert(view.bounds, to: nil)
        if !windowBounds.intersects(frameInWindow) { return }

        let isAccessible = view.isAccessibilityElement
        let label = view.accessibilityLabel ?? ""
        let identifier = view.accessibilityIdentifier ?? ""
        let traits = Int(view.accessibilityTraits.rawValue)
        let value = (view.accessibilityValue ?? "") as String
        let className = String(describing: type(of: view))
        let path = parentPath.isEmpty ? className : "\(parentPath) > \(className)"

        // Emit if any of:
        //   - Marked accessible (covers UIKit-native widgets)
        //   - Has explicit AX label / identifier
        //   - Is a known interactive type (UIControl, UITextField, UIScrollView)
        //   - Hosts a SwiftUI view (UIHostingController's view class)
        let isInteractive = view is UIControl || view is UIScrollView || view is UITextInput
        let isHosting = className.contains("Hosting") || className.contains("SwiftUI")
        if isAccessible || !label.isEmpty || !identifier.isEmpty || isInteractive || isHosting {
            elements.append([
                "path": path,
                "class": className,
                "label": label,
                "identifier": identifier,
                "value": value,
                "traits": traits,
                "frame": [
                    "x": Int(frameInWindow.origin.x),
                    "y": Int(frameInWindow.origin.y),
                    "w": Int(frameInWindow.size.width),
                    "h": Int(frameInWindow.size.height),
                ],
                "is_user_interaction_enabled": view.isUserInteractionEnabled,
            ])
        }

        // Recurse into accessibility-elements first (some custom views vend
        // synthetic children), then UIView subviews. SwiftUI's host views
        // populate accessibilityElements lazily — many return nil before
        // VoiceOver triggers them. Force population by reading accessibilityElementCount.
        _ = view.accessibilityElementCount()
        if let axElements = view.accessibilityElements {
            for case let element as NSObject in axElements {
                if let v = element as? UIView {
                    collect(view: v, parentPath: path, windowBounds: windowBounds, into: &elements, seen: &seen)
                } else {
                    // Synthetic accessibility element (no UIView). Capture frame in screen coords.
                    let af = (element.value(forKey: "accessibilityFrame") as? CGRect) ?? .zero
                    elements.append([
                        "path": "\(path) > <synthetic>",
                        "class": "AccessibilityElement",
                        "label": (element.value(forKey: "accessibilityLabel") as? String) ?? "",
                        "identifier": (element.value(forKey: "accessibilityIdentifier") as? String) ?? "",
                        "value": (element.value(forKey: "accessibilityValue") as? String) ?? "",
                        "traits": (element.value(forKey: "accessibilityTraits") as? NSNumber)?.intValue ?? 0,
                        "frame": [
                            "x": Int(af.origin.x),
                            "y": Int(af.origin.y),
                            "w": Int(af.size.width),
                            "h": Int(af.size.height),
                        ],
                        "is_user_interaction_enabled": true,
                    ])
                }
            }
        } else {
            // accessibilityElements is nil — iterate by index. SwiftUI uses
            // this dynamic protocol pattern; many AX elements only respond
            // to accessibilityElementCount + accessibilityElement(at:).
            let count = view.accessibilityElementCount()
            for i in 0..<count {
                guard let element = view.accessibilityElement(at: i) as? NSObject else { continue }
                if let v = element as? UIView {
                    collect(view: v, parentPath: path, windowBounds: windowBounds, into: &elements, seen: &seen)
                } else {
                    let af = (element.value(forKey: "accessibilityFrame") as? CGRect) ?? .zero
                    elements.append([
                        "path": "\(path) > <ax\(i)>",
                        "class": String(describing: type(of: element)),
                        "label": (element.value(forKey: "accessibilityLabel") as? String) ?? "",
                        "identifier": (element.value(forKey: "accessibilityIdentifier") as? String) ?? "",
                        "value": (element.value(forKey: "accessibilityValue") as? String) ?? "",
                        "traits": (element.value(forKey: "accessibilityTraits") as? NSNumber)?.intValue ?? 0,
                        "frame": [
                            "x": Int(af.origin.x),
                            "y": Int(af.origin.y),
                            "w": Int(af.size.width),
                            "h": Int(af.size.height),
                        ],
                        "is_user_interaction_enabled": true,
                    ])
                }
            }
        }
        for sub in view.subviews {
            collect(view: sub, parentPath: path, windowBounds: windowBounds, into: &elements, seen: &seen)
        }
    }
}

// MARK: - MutationBridge implementation

@MainActor
enum MutationBridgeImpl {
    /// Route a mutation op to the right handler. Returns true on success,
    /// false on failure (which the StateServer surfaces as 400 to the agent).
    static func dispatch(op: String, payload: JSONDict) -> Bool {
        switch op {
        case "tap":     return handleTap(payload)
        case "type":    return handleType(payload)
        case "swipe":   return handleSwipe(payload)
        default:        return false
        }
    }

    /// Tap at (x, y) in window coordinates. Delegates to DebugBridgeTouch
    /// (KIF-derived in-process touch synthesis). The Obj-C target builds a
    /// real UITouch + IOHIDEvent + UIEvent and dispatches via
    /// `UIApplication.sendEvent`, which is what UIKit uses for real touches.
    /// This works for UIControl, SwiftUI Button (via iOS 18+
    /// `_UIHitTestContext`), gesture recognizers, and anything else that
    /// listens to the real event-dispatch path.
    private static func handleTap(_ payload: JSONDict) -> Bool {
        guard let x = payload["x"] as? NSNumber,
              let y = payload["y"] as? NSNumber else { return false }
        let point = CGPoint(x: x.doubleValue, y: y.doubleValue)
        guard let window = ScreenshotBridgeImpl.frontmostWindow() else { return false }
        return DebugBridgeTouch.sendTap(at: point, in: window)
    }

    /// Set text on the first responder if it's a UITextField or UITextView.
    private static func handleType(_ payload: JSONDict) -> Bool {
        guard let text = payload["text"] as? String else { return false }
        guard let responder = ScreenshotBridgeImpl.searchRoots()
            .lazy.compactMap({ findFirstResponder(in: $0) }).first else { return false }
        if let field = responder as? UITextField {
            field.text = text
            field.sendActions(for: .editingChanged)
            return true
        }
        if let view = responder as? UITextView {
            view.text = text
            view.delegate?.textViewDidChange?(view)
            return true
        }
        return false
    }

    /// Swipe via UIScrollView programmatic scroll OR via setContentOffset on
    /// the deepest UIScrollView in the hit-tested ancestor chain. Less
    /// faithful than synthesized touches but covers common scroll scenarios.
    private static func handleSwipe(_ payload: JSONDict) -> Bool {
        guard let fx = payload["from_x"] as? NSNumber,
              let fy = payload["from_y"] as? NSNumber,
              let tx = payload["to_x"] as? NSNumber,
              let ty = payload["to_y"] as? NSNumber else { return false }
        let from = CGPoint(x: fx.doubleValue, y: fy.doubleValue)
        let to = CGPoint(x: tx.doubleValue, y: ty.doubleValue)

        guard let hit = ScreenshotBridgeImpl.searchRoots()
            .lazy.compactMap({ $0.hitTest($0.convert(from, from: nil), with: nil) })
            .first else { return false }

        // Find the nearest enclosing UIScrollView.
        var node: UIView? = hit
        while let cur = node {
            if let scroll = cur as? UIScrollView {
                let dx = from.x - to.x
                let dy = from.y - to.y
                var off = scroll.contentOffset
                off.x = max(0, min(scroll.contentSize.width - scroll.bounds.width, off.x + dx))
                off.y = max(0, min(scroll.contentSize.height - scroll.bounds.height, off.y + dy))
                scroll.setContentOffset(off, animated: true)
                return true
            }
            node = cur.superview
        }
        return false
    }

    // MARK: helpers

    private static func walkUp(_ view: UIView) -> UIView? {
        var node: UIView? = view
        while let cur = node {
            if cur is UIControl { return cur }
            node = cur.superview
        }
        return view
    }

    private static func findFirstResponder(in view: UIView) -> UIResponder? {
        if view.isFirstResponder { return view }
        for sub in view.subviews {
            if let found = findFirstResponder(in: sub) { return found }
        }
        return nil
    }
}

#endif // DEBUG && canImport(UIKit)
