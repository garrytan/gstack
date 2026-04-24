// SYSTEM.md parser + reconciler.
//
// Parses the YAML frontmatter block from SYSTEM.md, validates schema, builds
// the contract graph. The reconcile() function is the other half: given a
// parsed SystemMap and a discovered import graph, produces a list of flags
// for the skill to surface to the user.
//
// This is the v1 stub. Public API is stable; internals will grow.

import { readFileSync } from "node:fs";
import YAML from "yaml"; // gstack already uses yaml in other places

// ---------- Types ----------

export type RolloutEdge = "hard" | "soft";

export interface Contract {
  with: string;
  nature: string;
  breaksIf: string;
  rolloutEdge: RolloutEdge;
  note?: string;
}

export interface Component {
  name: string;
  path: string;
  repo?: string;
  role: string;
  owns: string[];
  contracts: Contract[];
  rolloutOrder: number;
}

export interface SystemMap {
  version: number;
  components: Component[];
  narrative: string;
}

// Discovered edges — produced elsewhere (AST walker, grep pipeline, etc.)
export interface ImportEdge {
  from: string; // file path
  to: string;   // file path
  kind: "import" | "call" | "reexport";
}

// ---------- Parser ----------

export function parseSystemMap(filepath: string): SystemMap {
  const raw = readFileSync(filepath, "utf8");
  const match = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `${filepath}: missing YAML frontmatter (expected ---...--- block)`,
    );
  }
  const [, frontmatter, narrative] = match;
  const parsed = YAML.parse(frontmatter);
  validateSystemMap(parsed, filepath);
  return {
    version: parsed.version,
    components: parsed.components.map(normalizeComponent),
    narrative: narrative.trim(),
  };
}

function normalizeComponent(raw: any): Component {
  return {
    name: raw.name,
    path: raw.path,
    repo: raw.repo,
    role: raw.role,
    owns: raw.owns ?? [],
    contracts: (raw.contracts ?? []).map((c: any) => ({
      with: c.with,
      nature: c.nature,
      breaksIf: c["breaks-if"],
      rolloutEdge: c["rollout-edge"],
      note: c.note,
    })),
    rolloutOrder: raw["rollout-order"],
  };
}

function validateSystemMap(parsed: any, filepath: string): void {
  if (parsed.version !== 1) {
    throw new Error(`${filepath}: unsupported version ${parsed.version} (expected 1)`);
  }
  if (!Array.isArray(parsed.components) || parsed.components.length === 0) {
    throw new Error(`${filepath}: components array is missing or empty`);
  }
  const names = new Set<string>();
  for (const c of parsed.components) {
    for (const field of ["name", "path", "role"]) {
      if (typeof c[field] !== "string" || !c[field]) {
        throw new Error(`${filepath}: component is missing required field '${field}'`);
      }
    }
    if (names.has(c.name)) {
      throw new Error(`${filepath}: duplicate component name '${c.name}'`);
    }
    names.add(c.name);
    for (const contract of c.contracts ?? []) {
      if (!["hard", "soft"].includes(contract["rollout-edge"])) {
        throw new Error(
          `${filepath}: contract ${c.name} -> ${contract.with}: rollout-edge must be 'hard' or 'soft'`,
        );
      }
    }
    if (typeof c["rollout-order"] !== "number") {
      throw new Error(`${filepath}: component '${c.name}' missing numeric rollout-order`);
    }
  }
  // Every contract's `with` must reference a known component.
  for (const c of parsed.components) {
    for (const contract of c.contracts ?? []) {
      if (!names.has(contract.with)) {
        throw new Error(
          `${filepath}: component '${c.name}' has contract with unknown component '${contract.with}'`,
        );
      }
    }
  }
}

// ---------- Component membership ----------

// Given a file path, return the component it belongs to (or null for
// "not in any declared component" — e.g., root-level infra files).
export function componentForFile(
  map: SystemMap,
  filepath: string,
): Component | null {
  // Longest-prefix match — more specific component wins.
  const matches = map.components
    .filter((c) => filepath === c.path || filepath.startsWith(c.path + "/"))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0] ?? null;
}

// ---------- Reconciliation ----------

export type ReconcileFlagCategory =
  | "import-without-contract"
  | "contract-without-imports"
  | "rollout-order-inversion";

