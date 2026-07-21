import Foundation
import XCTest

/// Concrete XCUITest adapter for the JSON contract in ios-qa/executor/contract.ts.
/// The environment supplies the flow path; xcodebuild remains responsible for routing
/// this exact runner to either a simulator or a provisioned physical device.
final class GStackFlowRunnerUITests: XCTestCase {
    private struct Flow: Decodable {
        let version: Int
        let name: String
        let bundleIdentifier: String?
        let steps: [Step]
    }

    private struct Selector: Decodable {
        let identifier: String?
        let label: String?
        let role: String?
    }

    private struct Verification: Decodable {
        let kind: String
        let selector: Selector
        let value: String?
        let timeoutMs: Int?
    }

    private struct Step: Decodable {
        let id: String
        let action: String
        let arguments: [String]?
        let environment: [String: String]?
        let selector: Selector?
        let text: String?
        let clear: Bool?
        let timeoutMs: Int?
        let direction: String?
        let verify: Verification?
        let verification: Verification?
    }

    private enum RunnerError: Error, CustomStringConvertible {
        case blocked(String)
        case unsupported(String)
        case step(String, String)

        var description: String {
            switch self {
            case .blocked(let message): return "BLOCKED: \(message)"
            case .unsupported(let message): return "UNSUPPORTED: \(message)"
            case .step(let id, let message): return "STEP \(id) FAILED: \(message)"
            }
        }
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testFlow() throws {
        do {
            let flow = try loadFlow()
            guard flow.version == 1 else { throw RunnerError.unsupported("flow version \(flow.version)") }
            guard let bundleIdentifier = flow.bundleIdentifier, !bundleIdentifier.isEmpty else {
                throw RunnerError.blocked("bundleIdentifier is required by the XCUITest runner")
            }
            let app = XCUIApplication(bundleIdentifier: bundleIdentifier)
            for step in flow.steps {
                try execute(step, in: app)
            }
        } catch {
            XCTFail(String(describing: error))
            throw error
        }
    }

