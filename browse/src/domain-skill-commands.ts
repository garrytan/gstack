/**
 * $B domain-skill subcommands — CLI surface for the domain-skills storage layer.
 *
 * Subcommands:
 *   save                          — save a skill body (host derived from active tab, T3)
 *   list                          — list all skills (project + global) visible here
 *   show <host>                   — print the body of a skill
 *   edit <host>                   — round-trip through $EDITOR
 *   promote-to-global <host>      — promote active per-project skill to global
 *   rollback <host>               — restore prior version
 *   rm <host> [--global]          — tombstone a skill
 *
 * Design constraints:
 *   - host is ALWAYS derived from the active tab's top-level origin (T3
 *     confused-deputy fix). Never accepted as an arg.
 *   - Save-time security uses content-security.ts L1-L3 filters (importable
 *     from the compiled binary, unlike the L4 ML classifier). The full L4
 *     scan happens in sidebar-agent.ts when the skill is loaded into a prompt.
 *   - Output is structured: every success/error includes problem + cause +
 *     suggested-action. Matches the gstack house style.
 *
 * The body for `save` is supplied via stdin or --from-file, NOT inline argv,
 * so multi-line markdown bodies don't get mangled by shell quoting.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import type { BrowserManager } from './browser-manager';
import {
  deriveHostFromActiveTab,
  writeSkill,
  readSkill,
  listSkills,
  promoteToGlobal,
  rollbackSkill,
  deleteSkill,
  type DomainSkillRow,
  type SkillScope,
} from './domain-skills';
import { runContentFilters } from './content-security';
import { getCurrentProjectSlug } from './project-slug';
import { logTelemetry } from './telemetry';

// ─── Body input resolution ──────────────────────────────────────

/**
 * Read skill body from --from-file <path> or from stdin.
 * Body is NEVER taken from inline argv (shell quoting hazard for multi-line markdown).
 */
async function readBodyFromArgs(args: string[]): Promise<string> {
  const fromFileIdx = args.indexOf('--from-file');
  if (fromFileIdx >= 0 && fromFileIdx + 1 < args.length) {
    const filePath = args[fromFileIdx + 1]!;
    const body = await fs.readFile(filePath, 'utf8');
    return body;
  }
  // Read from stdin (the CLI may pipe content in)
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    // If no stdin attached, end immediately with empty string
    if (process.stdin.isTTY) resolve('');
  });
}

// ─── Output formatting ──────────────────────────────────────────

function formatSavedOk(row: DomainSkillRow, slug: string): string {
  return [
    `Saved (state: ${row.state}, scope: ${row.scope}).`,
    `Host: ${row.host}`,
    `Bytes: ${row.body.length}`,
    `Version: ${row.version}`,
    `Stored at: ~/.gstack/projects/${slug}/learnings.jsonl`,
    '',
    `Next: skill is quarantined and won't fire in prompts until used 3 times`,
    `      without classifier flags. Run $B domain-skill list to see state.`,
  ].join('\n');
}

function formatSkillListing(list: { project: DomainSkillRow[]; global: DomainSkillRow[] }): string {
  if (list.project.length === 0 && list.global.length === 0) {
    return 'No domain-skills yet.\n\nNext: navigate to a site, then $B domain-skill save with a markdown body to begin.';
  }
  const lines: string[] = [];
  if (list.project.length > 0) {
    lines.push('Project (per-project):');
    for (const r of list.project) {
      lines.push(`  [${r.state}] ${r.host} — v${r.version}, ${r.body.length} bytes, used ${r.use_count}× (${r.flag_count} flags)`);
    }
  }
  if (list.global.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Global (cross-project):');
    for (const r of list.global) {
      lines.push(`  ${r.host} — v${r.version}, ${r.body.length} bytes`);
    }
  }
  return lines.join('\n');
}

// ─── Subcommand handlers ────────────────────────────────────────

async function handleSave(args: string[], bm: BrowserManager): Promise<string> {
  const page = bm.getPage();
  const host = await deriveHostFromActiveTab(page);
  const body = await readBodyFromArgs(args);
  if (!body || !body.trim()) {
    throw new Error(
      'Save failed: empty body.\n' +
        'Cause: no content provided via --from-file or stdin.\n' +
        'Action: pipe markdown into $B domain-skill save, or pass --from-file <path>.'
    );
  }
  // L1-L3 content filters (datamarking, hidden-element strip, ARIA regex,
  // URL blocklist). The full L4 ML classifier runs at sidebar-agent prompt
  // injection time, not here (CLAUDE.md: classifier can't import in compiled binary).
  const filterResult = runContentFilters(body, page.url(), 'domain-skill-save');
  if (filterResult.blocked) {
    logTelemetry({ event: 'domain_skill_save_blocked', host, reason: filterResult.message });
    throw new Error(
      `Save blocked: ${filterResult.message}\n` +
        'Cause: skill body trips L1-L3 content filters (likely contains URL blocklist match or ARIA injection patterns).\n' +
        'Action: review the body for suspicious instruction-like content; rewrite and retry.'
    );
  }
  // L1-L3 score is binary (passed or not). For the L4 score field we leave 0
  // (meaning "not yet scanned by ML classifier") — sidebar-agent fills this
  // in on first prompt-injection load.
  const slug = getCurrentProjectSlug();
  const row = await writeSkill({
    host,
    body,
    projectSlug: slug,
    source: 'agent',
    classifierScore: 0, // L4 deferred to load-time
  });
  logTelemetry({ event: 'domain_skill_saved', host, scope: row.scope, state: row.state, bytes: body.length });
  return formatSavedOk(row, slug);
}

