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
        // KIF turns on accessibility automation before walking SwiftUI's AX
        // tree. Without it SwiftUI exposes only the hosting shell and taps
        // can report success without invoking Button.action.
        DebugBridgeTouch.prepareForAutomation()
        ScreenshotBridge.resolver = { ScreenshotBridgeImpl.capturePNG() }
        ElementsBridge.resolver = { ElementsBridgeImpl.snapshot() }
        MutationBridge.resolver = { op, payload in MutationBridgeImpl.dispatch(op: op, payload: payload) }
    }
}

/// Return the children UIKit exposes specifically to accessibility automation.
/// iOS 17 added `automationElements`; unlike the older container APIs it
/// preserves identified SwiftUI descendants inside accessibility groups.
@MainActor
private func debugBridgeAccessibilityChildren(of element: NSObject) -> [NSObject] {
    if #available(iOS 17.0, *),
       let automation = element.automationElements,
       !automation.isEmpty {
        return automation.compactMap { $0 as? NSObject }
    }
    if let accessibility = element.accessibilityElements,
       !accessibility.isEmpty {
        return accessibility.compactMap { $0 as? NSObject }
    }
    let count = element.accessibilityElementCount()
    guard count > 0, count < 512 else { return [] }
    return (0..<count).compactMap { element.accessibilityElement(at: $0) as? NSObject }
}

// MARK: - ScreenshotBridge implementation

@MainActor
enum ScreenshotBridgeImpl {
    /// Capture a PNG of the active window. Uses UIGraphicsImageRenderer
    /// (modern API, replaces UIGraphicsBeginImageContext). Returns nil if
    /// no key window is available (e.g., app backgrounded).
    static func capturePNG() -> Data? {
        guard let scene = activeScene(), let window = activeKeyWindow(in: scene) else { return nil }
        let bounds = window.bounds
        let format = UIGraphicsImageRendererFormat.default()
        // /tap consumes UIKit window points. Render at 1x so screenshot pixels
        // use that same coordinate space on 2x/3x devices.
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        let image = renderer.image { _ in
            // drawHierarchy is the documented way to snapshot real UIKit
            // layers including layer-backed views. afterScreenUpdates: false
            // because we want the CURRENT visible state, not a forced layout.
            window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        return image.pngData()
    }

    private static func activeScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)
    }

    private static func activeKeyWindow(in scene: UIWindowScene) -> UIWindow? {
        let windows = scene.windows.filter { window in
            !window.isHidden && !String(describing: type(of: window)).contains("PassThroughWindow")
        }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.max(by: { $0.windowLevel < $1.windowLevel })
    }
}

// MARK: - ElementsBridge implementation

@MainActor
enum ElementsBridgeImpl {
    /// Walk the accessibility hierarchy + emit a flat list of elements.
    /// Each entry has frame (in window coords), accessibility label,
    /// identifier, traits as a bitmask, and a parent path. Skips
    /// non-accessible / hidden views.
    static func snapshot() -> [JSONDict] {
        guard let scene = activeScene(), let window = activeKeyWindow(in: scene) else { return [] }
        var elements: [JSONDict] = []
        var visited = Set<ObjectIdentifier>()
        var remaining = 2_048
        collect(
            view: window,
            parentPath: "",
            window: window,
            visited: &visited,
            remaining: &remaining,
            into: &elements
        )
        return elements
    }

    private static func collect(
        view: UIView,
        parentPath: String,
        window: UIWindow,
        visited: inout Set<ObjectIdentifier>,
        remaining: inout Int,
        into elements: inout [JSONDict]
    ) {
        guard remaining > 0, visited.insert(ObjectIdentifier(view)).inserted else { return }
        remaining -= 1

        // Skip hidden / zero-size / off-screen subtrees early.
        if view.isHidden || view.alpha < 0.01 { return }

        let frameInWindow = view.convert(view.bounds, to: window)
        if !window.bounds.intersects(frameInWindow) { return }

        let isAccessible = view.isAccessibilityElement
        let label = view.accessibilityLabel ?? ""
        let identifier = view.accessibilityIdentifier ?? ""
        let traits = NSNumber(value: view.accessibilityTraits.rawValue)
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

        // Walk automation children before raw subviews. On iOS 17+ this
        // exposes identified SwiftUI controls nested inside GroupBox/List.
        for (index, element) in debugBridgeAccessibilityChildren(of: view).enumerated() {
            if let child = element as? UIView {
                collect(
                    view: child,
                    parentPath: path,
                    window: window,
                    visited: &visited,
                    remaining: &remaining,
                    into: &elements
                )
            } else {
                appendSynthetic(
                    element,
                    path: "\(path) > <ax\(index)>",
                    window: window,
                    visited: &visited,
                    remaining: &remaining,
                    into: &elements
                )
            }
        }
        for sub in view.subviews {
            collect(
                view: sub,
                parentPath: path,
                window: window,
                visited: &visited,
                remaining: &remaining,
                into: &elements
            )
        }
    }

