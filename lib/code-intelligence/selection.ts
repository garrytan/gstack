/**
 * selection — persists the user's chosen code-intelligence provider and their
 * per-repo indexing consent. Stored at `$GSTACK_HOME/code-intelligence.json`
 * (default `~/.gstack/`), the same home the rest of gstack uses.
 *
 * Consent is per-repo (keyed by absolute repo path), because indexing consent
 * is "may THIS repo's content be indexed by the selected provider" — a decision
 * a user makes per project, not once for the machine. No selection at all is the
 * provider-OFF default: callers degrade to grep / the file-only decision store.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { CodeProviderId } from "./contract";

export interface Selection {
  provider: CodeProviderId | null;
  /** Absolute repo path → consented. */
  consents: Record<string, boolean>;
  /** Provider id → the absolute repo path it last indexed (so search finds it). */
  roots: Record<string, string>;
}

const EMPTY: Selection = { provider: null, consents: {}, roots: {} };

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
  const next = { ...readSelection(env), provider };
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

export function hasConsent(repoPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readSelection(env).consents[resolve(repoPath)] === true;
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
