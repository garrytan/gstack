// gen-accessors entry point. Walks the input dir for *.swift files, parses
// each via SwiftParser, finds @Observable classes with `// @Snapshotable`
// source-marker comments (plus the legacy attribute form), and emits
// StateAccessor.swift for each.
//
// Output goes to --output (default: same dir as input). Cache key is
// computed from a composite hash and stored at
// ~/.gstack/cache/gen-accessors/<hash>/StateAccessor.swift.

import Foundation
import SwiftSyntax
import SwiftParser

struct AccessorSpec {
    let className: String
    let fields: [(name: String, typeText: String)]
}

private let generatorFormatVersion = "accessor-generator-v5"

@main
struct GenAccessors {
    static func main() async {
        let args = CommandLine.arguments
        guard let inputIdx = args.firstIndex(of: "--input"), args.count > inputIdx + 1 else {
            FileHandle.standardError.write(Data("usage: gen-accessors --input <dir> [--output <dir>]\n".utf8))
            exit(2)
        }
        let inputDir = args[inputIdx + 1]
        let outputDir: String = {
            if let idx = args.firstIndex(of: "--output"), args.count > idx + 1 {
                return args[idx + 1]
            }
            return inputDir
        }()

        // Walk + collect *.swift files
        guard let swiftFiles = collectSwiftFiles(at: inputDir, excluding: outputDir) else {
            FileHandle.standardError.write(Data("input dir not found: \(inputDir)\n".utf8))
            exit(3)
        }

        // Parse + validate before consulting the cache. Invalid marked fields
        // must fail deterministically rather than being hidden by an older
        // cached output.
        var specs: [AccessorSpec] = []
        var diagnostics: [String] = []
        for path in swiftFiles {
            guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            let tree = Parser.parse(source: source)
            let visitor = ObservableClassVisitor(sourcePath: path, viewMode: .sourceAccurate)
            visitor.walk(tree)
            specs.append(contentsOf: visitor.specs)
            diagnostics.append(contentsOf: visitor.diagnostics)
        }
        var snapshotKeyOwners: [String: String] = [:]
        for spec in specs {
            for field in spec.fields {
                if let previous = snapshotKeyOwners[field.name] {
                    diagnostics.append(
                        "snapshot key '\(field.name)' is declared by both \(previous) and \(spec.className); "
                            + "keys must be unique across @Observable types"
                    )
                } else {
                    snapshotKeyOwners[field.name] = spec.className
                }
            }
        }
        if !diagnostics.isEmpty {
            let message = "gen-accessors: invalid @Snapshotable declaration(s):\n"
                + diagnostics.map { "  - \($0)" }.joined(separator: "\n") + "\n"
            FileHandle.standardError.write(Data(message.utf8))
            exit(4)
        }

        let buildId = detectedBuildId()
        let accessorHash = computeAccessorHash(specs: specs)
        // Cache identity includes build provenance and generator ABI. The
        // separately computed accessorHash is schema-only and remains stable
        // across checkout paths, unrelated sources, and app rebuilds.
        let cacheKey = computeCacheKey(swiftFiles: swiftFiles, buildId: buildId)
        let cacheDir = getEnv("GSTACK_IOS_CACHE_ROOT")
            ?? ("~/.gstack/cache/gen-accessors" as NSString).expandingTildeInPath
        let cachedOutput = "\(cacheDir)/\(cacheKey)/StateAccessor.swift"
        do {
            try FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("gen-accessors: cannot create output directory: \(error)\n".utf8))
            exit(5)
        }
        if FileManager.default.fileExists(atPath: cachedOutput) {
            // Cache hit. Copy to output dir.
            let finalOutput = "\(outputDir)/StateAccessor.swift"
            do {
                if FileManager.default.fileExists(atPath: finalOutput) {
                    try FileManager.default.removeItem(atPath: finalOutput)
                }
                try FileManager.default.copyItem(atPath: cachedOutput, toPath: finalOutput)
            } catch {
                FileHandle.standardError.write(Data("gen-accessors: cannot restore cached output: \(error)\n".utf8))
                exit(5)
            }
            print("gen-accessors: cache hit (\(cacheKey))")
            return
        }