    private func loadFlow() throws -> Flow {
        if let encoded = ProcessInfo.processInfo.environment["GSTACK_IOS_QA_FLOW_JSON_BASE64"],
           !encoded.isEmpty {
            guard let data = Data(base64Encoded: encoded) else {
                throw RunnerError.blocked("GSTACK_IOS_QA_FLOW_JSON_BASE64 is invalid")
            }
            do {
                return try JSONDecoder().decode(Flow.self, from: data)
            } catch {
                throw RunnerError.blocked("cannot decode inline flow JSON: \(error)")
            }
        }
        guard let path = ProcessInfo.processInfo.environment["GSTACK_IOS_QA_FLOW_PATH"], !path.isEmpty else {
            throw RunnerError.blocked("neither inline flow JSON nor GSTACK_IOS_QA_FLOW_PATH is set")
        }
        do {
            return try JSONDecoder().decode(Flow.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        } catch {
            throw RunnerError.blocked("cannot decode flow at \(path): \(error)")
        }
    }

    private func execute(_ step: Step, in app: XCUIApplication) throws {
        do {
            switch step.action {
            case "launch":
                app.launchArguments = step.arguments ?? []
                app.launchEnvironment = step.environment ?? [:]
                app.launch()
            case "tap":
                let resolved = try resolve(requiredSelector(step), in: app, timeoutMs: step.timeoutMs)
                // If the identifier lands on a wrapper, target the actual switch inside it.
                let element = resolved.elementType == .switch
                    ? resolved
                    : (resolved.switches.firstMatch.exists ? resolved.switches.firstMatch : resolved)
                guard waitUntilHittable(element, timeoutMs: step.timeoutMs) else {
                    throw RunnerError.step(step.id, "element exists but is not hittable")
                }
                if element.elementType == .switch {
                    try tapSwitch(element, stepID: step.id)
                } else {
                    element.tap()
                }
            case "typeText":
                let element = try resolve(requiredSelector(step), in: app, timeoutMs: step.timeoutMs)
                guard waitUntilHittable(element, timeoutMs: step.timeoutMs) else {
                    throw RunnerError.step(step.id, "text element exists but is not hittable")
                }
                guard let text = step.text else { throw RunnerError.step(step.id, "typeText is missing text") }
                element.tap()
                if step.clear == true, let current = element.value as? String, !current.isEmpty {
                    element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
                }
                element.typeText(text)
            case "swipe":
                let element = try step.selector.map { try resolve($0, in: app, timeoutMs: step.timeoutMs) } ?? app
                switch step.direction {
                case "up": element.swipeUp()
                case "down": element.swipeDown()
                case "left": element.swipeLeft()
                case "right": element.swipeRight()
                default: throw RunnerError.step(step.id, "unsupported swipe direction \(step.direction ?? "<missing>")")
                }
            case "wait":
                guard let verification = step.verification else { throw RunnerError.step(step.id, "wait is missing verification") }
                try verify(verification, in: app, stepID: step.id)
            default:
                throw RunnerError.unsupported("action \(step.action) at step \(step.id)")
            }
            if let verification = step.verify {
                try verify(verification, in: app, stepID: step.id)
            }
        } catch let error as RunnerError {
            throw error
        } catch {
            throw RunnerError.step(step.id, String(describing: error))
        }
    }

    private func requiredSelector(_ step: Step) throws -> Selector {
        guard let selector = step.selector else { throw RunnerError.step(step.id, "action is missing selector") }
        return selector
    }

    /// Identifier is resolved first. A label is only a fallback after the identifier
    /// query has had its bounded existence wait; no screen-coordinate fallback exists.
    private func resolve(_ selector: Selector, in app: XCUIApplication, timeoutMs: Int?) throws -> XCUIElement {
        let query = query(for: selector.role, in: app)
        let timeout = seconds(timeoutMs)
        if let identifier = selector.identifier, !identifier.isEmpty {
            let candidate = query.matching(identifier: identifier).firstMatch
            if candidate.waitForExistence(timeout: timeout) { return candidate }
        }
        if let label = selector.label, !label.isEmpty {
            let candidate = query.matching(NSPredicate(format: "label == %@", label)).firstMatch
            if candidate.waitForExistence(timeout: timeout) { return candidate }
        }
        throw RunnerError.blocked("no element resolved by identifier/label (role: \(selector.role ?? "any"))")
    }

    private func query(for role: String?, in app: XCUIApplication) -> XCUIElementQuery {
        let type: XCUIElement.ElementType
        switch role {
        case nil: type = .any
        case "button": type = .button
        case "cell": type = .cell
        case "link": type = .link
        case "navigationBar": type = .navigationBar
        case "secureTextField": type = .secureTextField
        case "staticText": type = .staticText
        case "switch": type = .switch
        case "textField": type = .textField
        default: type = .any
        }
        return app.descendants(matching: type)
    }

    /// Toggle a switch and confirm its value actually changed. A SwiftUI Toggle
    /// spans its whole row, so XCUIElement.tap() (geometric center) lands on the
    /// label and misses the control. Center-tap first (correct for a narrow native
    /// switch); if the value doesn't move, retry on the trailing edge via an
    /// element-anchored normalized offset — still adaptive, resolved from the
    /// element's live frame, not a raw screen coordinate. If it still doesn't
    /// change, that's an interaction failure, reported as such rather than as a
    /// confirmed product defect.
    private func tapSwitch(_ element: XCUIElement, stepID: String) throws {
        let before = element.value as? String
        element.tap()
        if let before, settledValue(of: element) == before {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        }
        if let before, let after = settledValue(of: element), before == after {
            throw RunnerError.step(stepID, "switch tap did not change its value (stayed \(before.debugDescription)); the control was not activated, so this is an interaction failure, not a confirmed product defect")
        }
    }

    /// Re-read a control's value after a short settle so a post-tap comparison
    /// reflects the committed state, not an in-flight animation frame.
    private func settledValue(of element: XCUIElement) -> String? {
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        return element.value as? String
    }

    private func waitUntilHittable(_ element: XCUIElement, timeoutMs: Int?) -> Bool {
        let deadline = Date().addingTimeInterval(seconds(timeoutMs))
        repeat {
            if element.exists && element.isHittable { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        } while Date() < deadline
        return element.exists && element.isHittable
    }

    private func verify(_ verification: Verification, in app: XCUIApplication, stepID: String) throws {
        let timeout = verification.timeoutMs
        switch verification.kind {
        case "exists":
            _ = try resolve(verification.selector, in: app, timeoutMs: timeout)
        case "notExists":
            let candidates = unresolvedCandidates(verification.selector, in: app)
            let deadline = Date().addingTimeInterval(seconds(timeout))
            while candidates.contains(where: \.exists), Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
            guard !candidates.contains(where: \.exists) else { throw RunnerError.step(stepID, "expected element not to exist") }
        case "labelEquals":
            guard let expected = verification.value else { throw RunnerError.step(stepID, "labelEquals is missing value") }
            let element = try resolve(verification.selector, in: app, timeoutMs: timeout)
            guard element.label == expected else {
                throw RunnerError.step(stepID, "expected label \(expected.debugDescription), got \(element.label.debugDescription)")
            }
        default:
            throw RunnerError.unsupported("verification \(verification.kind) at step \(stepID)")
        }
    }

    private func unresolvedCandidates(_ selector: Selector, in app: XCUIApplication) -> [XCUIElement] {
        let query = query(for: selector.role, in: app)
        var elements: [XCUIElement] = []
        if let identifier = selector.identifier, !identifier.isEmpty { elements.append(query.matching(identifier: identifier).firstMatch) }
        if let label = selector.label, !label.isEmpty { elements.append(query.matching(NSPredicate(format: "label == %@", label)).firstMatch) }
        return elements
    }

    private func seconds(_ timeoutMs: Int?) -> TimeInterval {
        TimeInterval(timeoutMs ?? 10_000) / 1_000
    }
}
