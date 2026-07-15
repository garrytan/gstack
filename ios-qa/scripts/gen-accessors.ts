#!/usr/bin/env bun
//
// gen-accessors (TS port). Mirrors the SwiftPM tool's logic for the cases
// where a user doesn't want to wait 2-5min for swift-syntax to build the
// first time. Also exercised by tests so we can verify the cache + parse
// behavior without a Swift toolchain.
//
// The TS port uses a stricter regex than the fork's original — it understands:
//   - @Observable class declarations
//   - @Snapshotable property markers (only marked fields are exported)
//   - Multi-line type signatures (collapses whitespace before matching)
//   - Generic type parameters (matched as opaque text inside the type)
//
// What it does NOT handle (deferred to the SwiftPM tool):
//   - Computed properties with bodies (regex can mis-parse braces)
//   - Property wrappers other than @Snapshotable
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
  specs: AccessorSpec[];
  cacheHit: boolean;
}

const FALLBACK_PLATFORM = process.platform === 'darwin' ? 'darwin-arm64' : `${process.platform}-${process.arch}`;

export function collectSwiftFiles(dir: string, opts: { excludeGenerated?: boolean } = {}): string[] {
  const out: string[] = [];
  const excludeGenerated = opts.excludeGenerated ?? true;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip generated output dir (when it lives under the input dir)
      if (excludeGenerated && name === 'DebugBridgeGenerated') continue;
      out.push(...collectSwiftFiles(full, opts));
    } else if (name.endsWith('.swift')) {
      // Skip the codegen output file. Otherwise the second run picks it up,
      // changes the cache key, and the cache never hits.
      if (excludeGenerated && name === 'StateAccessor.swift') continue;
      out.push(full);
    }
  }
  return out.sort();
}

export function parseSwift(source: string): AccessorSpec[] {
  const specs: AccessorSpec[] = [];
  // Find `@Observable\n(public )?(final )?class <Name>` followed by a brace
  // block. We then scan inside that block for @Snapshotable fields.
  const classPattern = /@Observable\s*(?:(?:public|internal|fileprivate|private)\s+)?(?:final\s+)?class\s+(\w+)[^{]*\{/g;

  let match: RegExpExecArray | null;
  while ((match = classPattern.exec(source)) !== null) {
    const className = match[1]!;
    const startIdx = classPattern.lastIndex;
    const endIdx = findMatchingBrace(source, startIdx - 1);
    if (endIdx === -1) continue;
    const body = source.slice(startIdx, endIdx);

    const fields = parseFields(body);
    if (fields.length > 0) {
      specs.push({ className, fields });
    }
  }
  return specs;
}

function findMatchingBrace(s: string, openIdx: number): number {
  // openIdx points at '{'. Return idx of matching '}', or -1.
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      // skip string literal
      const quote = c;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\') i++;
        i++;
      }
    } else if (c === '/' && s[i + 1] === '/') {
      // skip line comment
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    }
  }
  return -1;
}

function parseFields(body: string): AccessorField[] {
  // Look for @Snapshotable followed by var/let declarations. Allow attribute
  // ordering: `@Snapshotable var name: Type` OR `@Snapshotable\n  var name: Type`.
  // Multi-line types are handled by greedy non-newline match in the type, but
  // we collapse adjacent whitespace first to avoid false negatives.
  const normalized = body.replace(/[\t ]*\r?\n[\t ]*/g, ' ');
  const fieldPattern = /@Snapshotable\s+(?:(?:public|internal|fileprivate|private)\s+)?(?:var|let)\s+(\w+)\s*:\s*([^={]+?)(?=\s*(?:=|\{|@Snapshotable|\bvar\b|\blet\b|\bfunc\b|\}|$))/g;
  const fields: AccessorField[] = [];
  let m: RegExpExecArray | null;
  while ((m = fieldPattern.exec(normalized)) !== null) {
    // Codex catch: skip fields that have a computed body (`{ get ... }` or
    // `{ didSet ... }` after the type). The match boundary stops before `{`,
    // so we peek at what comes after the type in the original body.
    const afterMatchIdx = m.index + m[0].length;
    const afterMatch = normalized.slice(afterMatchIdx, afterMatchIdx + 4).trim();
    // If the next non-space character is `{`, this is a computed property.
    // We're conservative: snapshot-eligible fields must be stored properties
    // (initialized with `=` or just declared).
    if (afterMatch.startsWith('{')) continue;
    fields.push({ name: m[1]!, typeText: m[2]!.trim() });
  }
  return fields;
}

export function computeCacheKey(inputs: {
  swiftFiles: string[];
  swiftVersion: string;
  toolGitRev: string;
  platformTriple: string;
}): string {
  const h = createHash('sha256');
  h.update(`swift=${inputs.swiftVersion}|tool=${inputs.toolGitRev}|platform=${inputs.platformTriple}|`);
  for (const f of inputs.swiftFiles) {
    const content = readFileSync(f);
    h.update(`${f}:${content.length}:`);
    h.update(content);
    h.update('|');
  }
  return h.digest('hex');
}

export function render(specs: AccessorSpec[], buildId: string, accessorHash: string): string {
  let out = '// AUTO-GENERATED — DO NOT EDIT. Regenerate with /ios-sync.\n';
  out += '#if DEBUG\nimport Foundation\nimport DebugBridge\n\n';
  for (const spec of specs) {
    out += `@MainActor\npublic enum ${spec.className}Accessor {\n`;
    out += `    public static func register(_ state: ${spec.className}) {\n`;
    out += `        StateServer.shared.register(\n`;
    out += `            buildId: "${buildId}",\n`;
    out += `            accessorHash: "${accessorHash}",\n`;
    out += `            atomicRestore: { _ in .ok }\n`;
    out += `        )\n`;
    for (const field of spec.fields) {
      out += `        StateServer.shared.registerAccessor(\n`;
      out += `            key: "${field.name}",\n`;
      out += `            type: "${field.typeText}",\n`;
      out += `            read: { state.${field.name} as Any? },\n`;
      out += `            write: { _ in false }\n`;
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

export function defaultCacheRoot(): string {
  return process.env.GSTACK_IOS_CACHE_ROOT ?? join(homedir(), '.gstack', 'cache', 'gen-accessors');
}

export function generate(inputs: GenInputs): GenResult {
  const inputDir = resolve(inputs.inputDir);
  const outputDir = resolve(inputs.outputDir ?? inputDir);
  const cacheRoot = inputs.cacheRoot ?? defaultCacheRoot();
  const swiftFiles = collectSwiftFiles(inputDir);

  const cacheKey = computeCacheKey({
    swiftFiles,
    swiftVersion: inputs.swiftVersion ?? detectSwiftVersion(),
    toolGitRev: inputs.toolGitRev ?? detectToolGitRev(),
    platformTriple: inputs.platformTriple ?? FALLBACK_PLATFORM,
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
      specs: [], // intentionally empty on cache hit (no need to re-parse)
      cacheHit: true,
    };
  }

  // Parse + render fresh
  const allSpecs: AccessorSpec[] = [];
  for (const f of swiftFiles) {
    const src = readFileSync(f, 'utf-8');
    allSpecs.push(...parseSwift(src));
  }
  const rendered = render(allSpecs, inputs.buildId ?? 'unknown', cacheKey);
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
  const result = generate({ inputDir, outputDir });
  process.stdout.write(
    result.cacheHit
      ? `gen-accessors: cache hit (${result.cacheKey.slice(0, 12)})\n`
      : `gen-accessors: wrote ${result.specs.length} accessor(s) to ${result.outputPath}\n`,
  );
}
