/**
 * gstack-memory-helpers — shared helpers for the V1 memory ingest + retrieval pipeline.
 *
 * Imported by:
 *   - bin/gstack-memory-ingest.ts (Lane A)
 *   - bin/gstack-gbrain-sync.ts   (Lane B)
 *   - bin/gstack-brain-context-load.ts (Lane C)
 *   - scripts/gen-skill-docs.ts (manifest validation)
 *
 * Design refs in the plan:
 *   §"Eng review additions" — DRY refactor (Section 1A)
 *   §"V1 final scope clarification" — schema_version: 1 standardization (Section 2A)
 *   ED1 — engine-tier cache lives in ~/.gstack/.gbrain-engine-cache.json (60s TTL)
 *
 * NOTE: secretScanFile() currently shells out to `gitleaks` from PATH; the vendored
 * binary install is part of Lane E (setup-gbrain). When gitleaks is missing, the
 * helper warns once and returns an empty findings list — fail-safe defaults.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { execSync, execFileSync } from "child_process";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SecretFinding {
  rule_id: string;
  description: string;
  line: number;
  redacted_match: string;
}

export interface SecretScanResult {
  scanned: boolean;
  findings: SecretFinding[];
  scanner: "gitleaks" | "missing" | "error";
}

export type EngineTier = "pglite" | "supabase" | "unknown";

export interface EngineDetect {
  engine: EngineTier;
  supabase_url?: string;
  detected_at: number;
  schema_version: 1;
}

export interface GbrainManifestQuery {
  id: string;
  kind: "vector" | "list" | "filesystem";
  render_as: string;
  // kind=vector
  query?: string;
  // kind=list
  filter?: Record<string, unknown>;
  sort?: string;
  // kind=filesystem
  glob?: string;
  tail?: number;
  // common
  limit?: number;
}

export interface GbrainManifest {
  schema: number; // gbrain.schema in frontmatter; V1 = 1
  context_queries: GbrainManifestQuery[];
}

export interface ErrorContextEntry {
  ts: string;
  op: string;
  duration_ms: number;
  outcome: "ok" | "error";
  error?: string;
  schema_version: 1;
  last_writer: string;
}

// ── Public: canonicalizeRemote ────────────────────────────────────────────

/**
 * Normalize a git remote URL to a canonical form: `host/org/repo` (no scheme,
 * no trailing `.git`). Used as the dedup key for cross-Mac transcript routing
 * (per ED1 — gbrain-side session_id dedup uses repo as a tag).
 *
 * Examples:
 *   https://github.com/garrytan/gstack.git → github.com/garrytan/gstack
 *   git@github.com:garrytan/gstack.git     → github.com/garrytan/gstack
 *   ssh://git@gitlab.com/foo/bar           → gitlab.com/foo/bar
 *   (empty / null)                         → ""
 */
