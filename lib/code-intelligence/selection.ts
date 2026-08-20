/**
 * selection — persists the user's chosen code-intelligence provider and their
 * per-repo indexing consent. Stored at `$GSTACK_HOME/code-intelligence.json`
 * (default `~/.gstack/`), the same home the rest of gstack uses.
 *
 * Portions copyright (c) 2026 Sina Matian, time-attack/gstack (GStack 2), MIT.
 *
 * Consent is per-repo (keyed by absolute repo path), because indexing consent
 * is "may THIS repo's content be indexed by the selected provider" — a decision
 * a user makes per project, not once for the machine. No selection at all is the
 * provider-OFF default: callers degrade to grep / the file-only decision store.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { execFileSync } from "child_process";
import { hasRepoPolicyStore, repoPolicyTier } from "../gbrain-repo-policy-client";
import type { CodeProviderId, OpClass } from "./contract";

export interface Selection {
  provider: CodeProviderId | null;
  /** Absolute repo path → consented. */
  consents: Record<string, boolean>;
  /** Provider id → the absolute repo path it last indexed (so search finds it). */
  roots: Record<string, string>;
  /** User explicitly chose no indexing — never offer again. */
  declined: boolean;
}

const EMPTY: Selection = { provider: null, consents: {}, roots: {}, declined: false };

function storePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.GSTACK_HOME || join(env.HOME || homedir(), ".gstack");
  return join(home, "code-intelligence.json");
}

export function readSelection(env: NodeJS.ProcessEnv = process.env): Selection {
  const p = storePath(env);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<Selection>;
    return {
      provider: raw.provider ?? null,
      consents: raw.consents && typeof raw.consents === "object" ? raw.consents : {},
      roots: raw.roots && typeof raw.roots === "object" ? raw.roots : {},
      declined: raw.declined === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(selection: Selection, env: NodeJS.ProcessEnv = process.env): void {
  const p = storePath(env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(selection, null, 2), "utf-8");
  renameSync(tmp, p);
}

export function setProvider(provider: CodeProviderId | null, env: NodeJS.ProcessEnv = process.env): Selection {
  // Choosing a provider clears a prior decline; clearing to null records one,
  // so the session-start offer is never repeated after an explicit "none".
  const next = { ...readSelection(env), provider, declined: provider === null };
  write(next, env);
  return next;
}

/** Record per-repo indexing consent (repo path resolved to absolute). */
export function setConsent(repoPath: string, consented: boolean, env: NodeJS.ProcessEnv = process.env): Selection {
  const current = readSelection(env);
  const next: Selection = { ...current, consents: { ...current.consents, [resolve(repoPath)]: consented } };
  write(next, env);
  return next;
}

/**
 * The per-remote trust store (gstack-gbrain-repo-policy) is the SINGLE
 * authority for consent-to-send: a `deny` tier vetoes any recorded
 * code-intelligence consent, so two stores can never disagree about whether
 * code may leave this repo (R1, fork port wave 2 review). The veto is
 * op-class-aware (R2): `read-only` means "search allowed, page writes never"
 * (the exact semantics runCodeImport in bin/gstack-gbrain-sync.ts enforces —
 * code ingest writes pages), so it vetoes write-class ops (register / index /
 * refresh / add / delete) while read-class ops (search / export / status)
 * pass; `deny` vetoes both classes. Mirrors the gbrain-sync chokepoint's
 * polarity: no policy store → no veto (nothing was ever set); unreadable
 * store OR unspawnable policy helper → veto for every op class (fail-closed —
 * a policy the user set must not be bypassed by a broken store or a helper
 * that can't run). Reads through the shared lib/gbrain-repo-policy-client.ts
 * so this site and the gbrain-sync gate can never drift.
 */
function repoPolicyVeto(repoPath: string, opClass: OpClass, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hasRepoPolicyStore(env)) return false; // fast path: nothing was ever set — skip the git spawn too
  let url = "";
  try {
    url = execFileSync("git", ["-C", resolve(repoPath), "remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5000,
    }).trim();
  } catch {
    return false; // no remote → policy (keyed by remote) has nothing set for this repo
  }
  if (!url) return false;
  const res = repoPolicyTier(url, env);
  if (res.error) return true; // fail-closed (unreadable store or spawn failure alike)
  if (res.tier === "deny") return true; // deny beats consent for every op class
  return res.tier === "read-only" && opClass === "write"; // read-only: writes never, reads pass
}

/**
 * Recorded per-repo consent, filtered through the repo-policy veto. `opClass`
 * defaults to "write" so a caller that doesn't classify its op gets the
 * fail-closed answer; pass "read" only for ops that write no pages (search /
 * export / status).
 */
export function hasConsent(repoPath: string, env: NodeJS.ProcessEnv = process.env, opClass: OpClass = "write"): boolean {
  if (readSelection(env).consents[resolve(repoPath)] !== true) return false;
  return !repoPolicyVeto(repoPath, opClass, env);
}

/** Record the repo path a provider last indexed, so search reads the same graph. */
export function setRoot(provider: CodeProviderId, repoPath: string, env: NodeJS.ProcessEnv = process.env): Selection {
  const current = readSelection(env);
  const next: Selection = { ...current, roots: { ...current.roots, [provider]: resolve(repoPath) } };
  write(next, env);
  return next;
}

export function getRoot(provider: CodeProviderId, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readSelection(env).roots[provider];
}
