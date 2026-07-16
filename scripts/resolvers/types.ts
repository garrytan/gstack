import { ALL_HOST_CONFIGS } from '../../hosts/index';

/**
 * Host type — derived from host configs in hosts/*.ts.
 * Adding a new host: create hosts/myhost.ts + add to hosts/index.ts.
 * Do NOT hardcode host names here.
 */
export type Host = (typeof ALL_HOST_CONFIGS)[number]['name'];

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
  designDir: string;
  makePdfDir: string;
}

/**
 * HOST_PATHS — derived from host configs.
 * Each config's globalRoot/localSkillRoot determines the path structure.
 * Non-Claude hosts use $GSTACK_ROOT env vars (set by preamble).
 */
function buildHostPaths(): Record<string, HostPaths> {
  const paths: Record<string, HostPaths> = {};
  for (const config of ALL_HOST_CONFIGS) {
    if (config.usesEnvVars) {
      paths[config.name] = {
        skillRoot: '$GSTACK_ROOT',
        localSkillRoot: config.localSkillRoot,
        binDir: '$GSTACK_BIN',
        browseDir: '$GSTACK_BROWSE',
        designDir: '$GSTACK_DESIGN',
        makePdfDir: '$GSTACK_MAKE_PDF',
      };
    } else {
      const root = `~/${config.globalRoot}`;
      paths[config.name] = {
        skillRoot: root,
        localSkillRoot: config.localSkillRoot,
        binDir: `${root}/bin`,
        browseDir: `${root}/browse/dist`,
        designDir: `${root}/design/dist`,
        makePdfDir: `${root}/make-pdf/dist`,
      };
    }
  }
  return paths;
}

export const HOST_PATHS: Record<string, HostPaths> = buildHostPaths();

import type { Model } from '../models';
export type { Model } from '../models';

export interface TemplateContext {
  skillName: string;
  tmplPath: string;
  benefitsFrom?: string[];
  host: Host;
  paths: HostPaths;
  preambleTier?: number;  // 1-4, controls which preamble sections are included
  model?: Model;  // model family for behavioral overlay. Omitted/undefined → no overlay.
  interactive?: boolean;  // true → emit plan-mode handshake in preamble. Generator-only, not written to SKILL.md.
  /**
   * Build-time compression mode. Defaults to 'default'.
   *
   * - 'default': full preamble prose ships as today (writing style, completeness,
   *   confusion protocol, context health are all present).
   * - 'terse': writing-style + completeness + confusion-protocol + context-health
   *   sections are compressed to a one-line pointer at gen time. Saves ~3-5 KB
   *   per tier-2+ skill. Opt-in via `--explain-level=terse` build flag for
   *   users who want shipped skills to match their runtime preference and
   *   avoid the per-session terse-mode prose.
   *
   * Default builds keep the runtime-conditional behavior intact (Writing Style
   * section says "skip entirely if EXPLAIN_LEVEL: terse appears in preamble echo").
   * Terse builds make the compression structural — bytes never ship in the first place.
   */
  explainLevel?: 'default' | 'terse';
}

/** Resolver function signature. args is populated for parameterized placeholders like {{INVOKE_SKILL:name}}. */
export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;

/**
 * Optional gated resolver. When the gate returns false, the resolver is
 * skipped (substituted with empty string) — same effect as the placeholder
 * not being referenced. Use when a resolver's output is only meaningful for
 * a known subset of skills, so future template authors get a structural
 * guardrail instead of relying on social knowledge.
 *
 * Most resolvers don't need this — the {{NAME}} placeholder system is
 * already conditional at the template level. Use only when a resolver
 * lives inside another resolver (e.g. via preamble composition) AND must
 * be conditionalized, or when a top-level resolver has a small, well-defined
 * audience.
 */
export interface ResolverEntry {
  resolve: ResolverFn;
  appliesTo?: (ctx: TemplateContext) => boolean;
}

/** Anything the RESOLVERS map accepts — either a bare function or a gated entry. */
export type ResolverValue = ResolverFn | ResolverEntry;

/**
 * Type-narrowing helper for the gen-skill-docs lookup.
 * Returns (resolverFn, gate) so callers can do gate?.(ctx) before invoking.
 */
export function unwrapResolver(entry: ResolverValue): {
  resolve: ResolverFn;
  appliesTo?: (ctx: TemplateContext) => boolean;
} {
  if (typeof entry === 'function') return { resolve: entry };
  return { resolve: entry.resolve, appliesTo: entry.appliesTo };
}
