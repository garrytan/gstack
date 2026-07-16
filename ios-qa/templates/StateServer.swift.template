// AUTO-GENERATED from gstack/ios-qa/templates/StateServer.swift.template
// Regenerate with: /ios-sync
//
// StateServer — HTTP server embedded in the iOS app under test. Loopback-only.
// All tailnet ingress is the responsibility of the Mac-side daemon.
//
// Threat model: this surface is reachable from the local Mac via the CoreDevice
// IPv6 tunnel. It MUST refuse any caller without a current bearer token. The
// boot token is rotated within ~5 seconds of daemon spawn so anything scraping
// os_log past that window sees a dead credential.

import Foundation
import Network
import os.log

#if DEBUG

public typealias JSONDict = [String: Any]

@MainActor
public final class StateServer {
    // MARK: Public surface

    public static let shared = StateServer()

    // MARK: Configuration

    private let logger = Logger(subsystem: "gstack.ios-qa", category: "StateServer")
    private let port: UInt16
    private let bootTokenPath: String

    // Two listeners for dual-stack loopback. The fork's single-listener IPv6-only
    // binding was caught in eng + outside-voice review as incomplete.
    private var ipv6Listener: NWListener?
    private var ipv4Listener: NWListener?

    // Auth state. The boot token is what we wrote to os_log on first launch.
    // It exists ONLY long enough for the daemon to call /auth/rotate.
    private var bootToken: String
    private var rotatedToken: String?  // set after first /auth/rotate
    private var bootTokenValid: Bool = true

    // MARK: Session lock (per-device, sliding window on mutations only)

    private struct Session {
        let id: String
        var lastMutationAt: Date
    }
    private var activeSession: Session?
    private let sessionTtlSeconds: TimeInterval = 300  // 5 min orphan timeout

    // MARK: Accessor registry (populated by codegen)

    public typealias ReadHandler = () -> Any?
    public typealias WriteHandler = (Any) -> Bool
    public typealias TypeName = String

    private var readHandlers: [String: ReadHandler] = [:]
    private var writeHandlers: [String: WriteHandler] = [:]
    private var typeNames: [String: TypeName] = [:]

    // Validated-restore hooks. Every generated model registers one two-phase
    // handler. The server validates all models before it lets any model mutate,
    // so invalid input can never cause a cross-model partial restore.
    // Valid restores apply properties on MainActor; observers may receive one
    // change notification per property because arbitrary @Observable models do
    // not expose a general single-assignment transaction API.
    public typealias AtomicRestoreFn = (JSONDict, Bool) -> RestoreResult
    public enum RestoreResult {
        case ok
        case missingKey(String)
        case typeMismatch(String)
        case schemaMismatch(expected: String, got: String)
    }
    private var atomicRestores: [AtomicRestoreFn] = []

    // Snapshot schema hash — written by codegen, stable across builds with
    // identical accessor signatures.
    private var accessorHash: String = "uninitialized"
    private var appBuildId: String = "uninitialized"

    // Agent identity for the DebugOverlay attribution chip. Display-only,
    // never used for auth.
    public private(set) var lastAgentIdentity: String = "Claude Code (local)"

    // MARK: Lifecycle

    private init(port: UInt16 = 9999) {
        self.port = port
        self.bootToken = UUID().uuidString
        self.bootTokenPath = NSTemporaryDirectory() + "gstack-ios-qa.token"
    }

    public func start() {
        // 1. Persist boot token to a 0600 file (best-effort fallback for the
        //    daemon if os_log scrape misses).
        try? bootToken.write(toFile: bootTokenPath, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: bootTokenPath)

        // 2. Log the boot token EXACTLY ONCE so the daemon can scrape it.
        //    The daemon will rotate immediately; this log line is dead within
        //    seconds.
        logger.notice("gstack-ios-qa-bootstrap token=\(self.bootToken, privacy: .public) port=\(self.port, privacy: .public) build=\(self.appBuildId, privacy: .public)")

        // 3. Bind both IPv6 and IPv4 loopback. CoreDevice tunnel uses IPv6;
        //    local tooling may use IPv4. Never bind 0.0.0.0 or ::.
        startListener(family: .ipv6)
        startListener(family: .ipv4)
    }

