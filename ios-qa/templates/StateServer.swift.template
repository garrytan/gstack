import Foundation
import Network
import UIKit

#if DEBUG

@MainActor
public final class StateServer {
    private var listener: NWListener?
    private var readHandlers: [String: () -> String] = [:]
    private var writeHandlers: [String: (String) -> Bool] = [:]
    public private(set) var port: UInt16 = 0
    private var hasConnected = false

    public init() {}

    public func registerRead(_ key: String, handler: @escaping @MainActor () -> String) {
        readHandlers[key] = handler
    }

    public func registerWrite(_ key: String, handler: @escaping @MainActor (String) -> Bool) {
        writeHandlers[key] = handler
    }

    public func start(port: UInt16 = 9999) {
        do {
            let params = NWParameters.tcp
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)

            listener?.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    switch state {
                    case .ready:
                        if let p = self?.listener?.port?.rawValue {
                            self?.port = p
                            print("[DebugBridge] StateServer listening on http://localhost:\(p)")
                        }
                    case .failed(let error):
                        print("[DebugBridge] StateServer failed: \(error)")
                        self?.listener?.cancel()
                    default:
                        break
                    }
                }
            }

            listener?.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in
                    self?.handleConnection(connection)
                }
            }

            listener?.start(queue: .main)
        } catch {
            print("[DebugBridge] Failed to start StateServer: \(error)")
        }
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: .main)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            Task { @MainActor in
                guard let self = self, let data = data else {
                    connection.cancel()
                    return
                }
                self.handleRequest(data, on: connection)
            }
        }
    }

    private func handleRequest(_ data: Data, on connection: NWConnection) {
        guard let raw = String(data: data, encoding: .utf8) else {
            sendResponse(connection, status: 400, body: "{\"error\":\"bad request\"}")
            return
        }

        if !hasConnected {
            hasConnected = true
            DebugBridgeNotifier.connected()
        }

        let lines = raw.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            sendResponse(connection, status: 400, body: "{\"error\":\"bad request\"}")
            return
        }

        let parts = requestLine.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2 else {
            sendResponse(connection, status: 400, body: "{\"error\":\"bad request\"}")
            return
        }

        let method = String(parts[0])
        let path = String(parts[1])
        let body = extractBody(from: raw)

        // Route dispatch
        switch (method, path) {
        case ("GET", "/health"):
            sendResponse(connection, status: 200, body: "{\"status\":\"ok\"}")

        case ("GET", "/state"):
            let keys = Array(readHandlers.keys).sorted()
            let json = "[\(keys.map { "\"\($0)\"" }.joined(separator: ","))]"
            sendResponse(connection, status: 200, body: json)

        case ("GET", _) where path.hasPrefix("/state/"):
            let key = String(path.dropFirst("/state/".count))
            if let handler = readHandlers[key] {
                let value = handler()
                sendResponse(connection, status: 200, body: value)
                DebugBridgeNotifier.action("read \(key)")
            } else {
                sendResponse(connection, status: 404, body: "{\"error\":\"key not found\"}")
            }

        case ("POST", _) where path.hasPrefix("/state/"):
            let key = String(path.dropFirst("/state/".count))
            if let handler = writeHandlers[key] {
                if handler(body) {
                    DebugBridgeNotifier.action("write \(key)")
                    DebugBridgeNotifier.stateMutation()
                    sendResponse(connection, status: 200, body: "{\"ok\":true}")
                } else {
                    sendResponse(connection, status: 400, body: "{\"ok\":false,\"error\":\"write rejected\"}")
                }
            } else {
                sendResponse(connection, status: 404, body: "{\"error\":\"key not found\"}")
            }

        // MARK: - Screenshot
        case ("GET", "/screenshot"):
            let base64 = captureScreenshot()
            sendResponse(connection, status: 200, body: "{\"image\":\"\(base64)\"}")
            DebugBridgeNotifier.action("screenshot")

        // MARK: - Tap
        case ("POST", "/tap"):
            if let result = handleTap(body: body) {
                sendResponse(connection, status: 200, body: result)
            } else {
                sendResponse(connection, status: 400, body: "{\"error\":\"invalid tap params, need x and y\"}")
            }

        // MARK: - Swipe
        case ("POST", "/swipe"):
            if let result = handleSwipe(body: body) {
                sendResponse(connection, status: 200, body: result)
            } else {
                sendResponse(connection, status: 400, body: "{\"error\":\"invalid swipe params\"}")
            }

        // MARK: - Type text
        case ("POST", "/type"):
            if let result = handleType(body: body) {
                sendResponse(connection, status: 200, body: result)
            } else {
                sendResponse(connection, status: 400, body: "{\"error\":\"invalid type params\"}")
            }

        // MARK: - Accessibility elements
        case ("GET", "/elements"):
            let elements = captureAccessibilityTree()
            sendResponse(connection, status: 200, body: elements)
            DebugBridgeNotifier.action("elements")

        // MARK: - Device info
        case ("GET", "/device"):
            let info = deviceInfo()
            sendResponse(connection, status: 200, body: info)

        default:
            sendResponse(connection, status: 404, body: "{\"error\":\"not found\"}")
        }
    }

    // MARK: - Screenshot Capture

    private func captureScreenshot() -> String {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) else {
            return ""
        }

        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in
            // drawHierarchy captures the actual rendered pixels including SwiftUI content.
            // layer.render() only captures CALayer content and misses SwiftUI on newer iOS.
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }

        guard let data = image.pngData() else { return "" }
        return data.base64EncodedString()
    }

    // MARK: - Tap Injection

    private func handleTap(body: String) -> String? {
        guard let json = parseJSON(body),
              let x = json["x"] as? Double,
              let y = json["y"] as? Double else {
            return nil
        }

        let point = CGPoint(x: x, y: y)

        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) else {
            return "{\"ok\":false,\"error\":\"no key window\"}"
        }

        // Find the hit target
        if let target = window.hitTest(point, with: nil) {
            // Try accessibility activate
            if target.accessibilityActivate() {
                DebugBridgeNotifier.action("tap \(Int(x)),\(Int(y)) → \(type(of: target))")
                return "{\"ok\":true,\"target\":\"\(type(of: target))\",\"label\":\"\(target.accessibilityLabel ?? "")\"}"
            }

            // Try as UIControl
            if let control = findControl(from: target) {
                control.sendActions(for: .touchUpInside)
                DebugBridgeNotifier.action("tap \(Int(x)),\(Int(y)) → \(type(of: control))")
                return "{\"ok\":true,\"target\":\"\(type(of: control))\",\"label\":\"\(control.accessibilityLabel ?? "")\"}"
            }

            // Try gesture recognizers on the view hierarchy
            if activateGestureRecognizer(on: target) {
                DebugBridgeNotifier.action("tap \(Int(x)),\(Int(y)) → gesture")
                return "{\"ok\":true,\"target\":\"\(type(of: target))\",\"method\":\"gesture\"}"
            }

            DebugBridgeNotifier.action("tap \(Int(x)),\(Int(y)) → \(type(of: target))")
            return "{\"ok\":true,\"target\":\"\(type(of: target))\",\"method\":\"hitTest\",\"label\":\"\(target.accessibilityLabel ?? "")\"}"
        }

        return "{\"ok\":false,\"error\":\"no hit target at (\(x),\(y))\"}"
    }

    private func findControl(from view: UIView) -> UIControl? {
        var current: UIView? = view
        while let v = current {
            if let control = v as? UIControl { return control }
            current = v.superview
        }
        return nil
    }

    private func activateGestureRecognizer(on view: UIView) -> Bool {
        var current: UIView? = view
        while let v = current {
            if let recognizers = v.gestureRecognizers {
                for recognizer in recognizers {
                    if recognizer is UITapGestureRecognizer && recognizer.isEnabled {
                        recognizer.state = .ended
                        return true
                    }
                }
            }
            current = v.superview
        }
        return false
    }

    // MARK: - Swipe Injection

    private func handleSwipe(body: String) -> String? {
        guard let json = parseJSON(body),
              let fromX = json["fromX"] as? Double,
              let fromY = json["fromY"] as? Double,
              let toX = json["toX"] as? Double,
              let toY = json["toY"] as? Double else {
            return nil
        }

        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) else {
            return "{\"ok\":false,\"error\":\"no key window\"}"
        }

        // Find scroll views and scroll them
        let from = CGPoint(x: fromX, y: fromY)
        let deltaX = toX - fromX
        let deltaY = toY - fromY

        if let scrollView = findScrollView(at: from, in: window) {
            let newOffset = CGPoint(
                x: scrollView.contentOffset.x - deltaX,
                y: scrollView.contentOffset.y - deltaY
            )
            scrollView.setContentOffset(newOffset, animated: true)
            DebugBridgeNotifier.action("swipe (\(Int(fromX)),\(Int(fromY)))→(\(Int(toX)),\(Int(toY)))")
            return "{\"ok\":true,\"method\":\"scrollView\"}"
        }

        DebugBridgeNotifier.action("swipe (\(Int(fromX)),\(Int(fromY)))→(\(Int(toX)),\(Int(toY)))")
        return "{\"ok\":true,\"method\":\"noop\",\"note\":\"no scroll view found\"}"
    }

    private func findScrollView(at point: CGPoint, in window: UIWindow) -> UIScrollView? {
        var current: UIView? = window.hitTest(point, with: nil)
        while let v = current {
            if let sv = v as? UIScrollView { return sv }
            current = v.superview
        }
        return nil
    }

    // MARK: - Type Text

    private func handleType(body: String) -> String? {
        guard let json = parseJSON(body),
              let text = json["text"] as? String else {
            return nil
        }

        guard let responder = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .compactMap({ findFirstResponder(in: $0) })
            .first else {
            return "{\"ok\":false,\"error\":\"no focused text field\"}"
        }

        if let textInput = responder as? UITextInput {
            textInput.insertText(text)
            DebugBridgeNotifier.action("type \"\(text.prefix(20))\"")
            return "{\"ok\":true,\"typed\":\"\(text)\"}"
        }

        return "{\"ok\":false,\"error\":\"focused element is not a text input\"}"
    }

    private func findFirstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for subview in view.subviews {
            if let found = findFirstResponder(in: subview) { return found }
        }
        return nil
    }

    // MARK: - Accessibility Tree

    private func captureAccessibilityTree() -> String {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow }) else {
            return "[]"
        }

        var elements: [[String: Any]] = []
        collectAccessibilityElements(from: window, into: &elements)

        if let data = try? JSONSerialization.data(withJSONObject: elements, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return "[]"
    }

    private func collectAccessibilityElements(from view: UIView, into elements: inout [[String: Any]]) {
        let frame = view.convert(view.bounds, to: nil)

        // Only include views that are visible and have accessibility info
        if !view.isHidden && view.alpha > 0 && frame.width > 0 && frame.height > 0 {
            let hasLabel = view.accessibilityLabel != nil && !view.accessibilityLabel!.isEmpty
            let isControl = view is UIControl
            let isInteractive = view.accessibilityTraits.contains(.button) ||
                               view.accessibilityTraits.contains(.link) ||
                               view.accessibilityTraits.contains(.keyboardKey)

            if hasLabel || isControl || isInteractive {
                var element: [String: Any] = [
                    "type": String(describing: type(of: view)),
                    "frame": [
                        "x": Int(frame.origin.x),
                        "y": Int(frame.origin.y),
                        "width": Int(frame.width),
                        "height": Int(frame.height)
                    ],
                    "center": [
                        "x": Int(frame.midX),
                        "y": Int(frame.midY)
                    ]
                ]

                if let label = view.accessibilityLabel, !label.isEmpty {
                    element["label"] = label
                }
                if let value = view.accessibilityValue, !value.isEmpty {
                    element["value"] = value
                }
                if let hint = view.accessibilityHint, !hint.isEmpty {
                    element["hint"] = hint
                }

                var traits: [String] = []
                if view.accessibilityTraits.contains(.button) { traits.append("button") }
                if view.accessibilityTraits.contains(.link) { traits.append("link") }
                if view.accessibilityTraits.contains(.header) { traits.append("header") }
                if view.accessibilityTraits.contains(.staticText) { traits.append("text") }
                if view.accessibilityTraits.contains(.image) { traits.append("image") }
                if view.accessibilityTraits.contains(.selected) { traits.append("selected") }
                if view.accessibilityTraits.contains(.notEnabled) { traits.append("disabled") }
                if !traits.isEmpty { element["traits"] = traits }

                element["interactive"] = isControl || isInteractive
                elements.append(element)
            }
        }

        for subview in view.subviews {
            collectAccessibilityElements(from: subview, into: &elements)
        }
    }

    // MARK: - Device Info

    private func deviceInfo() -> String {
        let device = UIDevice.current
        let screen = UIScreen.main
        let info: [String: Any] = [
            "name": device.name,
            "model": device.model,
            "systemVersion": device.systemVersion,
            "screenWidth": Int(screen.bounds.width),
            "screenHeight": Int(screen.bounds.height),
            "scale": Int(screen.scale),
            "safeAreaTop": Int(safeAreaInsets().top),
            "safeAreaBottom": Int(safeAreaInsets().bottom)
        ]
        if let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return "{}"
    }

    private func safeAreaInsets() -> UIEdgeInsets {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets ?? .zero
    }

    // MARK: - Helpers

    private func extractBody(from raw: String) -> String {
        if let range = raw.range(of: "\r\n\r\n") {
            return String(raw[range.upperBound...])
        }
        return ""
    }

    private func parseJSON(_ string: String) -> [String: Any]? {
        guard let data = string.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }

    private func sendResponse(_ connection: NWConnection, status: Int, body: String, contentType: String = "application/json") {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        default: statusText = "Error"
        }

        let response = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"

        connection.send(content: response.data(using: .utf8), contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

#endif