        // Emit
        let output = render(specs: specs, buildId: buildId, accessorHash: accessorHash)
        do {
            try output.write(toFile: "\(outputDir)/StateAccessor.swift", atomically: true, encoding: .utf8)
        } catch {
            FileHandle.standardError.write(Data("gen-accessors: cannot write output: \(error)\n".utf8))
            exit(5)
        }

        // Populate cache
        try? FileManager.default.createDirectory(atPath: "\(cacheDir)/\(cacheKey)", withIntermediateDirectories: true)
        try? output.write(toFile: cachedOutput, atomically: true, encoding: .utf8)

        print("gen-accessors: wrote \(specs.count) accessor(s) to \(outputDir)/StateAccessor.swift")
    }

    static func collectSwiftFiles(at path: String, excluding outputPath: String) -> [String]? {
        let inputURL = URL(fileURLWithPath: path).standardizedFileURL
        let outputURL = URL(fileURLWithPath: outputPath).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: inputURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue,
              let enumerator = FileManager.default.enumerator(
                at: inputURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: []
              ) else { return nil }

        // When --output is the input root, scan the root but still exclude
        // StateAccessor.swift. For a nested output, skip the entire subtree.
        let shouldExcludeOutputSubtree = outputURL.path != inputURL.path
        var files: [String] = []
        for case let fileURL as URL in enumerator {
            let normalized = fileURL.standardizedFileURL
            let values = try? normalized.resourceValues(forKeys: [.isDirectoryKey])
            if values?.isDirectory == true {
                if normalized.lastPathComponent == "DebugBridgeGenerated"
                    || (shouldExcludeOutputSubtree && normalized.path == outputURL.path) {
                    enumerator.skipDescendants()
                }
                continue
            }
            guard normalized.pathExtension == "swift",
                  normalized.lastPathComponent != "StateAccessor.swift" else { continue }
            files.append(normalized.path)
        }
        return files.sorted()
    }

    static func computeCacheKey(swiftFiles: [String], buildId: String) -> String {
        // Codex-flagged: hash must include Swift version, tool git rev, platform.
        let swiftVer = getEnv("SWIFT_VERSION") ?? "unknown"
        let toolRev = getEnv("GEN_ACCESSORS_REV") ?? generatorFormatVersion
        #if arch(arm64)
        let platform = "darwin-arm64"
        #elseif arch(x86_64)
        let platform = "darwin-x86_64"
        #else
        let platform = "darwin-unknown"
        #endif
        var combined = Data("\(generatorFormatVersion)|swift=\(swiftVer)|tool=\(toolRev)|platform=\(platform)|build=\(buildId)|".utf8)
        for path in swiftFiles {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
                // Do not include absolute checkout paths in cache identity.
                combined.append(Data("\(data.count):".utf8))
                combined.append(data)
                combined.append(Data("|".utf8))
            }
        }
        return combined.sha256()
    }

    static func computeAccessorHash(specs: [AccessorSpec]) -> String {
        var signature = "snapshot-schema-v1\n"
        for spec in specs {
            signature += "C\(spec.className.utf8.count):\(spec.className)\n"
            for field in spec.fields {
                signature += "F\(field.name.utf8.count):\(field.name)"
                signature += "T\(field.typeText.utf8.count):\(field.typeText)\n"
            }
            signature += "E\n"
        }
        return signature.sha256()
    }

    static func render(specs: [AccessorSpec], buildId: String, accessorHash: String) -> String {
        var out = "// AUTO-GENERATED — DO NOT EDIT. Regenerate with /ios-sync.\n"
        out += "#if DEBUG\nimport Foundation\nimport DebugBridgeCore\n\n"
        if !specs.isEmpty {
            // JSONSerialization produces Foundation bridge objects. Direct
            // `as?` casts let NSNumber cross-cast between Bool and numeric
            // Swift types. Round-tripping through JSONDecoder enforces the
            // declared Codable shape (including every collection element)
            // and preserves a successful Optional nil as a double Optional.
            out += "private enum _GStackDebugBridgeSnapshotJSON {\n"
            out += "    private struct Box<Value: Decodable>: Decodable {\n"
            out += "        let value: Value\n"
            out += "    }\n\n"
            out += "    static func decode<Value: Decodable>(_ value: Any, as _: Value.Type) -> Value? {\n"
            out += "        let object: [String: Any] = [\"value\": value]\n"
            out += "        guard JSONSerialization.isValidJSONObject(object),\n"
            out += "              let data = try? JSONSerialization.data(withJSONObject: object) else {\n"
            out += "            return nil\n"
            out += "        }\n"
            out += "        do {\n"
            out += "            return try JSONDecoder().decode(Box<Value>.self, from: data).value\n"
            out += "        } catch {\n"
            out += "            return nil\n"
            out += "        }\n"
            out += "    }\n"
            out += "}\n\n"
        }
        for spec in specs {
            // Accessors live in the app target beside its usually-internal
            // state types. A public signature cannot expose an internal type.
            out += "@MainActor\nenum \(spec.className)Accessor {\n"
            out += "    static func register(_ state: \(spec.className)) {\n"
            out += "        StateServer.shared.register(\n"
            out += "            buildId: {\n"
            out += "                let shortVersion = Bundle.main.object(forInfoDictionaryKey: \"CFBundleShortVersionString\") as? String\n"
            out += "                let bundleVersion = Bundle.main.object(forInfoDictionaryKey: \"CFBundleVersion\") as? String\n"
            out += "                if let shortVersion, let bundleVersion { return \"\\(shortVersion) (\\(bundleVersion))\" }\n"
            out += "                return shortVersion ?? bundleVersion ?? \(String(reflecting: buildId))\n"
            out += "            }(),\n"
            out += "            accessorHash: \(String(reflecting: accessorHash)),\n"
            out += "            atomicRestore: { keys, apply in\n"
            out += "                // Validate every key and value before assignment.\n"
            out += "                // StateServer invokes every model once with apply=false,\n"
            out += "                // then applies every validated model with apply=true.\n"
            for (index, field) in spec.fields.enumerated() {
                let (name, typeText) = field
                out += "                guard let raw\(index) = keys[\"\(name)\"] else {\n"
                out += "                    return .missingKey(\"\(name)\")\n"
                out += "                }\n"
                out += "                guard let restored\(index): \(typeText) = _GStackDebugBridgeSnapshotJSON.decode(raw\(index), as: \(typeText).self) else {\n"
                out += "                    return .typeMismatch(\"\(name)\")\n"
                out += "                }\n"
            }
            out += "                if apply {\n"
            for (index, field) in spec.fields.enumerated() {
                out += "                    state.\(field.name) = restored\(index)\n"
            }
            out += "                }\n"
            out += "                return .ok\n"
            out += "            }\n"
            out += "        )\n"
            for (name, typeText) in spec.fields {
                let wrapped = optionalWrappedType(typeText)
                out += "        StateServer.shared.registerAccessor(\n"
                out += "            key: \"\(name)\",\n"
                out += "            type: \"\(typeText)\",\n"
                if wrapped != nil {
                    out += "            read: {\n"
                    out += "                guard let value = state.\(name) else { return NSNull() }\n"
                    out += "                return value as Any\n"
                    out += "            },\n"
                } else {
                    out += "            read: { state.\(name) as Any? },\n"
                }
                out += "            write: { value in\n"
                out += "                guard let typed: \(typeText) = _GStackDebugBridgeSnapshotJSON.decode(value, as: \(typeText).self) else { return false }\n"
                out += "                state.\(name) = typed\n"
                out += "                return true\n"
                out += "            }\n"
                out += "        )\n"
            }
            out += "    }\n}\n\n"
        }
        out += "#endif\n"
        return out
    }
}