export function canonicalizeRemote(url: string | null | undefined): string {
  if (!url) return "";
  let s = url.trim();
  if (!s) return "";
  // strip surrounding quotes that some configs add
  s = s.replace(/^['"]|['"]$/g, "");
  // git@host:path/repo  →  host/path/repo
  const scpMatch = s.match(/^[^@\s]+@([^:]+):(.+)$/);
  if (scpMatch) {
    s = `${scpMatch[1]}/${scpMatch[2]}`;
  } else {
    // strip scheme (https://, ssh://, git://, http://)
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    // strip user@ prefix on URL-style remotes
    s = s.replace(/^[^@\/]+@/, "");
  }
  // strip trailing .git
  s = s.replace(/\.git$/i, "");
  // strip trailing slash
  s = s.replace(/\/+$/, "");
  // collapse multiple slashes (after path normalization)
  s = s.replace(/\/{2,}/g, "/");
  return s.toLowerCase();
}

// ── Public: secretScanFile (gitleaks wrapper) ─────────────────────────────

let _gitleaksAvailability: boolean | null = null;

function gitleaksAvailable(): boolean {
  if (_gitleaksAvailability !== null) return _gitleaksAvailability;
  try {
    execSync("command -v gitleaks", { stdio: "ignore" });
    _gitleaksAvailability = true;
  } catch {
    _gitleaksAvailability = false;
    // Only warn once per process — Lane E will vendor the binary.
    process.stderr.write(
      "[gstack-memory-helpers] gitleaks not in PATH; secret scanning disabled. " +
      "Run /setup-gbrain to install (or `brew install gitleaks`).\n"
    );
  }
  return _gitleaksAvailability;
}

/**
 * Scan a file for embedded secrets using gitleaks. Returns findings list
 * (empty if clean). When gitleaks is not in PATH, returns scanned=false with
 * scanner="missing" — caller decides whether to skip the file or proceed.
 *
 * Per D19: gitleaks runs at ingest time before any put_page / put_file write.
 * Replaces the inadequate regex scanner in bin/gstack-brain-sync (which only
 * applies to staged git diffs).
 */
export function secretScanFile(path: string): SecretScanResult {
  if (!existsSync(path)) {
    return { scanned: false, findings: [], scanner: "error" };
  }
  if (!gitleaksAvailable()) {
    return { scanned: false, findings: [], scanner: "missing" };
  }
  try {
    // gitleaks detect --no-git --source <path> --report-format json --report-path -
    // Returns 0 on clean, 1 on findings, 126/127 on bad invocation.
    const out = execFileSync(
      "gitleaks",
      ["detect", "--no-git", "--source", path, "--report-format", "json", "--report-path", "/dev/stdout", "--exit-code", "0"],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }
    );
    const trimmed = out.trim();
    if (!trimmed) return { scanned: true, findings: [], scanner: "gitleaks" };
    const parsed = JSON.parse(trimmed) as Array<{
      RuleID: string;
      Description: string;
      StartLine: number;
      Match?: string;
      Secret?: string;
    }>;
    const findings: SecretFinding[] = (parsed || []).map((f) => ({
      rule_id: f.RuleID || "unknown",
      description: f.Description || "",
      line: f.StartLine || 0,
      redacted_match: redactMatch(f.Secret || f.Match || ""),
    }));
    return { scanned: true, findings, scanner: "gitleaks" };
  } catch (err) {
    return {
      scanned: false,
      findings: [],
      scanner: "error",
    };
  }
}

function redactMatch(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "[REDACTED]";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

// ── Public: detectEngineTier (cached) ─────────────────────────────────────

const ENGINE_CACHE_TTL_MS = 60 * 1000;

function gstackHome(): string {
  return process.env.GSTACK_HOME || join(homedir(), ".gstack");
}

function engineCachePath(): string {
  return join(gstackHome(), ".gbrain-engine-cache.json");
}

function errorLogPath(): string {
  return join(gstackHome(), ".gbrain-errors.jsonl");
}

/**
 * Detect which gbrain engine is active (PGLite vs Supabase) and cache the
 * answer for 60s in ~/.gstack/.gbrain-engine-cache.json. Caching avoids
 * fork+exec'ing `gbrain doctor --json` on every skill start.
 *
 * Per ED1 (state files local-only): this cache is gitignored from the brain
 * repo. Per Section 2A: schema_version: 1 + last_writer field for forensic
 * tracing.
 */
export function detectEngineTier(): EngineDetect {
  // Try cache first
  if (existsSync(engineCachePath())) {
    try {
      const stat = statSync(engineCachePath());
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < ENGINE_CACHE_TTL_MS) {
        const cached = JSON.parse(readFileSync(engineCachePath(), "utf-8")) as EngineDetect;
        if (cached.schema_version === 1) return cached;
      }
    } catch {
      // Cache corrupt; fall through to fresh detect.
    }
  }

  const fresh = freshDetectEngineTier();
  try {
    mkdirSync(dirname(engineCachePath()), { recursive: true });
    writeFileSync(
      engineCachePath(),
      JSON.stringify({ ...fresh, last_writer: "gstack-memory-helpers.detectEngineTier" }, null, 2),
      "utf-8"
    );
  } catch {
    // Cache write failure is non-fatal.
  }
  return fresh;
}

function freshDetectEngineTier(): EngineDetect {
  const now = Date.now();
  try {
    const out = execSync("gbrain doctor --json --fast 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
    const parsed = JSON.parse(out);
    const engine: EngineTier = parsed?.engine === "supabase" ? "supabase" : parsed?.engine === "pglite" ? "pglite" : "unknown";
    return {
      engine,
      supabase_url: parsed?.supabase_url || undefined,
      detected_at: now,
      schema_version: 1,
    };
  } catch {
    return { engine: "unknown", detected_at: now, schema_version: 1 };
  }
}

// ── Public: parseSkillManifest ────────────────────────────────────────────

/**
 * Parse the `gbrain:` section out of a SKILL.md.tmpl frontmatter block.
 * Returns null if no manifest is declared OR if the file has no frontmatter.
 *
 * Schema validation (full kind/required-fields check) lives in
 * scripts/gen-skill-docs.ts and runs at generation time. This parser is the
 * runtime read path used by gstack-brain-context-load; it tolerates extra
 * fields and relies on validation having already happened upstream.
 */
export function parseSkillManifest(skillFilePath: string): GbrainManifest | null {
  if (!existsSync(skillFilePath)) return null;
  const content = readFileSync(skillFilePath, "utf-8");
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;
  const gbrain = extractGbrainBlock(frontmatter);
  if (!gbrain) return null;
  return gbrain;
}

function extractFrontmatter(content: string): string | null {
  // Supports both `---\n...\n---` (YAML) and `+++\n...\n+++` (TOML, rare).
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (yamlMatch) return yamlMatch[1];
  return null;
}

function extractGbrainBlock(frontmatter: string): GbrainManifest | null {
  // Naive YAML extraction — finds the `gbrain:` key and parses its sub-tree.
  // Real YAML parsing avoided to keep zero-deps; gen-skill-docs validates the
  // shape strictly at build time.
  const lines = frontmatter.split("\n");
  const start = lines.findIndex((l) => /^gbrain\s*:/.test(l));
  if (start === -1) return null;

  // Collect indented lines under `gbrain:` until next top-level key or EOF
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) break; // next top-level key
    block.push(line);
  }

  const text = block.join("\n");
  // Extract schema number
  const schemaMatch = text.match(/\n\s*schema\s*:\s*(\d+)/);
  const schema = schemaMatch ? parseInt(schemaMatch[1], 10) : 1;

  // Extract context_queries items
  const queries: GbrainManifestQuery[] = [];
  const cqMatch = text.match(/\n\s*context_queries\s*:\s*\n([\s\S]+)/);
  if (cqMatch) {
    const cqText = cqMatch[1];
    // Split using a positive lookahead so each chunk begins with the list-item dash.
    // Pattern: line starting with 4-6 spaces + "-" + whitespace.
    const rawItems = cqText.split(/(?=^[ ]{4,6}-\s)/m);
    const items = rawItems.filter((s) => /^[ ]{4,6}-\s/.test(s));
    for (const item of items) {
      const q: Partial<GbrainManifestQuery> = {};
      // Strip the leading list-item marker so id/kind/etc. regexes can use line-start.
      const body = item.replace(/^[ ]{4,6}-\s+/, "      ");
      const idM = body.match(/(?:^|\n)\s*id\s*:\s*([^\n]+)/);
      const kindM = body.match(/(?:^|\n)\s*kind\s*:\s*([^\n]+)/);
      const renderM = body.match(/(?:^|\n)\s*render_as\s*:\s*"?([^"\n]+?)"?\s*$/m);
      const queryM = body.match(/(?:^|\n)\s*query\s*:\s*"?([^"\n]+?)"?\s*$/m);
      const limitM = body.match(/(?:^|\n)\s*limit\s*:\s*(\d+)/);
      const globM = body.match(/(?:^|\n)\s*glob\s*:\s*"?([^"\n]+?)"?\s*$/m);
      const sortM = body.match(/(?:^|\n)\s*sort\s*:\s*([^\n]+)/);
      const tailM = body.match(/(?:^|\n)\s*tail\s*:\s*(\d+)/);

      if (idM) q.id = idM[1].trim();
      if (kindM) {
        const k = kindM[1].trim();
        if (k === "vector" || k === "list" || k === "filesystem") q.kind = k;
      }
      if (renderM) q.render_as = renderM[1].trim();
      if (queryM) q.query = queryM[1].trim();
      if (limitM) q.limit = parseInt(limitM[1], 10);
      if (globM) q.glob = globM[1].trim();
      if (sortM) q.sort = sortM[1].trim();
      if (tailM) q.tail = parseInt(tailM[1], 10);

      if (q.id && q.kind && q.render_as) {
        queries.push(q as GbrainManifestQuery);
      }
    }
  }

  return { schema, context_queries: queries };
}

