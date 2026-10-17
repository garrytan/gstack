/**
 * Frozen parity oracle for the exercised-path map (W2-A2): the measured
 * prototype (GSTA-45 investigation, exercised.ts at 521fd42, REPORT-2) with
 * only its module-level root and base derivation turned into parameters, its
 * path-prefix regex rewritten to an equivalent non-backtracking form, its
 * import scan switched to A1's scanCodeImports (the prototype ran on the
 * shebang-fixed base; A1 also fixed the TSX loader misreading .ts generics),
 * and the per-case build of its replay (variant cu) appended. Do not edit its
 * edge rules: test/exercised-map.test.ts pins that the shipped
 * exercisedConsumers() equals or is a reviewed superset of this map.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { derivedDependencies, scanCodeImports, SELECTION_DATA_MODULES, type DependencyMaps, type ExercisedMap } from '../../scripts/pr-dependencies';
import { matchGlob } from './test-selection';
import { isPaidTestFile } from './paid-test-set';

export function prototypeConsumers(maps: DependencyMaps, ROOT: string, observedMap: ExercisedMap | null, PR_FULL_GATE_FILES: readonly string[]): Map<string, Set<string>> {
  const base = derivedDependencies(maps, ROOT);
  const tracked: string[] = [...base.tracked];
  const trackedSet = base.tracked as Set<string>;
  const cache = new Map<string, string>();
  const read = (f: string) => { if (!cache.has(f)) { let t = ''; try { if (trackedSet.has(f) && fs.statSync(path.join(ROOT, f)).size < 3_000_000) t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch {} cache.set(f, t); } return cache.get(f)!; };
  const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
  const isBunShebang = (f: string) => /^#!.*\b(?:bun|node)\b/.test(read(f).slice(0, 200));
  const isCode = (f: string) => CODE.test(f) || isBunShebang(f);
  const isShell = (f: string) => !isCode(f) && (/\.sh$/.test(f) || f === 'setup' || /^#!.*\b(?:ba|z|da)?sh\b/.test(read(f).slice(0, 200)));
  const resolveSpec = (spec: string, from: string) => {
    if (!spec.startsWith('.')) return null;
    const b = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    for (const c of [b, b + '.ts', b + '.tsx', b + '.js', b + '.mjs', b + '/index.ts', b + '/index.js']) if (trackedSet.has(c)) return c;
    return null;
  };
  const dirs = new Set(tracked.flatMap(f => f.split('/').slice(0, -1).map((_, i, p) => p.slice(0, i + 1).join('/'))));
  const REPO_PATH = /(?:^|[^\w.@-])((?:bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents|test\/helpers|test\/fixtures|capy)\/[\w.@-]+(?:\/[\w.@-]+)*)/g;
  const JOINED = /['"\x60](bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents)['"\x60]\s*,\s*['"\x60]([\w.@-]+)['"\x60]/g;
  const binByName = new Map<string, string>();
  for (const f of tracked) if (f.startsWith('bin/') || f.startsWith('browse/bin/')) { const b = path.posix.basename(f); binByName.set(b, f); binByName.set(b.replace(/\.(ts|sh|js)$/, ''), f); }
  const BINARIES = [...read('scripts/build.sh').matchAll(/--compile\b[^\n]*?\s([\w./-]+\.ts)\s+--outfile\s+([\w./-]+)/g)].map(m => ({ outfile: m[2]!, entry: m[1]!, tree: m[1]!.startsWith('bin/') ? [m[1]!] : tracked.filter(f => matchGlob(f, path.posix.dirname(m[1]!) + '/**')) }));
  let pkgScripts: Record<string, string> = {}; try { pkgScripts = JSON.parse(read('package.json')).scripts ?? {}; } catch {}
  const expandRef = (ref: string) => { ref = ref.replace(/[.]+$/, ''); if (trackedSet.has(ref)) return [ref]; if (dirs.has(ref)) return tracked.filter(f => f.startsWith(ref + '/')); return []; };
  const stripCode = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const stripMessages = (t: string) => {
    let out = '', i = 0;
    while (i < t.length) {
      const m = /^(?:echo|printf|say|warn|die|fail|err|log|info|note|_dc_row|row)\b/.exec(t.slice(i, i + 8));
      const prev = i === 0 ? '\n' : t[i - 1]!;
      if (m && /[\s;|&(\x60{]/.test(prev)) {
        let j = i + m[0].length, q: string | null = null;
        while (j < t.length) { const c = t[j]!; if (q) { if (c === '\\') { j += 2; continue; } if (c === q) q = null; j++; continue; } if (c === '"' || c === "'") { q = c; j++; continue; } if (c === '\n' || c === ';' || c === '|' || c === '&' || c === ')') break; j++; }
        out += ' '; i = j; continue;
      }
      out += t[i]; i++;
    }
    return out;
  };
  const stripShell = (t: string) => stripMessages(t
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*$/gm, '')
    .split('\n').filter(l => !/^\s*#(?!!)/.test(l))
    .map(l => l.replace(/(^\s*|\bin\s+|;;\s*)[\w*."'-]+(?:\s*\|\s*[\w*."'-]+)*\)(?=\s|$)/g, '$1').replace(/\s#\s.*$/, ''))
    .join('\n'));
  const CMD_START = /(?:^|[;|&({\x60]|\$\(|\b(?:then|do|else|exec|command|nohup|bash|sh|bun|node|timeout\s+\S+|env(?:\s+\w+=\S*)*|if|while|until|!|time))\s*"?$/;
  // Changed from the prototype: its `(?:\/?[\w.@-]+)*\/` path prefix backtracks exponentially; this is the same language (words separated by single slashes, ending in a slash) in an unambiguous form.
  const PREFIX = /(?:"?(?:\$\{?\w+\}?|\$\(dirname\s+"?\$0"?\)|~|\.)?(?:\/(?:[\w.@-]+\/)*|(?:[\w.@-]+\/)+))?"?$/;
  const cmdOk = (before: string) => { const b = before.replace(PREFIX, ''); return CMD_START.test(b) || (/\/$/.test(before) && /\b\w+="?$/.test(b)); };
  const shellExec = (text: string, from: string, out: Set<string>) => {
    for (const m of text.matchAll(/gstack-[a-z0-9][a-z0-9-]*[a-z0-9](?:\.(?:sh|ts))?\b/g)) {
      const i = m.index!; const ls = text.lastIndexOf('\n', i - 1) + 1;
      if (!cmdOk(text.slice(ls, i))) continue;
      const b = binByName.get(m[0]); if (b) out.add(b);
    }
    for (const m of text.matchAll(/(?:bin|lib|scripts|browse|design|make-pdf)\/[\w.@-]+(?:\/[\w.@-]+)*/g)) {
      const i = m.index!; const ls = text.lastIndexOf('\n', i - 1) + 1; const before = text.slice(ls, i);
      if (/[\w.@-]$/.test(before)) continue;
      if (!cmdOk(before) && !/\bbun\s+(?:run\s+)?"?(?:\$\{?\w+\}?\/)?$/.test(before)) continue;
      for (const f of expandRef(m[0])) out.add(f);
    }
    for (const m of text.matchAll(/(?:bin|lib|scripts|browse|design|make-pdf|hosts|capy|test\/fixtures|test\/helpers)\/[\w.@-]+(?:\/[\w.@-]+)*\.(?:json|jsonl|env|txt|ya?ml|toml|csv|tsv)\b/g)) for (const f of expandRef(m[0])) out.add(f);
    for (const m of text.matchAll(/(?:^|[\s;&|({])(?:\.|source)\s+([^;|&\n]+)/gm)) { const names = [...m[1]!.matchAll(/([\w.-]+\.sh|gstack-[\w.-]+)/g)].map(x => x[1]!); if (!names.length) continue; const b = names[names.length - 1]!; const sib = path.posix.join(path.posix.dirname(from), b); if (trackedSet.has(sib)) out.add(sib); else if (binByName.get(b)) out.add(binByName.get(b)!); }
    for (const bin of BINARIES) if (text.includes(bin.outfile) || (bin.outfile === 'browse/dist/browse' && /\$B\b|find-browse/.test(text)) || (bin.outfile === 'design/dist/design' && /\$D\b/.test(text))) for (const f of bin.tree) out.add(f);
    for (const m of text.matchAll(/\b(?:bun|npm) run ([a-z][\w:.-]*)/g)) { const c = pkgScripts[m[1]!]; if (c) for (const r of c.matchAll(REPO_PATH)) for (const f of expandRef(r[1]!)) out.add(f); }
  };
  const bashBlocks = (md: string) => [...md.matchAll(/\x60\x60\x60(?:bash|sh|shell)\n([\s\S]*?)\x60\x60\x60/g)].map(m => m[1]!).join('\n');
  const edges = new Map<string, string[]>();
  const execRefs = (f: string): string[] => {
    if (edges.has(f)) return edges.get(f)!;
    const out = new Set<string>();
    const raw = read(f);
    if ((SELECTION_DATA_MODULES as readonly string[]).includes(f) || !raw) { edges.set(f, []); return []; }
    if (isCode(f)) {
      try { for (const spec of scanCodeImports(f, raw)) { const h = resolveSpec(spec, f); if (h) out.add(h); } } catch {}
      const code = stripCode(raw.replace(/^#!.*/, ''));
      for (const m of code.matchAll(/['"\x60](?:\$\{[^}]+\}\/)?((?:bin|lib|scripts|browse|design|make-pdf|hosts|extension|model-overlays|agents|test\/helpers|test\/fixtures)\/[\w.@-]+(?:\/[\w.@-]+)*)['"\x60]/g)) for (const x of expandRef(m[1]!)) out.add(x);
      for (const m of code.matchAll(JOINED)) for (const x of expandRef(m[1] + '/' + m[2])) out.add(x);
      for (const bin of BINARIES) if (code.includes("'" + bin.outfile + "'") || code.includes('"' + bin.outfile + '"')) for (const x of bin.tree) out.add(x);
    } else if (isShell(f)) {
      shellExec(stripShell(raw), f, out);
    } else if (/\.(md|tmpl)$/.test(f)) {
      shellExec(stripShell(bashBlocks(raw)), f, out);
    }
    out.delete(f);
    const list = [...out]; edges.set(f, list); return list;
  };
  const isFullGate = (f: string) => PR_FULL_GATE_FILES.some((p: string) => matchGlob(f, p));
  const closure = (entries: Iterable<string>) => {
    const seen = new Set<string>(); const q = [...entries].filter(f => trackedSet.has(f));
    while (q.length) { const f = q.pop()!; if (seen.has(f)) continue; seen.add(f); if (base.global.has(f) || isFullGate(f)) continue; for (const n of execRefs(f)) if (!seen.has(n) && !(/\.test\.tsx?$/.test(n) && isPaidTestFile(n))) q.push(n); }
    return seen;
  };
  const expand = (p: string) => p.includes('*') ? tracked.filter(f => matchGlob(f, p)) : trackedSet.has(p) ? [p] : [];
  const OWNER = /^test\/[^/]+\.test\.ts$/;
  function caseEntries(patterns: string[], defaultOwner: string | null) {
    const owners = patterns.filter(p => OWNER.test(p) && isPaidTestFile(p));
    const files = [...(owners.length ? owners : defaultOwner ? [defaultOwner] : []), ...patterns.flatMap(expand)];
    const gen = files.filter(f => f.endsWith('.tmpl')).map(f => f.replace(/\.tmpl$/, '')).filter(f => trackedSet.has(f));
    return [...files, ...gen];
  }
  function binsInCommand(cmd: string): string[] {
    const out = new Set<string>();
    const pty = cmd.startsWith('PTY:');
    for (const m of cmd.matchAll(/gstack-[a-z0-9-]*[a-z0-9](?:\.(?:sh|ts))?/g)) {
      let tok = m[0]!;
      if (pty) { while (tok.length > 7 && !binByName.has(tok)) { const k = tok.lastIndexOf('-'); tok = k > 6 ? tok.slice(0, k) : ''; } }
      const i = m.index!; if (cmd[i - 1] === '/' && i >= 2 && /[\s"'\x60(]/.test(cmd[i - 2]!)) continue;
      const b = binByName.get(tok); if (b) out.add(b);
    }
    for (const m of cmd.matchAll(/browse\/bin\/([a-z-]+)/g)) { const b = binByName.get(m[1]!); if (b) out.add(b); }
    for (const bin of BINARIES) {
      const hit = cmd.includes(bin.outfile) || (bin.outfile === 'browse/dist/browse' && /\$B\b|\$\{B\}|find-browse/.test(cmd)) || (bin.outfile === 'design/dist/design' && /\$D\b|\$\{D\}/.test(cmd)) || (bin.outfile === 'make-pdf/dist/pdf' && /make-pdf\/dist\/pdf/.test(cmd));
      if (hit) out.add(bin.outfile);
    }
    return [...out];
  }
  const binaryTree = (outfile: string) => BINARIES.find(b => b.outfile === outfile)?.tree ?? [];

  const observed = observedMap?.cases ?? {};
  const hostIds = tracked.filter((f: string) => /^hosts\/[\w-]+\.ts$/.test(f) && f !== 'hosts/index.ts').map((f: string) => path.basename(f, '.ts'));
  const byFile = new Map<string, Set<string>>();
  for (const [id, patterns] of Object.entries(maps.e2eTouchfiles)) {
    const entries = caseEntries(patterns, null);
    for (const b of observed[id]?.commands ?? []) { if (trackedSet.has(b)) entries.push(b); else entries.push(...binaryTree(b)); }
    const files = closure(entries);
    const ownerText = entries.filter((f: string) => /^test\/[^/]+\.test\.ts$/.test(f)).map(read).join('\n');
    for (const h of hostIds) if (new RegExp('[\'"\x60]' + h + '[\'"\x60]|--host[ =]' + h + '\\b').test(ownerText)) for (const f of closure(['hosts/' + h + '.ts', ...expand('hosts/' + h + '/**')])) files.add(f);
    for (const f of files) { if (!byFile.has(f)) byFile.set(f, new Set()); byFile.get(f)!.add(id); }
  }
  void binsInCommand; void stripShell; void execRefs;
  return byFile;
}