    private static func appendSynthetic(
        _ element: NSObject,
        path: String,
        window: UIWindow,
        visited: inout Set<ObjectIdentifier>,
        remaining: inout Int,
        into elements: inout [JSONDict]
    ) {
        guard remaining > 0, visited.insert(ObjectIdentifier(element)).inserted else { return }
        remaining -= 1

        let screenFrame = (element.value(forKey: "accessibilityFrame") as? CGRect) ?? .zero
        let frame = window.coordinateSpace.convert(screenFrame, from: window.screen.coordinateSpace)
        let label = (element.value(forKey: "accessibilityLabel") as? String) ?? ""
        let identifier = (element.value(forKey: "accessibilityIdentifier") as? String) ?? ""
        let value = (element.value(forKey: "accessibilityValue") as? String) ?? ""
        let traits = (element.value(forKey: "accessibilityTraits") as? NSNumber)?.uint64Value ?? 0
        if !label.isEmpty || !identifier.isEmpty || !value.isEmpty || traits != 0 {
            elements.append([
                "path": path,
                "class": String(describing: type(of: element)),
                "label": label,
                "identifier": identifier,
                "value": value,
                "traits": NSNumber(value: traits),
                "frame": [
                    "x": Int(frame.origin.x),
                    "y": Int(frame.origin.y),
                    "w": Int(frame.size.width),
                    "h": Int(frame.size.height),
                ],
                "is_user_interaction_enabled": true,
            ])
        }

        // Synthetic SwiftUI nodes are themselves accessibility containers.
        // Recurse even when this grouping node has no metadata of its own.
        for (index, child) in debugBridgeAccessibilityChildren(of: element).enumerated() {
            if let childView = child as? UIView {
                collect(
                    view: childView,
                    parentPath: path,
                    window: window,
                    visited: &visited,
                    remaining: &remaining,
                    into: &elements
                )
            } else {
                appendSynthetic(
                    child,
                    path: "\(path) > <ax\(index)>",
                    window: window,
                    visited: &visited,
                    remaining: &remaining,
                    into: &elements
                )
            }
        }
    }

    private static func activeScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)
    }

    private static func activeKeyWindow(in scene: UIWindowScene) -> UIWindow? {
        let windows = scene.windows.filter { window in
            !window.isHidden && !String(describing: type(of: window)).contains("PassThroughWindow")
        }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.max(by: { $0.windowLevel < $1.windowLevel })
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

    /// Tap at (x, y) in window coordinates. Prefer accessibility activation,
    /// which is stable for SwiftUI buttons across OS releases, then fall back
    /// to KIF-derived UITouch synthesis for gesture-only/custom controls.
    private static func handleTap(_ payload: JSONDict) -> Bool {
        guard let x = payload["x"] as? NSNumber,
              let y = payload["y"] as? NSNumber else { return false }
        let point = CGPoint(x: x.doubleValue, y: y.doubleValue)
        guard let scene = activeScene(), let window = activeKeyWindow(in: scene) else { return false }
        if let element = findActivatableAXElement(at: point, in: window),
           element.accessibilityActivate() {
            return true
        }
        return DebugBridgeTouch.sendTap(at: point, in: window)
    }

    private static func findActivatableAXElement(at point: CGPoint, in window: UIWindow) -> NSObject? {
        let screenPoint = window.screen.coordinateSpace.convert(point, from: window.coordinateSpace)
        var best: NSObject?
        var bestArea: CGFloat = .infinity
        var visited = Set<ObjectIdentifier>()
        var remaining = 2_048

        func consider(frame: CGRect, traits: UInt64, element: NSObject) {
            guard frame.contains(screenPoint),
                  (traits & UIAccessibilityTraits.button.rawValue) != 0 else { return }
            let area = frame.width * frame.height
            if area > 0 && area < bestArea {
                best = element
                bestArea = area
            }
        }

        func visit(_ element: NSObject) {
            guard remaining > 0, visited.insert(ObjectIdentifier(element)).inserted else { return }
            remaining -= 1

            if let view = element as? UIView {
                guard !view.isHidden, view.alpha >= 0.01,
                      view.convert(view.bounds, to: window).contains(point) else { return }
                if view.isAccessibilityElement {
                    consider(frame: view.accessibilityFrame, traits: view.accessibilityTraits.rawValue, element: view)
                }
                for child in debugBridgeAccessibilityChildren(of: view) { visit(child) }
                for child in view.subviews { visit(child) }
            } else {
                let frame = (element.value(forKey: "accessibilityFrame") as? CGRect) ?? .zero
                let traits = (element.value(forKey: "accessibilityTraits") as? NSNumber)?.uint64Value ?? 0
                consider(frame: frame, traits: traits, element: element)
                for child in debugBridgeAccessibilityChildren(of: element) { visit(child) }
            }
        }

        visit(window)
        return best
    }

    /// Set text on the first responder if it's a UITextField or UITextView.
    private static func handleType(_ payload: JSONDict) -> Bool {
        guard let text = payload["text"] as? String else { return false }
        guard let scene = activeScene(), let window = activeKeyWindow(in: scene) else { return false }
        guard let responder = findFirstResponder(in: window) else { return false }
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

        guard let scene = activeScene(), let window = activeKeyWindow(in: scene) else { return false }
        guard let hit = window.hitTest(from, with: nil) else { return false }

        // Find the nearest enclosing UIScrollView.
        var node: UIView? = hit
        while let cur = node {
            if let scroll = cur as? UIScrollView {
                let dx = from.x - to.x
                let dy = from.y - to.y
                var off = scroll.contentOffset
                off.x = max(0, min(scroll.contentSize.width - scroll.bounds.width, off.x + dx))
                off.y = max(0, min(scroll.contentSize.height - scroll.bounds.height, off.y + dy))
                // Automation commands return synchronously; do not report
                // success while the target is still moving underneath the
                // next tap coordinate.
                scroll.setContentOffset(off, animated: false)
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

    private static func activeScene() -> UIWindowScene? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)
    }

    private static func activeKeyWindow(in scene: UIWindowScene) -> UIWindow? {
        let windows = scene.windows.filter { window in
            !window.isHidden && !String(describing: type(of: window)).contains("PassThroughWindow")
        }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.max(by: { $0.windowLevel < $1.windowLevel })
    }
}

#endif // DEBUG && canImport(UIKit)
