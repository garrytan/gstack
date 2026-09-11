import { createHash } from 'node:crypto';
import { extractReleaseProjection, type ReleaseProjection, type ReleaseMetadataDecision } from './release-policy';
import { npmVersion, parseVersion } from './version-source';

export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export interface ChangelogProposal {
  schema_version: 'harness.gstack.changelog-proposal.v1';
  base_blob_sha: string; base_content_sha256: string; version: string; governance_date: string;
  operation: 'insert_new_version'; insertion_start_byte: number; insertion_end_byte: number;
  normalized_entry_sha256: string; normalized_entry_bytes: number; proposal_sha256: string;
}
export interface MutationProjection extends ReleaseProjection { purpose: 'version' | 'changelog' }
export interface ReleaseFile {
  path: string; mode: number; before: string; after: string; before_sha256: string; after_sha256: string;
  projections: MutationProjection[];
}

export function validateReleaseTargets(decision: ReleaseMetadataDecision): MutationProjection[] {
  const targets: MutationProjection[] = decision.version_targets.map(item => ({ ...item, purpose: 'version' }));
  if (decision.changelog_path !== null) {
    if (decision.changelog_path !== 'CHANGELOG.md') throw new Error('release_changelog_path_unsupported');
    targets.push({ path: decision.changelog_path, format: 'plain_text', selector: 'whole_file', purpose: 'changelog' });
  }
  if (!targets.length || targets.length > 16) throw new Error('release_projection_invalid');
  const seen = new Set<string>();
  for (const item of targets) {
    if (!item.path || item.path.includes('\\') || item.path.includes('\0') || item.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('release_projection_path_invalid');
    const key = `${item.path}\0${item.selector}`;
    if (seen.has(key)) throw new Error('release_projection_duplicate');
    seen.add(key);
    const compatible = (item.format === 'plain_text' && item.selector === 'whole_file') ||
      (item.format === 'json' && ['/version', '/packages//version'].includes(item.selector)) ||
      (item.format === 'toml' && item.selector === '/project/version');
    if (!compatible || (item.value_encoding !== undefined && !['exact', 'npm_semver'].includes(item.value_encoding))) throw new Error('release_projection_unsupported');
    if (targets.some(other => other !== item && other.path === item.path && (other.format !== item.format || item.format !== 'json' || other.purpose !== item.purpose))) throw new Error('release_projection_incompatible');
  }
  const source = decision.version_source;
  if (!source || !targets.some(item => item.purpose === 'version' && item.path === source.path && item.format === source.format && item.selector === source.selector && item.value_encoding !== 'npm_semver')) throw new Error('release_source_target_missing');
  return targets;
}

// Parse JSON once and retain scalar token spans. Duplicate keys are ambiguous,
// even when JSON.parse would silently accept the last one.
function jsonStringSpans(text: string): { spans: Map<string, [number, number]>; parsed: any } {
  const parsed = JSON.parse(text);
  let position = 0;
  const spans = new Map<string, [number, number]>();
  const ws = () => { while (/\s/.test(text[position] ?? '') && position < text.length) position++; };
  function string(): [string, number, number] {
    const start = position++;
    while (position < text.length) {
      if (text[position] === '\\') { position += 2; continue; }
      if (text[position++] === '"') return [JSON.parse(text.slice(start, position)), start, position];
    }
    throw new Error('release_projection_invalid');
  }
  function value(keys: string[]): void {
    ws();
    if (text[position] === '"') { const [, start, end] = string(); spans.set(JSON.stringify(keys), [start, end]); return; }
    if (text[position] === '{') {
      position++; ws(); const seen = new Set<string>();
      if (text[position] === '}') { position++; return; }
      while (position < text.length) {
        ws(); const [key] = string(); if (seen.has(key)) throw new Error('release_projection_duplicate_key'); seen.add(key);
        ws(); position++; value([...keys, key]); ws(); if (text[position++] === '}') return;
      }
    } else if (text[position] === '[') {
      position++; ws(); if (text[position] === ']') { position++; return; }
      let index = 0;
      while (position < text.length) { value([...keys, String(index++)]); ws(); if (text[position++] === ']') return; }
    } else {
      const start = position;
      while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
      spans.set(JSON.stringify(keys), [start, position]); return;
    }
    throw new Error('release_projection_invalid');
  }
  value([]); return { spans, parsed };
}

/** Legacy lock discovery and rendering share one parse and one replacement. */
export function renderLegacyJson(text: string, version: string, lock = false): { text: string; selectors: Array<'/version' | '/packages//version'> } {
  const { spans, parsed } = jsonStringSpans(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('release_legacy_lock_invalid');
  if (lock && parsed.packages !== undefined && (!parsed.packages || typeof parsed.packages !== 'object' || Array.isArray(parsed.packages))) throw new Error('release_legacy_lock_invalid');
  const nested = parsed.packages?.[''];
  if (lock && nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested))) throw new Error('release_legacy_lock_invalid');
  const selectors: Array<'/version' | '/packages//version'> = [];
  if (Object.hasOwn(parsed, 'version')) selectors.push('/version');
  if (lock && nested && Object.hasOwn(nested, 'version')) selectors.push('/packages//version');
  const selected = selectors.map(selector => ({ selector, value: selector === '/version' ? parsed.version : nested.version, span: spans.get(JSON.stringify(selector.slice(1).split('/'))) }));
  if (selected.some(item => !item.span || (lock && (typeof item.value !== 'string' || !parseVersion(item.value)))) || (lock && new Set(selected.map(item => item.value)).size > 1)) throw new Error('release_legacy_lock_drift');
  let result = text;
  for (const item of selected.sort((a, b) => b.span![0] - a.span![0])) result = result.slice(0, item.span![0]) + JSON.stringify(version) + result.slice(item.span![1]);
  // Historical manifests may start without a version. Lockfields stay absent.
  if (!lock && !selectors.length) { parsed.version = version; result = JSON.stringify(parsed, null, 2) + '\n'; }
  return { text: result, selectors };
}

