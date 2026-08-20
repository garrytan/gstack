#!/usr/bin/env bun
//
// gen-accessors (TS port). Mirrors the SwiftPM tool's logic for the cases
// where a user doesn't want to wait 2-5min for swift-syntax to build the
// first time. Also exercised by tests so we can verify the cache + parse
// behavior without a Swift toolchain.
//
// The TS fast path uses a lightweight Swift lexical scanner — it understands:
//   - @Observable class declarations
//   - `// @Snapshotable` property markers (only marked fields are exported)
//   - Legacy @Snapshotable attributes for existing integrations
//   - Multi-line type signatures (collapses whitespace before matching)
//   - JSON-native generic arrays and String-keyed dictionaries
//
// Invalid marked declarations (computed/immutable/inaccessible/untyped,
// nested, duplicate-keyed, or non-JSON) fail generation instead of producing
// Swift that only fails later in xcodebuild or at snapshot time.
//
// Composite cache key (codex-flagged): swift_version || tool_git_rev ||
// platform_triple || source_content_hash. Source-only hash misses generator
// logic changes.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

export interface AccessorField {
  name: string;
  typeText: string;
}

export interface AccessorSpec {
  className: string;
  fields: AccessorField[];
}

export class AccessorGenerationError extends Error {
  readonly diagnostics: string[];

  constructor(diagnostics: string[]) {
    super(`gen-accessors: invalid @Snapshotable declaration(s):\n${diagnostics.map(d => `  - ${d}`).join('\n')}`);
    this.name = 'AccessorGenerationError';
    this.diagnostics = diagnostics;
  }
}

export interface GenInputs {
  inputDir: string;
  outputDir?: string;
  buildId?: string;
  cacheRoot?: string;
  swiftVersion?: string;
  toolGitRev?: string;
  platformTriple?: string;
}

export interface GenResult {
  outputPath: string;
  cacheKey: string;
  accessorHash: string;
  specs: AccessorSpec[];
  cacheHit: boolean;
}

const FALLBACK_PLATFORM = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}`;
const GENERATOR_FORMAT_VERSION = 'accessor-generator-v5';

const JSON_SCALAR_TYPES = new Set([
  'String',
  'Bool',
  'Int', 'Int8', 'Int16', 'Int32', 'Int64',
  'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Float', 'Double', 'CGFloat',
]);

export function collectSwiftFiles(
  dir: string,
  opts: { excludeGenerated?: boolean; outputDir?: string } = {},
): string[] {
  const out: string[] = [];
  const excludeGenerated = opts.excludeGenerated ?? true;
  const root = resolve(dir);
  const outputDir = opts.outputDir ? resolve(opts.outputDir) : undefined;

  function walk(currentDir: string): void {
    for (const name of readdirSync(currentDir)) {
      const full = join(currentDir, name);
      const s = statSync(full);
      if (s.isDirectory()) {
        // The generated subtree must never participate in its own cache key.
        // Keep the well-known-name guard for direct collectSwiftFiles callers,
        // and use the actual --output path when generate() supplies one.
        const isOutputSubtree = outputDir !== undefined
          && outputDir !== root
          && resolve(full) === outputDir;
        if (excludeGenerated && (name === 'DebugBridgeGenerated' || isOutputSubtree)) continue;
        walk(full);
      } else if (name.endsWith('.swift')) {
        // Skip generated accessor files wherever they live. Otherwise moving
        // an old copy outside the output directory poisons the next cache key.
        if (excludeGenerated && name === 'StateAccessor.swift') continue;
        out.push(full);
      }
    }
  }

  walk(root);
  return out.sort();
}

export function parseSwift(source: string): AccessorSpec[] {
  const specs: AccessorSpec[] = [];
  const diagnostics: string[] = [];
  const masked = maskSwiftSource(source);
  // Find `@Observable\n(public )?(final )?class <Name>` followed by a brace
  // block. We then scan inside that block for @Snapshotable fields.
  const classPattern = /@Observable\s*(?:(?:public|internal|fileprivate|private)\s+)?(?:final\s+)?class\s+(\w+)[^{]*\{/g;

  for (const match of masked.matchAll(classPattern)) {
    const className = match[1]!;
    const matchOffset = match.index!;
    const openBraceOffset = matchOffset + match[0].lastIndexOf('{');
    const startIdx = openBraceOffset + 1;
    const endIdx = findMatchingBrace(masked, startIdx - 1);
    if (endIdx === -1) continue;
    const body = masked.slice(startIdx, endIdx);

    const parsed = parseFields(body, source, startIdx, className);
    if (braceDepthAt(masked, matchOffset) !== 0) {
      if (parsed.fields.length > 0 || parsed.diagnostics.length > 0) {
        const line = source.slice(0, matchOffset).split(/\r?\n/).length;
        diagnostics.push(`${className} (line ${line}): nested @Observable types are not supported; move the type to file scope`);
      }
      continue;
    }
    diagnostics.push(...parsed.diagnostics);
    const fields = parsed.fields;
    if (fields.length > 0) {
      specs.push({ className, fields });
    }
  }

  if (diagnostics.length > 0) throw new AccessorGenerationError(diagnostics);
  return specs;
}

function braceDepthAt(masked: string, offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function findMatchingBrace(s: string, openIdx: number): number {
  // Strings and comments have already been blanked by maskSwiftSource, so
  // braces here are syntax rather than prose or literal content.
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Blank comments and string literals while preserving byte offsets/newlines.
 * A canonical standalone `// @Snapshotable` comment is rewritten to the
 * equivalent attribute token. This is intentionally lexical rather than a
 * whole-file regexp: markers inside nested block comments, normal/triple/raw
 * strings, trailing comments, and prose comments must never opt a field in.
 */