final class ObservableClassVisitor: SyntaxVisitor {
    var specs: [AccessorSpec] = []
    var diagnostics: [String] = []
    private let sourcePath: String

    init(sourcePath: String, viewMode: SyntaxTreeViewMode) {
        self.sourcePath = sourcePath
        super.init(viewMode: viewMode)
    }

    private func hasSnapshotableMarker(_ declaration: VariableDeclSyntax) -> Bool {
        // Preserve compatibility with source that defines a custom attribute
        // or wrapper, even though that form conflicts with @Observable in
        // ordinary app models.
        if declaration.attributes.contains(where: { attribute in
            guard let attribute = attribute.as(AttributeSyntax.self) else { return false }
            return attribute.attributeName.trimmedDescription == "Snapshotable"
        }) {
            return true
        }

        // Match a standalone ordinary line-comment trivia piece exactly.
        // Avoid declaration.description/contains: both would accept prose
        // such as `// do not expose through @Snapshotable`.
        return declaration.leadingTrivia.contains { piece in
            guard case .lineComment(let text) = piece else { return false }
            return text.dropFirst(2).trimmingCharacters(in: .whitespaces) == "@Snapshotable"
        }
    }

    private func enclosingScopeDescription(for node: ClassDeclSyntax) -> String? {
        var ancestor = Syntax(node).parent
        while let current = ancestor {
            if let declaration = current.as(ClassDeclSyntax.self) {
                return "class \(declaration.name.text)"
            }
            if let declaration = current.as(StructDeclSyntax.self) {
                return "struct \(declaration.name.text)"
            }
            if let declaration = current.as(EnumDeclSyntax.self) {
                return "enum \(declaration.name.text)"
            }
            if let declaration = current.as(ActorDeclSyntax.self) {
                return "actor \(declaration.name.text)"
            }
            if let declaration = current.as(ExtensionDeclSyntax.self) {
                return "extension \(declaration.extendedType.trimmedDescription)"
            }
            if current.is(CodeBlockSyntax.self) {
                return "a local scope"
            }
            ancestor = current.parent
        }
        return nil
    }

    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
        // Look for @Observable attribute
        let isObservable = node.attributes.contains(where: { attr in
            guard let attr = attr.as(AttributeSyntax.self) else { return false }
            return attr.attributeName.trimmedDescription == "Observable"
        })
        guard isObservable else { return .visitChildren }