function renderVersions(text: string, items: MutationProjection[], version: string, current: string, legacyMirror = false): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const json = items[0].format === 'json' ? jsonStringSpans(text) : null;
  for (const item of items) {
    const before = item.value_encoding === 'npm_semver' ? npmVersion(current) : current;
    const after = item.value_encoding === 'npm_semver' ? npmVersion(version) : version;
    const actual = json ? (item.selector === '/version' ? json.parsed?.version : json.parsed?.packages?.['']?.version) : extractReleaseProjection(text, item);
    if (actual !== before && !(legacyMirror && item.value_encoding === 'npm_semver' && actual === current)) throw new Error('release_version_target_drift');
    if (item.format === 'plain_text') {
      if (!parseVersion(text.trim())) throw new Error('release_projection_invalid');
      const start = text.indexOf(text.trim()); replacements.push({ start, end: start + text.trim().length, value: after });
    } else if (item.format === 'json') {
      const span = json!.spans.get(JSON.stringify(item.selector.slice(1).split('/')));
      if (!span) throw new Error('release_projection_invalid');
      replacements.push({ start: span[0], end: span[1], value: JSON.stringify(after) });
    } else {
      let inProject = false, offset = 0;
      const matches: Array<{ start: number; end: number; value: string }> = [];
      for (const line of text.split(/(?<=\n)/)) {
        if (/^\s*\[/.test(line)) inProject = /^\s*\[project\]\s*(?:#.*)?(?:\r?\n)?$/.test(line);
        if (inProject) {
          const match = /^(\s*version\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*')(\s*(?:#.*)?(?:\r?\n)?)$/.exec(line);
          if (match) matches.push({ start: offset + match[1].length, end: offset + match[1].length + match[2].length, value: `${match[2][0]}${after}${match[2][0]}` });
        }
        offset += line.length;
      }
      if (matches.length !== 1) throw new Error('release_toml_layout_unsupported');
      replacements.push(matches[0]);
    }
  }
  let result = text;
  for (const item of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, item.start) + item.value + result.slice(item.end);
  const verifiedJson = json ? JSON.parse(result) : null;
  for (const item of items) {
    const verified = json ? (item.selector === '/version' ? verifiedJson?.version : verifiedJson?.packages?.['']?.version) : extractReleaseProjection(result, item);
    if (verified !== (item.value_encoding === 'npm_semver' ? npmVersion(version) : version)) throw new Error('release_projection_verification_failed');
  }
  // A regex match inside TOML multiline string data must not acquire authority.
  if (items[0].format === 'toml') {
    const before = Bun.TOML.parse(text) as any, after = Bun.TOML.parse(result) as any;
    before.project.version = after.project.version;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('release_projection_verification_failed');
  }
  return result;
}

export function renderReleaseFile(input: { path: string; bytes: Buffer; mode: number; projections: MutationProjection[]; version: string; current: string; entry?: string; date: string; legacyMirror?: boolean }): { file: ReleaseFile; proposal: ChangelogProposal | null; insertionHash: string | null } {
  // Keep a UTF-8 BOM in the decoded string so untouched bytes and byte offsets
  // refer to the actual source, not TextDecoder's default BOM-stripped view.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes);
  let after: string, proposal: ChangelogProposal | null = null, insertionHash: string | null = null;
  if (input.projections[0].purpose === 'changelog') {
    const entry = (input.entry ?? '').replace(/\r\n?/g, '\n').trim();
    if (!entry || Buffer.byteLength(entry) > 16384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(entry) || /^\s{0,3}#{1,2}(?:\s|$)/m.test(entry) || /\n\s*(?:===+|---+)\s*(?:\n|$)/.test(entry)) throw new Error('release_changelog_entry_invalid');
    if (!/^\uFEFF?# Changelog(?:\r?\n|$)/.test(text)) throw new Error('release_changelog_layout_unsupported');
    const versionToken = new RegExp(`(?:^|[^\\w.+-])v?${input.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w.+-])`);
    if (text.split(/\r?\n/).some(line => {
      const heading = /^ {0,3}##(?:[ \t]+|$)(.*)$/.exec(line);
      return heading !== null && versionToken.test(heading[1]);
    })) throw new Error('release_changelog_version_exists');
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const firstEnd = text.indexOf('\n');
    const start = firstEnd < 0 ? text.length : firstEnd + 1;
    const insertion = `${firstEnd < 0 ? newline : ''}${newline}## [${input.version}] - ${input.date}${newline}${newline}${entry.replaceAll('\n', newline)}${newline}${newline}`;
    after = text.slice(0, start) + insertion + text.slice(start);
    const fields = { schema_version: 'harness.gstack.changelog-proposal.v1' as const,
      base_blob_sha: createHash('sha1').update(`blob ${input.bytes.length}\0`).update(input.bytes).digest('hex'),
      base_content_sha256: digest(input.bytes), version: input.version, governance_date: input.date,
      operation: 'insert_new_version' as const, insertion_start_byte: Buffer.byteLength(text.slice(0, start)), insertion_end_byte: Buffer.byteLength(text.slice(0, start)),
      normalized_entry_sha256: digest(entry), normalized_entry_bytes: Buffer.byteLength(entry) };
    proposal = { ...fields, proposal_sha256: digest(JSON.stringify(fields)) }; insertionHash = digest(insertion);
  } else after = renderVersions(text, input.projections, input.version, input.current, input.legacyMirror);
  return { file: { path: input.path, mode: input.mode, before: input.bytes.toString('base64'), after: Buffer.from(after).toString('base64'), before_sha256: digest(input.bytes), after_sha256: digest(after), projections: input.projections }, proposal, insertionHash };
}
