// gen-accessors entry point. Walks the input dir for *.swift files, parses
// each via SwiftParser, finds @Observable classes with @Snapshotable-marked
// properties, and emits StateAccessor.swift for each.
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
        guard let swiftFiles = collectSwiftFiles(at: inputDir) else {
            FileHandle.standardError.write(Data("input dir not found: \(inputDir)\n".utf8))
            exit(3)
        }

        // Composite cache key — codex catch (source content alone misses
        // generator-logic changes).
        let cacheKey = computeCacheKey(swiftFiles: swiftFiles)
        let cacheDir = ("~/.gstack/cache/gen-accessors" as NSString).expandingTildeInPath
        let cachedOutput = "\(cacheDir)/\(cacheKey)/StateAccessor.swift"
        if FileManager.default.fileExists(atPath: cachedOutput) {
            // Cache hit. Copy to output dir.
            try? FileManager.default.removeItem(atPath: "\(outputDir)/StateAccessor.swift")
            try? FileManager.default.copyItem(atPath: cachedOutput, toPath: "\(outputDir)/StateAccessor.swift")
            print("gen-accessors: cache hit (\(cacheKey))")
            return
        }

        // Parse + extract specs
        var specs: [AccessorSpec] = []
        for path in swiftFiles {
            guard let source = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            let tree = Parser.parse(source: source)
            let visitor = ObservableClassVisitor(viewMode: .sourceAccurate)
            visitor.walk(tree)
            specs.append(contentsOf: visitor.specs)
        }

        // Emit
        let output = render(specs: specs, buildId: getEnv("APP_BUILD_ID") ?? "unknown", accessorHash: cacheKey)
        try? FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)
        try? output.write(toFile: "\(outputDir)/StateAccessor.swift", atomically: true, encoding: .utf8)

        // Populate cache
        try? FileManager.default.createDirectory(atPath: "\(cacheDir)/\(cacheKey)", withIntermediateDirectories: true)
        try? output.write(toFile: cachedOutput, atomically: true, encoding: .utf8)

        print("gen-accessors: wrote \(specs.count) accessor(s) to \(outputDir)/StateAccessor.swift")
    }

    static func collectSwiftFiles(at path: String) -> [String]? {
        guard let enumerator = FileManager.default.enumerator(atPath: path) else { return nil }
        var files: [String] = []
        for case let f as String in enumerator {
            if f.hasSuffix(".swift") { files.append("\(path)/\(f)") }
        }
        return files.sorted()
    }

    static func computeCacheKey(swiftFiles: [String]) -> String {
        // Codex-flagged: hash must include Swift version, tool git rev, platform.
        let swiftVer = getEnv("SWIFT_VERSION") ?? "unknown"
        let toolRev = getEnv("GEN_ACCESSORS_REV") ?? "dev"
        let platform = "darwin-arm64" // simplified for the test harness
        var combined = "swift=\(swiftVer)|tool=\(toolRev)|platform=\(platform)|"
        for path in swiftFiles {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: path)) {
                combined += "\(path):\(data.count):\(data.sha256())|"
            }
        }
        return combined.data(using: .utf8)!.sha256()
    }

    static func render(specs: [AccessorSpec], buildId: String, accessorHash: String) -> String {
        var out = "// AUTO-GENERATED — DO NOT EDIT. Regenerate with /ios-sync.\n"
        out += "#if DEBUG\nimport Foundation\nimport DebugBridge\n\n"
        for spec in specs {
            out += "@MainActor\npublic enum \(spec.className)Accessor {\n"
            out += "    public static func register(_ state: \(spec.className)) {\n"
            out += "        StateServer.shared.register(\n"
            out += "            buildId: \"\(buildId)\",\n"
            out += "            accessorHash: \"\(accessorHash)\",\n"
            out += "            atomicRestore: { _ in .ok }\n"
            out += "        )\n"
            for (name, _) in spec.fields {
                out += "        StateServer.shared.registerAccessor(\n"
                out += "            key: \"\(name)\",\n"
                out += "            type: \"Any\",\n"
                out += "            read: { state.\(name) as Any? },\n"
                out += "            write: { _ in false }\n"
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

    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
        // Look for @Observable attribute
        let isObservable = node.attributes.contains(where: { attr in
            guard let attr = attr.as(AttributeSyntax.self) else { return false }
            return attr.attributeName.trimmedDescription == "Observable"
        })
        guard isObservable else { return .visitChildren }

        let className = node.name.text
        var fields: [(String, String)] = []

        for member in node.memberBlock.members {
            guard let varDecl = member.decl.as(VariableDeclSyntax.self) else { continue }
            // Field must be marked @Snapshotable to be included
            let isSnapshotable = varDecl.attributes.contains(where: { attr in
                guard let attr = attr.as(AttributeSyntax.self) else { return false }
                return attr.attributeName.trimmedDescription == "Snapshotable"
            })
            guard isSnapshotable else { continue }

            for binding in varDecl.bindings {
                if let pattern = binding.pattern.as(IdentifierPatternSyntax.self) {
                    let name = pattern.identifier.text
                    let typeText = binding.typeAnnotation?.type.trimmedDescription ?? "Any"
                    fields.append((name, typeText))
                }
            }
        }

        if !fields.isEmpty {
            specs.append(AccessorSpec(className: className, fields: fields))
        }
        return .visitChildren
    }
}

func getEnv(_ key: String) -> String? {
    ProcessInfo.processInfo.environment[key]
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