export interface ReconcileFlag {
  category: ReconcileFlagCategory;
  fromComponent?: string;
  toComponent?: string;
  evidence: string; // human-readable, included in the AskUserQuestion prompt
  suggestedFix: string;
}

export function reconcile(
  map: SystemMap,
  edges: ImportEdge[],
): ReconcileFlag[] {
  const flags: ReconcileFlag[] = [];

  // Bucket edges by component pair
  const byPair = new Map<string, ImportEdge[]>();
  for (const edge of edges) {
    const fromComp = componentForFile(map, edge.from);
    const toComp = componentForFile(map, edge.to);
    if (!fromComp || !toComp || fromComp.name === toComp.name) continue;
    const key = `${fromComp.name}|${toComp.name}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(edge);
  }

  // Category 1: import-without-contract
  // If we see imports from component A to component B, A should have a contract
  // with B (or vice versa — direction of contract isn't required to match import
  // direction, since contracts describe role relationships not data flow).
  for (const [key, pairEdges] of byPair.entries()) {
    const [fromName, toName] = key.split("|");
    const hasContract = map.components.some(
      (c) =>
        (c.name === fromName && c.contracts.some((x) => x.with === toName)) ||
        (c.name === toName && c.contracts.some((x) => x.with === fromName)),
    );
    if (!hasContract) {
      flags.push({
        category: "import-without-contract",
        fromComponent: fromName,
        toComponent: toName,
        evidence: `${pairEdges.length} import edge(s) between '${fromName}' and '${toName}' but no contract declared. Example: ${pairEdges[0].from} -> ${pairEdges[0].to}`,
        suggestedFix: `Add a contract to SYSTEM.md between '${fromName}' and '${toName}', OR refactor to remove the cross-component import if it's a layering violation.`,
      });
    }
  }

  // Category 2: contract-without-imports
  // A contract exists but no supporting import edges. May be runtime-only (OK if
  // `note: runtime-only` is set) or stale.
  for (const c of map.components) {
    for (const contract of c.contracts) {
      const keyA = `${c.name}|${contract.with}`;
      const keyB = `${contract.with}|${c.name}`;
      const hasSupport = byPair.has(keyA) || byPair.has(keyB);
      if (!hasSupport && contract.note !== "runtime-only") {
        flags.push({
          category: "contract-without-imports",
          fromComponent: c.name,
          toComponent: contract.with,
          evidence: `Contract '${c.name} -> ${contract.with}' declared but no import/call edges found in the codebase.`,
          suggestedFix: `Either the contract is stale (remove it), or the coupling is runtime-only (DB, message bus, HTTP, filesystem) — add 'note: runtime-only' to suppress this flag.`,
        });
      }
    }
  }

  // Category 3: rollout-order-inversion
  // If A imports from B but A.rollout-order < B.rollout-order, B ships after A
  // but A depends on B at compile time. Usually wrong; types-only imports can
  // be legitimate exceptions.
  for (const [key, pairEdges] of byPair.entries()) {
    const [fromName, toName] = key.split("|");
    const fromComp = map.components.find((c) => c.name === fromName)!;
    const toComp = map.components.find((c) => c.name === toName)!;
    if (fromComp.rolloutOrder < toComp.rolloutOrder) {
      flags.push({
        category: "rollout-order-inversion",
        fromComponent: fromName,
        toComponent: toName,
        evidence: `'${fromName}' (rollout-order ${fromComp.rolloutOrder}) imports from '${toName}' (rollout-order ${toComp.rolloutOrder}). '${toName}' ships after '${fromName}' but '${fromName}' depends on it at build time.`,
        suggestedFix: `Swap rollout-order values, OR if the import is types-only, add 'note: types-only' to the contract.`,
      });
    }
  }

  return flags;
}

// ---------- Utility: stable component ordering for rollout ----------

export function rolloutOrder(map: SystemMap): Component[][] {
  // Group components by rollout-order integer, return in ascending order.
  // Each inner array contains components that can ship in parallel (same order).
  const buckets = new Map<number, Component[]>();
  for (const c of map.components) {
    if (!buckets.has(c.rolloutOrder)) buckets.set(c.rolloutOrder, []);
    buckets.get(c.rolloutOrder)!.push(c);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, comps]) => comps.sort((a, b) => a.name.localeCompare(b.name)));
}