        let className = node.name.text
        let markedMembers = node.memberBlock.members.compactMap {
            $0.decl.as(VariableDeclSyntax.self)
        }.filter(hasSnapshotableMarker)
        if !markedMembers.isEmpty, let enclosingScope = enclosingScopeDescription(for: node) {
            diagnostics.append(
                "\((sourcePath as NSString).lastPathComponent): nested @Observable class "
                    + "\(className) inside \(enclosingScope) is unsupported; "
                    + "move snapshot-enabled models to file scope"
            )
            // Continue walking so a more deeply nested marked model is also
            // diagnosed rather than silently omitted.
            return .visitChildren
        }
        var fields: [(String, String)] = []

        for member in node.memberBlock.members {
            guard let varDecl = member.decl.as(VariableDeclSyntax.self) else { continue }
            // Field must opt in with the source marker (or legacy attribute).
            guard hasSnapshotableMarker(varDecl) else { continue }

            let bindingName = varDecl.bindings.first?
                .pattern.as(IdentifierPatternSyntax.self)?.identifier.text ?? "<unknown>"
            let context = "\((sourcePath as NSString).lastPathComponent): \(className).\(bindingName)"
            if varDecl.bindingSpecifier.text == "let" {
                diagnostics.append("\(context) must be declared var, not let")
                continue
            }
            let modifierNames = varDecl.modifiers.map { modifier -> String in
                let detail = modifier.detail?.trimmedDescription ?? ""
                return modifier.name.text + detail
            }
            if modifierNames.contains(where: {
                $0 == "private" || $0 == "fileprivate"
                    || $0 == "private(set)" || $0 == "fileprivate(set)"
            }) {
                diagnostics.append("\(context) cannot be private, fileprivate, private(set), or fileprivate(set)")
                continue
            }
            if modifierNames.contains("static") || modifierNames.contains("class") {
                diagnostics.append("\(context) must be an instance property")
                continue
            }
            if varDecl.bindings.count != 1 {
                diagnostics.append("\(context) declaration must contain exactly one binding")
                continue
            }

            for binding in varDecl.bindings {
                guard let pattern = binding.pattern.as(IdentifierPatternSyntax.self) else {
                    diagnostics.append("\(context) only supports an identifier binding")
                    continue
                }
                // An initializer plus an accessor block is a stored property
                // with observers. Without an initializer, conservatively
                // reject the block rather than emitting a setter for a
                // computed/read-only declaration.
                if binding.accessorBlock != nil && binding.initializer == nil {
                    diagnostics.append("\(context) must be stored and writable")
                    continue
                }
                guard let annotation = binding.typeAnnotation else {
                    diagnostics.append("\(context) requires an explicit type annotation")
                    continue
                }
                let name = pattern.identifier.text
                let typeText = annotation.type.trimmedDescription
                    .split(whereSeparator: { $0.isWhitespace })
                    .joined(separator: " ")
                switch parseJSONSnapshotType(typeText) {
                case .valid:
                    break
                case .implicitlyUnwrappedOptional:
                    diagnostics.append("\(context) cannot use an implicitly unwrapped Optional type")
                    continue
                case .nestedOptional:
                    diagnostics.append("\(context) cannot use a nested Optional type")
                    continue
                case .unsupported:
                    diagnostics.append("\(context) uses unsupported non-JSON snapshot type '\(typeText)'")
                    continue
                }
                fields.append((name, typeText))
            }
        }