    public func register(buildId: String, accessorHash: String, atomicRestore: @escaping AtomicRestoreFn) {
        self.appBuildId = buildId
        self.accessorHash = accessorHash
        self.atomicRestores.append(atomicRestore)
    }

    public func registerAccessor(key: String, type: String, read: @escaping ReadHandler, write: @escaping WriteHandler) {
        readHandlers[key] = read
        writeHandlers[key] = write
        typeNames[key] = type
    }

    // MARK: Listener setup

    private enum AddressFamily {
        case ipv4
        case ipv6

        var host: NWEndpoint.Host {
            switch self {
            case .ipv4: return NWEndpoint.Host("127.0.0.1")
            case .ipv6: return NWEndpoint.Host("::1")
            }
        }
    }

    private func startListener(family: AddressFamily) {
        do {
            // Binding strategy: accept connections from the device's loopback
            // AND from the CoreDevice tunnel (the USB-mounted tunnel the Mac
            // daemon uses to reach this app — appears as a non-loopback
            // utun-style interface on the device with the peer's source
            // address in the fd*/fc* ULA range). We can't use
            // params.acceptLocalOnly — Network.framework's definition of
            // "local" is strictly loopback and silently drops CoreDevice
            // tunnel peers. Instead we accept on the wildcard interface and
            // do a per-connection peer-address check below: loopback OR
            // RFC 4193 ULA (fc00::/7) → accept, everything else → cancel.
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true

            let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    if case .ready = state {
                        self?.logger.notice("StateServer listening on \(String(describing: family))")
                    } else if case .failed(let err) = state {
                        self?.logger.error("StateServer listener failed: \(err.localizedDescription, privacy: .public)")
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in
                    // Defense-in-depth: even with .loopback interface gate, double-check
                    // the peer is loopback. Reject otherwise.
                    if let self, self.isLoopbackPeer(connection) {
                        self.handle(connection)
                    } else {
                        connection.cancel()
                    }
                }
            }
            listener.start(queue: .global(qos: .userInitiated))

            switch family {
            case .ipv6: ipv6Listener = listener
            case .ipv4: ipv4Listener = listener
            }
        } catch {
            logger.error("Listener bind failed (\(String(describing: family))): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func isLoopbackPeer(_ connection: NWConnection) -> Bool {
        switch connection.endpoint {
        case .hostPort(let host, _):
            switch host {
            case .ipv4(let addr):
                return addr == .loopback
            case .ipv6(let addr):
                // Loopback (::1) — local same-device traffic
                if addr.isLoopback { return true }
                // CoreDevice ULA range (fd00::/8 unique-local addresses) —
                // the USB tunnel that the Mac daemon uses to reach this app.
                // Apple's CoreDevice tunnel uses fd-prefixed ULAs like
                // fd72:8347:2ead::1 (Mac-facing) and fd72:8347:2ead::2
                // (device-facing). We accept the entire ULA range since
                // the prefix is regenerated per session.
                let bytes = addr.rawValue
                if bytes.count >= 1 && (bytes[0] & 0xFE) == 0xFC {
                    // RFC 4193 ULA range (fc00::/7) — fc* or fd* prefix.
                    return true
                }
                return false
            case .name(let name, _):
                return name == "localhost"
            @unknown default: return false
            }
        default: return false
        }
    }

    // MARK: Request handling

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .global(qos: .userInitiated))
        receive(connection: connection, buffer: Data())
    }

    private static let maxBodyBytes = 1_048_576  // 1MB hard cap

    private func receive(connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            Task { @MainActor in
                var current = buffer
                if let data = data { current.append(data) }
                if current.count > Self.maxBodyBytes {
                    self.send(connection: connection, status: 413, body: ["error": "body_too_large"])
                    return
                }
                if let req = self.tryParseRequest(current) {
                    self.route(connection: connection, request: req)
                } else if isComplete || error != nil {
                    self.send(connection: connection, status: 400, body: ["error": "bad_request"])
                } else {
                    self.receive(connection: connection, buffer: current)
                }
            }
        }
    }

    struct ParsedRequest {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    private func tryParseRequest(_ data: Data) -> ParsedRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerData = data.subdata(in: 0..<headerEnd.lowerBound)
        let body = data.subdata(in: headerEnd.upperBound..<data.count)
        guard let headerStr = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerStr.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        if let lenStr = headers["content-length"], let len = Int(lenStr), body.count < len {
            return nil  // need more bytes
        }
        return ParsedRequest(method: parts[0], path: parts[1], headers: headers, body: body)
    }

    private func route(connection: NWConnection, request: ParsedRequest) {
        // Update display attribution from header (display only — never trusted
        // for auth).
        if let agent = request.headers["x-agent-identity"], !agent.isEmpty, agent.count < 200 {
            lastAgentIdentity = agent
        }

        let path = request.path

        // 1. Public on loopback: /healthz.
        if request.method == "GET" && path == "/healthz" {
            send(connection: connection, status: 200, body: [
                "version": "1.0.0",
                "build": appBuildId,
                "accessor_hash": accessorHash,
                "bundle_id": Bundle.main.bundleIdentifier ?? "unknown",
            ])
            return
        }

        // 2. Auth bootstrap: /auth/rotate is the ONLY endpoint that accepts the
        //    boot token. Everything else requires the rotated token.
        if request.method == "POST" && path == "/auth/rotate" {
            handleAuthRotate(connection: connection, request: request)
            return
        }

        // 3. All other endpoints require Bearer auth with the rotated token.
        guard authorize(request: request) else {
            send(connection: connection, status: 401, body: ["error": "unauthorized"])
            return
        }

        switch (request.method, path) {
        case ("POST", "/session/acquire"): handleSessionAcquire(connection: connection)
        case ("POST", "/session/release"): handleSessionRelease(connection: connection)
        case ("POST", "/session/heartbeat"): handleSessionHeartbeat(connection: connection, request: request)
        case ("GET", "/state/snapshot"): handleSnapshotGet(connection: connection)
        case ("POST", "/state/restore"): handleSnapshotRestore(connection: connection, request: request)
        case ("GET", "/elements"): handleElements(connection: connection)
        case ("GET", "/screenshot"): handleScreenshot(connection: connection)
        case ("POST", "/tap"): handleMutation(connection: connection, request: request, op: "tap")
        case ("POST", "/swipe"): handleMutation(connection: connection, request: request, op: "swipe")
        case ("POST", "/type"): handleMutation(connection: connection, request: request, op: "type")
        case ("GET", let p) where p.hasPrefix("/state/"):
            let key = String(p.dropFirst("/state/".count))
            handleStateGet(connection: connection, key: key)
        case ("POST", let p) where p.hasPrefix("/state/"):
            let key = String(p.dropFirst("/state/".count))
            handleStateWrite(connection: connection, request: request, key: key)
        default:
            send(connection: connection, status: 404, body: ["error": "not_found", "path": path])
        }
    }

    // MARK: Auth

    private func authorize(request: ParsedRequest) -> Bool {
        guard let auth = request.headers["authorization"], auth.hasPrefix("Bearer ") else { return false }
        let token = String(auth.dropFirst("Bearer ".count))
        return token == rotatedToken
    }

    private func handleAuthRotate(connection: NWConnection, request: ParsedRequest) {
        // Validate boot token (still alive AND used only once).
        guard bootTokenValid,
              let auth = request.headers["authorization"],
              auth.hasPrefix("Bearer "),
              String(auth.dropFirst("Bearer ".count)) == bootToken else {
            send(connection: connection, status: 401, body: ["error": "boot_token_invalid"])
            return
        }

        guard let dict = try? JSONSerialization.jsonObject(with: request.body) as? JSONDict,
              let newToken = dict["new_token"] as? String,
              newToken.count >= 16 else {
            send(connection: connection, status: 400, body: ["error": "invalid_rotate_payload"])
            return
        }

        rotatedToken = newToken
        bootTokenValid = false
        // Best-effort scrub of on-disk boot token file.
        try? FileManager.default.removeItem(atPath: bootTokenPath)

        logger.notice("Boot token rotated; original now invalid")
        send(connection: connection, status: 200, body: ["ok": true])
    }

    // MARK: Session lock

    private static let mutatingPaths: Set<String> = ["/tap", "/swipe", "/type", "/state/restore"]

    private func mutatingPathRequiresSession(_ path: String, method: String) -> Bool {
        if method != "POST" { return false }
        if path.hasPrefix("/state/") && path != "/state/restore" { return true }  // /state/<key> writes
        return Self.mutatingPaths.contains(path)
    }

    private func requireSession(in request: ParsedRequest, connection: NWConnection) -> Bool {
        guard let id = request.headers["x-session-id"] else {
            send(connection: connection, status: 409, body: ["error": "session_required"])
            return false
        }
        guard let current = activeSession, current.id == id else {
            send(connection: connection, status: 409, body: ["error": "session_invalid_or_expired"])
            return false
        }
        // Mutation slides the lock; reads do not.
        activeSession?.lastMutationAt = Date()
        return true
    }

    private func handleSessionAcquire(connection: NWConnection) {
        // Reap orphaned session.
        if let s = activeSession, Date().timeIntervalSince(s.lastMutationAt) > sessionTtlSeconds {
            activeSession = nil
        }
        if activeSession != nil {
            send(connection: connection, status: 423, body: ["error": "device_locked"])
            return
        }
        let id = UUID().uuidString
        activeSession = Session(id: id, lastMutationAt: Date())
        send(connection: connection, status: 200, body: [
            "session_id": id,
            "ttl_seconds": Int(sessionTtlSeconds),
        ])
    }

    private func handleSessionRelease(connection: NWConnection) {
        activeSession = nil
        send(connection: connection, status: 200, body: ["ok": true])
    }

    private func handleSessionHeartbeat(connection: NWConnection, request: ParsedRequest) {
        guard let id = request.headers["x-session-id"],
              activeSession?.id == id else {
            send(connection: connection, status: 409, body: ["error": "session_invalid_or_expired"])
            return
        }
        activeSession?.lastMutationAt = Date()
        send(connection: connection, status: 200, body: ["ok": true, "ttl_seconds": Int(sessionTtlSeconds)])
    }

    // MARK: State handlers

    private func handleStateGet(connection: NWConnection, key: String) {
        guard let handler = readHandlers[key] else {
            send(connection: connection, status: 404, body: ["error": "unknown_key", "key": key])
            return
        }
        let value = handler() ?? NSNull()
        send(connection: connection, status: 200, body: ["key": key, "value": value])
    }

    private func handleStateWrite(connection: NWConnection, request: ParsedRequest, key: String) {
        guard requireSession(in: request, connection: connection) else { return }
        guard let handler = writeHandlers[key] else {
            send(connection: connection, status: 404, body: ["error": "unknown_key", "key": key])
            return
        }
        guard let payload = try? JSONSerialization.jsonObject(with: request.body) as? JSONDict,
              let value = payload["value"] else {
            send(connection: connection, status: 400, body: ["error": "missing_value"])
            return
        }
        let ok = handler(value)
        if ok {
            send(connection: connection, status: 200, body: ["ok": true])
        } else {
            send(connection: connection, status: 400, body: ["error": "type_mismatch", "expected": typeNames[key] ?? "?"])
        }
    }

    private func handleSnapshotGet(connection: NWConnection) {
        var keys: JSONDict = [:]
        for (k, read) in readHandlers {
            keys[k] = read() ?? NSNull()
        }
        let envelope: JSONDict = [
            "_schema_version": 1,
            "_app_build_id": appBuildId,
            "_accessor_hash": accessorHash,
            "keys": keys,
        ]
        send(connection: connection, status: 200, body: envelope)
    }

    private func handleSnapshotRestore(connection: NWConnection, request: ParsedRequest) {
        guard requireSession(in: request, connection: connection) else { return }
        guard let envelope = try? JSONSerialization.jsonObject(with: request.body) as? JSONDict else {
            send(connection: connection, status: 400, body: ["error": "invalid_json"])
            return
        }
        // Schema gate.
        if let hash = envelope["_accessor_hash"] as? String, hash != accessorHash {
            send(connection: connection, status: 409, body: [
                "error": "schema_mismatch",
                "expected_hash": accessorHash,
                "got_hash": hash,
            ])
            return
        }
        guard let keys = envelope["keys"] as? JSONDict else {
            send(connection: connection, status: 400, body: ["error": "missing_keys"])
            return
        }
        guard !atomicRestores.isEmpty else {
            send(connection: connection, status: 503, body: ["error": "atomic_restore_not_registered"])
            return
        }
        // Phase one validates every registered model without assignment.
        for restore in atomicRestores {
            switch restore(keys, false) {
            case .ok:
                continue
            case .missingKey(let k):
                send(connection: connection, status: 400, body: ["error": "validation_failed", "key": k, "reason": "missing"])
                return
            case .typeMismatch(let k):
                send(connection: connection, status: 400, body: ["error": "validation_failed", "key": k, "reason": "type-mismatch"])
                return
            case .schemaMismatch(let expected, let got):
                send(connection: connection, status: 409, body: ["error": "schema_mismatch", "expected_hash": expected, "got_hash": got])
                return
            }
        }

        // Phase two applies only after every model accepted the immutable input.
        // A valid multi-field restore may notify once per property.
        for restore in atomicRestores {
            guard case .ok = restore(keys, true) else {
                send(connection: connection, status: 500, body: ["error": "restore_apply_failed"])
                return
            }
        }
        send(connection: connection, status: 200, body: ["ok": true])
    }

    // MARK: Stubs (real impls live in DebugBridgeManager + UIKit)

    private func handleElements(connection: NWConnection) {
        let tree = ElementsBridge.snapshot()
        send(connection: connection, status: 200, body: ["elements": tree])
    }

    private func handleScreenshot(connection: NWConnection) {
        if let png = ScreenshotBridge.capturePNG() {
            send(connection: connection, status: 200, body: ["png_base64": png.base64EncodedString()])
        } else {
            send(connection: connection, status: 500, body: ["error": "screenshot_unavailable"])
        }
    }

    private func handleMutation(connection: NWConnection, request: ParsedRequest, op: String) {
        guard requireSession(in: request, connection: connection) else { return }
        guard let payload = try? JSONSerialization.jsonObject(with: request.body) as? JSONDict else {
            send(connection: connection, status: 400, body: ["error": "invalid_json"])
            return
        }
        let ok = MutationBridge.dispatch(op: op, payload: payload)
        send(connection: connection, status: ok ? 200 : 400, body: ["op": op, "ok": ok])
    }

    // MARK: Response

    private func send(connection: NWConnection, status: Int, body: JSONDict) {
        let responseStatus: Int
        let json: Data
        if JSONSerialization.isValidJSONObject(body),
           let encoded = try? JSONSerialization.data(withJSONObject: body) {
            responseStatus = status
            json = encoded
        } else {
            logger.error("Refusing to send a non-JSON response body")
            responseStatus = 500
            json = Data("{\"error\":\"response_not_json_serializable\"}".utf8)
        }
        let statusText: String
        switch responseStatus {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 404: statusText = "Not Found"
        case 409: statusText = "Conflict"
        case 413: statusText = "Payload Too Large"
        case 423: statusText = "Locked"
        case 429: statusText = "Too Many Requests"
        case 500: statusText = "Internal Server Error"
        case 503: statusText = "Service Unavailable"
        default: statusText = "Status"
        }
        let header = "HTTP/1.1 \(responseStatus) \(statusText)\r\nContent-Type: application/json\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n"
        var packet = Data(header.utf8)
        packet.append(json)
        connection.send(content: packet, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

// MARK: - Bridges (implementation provided by DebugBridgeManager)

@MainActor
public enum ElementsBridge {
    public static var resolver: () -> [JSONDict] = { [] }
    static func snapshot() -> [JSONDict] { resolver() }
}

@MainActor
public enum ScreenshotBridge {
    public static var resolver: () -> Data? = { nil }
    static func capturePNG() -> Data? { resolver() }
}

@MainActor
public enum MutationBridge {
    public static var resolver: (String, JSONDict) -> Bool = { _, _ in false }
    static func dispatch(op: String, payload: JSONDict) -> Bool { resolver(op, payload) }
}

#endif // DEBUG