async function handleList(_args: string[]): Promise<string> {
  const slug = getCurrentProjectSlug();
  const list = await listSkills(slug);
  return formatSkillListing(list);
}

async function handleShow(args: string[]): Promise<string> {
  const host = args[0];
  if (!host) {
    throw new Error(
      'Usage: $B domain-skill show <host>\n' +
        'Cause: missing hostname argument.\n' +
        'Action: $B domain-skill list to see available hosts.'
    );
  }
  const slug = getCurrentProjectSlug();
  const result = await readSkill(host, slug);
  if (!result) {
    return `No active skill for ${host}.\n\nA quarantined skill may exist; run $B domain-skill list to see all states.`;
  }
  return [
    `# ${result.row.host} (${result.source} scope, ${result.row.state})`,
    `# version: ${result.row.version}, used: ${result.row.use_count}×, flags: ${result.row.flag_count}`,
    '',
    result.row.body,
  ].join('\n');
}

async function handleEdit(args: string[]): Promise<string> {
  const host = args[0];
  if (!host) {
    throw new Error('Usage: $B domain-skill edit <host>');
  }
  const slug = getCurrentProjectSlug();
  // Read current body to seed the editor
  const list = await listSkills(slug);
  const current = [...list.project, ...list.global].find((r) => r.host === host);
  if (!current) {
    throw new Error(
      `Cannot edit: no skill for ${host}.\n` +
        'Cause: skill does not exist in this project or global scope.\n' +
        'Action: $B domain-skill save to create one first.'
    );
  }
  const editor = process.env.EDITOR || 'vi';
  const tmpFile = path.join(os.tmpdir(), `gstack-domain-skill-${process.pid}-${Date.now()}.md`);
  await fs.writeFile(tmpFile, current.body, 'utf8');
  const result = spawnSync(editor, [tmpFile], { stdio: 'inherit' });
  if (result.status !== 0) {
    await fs.unlink(tmpFile).catch(() => {});
    throw new Error(`Editor exited with status ${result.status}; no changes saved.`);
  }
  const newBody = await fs.readFile(tmpFile, 'utf8');
  await fs.unlink(tmpFile).catch(() => {});
  if (newBody === current.body) {
    return `No changes for ${host}.`;
  }
  // Re-save (always per-project; promotion is explicit)
  const page = (global as any).__bm?.getPage?.();
  void page; // we're in the daemon — page available, but for edit we trust the existing host
  const row = await writeSkill({
    host: current.host,
    body: newBody,
    projectSlug: slug,
    source: 'human',
    classifierScore: 0,
  });
  return formatSavedOk(row, slug);
}

async function handlePromoteToGlobal(args: string[]): Promise<string> {
  const host = args[0];
  if (!host) {
    throw new Error('Usage: $B domain-skill promote-to-global <host>');
  }
  const slug = getCurrentProjectSlug();
  const row = await promoteToGlobal(host, slug);
  return [
    `Promoted ${row.host} to global scope (v${row.version}).`,
    `Stored at: ~/.gstack/global-domain-skills.jsonl`,
    '',
    `This skill now fires for all projects unless they have a per-project skill for the same host.`,
  ].join('\n');
}

async function handleRollback(args: string[]): Promise<string> {
  const host = args[0];
  if (!host) {
    throw new Error('Usage: $B domain-skill rollback <host>');
  }
  const scope: SkillScope = args.includes('--global') ? 'global' : 'project';
  const slug = getCurrentProjectSlug();
  const row = await rollbackSkill(host, slug, scope);
  return [
    `Rolled back ${row.host} (${scope} scope) to prior version.`,
    `New version: ${row.version} (content from earlier revision)`,
  ].join('\n');
}

async function handleRm(args: string[]): Promise<string> {
  const host = args[0];
  if (!host) {
    throw new Error('Usage: $B domain-skill rm <host> [--global]');
  }
  const scope: SkillScope = args.includes('--global') ? 'global' : 'project';
  const slug = getCurrentProjectSlug();
  await deleteSkill(host, slug, scope);
  return `Tombstoned ${host} (${scope} scope). Use $B domain-skill rollback to restore.`;
}

// ─── Top-level dispatcher ──────────────────────────────────────

export async function handleDomainSkillCommand(args: string[], bm: BrowserManager): Promise<string> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'save':
      return handleSave(rest, bm);
    case 'list':
      return handleList(rest);
    case 'show':
      return handleShow(rest);
    case 'edit':
      return handleEdit(rest);
    case 'promote-to-global':
      return handlePromoteToGlobal(rest);
    case 'rollback':
      return handleRollback(rest);
    case 'rm':
    case 'remove':
    case 'delete':
      return handleRm(rest);
    case undefined:
    case '':
    case 'help':
      return [
        '$B domain-skill — agent-authored per-site notes',
        '',
        'Subcommands:',
        '  save              save body from stdin or --from-file (host derived from active tab)',
        '  list              list all skills visible to current project',
        '  show <host>       print skill body',
        '  edit <host>       open in $EDITOR',
        '  promote-to-global <host>  promote active skill to global scope',
        '  rollback <host> [--global]  restore prior version',
        '  rm <host> [--global]  tombstone',
      ].join('\n');
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\n` +
          'Cause: not one of save|list|show|edit|promote-to-global|rollback|rm.\n' +
          'Action: $B domain-skill help for the full list.'
      );
  }
}