        if !fields.isEmpty {
            specs.append(AccessorSpec(className: className, fields: fields))
        }
        return .visitChildren
    }
}

private indirect enum JSONSnapshotType {
    case scalar
    case optional(JSONSnapshotType)
    case array(JSONSnapshotType)
    case dictionary(JSONSnapshotType)

    var isOptional: Bool {
        if case .optional = self { return true }
        return false
    }
}

private enum JSONSnapshotTypeParseResult {
    case valid(JSONSnapshotType)
    case implicitlyUnwrappedOptional
    case nestedOptional
    case unsupported
}

/// Parse the deliberately small set of Swift types that can make a lossless
/// trip through JSONSerialization and JSONDecoder without application-defined
/// encoding behavior. Type aliases and arbitrary Codable models are rejected:
/// the bridge has no compiler/type-checker context in which to prove that they
/// are JSON-native.
private func parseJSONSnapshotType(_ source: String) -> JSONSnapshotTypeParseResult {
    let type = source.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !type.isEmpty else { return .unsupported }

    if type.hasSuffix("!") {
        return .implicitlyUnwrappedOptional
    }

    if type.hasSuffix("?") {
        let wrappedText = String(type.dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
        switch parseJSONSnapshotType(wrappedText) {
        case .valid(let wrapped):
            return wrapped.isOptional ? .nestedOptional : .valid(.optional(wrapped))
        case let issue:
            return issue
        }
    }

    if let bracketContents = outerDelimitedContents(type, open: "[", close: "]") {
        let dictionaryParts = splitTopLevel(bracketContents, separator: ":")
        if dictionaryParts.count == 1 {
            switch parseJSONSnapshotType(dictionaryParts[0]) {
            case .valid(let element): return .valid(.array(element))
            case let issue: return issue
            }
        }
        guard dictionaryParts.count == 2, isStringType(dictionaryParts[0]) else {
            return .unsupported
        }
        switch parseJSONSnapshotType(dictionaryParts[1]) {
        case .valid(let value): return .valid(.dictionary(value))
        case let issue: return issue
        }
    }

    if let generic = genericTypeParts(type) {
        let base = compactTypeName(generic.base)
        if base == "Optional" || base == "Swift.Optional" {
            guard generic.arguments.count == 1 else { return .unsupported }
            switch parseJSONSnapshotType(generic.arguments[0]) {
            case .valid(let wrapped):
                return wrapped.isOptional ? .nestedOptional : .valid(.optional(wrapped))
            case let issue:
                return issue
            }
        }
        if base == "Array" || base == "Swift.Array" {
            guard generic.arguments.count == 1 else { return .unsupported }
            switch parseJSONSnapshotType(generic.arguments[0]) {
            case .valid(let element): return .valid(.array(element))
            case let issue: return issue
            }
        }
        if base == "Dictionary" || base == "Swift.Dictionary" {
            guard generic.arguments.count == 2, isStringType(generic.arguments[0]) else {
                return .unsupported
            }
            switch parseJSONSnapshotType(generic.arguments[1]) {
            case .valid(let value): return .valid(.dictionary(value))
            case let issue: return issue
            }
        }
        return .unsupported
    }

    let scalar = compactTypeName(type)
    let supportedScalars: Set<String> = [
        "String", "Swift.String",
        "Bool", "Swift.Bool",
        "Int", "Swift.Int", "Int8", "Swift.Int8", "Int16", "Swift.Int16",
        "Int32", "Swift.Int32", "Int64", "Swift.Int64",
        "UInt", "Swift.UInt", "UInt8", "Swift.UInt8", "UInt16", "Swift.UInt16",
        "UInt32", "Swift.UInt32", "UInt64", "Swift.UInt64",
        "Float", "Swift.Float", "Double", "Swift.Double",
        "CGFloat", "CoreGraphics.CGFloat",
    ]
    return supportedScalars.contains(scalar) ? .valid(.scalar) : .unsupported
}

private func isStringType(_ source: String) -> Bool {
    let type = compactTypeName(source)
    return type == "String" || type == "Swift.String"
}

private func compactTypeName(_ source: String) -> String {
    source.filter { !$0.isWhitespace }
}

private func outerDelimitedContents(_ source: String, open: Character, close: Character) -> String? {
    let characters = Array(source)
    guard characters.first == open, characters.last == close else { return nil }
    var depth = 0
    for (index, character) in characters.enumerated() {
        if character == open {
            depth += 1
        } else if character == close {
            depth -= 1
            guard depth >= 0 else { return nil }
            if depth == 0, index != characters.count - 1 { return nil }
        }
    }
    guard depth == 0 else { return nil }
    return String(characters.dropFirst().dropLast())
}

private func genericTypeParts(_ source: String) -> (base: String, arguments: [String])? {
    let characters = Array(source)
    guard let openIndex = characters.firstIndex(of: "<") else { return nil }
    var depth = 0
    var closeIndex: Int?
    for index in openIndex..<characters.count {
        if characters[index] == "<" {
            depth += 1
        } else if characters[index] == ">" {
            depth -= 1
            guard depth >= 0 else { return nil }
            if depth == 0 {
                closeIndex = index
                break
            }
        }
    }
    guard let closeIndex, closeIndex == characters.count - 1 else { return nil }
    let base = String(characters[..<openIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
    let argumentsText = String(characters[(openIndex + 1)..<closeIndex])
    let arguments = splitTopLevel(argumentsText, separator: ",")
    guard !base.isEmpty, !arguments.isEmpty else { return nil }
    return (base, arguments)
}

private func splitTopLevel(_ source: String, separator: Character) -> [String] {
    let characters = Array(source)
    var angleDepth = 0
    var squareDepth = 0
    var parenDepth = 0
    var start = 0
    var parts: [String] = []

    for (index, character) in characters.enumerated() {
        switch character {
        case "<": angleDepth += 1
        case ">": angleDepth -= 1
        case "[": squareDepth += 1
        case "]": squareDepth -= 1
        case "(": parenDepth += 1
        case ")": parenDepth -= 1
        default: break
        }
        if character == separator, angleDepth == 0, squareDepth == 0, parenDepth == 0 {
            parts.append(
                String(characters[start..<index]).trimmingCharacters(in: .whitespacesAndNewlines)
            )
            start = index + 1
        }
    }
    parts.append(String(characters[start...]).trimmingCharacters(in: .whitespacesAndNewlines))
    return parts
}

func getEnv(_ key: String) -> String? {
    ProcessInfo.processInfo.environment[key]
}

func detectedBuildId() -> String {
    if let explicit = getEnv("APP_BUILD_ID"), !explicit.isEmpty { return explicit }
    let marketing = getEnv("MARKETING_VERSION")
    let build = getEnv("CURRENT_PROJECT_VERSION")
    if let marketing, let build, !marketing.isEmpty, !build.isEmpty {
        return "\(marketing) (\(build))"
    }
    if let build, !build.isEmpty { return build }
    return "unknown"
}

func optionalWrappedType(_ typeText: String) -> String? {
    let type = typeText.trimmingCharacters(in: .whitespacesAndNewlines)
    if type.hasSuffix("?") {
        let wrapped = String(type.dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
        return wrapped.isEmpty ? nil : wrapped
    }

    guard let optionalRange = type.range(of: #"^Optional\s*<"#, options: .regularExpression),
          let open = type[optionalRange].lastIndex(of: "<") else { return nil }
    let openIndex = type.distance(from: type.startIndex, to: open)
    var depth = 0
    for (offset, char) in type.enumerated() where offset >= openIndex {
        if char == "<" { depth += 1 }
        else if char == ">" {
            depth -= 1
            if depth == 0 {
                let close = type.index(type.startIndex, offsetBy: offset)
                guard type[type.index(after: close)...].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return nil
                }
                let wrappedStart = type.index(after: open)
                let wrapped = String(type[wrappedStart..<close]).trimmingCharacters(in: .whitespacesAndNewlines)
                return wrapped.isEmpty ? nil : wrapped
            }
        }
    }
    return nil
}

import CryptoKit

extension Data {
    func sha256() -> String {
        SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined()
    }
}

extension String {
    func sha256() -> String {
        Data(self.utf8).sha256()
    }
}