// ── Public: withErrorContext ──────────────────────────────────────────────

const ERROR_LOG_PATH = join(gstackHome(), ".gbrain-errors.jsonl");

/**
 * Wrap an op with structured error logging. Logs success/failure + duration
 * to ~/.gstack/.gbrain-errors.jsonl for forensic debugging. Replaces ad-hoc
 * try/catch sites across the three Bun helpers (Section 2B).
 *
 * On error: the error is RE-THROWN after logging — caller still owns flow.
 */
export async function withErrorContext<T>(
  op: string,
  fn: () => T | Promise<T>,
  caller: string = "unknown"
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    logErrorContext({
      ts: new Date().toISOString(),
      op,
      duration_ms: Date.now() - t0,
      outcome: "ok",
      schema_version: 1,
      last_writer: caller,
    });
    return result;
  } catch (err) {
    logErrorContext({
      ts: new Date().toISOString(),
      op,
      duration_ms: Date.now() - t0,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      schema_version: 1,
      last_writer: caller,
    });
    throw err;
  }
}

function logErrorContext(entry: ErrorContextEntry): void {
  try {
    const path = errorLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Logging failure is non-fatal — never block the op.
  }
}

// Test-only export for resetting the gitleaks availability cache between tests.
export function _resetGitleaksAvailabilityCache(): void {
  _gitleaksAvailability = null;
}