function maskSwiftSource(source: string): string {
  const out = source.split('');

  const blank = (start: number, end: number): void => {
    for (let j = start; j < end; j++) {
      if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    if (source[i] === '/' && source[i + 1] === '/') {
      let end = i + 2;
      while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end++;
      const lineStart = source.lastIndexOf('\n', i - 1) + 1;
      const standalone = source.slice(lineStart, i).trim().length === 0;
      const isMarker = standalone && source.slice(i + 2, end).trim() === '@Snapshotable';
      blank(i, end);
      if (isMarker) {
        const marker = '@Snapshotable';
        for (let j = 0; j < marker.length; j++) out[i + j] = marker[j]!;
      }
      i = end;
      continue;
    }

    if (source[i] === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blank(start, i);
      continue;
    }

    // Swift strings may be ordinary, multiline, or raw (`#"..."#` and
    // `#"""..."""#`). Mask the entire literal, including interpolation;
    // declarations cannot legally originate inside a literal.
    let hashCount = 0;
    while (source[i + hashCount] === '#') hashCount++;
    const quoteIdx = i + hashCount;
    if (source[quoteIdx] === '"') {
      const start = i;
      const triple = source.slice(quoteIdx, quoteIdx + 3) === '"""';
      const quoteCount = triple ? 3 : 1;
      i = quoteIdx + quoteCount;
      while (i < source.length) {
        if (hashCount === 0 && source[i] === '\\') {
          i += 2;
          continue;
        }
        const quoteRun = source.slice(i, i + quoteCount) === '"'.repeat(quoteCount);
        const hashesMatch = source.slice(i + quoteCount, i + quoteCount + hashCount) === '#'.repeat(hashCount);
        if (quoteRun && hashesMatch) {
          i += quoteCount + hashCount;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    i++;
  }
  return out.join('');
}

const DECL_MODIFIERS = new Set([
  'public', 'internal', 'package', 'open', 'private', 'fileprivate',
  'final', 'static', 'class', 'lazy', 'weak', 'unowned', 'override',
  'nonisolated', 'isolated', 'borrowing', 'consuming',
]);

function parseFields(
  body: string,
  fullSource: string,
  bodyOffset: number,
  className: string,
): { fields: AccessorField[]; diagnostics: string[] } {
  const fields: AccessorField[] = [];
  const diagnostics: string[] = [];
  let braceDepth = 0;

  const lineFor = (localOffset: number): number => {
    const absolute = bodyOffset + localOffset;
    let line = 1;
    for (let j = 0; j < absolute; j++) if (fullSource[j] === '\n') line++;
    return line;
  };
  const fail = (offset: number, message: string): void => {
    diagnostics.push(`${className} (line ${lineFor(offset)}): ${message}`);
  };
  const skipWhitespace = (start: number): number => {
    let at = start;
    while (at < body.length && /\s/.test(body[at]!)) at++;
    return at;
  };
  const identifierAt = (start: number): { text: string; end: number } | undefined => {
    const m = /^[A-Za-z_]\w*/.exec(body.slice(start));
    return m ? { text: m[0], end: start + m[0].length } : undefined;
  };
  const skipBalancedParens = (start: number): number => {
    if (body[start] !== '(') return start;
    let depth = 0;
    for (let at = start; at < body.length; at++) {
      if (body[at] === '(') depth++;
      else if (body[at] === ')' && --depth === 0) return at + 1;
    }
    return body.length;
  };

  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      braceDepth++;
      continue;
    }
    if (body[i] === '}') {
      braceDepth--;
      continue;
    }
    if (braceDepth !== 0 || !body.startsWith('@Snapshotable', i)) continue;
    const before = i === 0 ? '' : body[i - 1]!;
    const after = body[i + '@Snapshotable'.length] ?? '';
    if (/\w/.test(before) || /\w/.test(after)) continue;

    const markerOffset = i;
    let at = skipWhitespace(i + '@Snapshotable'.length);
    const modifiers: string[] = [];
    let bindingKind: 'var' | 'let' | undefined;

    // Permit other Swift attributes between the marker and declaration. They
    // remain the compiler's responsibility; this scanner only owns the
    // snapshot contract. Parenthesized attribute arguments are skipped.
    while (body[at] === '@') {
      const attribute = identifierAt(at + 1);
      if (!attribute) break;
      at = skipWhitespace(attribute.end);
      if (body[at] === '(') at = skipBalancedParens(at);
      at = skipWhitespace(at);
    }

    while (at < body.length) {
      const token = identifierAt(at);
      if (!token) break;
      if (token.text === 'var' || token.text === 'let') {
        bindingKind = token.text;
        at = token.end;
        break;
      }
      if (!DECL_MODIFIERS.has(token.text)) break;
      let modifier = token.text;
      at = skipWhitespace(token.end);
      if (body[at] === '(') {
        const end = skipBalancedParens(at);
        modifier += body.slice(at, end).replace(/\s+/g, '');
        at = skipWhitespace(end);
      }
      modifiers.push(modifier);
    }

    if (!bindingKind) {
      fail(markerOffset, '@Snapshotable must immediately precede a stored property declaration');
      continue;
    }

    at = skipWhitespace(at);
    const identifier = identifierAt(at);
    const fieldName = identifier?.text ?? '<unknown>';
    if (!identifier) {
      fail(markerOffset, '@Snapshotable only supports a single identifier binding');
      continue;
    }
    at = skipWhitespace(identifier.end);

    if (bindingKind === 'let') {
      fail(markerOffset, `@Snapshotable field '${fieldName}' must be declared var, not let`);
      continue;
    }
    if (modifiers.some(m => /^(?:private|fileprivate)(?:\(set\))?$/.test(m))) {
      fail(markerOffset, `@Snapshotable field '${fieldName}' cannot be private, fileprivate, private(set), or fileprivate(set)`);
      continue;
    }
    if (modifiers.some(m => m === 'static' || m === 'class')) {
      fail(markerOffset, `@Snapshotable field '${fieldName}' must be an instance property`);
      continue;
    }
    if (body[at] !== ':') {
      fail(markerOffset, `@Snapshotable field '${fieldName}' requires an explicit type annotation`);
      continue;
    }

    at = skipWhitespace(at + 1);
    const typeStart = at;
    let parens = 0;
    let brackets = 0;
    let angles = 0;
    let typeEnd = at;
    let delimiter = '';
    for (; at < body.length; at++) {
      const c = body[at]!;
      if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
      else if (c === '<') angles++;
      else if (c === '>') angles = Math.max(0, angles - 1);
      const topLevel = parens === 0 && brackets === 0 && angles === 0;
      if (topLevel && (c === '=' || c === '{' || c === ',' || c === ';')) {
        delimiter = c;
        break;
      }
      if (topLevel && (c === '\n' || c === '\r')) {
        const soFar = body.slice(typeStart, at).trim();
        if (soFar.length > 0 && !/(?:->|[&.,])\s*$/.test(soFar)) break;
      }
      typeEnd = at + 1;
    }
    const typeText = body.slice(typeStart, typeEnd).replace(/\s+/g, ' ').trim();
    if (typeText.length === 0) {
      fail(markerOffset, `@Snapshotable field '${fieldName}' requires an explicit type annotation`);
      continue;
    }
    if (delimiter === '{') {
      fail(markerOffset, `@Snapshotable field '${fieldName}' must be stored and writable`);
      continue;
    }
    if (delimiter === ',') {
      fail(markerOffset, '@Snapshotable declarations must contain exactly one binding');
      continue;
    }
    if (delimiter === '=') {
      // A declaration such as `var a: Int = 1, b: Int = 2` reaches `=`
      // before its binding comma. Scan the initializer at syntax depth zero
      // so commas in arrays/calls/closures remain valid.
      let initializerAt = at + 1;
      let expressionParens = 0;
      let expressionBrackets = 0;
      let expressionBraces = 0;
      let hasSecondBinding = false;
      for (; initializerAt < body.length; initializerAt++) {
        const c = body[initializerAt]!;
        if (c === '(') expressionParens++;
        else if (c === ')') expressionParens--;
        else if (c === '[') expressionBrackets++;
        else if (c === ']') expressionBrackets--;
        else if (c === '{') expressionBraces++;
        else if (c === '}') {
          if (expressionBraces === 0) break;
          expressionBraces--;
        }
        const topLevel = expressionParens === 0 && expressionBrackets === 0 && expressionBraces === 0;
        if (topLevel && c === ',') {
          hasSecondBinding = true;
          break;
        }
        if (topLevel && (c === '\n' || c === '\r' || c === ';')) break;
      }
      if (hasSecondBinding) {
        fail(markerOffset, '@Snapshotable declarations must contain exactly one binding');
        continue;
      }
    }
    const wrappedOptional = optionalWrappedType(typeText);
    if (wrappedOptional !== undefined && optionalWrappedType(wrappedOptional) !== undefined) {
      fail(markerOffset, `@Snapshotable field '${fieldName}' cannot use a nested Optional type`);
      continue;
    }
    const typeIssue = snapshotTypeIssue(typeText);
    if (typeIssue !== undefined) {
      fail(markerOffset, `@Snapshotable field '${fieldName}' ${typeIssue}`);
      continue;
    }

    fields.push({ name: fieldName, typeText });
  }
  return { fields, diagnostics };
}

export function computeCacheKey(inputs: {
  swiftFiles: string[];
  swiftVersion: string;
  toolGitRev: string;
  platformTriple: string;
  buildId?: string;
}): string {
  const h = createHash('sha256');
  h.update(`${GENERATOR_FORMAT_VERSION}|swift=${inputs.swiftVersion}|tool=${inputs.toolGitRev}|platform=${inputs.platformTriple}|build=${inputs.buildId ?? 'unknown'}|`);
  for (const f of inputs.swiftFiles) {
    const content = readFileSync(f);
    // Cache identity is content-based. Absolute checkout paths must not make
    // equivalent source trees produce different generated output.
    h.update(`${content.length}:`);
    h.update(content);
    h.update('|');
  }
  return h.digest('hex');
}

/** Stable snapshot-schema fingerprint, deliberately independent of cache ABI,
 * source paths, app build provenance, and unmarked source. Field/class order is
 * source order because restore payload compatibility is an ordered contract. */
export function computeAccessorHash(specs: AccessorSpec[]): string {
  let signature = 'snapshot-schema-v1\n';
  for (const spec of specs) {
    signature += `C${Buffer.byteLength(spec.className)}:${spec.className}\n`;
    for (const field of spec.fields) {
      signature += `F${Buffer.byteLength(field.name)}:${field.name}`;
      signature += `T${Buffer.byteLength(field.typeText)}:${field.typeText}\n`;
    }
    signature += 'E\n';
  }
  return createHash('sha256').update(signature).digest('hex');
}

/** Return the wrapped type for one top-level Optional spelling. */
export function optionalWrappedType(typeText: string): string | undefined {
  const type = typeText.trim();
  if (type.endsWith('?')) {
    const wrapped = type.slice(0, -1).trim();
    return wrapped.length > 0 ? wrapped : undefined;
  }

  const optional = /^(?:Swift\.)?Optional\s*</.exec(type);
  if (!optional) return undefined;
  const open = type.indexOf('<', optional.index);
  let depth = 0;
  for (let i = open; i < type.length; i++) {
    if (type[i] === '<') depth++;
    else if (type[i] === '>') {
      depth--;
      if (depth === 0) {
        if (type.slice(i + 1).trim().length > 0) return undefined;
        const wrapped = type.slice(open + 1, i).trim();
        return wrapped.length > 0 ? wrapped : undefined;
      }
    }
  }
  return undefined;
}

function splitTopLevel(type: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angle = 0;
  let square = 0;
  let paren = 0;
  for (let i = 0; i < type.length; i++) {
    const char = type[i]!;
    if (char === '<') angle++;
    else if (char === '>') angle--;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '(') paren++;
    else if (char === ')') paren--;
    else if (char === delimiter && angle === 0 && square === 0 && paren === 0) {
      parts.push(type.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(type.slice(start));
  return parts;
}

function genericArgument(type: string, name: string): string | undefined {
  const prefix = `${name}<`;
  if (!type.startsWith(prefix) || !type.endsWith('>')) return undefined;
  let depth = 0;
  for (let i = name.length; i < type.length; i++) {
    if (type[i] === '<') depth++;
    else if (type[i] === '>') {
      depth--;
      if (depth === 0 && i !== type.length - 1) return undefined;
      if (depth < 0) return undefined;
    }
  }
  return depth === 0 ? type.slice(prefix.length, -1) : undefined;
}

/** Return a user-facing suffix when a Swift type cannot round-trip through
 * Foundation JSON without custom encoding. The accepted grammar is deliberately
 * narrow: JSON scalar values, arrays, string-keyed dictionaries, and Optional
 * compositions of those types. */
export function snapshotTypeIssue(typeText: string): string | undefined {
  const type = typeText.replace(/\s+/g, '');
  if (type.length === 0) return 'requires a JSON-compatible type';
  if (type.endsWith('!')) {
    return 'cannot use an implicitly unwrapped Optional; use T? instead';
  }

  if (type.endsWith('?')) {
    const wrapped = type.slice(0, -1);
    if (wrapped.endsWith('?')
      || genericArgument(wrapped, 'Optional') !== undefined
      || genericArgument(wrapped, 'Swift.Optional') !== undefined) {
      return 'cannot use a nested Optional type';
    }
    return snapshotTypeIssue(wrapped);
  }
  const optional = genericArgument(type, 'Optional') ?? genericArgument(type, 'Swift.Optional');
  if (optional !== undefined) {
    if (optional.endsWith('?')
      || genericArgument(optional, 'Optional') !== undefined
      || genericArgument(optional, 'Swift.Optional') !== undefined) {
      return 'cannot use a nested Optional type';
    }
    return snapshotTypeIssue(optional);
  }

  const scalar = type === 'CoreGraphics.CGFloat'
    ? 'CGFloat'
    : (type.startsWith('Swift.') ? type.slice('Swift.'.length) : type);
  if (JSON_SCALAR_TYPES.has(scalar)) return undefined;

  if (type.startsWith('[') && type.endsWith(']')) {
    const inner = type.slice(1, -1);
    const dictionaryParts = splitTopLevel(inner, ':');
    if (dictionaryParts.length === 1) return snapshotTypeIssue(inner);
    if (dictionaryParts.length === 2) {
      const key = dictionaryParts[0]!.replace(/^Swift\./, '');
      if (key !== 'String') return 'must use String keys for snapshot dictionaries';
      return snapshotTypeIssue(dictionaryParts[1]!);
    }
    return 'requires a JSON-compatible array or dictionary type';
  }

  const array = genericArgument(type, 'Array') ?? genericArgument(type, 'Swift.Array');
  if (array !== undefined) return snapshotTypeIssue(array);
  const dictionary = genericArgument(type, 'Dictionary') ?? genericArgument(type, 'Swift.Dictionary');
  if (dictionary !== undefined) {
    const parts = splitTopLevel(dictionary, ',');
    if (parts.length !== 2) return 'requires a JSON-compatible dictionary type';
    const key = parts[0]!.replace(/^Swift\./, '');
    if (key !== 'String') return 'must use String keys for snapshot dictionaries';
    return snapshotTypeIssue(parts[1]!);
  }

  return `uses unsupported snapshot type '${typeText}'; use JSON scalar, array, or String-keyed dictionary types`;
}

export function validateAccessorSpecs(specs: AccessorSpec[]): void {
  const owners = new Map<string, string>();
  const diagnostics: string[] = [];
  for (const spec of specs) {
    for (const field of spec.fields) {
      const previous = owners.get(field.name);
      if (previous !== undefined) {
        diagnostics.push(`snapshot key '${field.name}' is declared by both ${previous} and ${spec.className}; keys must be unique across @Observable types`);
      } else {
        owners.set(field.name, spec.className);
      }
    }
  }
  if (diagnostics.length > 0) throw new AccessorGenerationError(diagnostics);
}

function swiftStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export function render(specs: AccessorSpec[], buildId: string, accessorHash: string): string {
  validateAccessorSpecs(specs);
  let out = '// AUTO-GENERATED — DO NOT EDIT. Regenerate with /ios-sync.\n';
  out += '#if DEBUG\nimport Foundation\nimport DebugBridgeCore\n\n';
  for (const spec of specs) {
    // Accessors compile in the app target beside its usually-internal state
    // types. Making this API public would make valid internal models fail
    // Swift type checking (a public signature cannot expose an internal type).
    out += `@MainActor\nenum ${spec.className}Accessor {\n`;
    out += `    private static func decodeSnapshotValue<T: Decodable>(_ value: Any, as type: T.Type) -> T? {\n`;
    out += `        guard JSONSerialization.isValidJSONObject(["value": value]),\n`;
    out += `              let data = try? JSONSerialization.data(withJSONObject: ["value": value]),\n`;
    out += `              let decoded = try? JSONDecoder().decode([String: T].self, from: data) else { return nil }\n`;
    out += `        return decoded["value"]\n`;
    out += `    }\n\n`;
    out += `    static func register(_ state: ${spec.className}) {\n`;
    out += `        StateServer.shared.register(\n`;
    out += `            buildId: {\n`;
    out += `                let shortVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String\n`;
    out += `                let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String\n`;
    out += `                if let shortVersion, let bundleVersion { return "\\(shortVersion) (\\(bundleVersion))" }\n`;
    out += `                return shortVersion ?? bundleVersion ?? ${swiftStringLiteral(buildId)}\n`;
    out += `            }(),\n`;
    out += `            accessorHash: ${swiftStringLiteral(accessorHash)},\n`;
    out += `            atomicRestore: { keys, apply in\n`;
    out += `                // Validate every key and value before assignment.\n`;
    out += `                // Successful assignments are sequential on MainActor.\n`;
    spec.fields.forEach((field, index) => {
      out += `                guard let raw${index} = keys["${field.name}"] else {\n`;
      out += `                    return .missingKey("${field.name}")\n`;
      out += `                }\n`;
      const wrapped = optionalWrappedType(field.typeText);
      if (wrapped !== undefined) {
        out += `                let restored${index}: ${field.typeText}\n`;
        out += `                if raw${index} is NSNull {\n`;
        out += `                    restored${index} = nil\n`;
        out += `                } else if let typed = Self.decodeSnapshotValue(raw${index}, as: ${wrapped}.self) {\n`;
        out += `                    restored${index} = typed\n`;
        out += `                } else {\n`;
        out += `                    return .typeMismatch("${field.name}")\n`;
        out += `                }\n`;
      } else {
        out += `                guard let restored${index} = Self.decodeSnapshotValue(raw${index}, as: ${field.typeText}.self) else {\n`;
        out += `                    return .typeMismatch("${field.name}")\n`;
        out += `                }\n`;
      }
    });
    out += `                if apply {\n`;
    spec.fields.forEach((field, index) => {
      out += `                    state.${field.name} = restored${index}\n`;
    });
    out += `                }\n`;
    out += `                return .ok\n`;
    out += `            }\n`;
    out += `        )\n`;
    for (const field of spec.fields) {
      const wrapped = optionalWrappedType(field.typeText);
      out += `        StateServer.shared.registerAccessor(\n`;
      out += `            key: "${field.name}",\n`;
      out += `            type: "${field.typeText}",\n`;
      if (wrapped !== undefined) {
        out += `            read: {\n`;
        out += `                guard let value = state.${field.name} else { return NSNull() }\n`;
        out += `                return value as Any\n`;
        out += `            },\n`;
      } else {
        out += `            read: { state.${field.name} as Any? },\n`;
      }
      out += `            write: { value in\n`;
      if (wrapped !== undefined) {
        out += `                if value is NSNull {\n`;
        out += `                    state.${field.name} = nil\n`;
        out += `                    return true\n`;
        out += `                }\n`;
        out += `                guard let typed = Self.decodeSnapshotValue(value, as: ${wrapped}.self) else { return false }\n`;
      } else {
        out += `                guard let typed = Self.decodeSnapshotValue(value, as: ${field.typeText}.self) else { return false }\n`;
      }
      out += `                state.${field.name} = typed\n`;
      out += `                return true\n`;
      out += `            }\n`;
      out += `        )\n`;
    }
    out += `    }\n}\n\n`;
  }
  out += '#endif\n';
  return out;
}

function detectSwiftVersion(): string {
  if (process.env.SWIFT_VERSION) return process.env.SWIFT_VERSION;
  try {
    const out = execSync('swift --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = out.match(/Apple Swift version (\d+\.\d+\.\d+)/);
    if (m) return m[1]!;
  } catch {
    /* swift not installed */
  }
  return 'unknown';
}

function detectToolGitRev(): string {
  if (process.env.GEN_ACCESSORS_REV) return process.env.GEN_ACCESSORS_REV;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: dirname(new URL(import.meta.url).pathname),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'dev';
  }
}

function detectBuildId(): string {
  if (process.env.APP_BUILD_ID) return process.env.APP_BUILD_ID;
  const marketing = process.env.MARKETING_VERSION;
  const build = process.env.CURRENT_PROJECT_VERSION;
  if (marketing && build) return `${marketing} (${build})`;
  if (build) return build;
  return 'unknown';
}

export function defaultCacheRoot(): string {
  return process.env.GSTACK_IOS_CACHE_ROOT ?? join(homedir(), '.gstack', 'cache', 'gen-accessors');
}

export function generate(inputs: GenInputs): GenResult {
  const inputDir = resolve(inputs.inputDir);
  const outputDir = resolve(inputs.outputDir ?? inputDir);
  const cacheRoot = inputs.cacheRoot ?? defaultCacheRoot();
  const swiftFiles = collectSwiftFiles(inputDir, { outputDir });
  const buildId = inputs.buildId ?? detectBuildId();

  // Parse before cache lookup. This keeps diagnostics deterministic even when
  // an older cache entry exists, and gives us the schema-only accessor hash.
  const allSpecs: AccessorSpec[] = [];
  for (const f of swiftFiles) {
    const src = readFileSync(f, 'utf-8');
    allSpecs.push(...parseSwift(src));
  }
  validateAccessorSpecs(allSpecs);
  const accessorHash = computeAccessorHash(allSpecs);

  const cacheKey = computeCacheKey({
    swiftFiles,
    swiftVersion: inputs.swiftVersion ?? detectSwiftVersion(),
    toolGitRev: inputs.toolGitRev ?? detectToolGitRev(),
    platformTriple: inputs.platformTriple ?? FALLBACK_PLATFORM,
    buildId,
  });

  const cachedOutput = join(cacheRoot, cacheKey, 'StateAccessor.swift');
  const finalOutput = join(outputDir, 'StateAccessor.swift');
  mkdirSync(outputDir, { recursive: true });

  if (existsSync(cachedOutput)) {
    copyFileSync(cachedOutput, finalOutput);
    // Parse for return value but use cached content as truth.
    return {
      outputPath: finalOutput,
      cacheKey,
      accessorHash,
      specs: allSpecs,
      cacheHit: true,
    };
  }

  const rendered = render(allSpecs, buildId, accessorHash);
  writeFileSync(finalOutput, rendered);

  // Populate cache (best-effort — cache failures don't break codegen).
  try {
    mkdirSync(join(cacheRoot, cacheKey), { recursive: true });
    writeFileSync(cachedOutput, rendered);
  } catch {
    // best-effort
  }

  return {
    outputPath: finalOutput,
    cacheKey,
    accessorHash,
    specs: allSpecs,
    cacheHit: false,
  };
}

export function pruneCache(cacheRoot: string = defaultCacheRoot(), maxAgeDays = 30): { pruned: string[] } {
  const pruned: string[] = [];
  if (!existsSync(cacheRoot)) return { pruned };
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(cacheRoot)) {
    const full = join(cacheRoot, name);
    try {
      const s = statSync(full);
      if (s.isDirectory() && s.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        pruned.push(full);
      }
    } catch { /* ignore */ }
  }
  return { pruned };
}

// CLI entry
if (import.meta.main) {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf('--input');
  if (inputIdx === -1) {
    process.stderr.write('usage: gen-accessors --input <dir> [--output <dir>]\n');
    process.exit(2);
  }
  const inputDir = args[inputIdx + 1]!;
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
  try {
    const result = generate({ inputDir, outputDir });
    process.stdout.write(
      result.cacheHit
        ? `gen-accessors: cache hit (${result.cacheKey.slice(0, 12)})\n`
        : `gen-accessors: wrote ${result.specs.length} accessor(s) to ${result.outputPath}\n`,
    );
  } catch (error) {
    if (error instanceof AccessorGenerationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(4);
    }
    throw error;
  }
}
