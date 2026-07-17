#!/usr/bin/env bun

/**
 * Build the GStack 2.0 backlog map from frozen GitHub API snapshots.
 *
 * The GitHub issues endpoint includes pull requests, while the pull-request
 * endpoint repeats those records with PR-specific fields. This generator
 * recursively flattens page arrays/envelopes, reconciles those duplicates by
 * repository + number, and retains every source occurrence for auditability.
 *
 * Classification is deliberately conservative: titles are considered first;
 * bodies only match narrow two-signal expressions; unmatched work lands in the
 * governance intake with NEEDS_EVIDENCE. The required port PR list is the only
 * hand-curated mapping table.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const DEFAULT_BASE_SHA = 'bb57306d98c97011b0919c6132705a15b1579781';
const REQUIRED_PORT_PRS = [
  610, 645, 679, 884, 1071, 1484, 1636, 1777,
  1920, 2014, 2023, 2030, 2037, 2141, 2186, 2189,
] as const;

const COMPONENTS = [
  'plan',
  'design',
  'qa',
  'debug',
  'review',
  'ship',
  'runtime-paths-state',
  'runtime-browser',
  'runtime-ios',
  'runtime-context-dev',
  'runtime-pdf-diagram',
  'installation-migration',
  'docs-governance',
] as const;

const DISPOSITIONS = [
  'PORT_JUDGMENT',
  'FIX_IN_GSTACK_2',
  'SUPERSEDED_BY_CONSOLIDATION',
  'RETAIN_INTERNAL',
  'DEFER_COMMUNITY',
  'NEEDS_EVIDENCE',
  'NOT_CORE',
] as const;

const CATEGORIES = [
  'infrastructure',
  'judgment',
  'workflow',
  'context',
  'UX',
  'governance',
  'not-core',
] as const;

const JUDGMENT_MODULES = [
  'office-hours',
  'ceo-review',
  'engineering-review',
  'dx-review',
  'specification',
  'consultation',
  'alternatives',
  'html-generation',
  'plan-review',
  'live-review',
  'ios-hig-review',
  'web-qa',
  'report-only',
  'fix-and-verify',
  'performance',
  'developer-experience',
  'ios-qa',
  'investigation',
  'ios-fix',
  'core-review',
  'security-review',
  'health',
  'outside-voice',
  'release',
  'land-deploy',
  'canary',
  'docs',
  'none',
] as const;

const ROOT_CAUSE_FAMILIES = [
  'installation-and-migration',
  'host-capability-and-portability',
  'path-state-and-lifecycle',
  'browser-control-and-evidence',
  'device-control-and-evidence',
  'context-memory-and-isolation',
  'artifact-generation-and-rendering',
  'workflow-orchestration-and-handoffs',
  'judgment-quality-and-calibration',
  'verification-and-regression-coverage',
  'security-trust-and-governance',
  'documentation-and-discoverability',
  'out-of-scope-or-insufficient-signal',
] as const;

type Component = typeof COMPONENTS[number];
type Disposition = typeof DISPOSITIONS[number];
type Category = typeof CATEGORIES[number];
type JudgmentModule = typeof JUDGMENT_MODULES[number];
type RootCauseFamily = typeof ROOT_CAUSE_FAMILIES[number];

interface GitHubRecord {
  [key: string]: unknown;
  number: number;
  title: string;
  body?: string | null;
  html_url?: string;
  url?: string;
  repository_url?: string;
  state?: string;
  state_reason?: string | null;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
  pull_request?: unknown;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  base?: { ref?: string; repo?: { full_name?: string } };
  head?: { ref?: string; repo?: { full_name?: string } };
}

interface GitHubFileRecord {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

interface SnapshotSpec {
  id: string;
  repo: string;
  kind: 'open-items' | 'open-prs' | 'labels';
  file: string;
}

interface Mapping {
  rootCauseFamily: RootCauseFamily;
  component: Component;
  disposition: Disposition;
  replacementTest: string;
  relatedJudgmentModule: JudgmentModule;
  category: Category;
  classification: {
    rule: string;
    input: 'manual-required-pr' | 'title' | 'title+body' | 'fallback';
    note: string;
  };
}

interface ComponentRule {
  id: string;
  component: Component;
  rootCauseFamily: RootCauseFamily;
  category: Category;
  title: RegExp;
  body?: RegExp;
}

const REPLACEMENT_TESTS: Record<Component, { id: string; assertion: string }> = {
  plan: {
    id: 'judgment.plan.contract',
    assertion: 'Replay a curated plan fixture and assert the recommendation, rationale, scope gate, and user-control point.',
  },
  design: {
    id: 'judgment.design.contract',
    assertion: 'Replay representative design inputs and assert hierarchy, constraint preservation, evidence, and explicit taste decisions.',
  },
  qa: {
    id: 'workflow.qa.evidence-contract',
    assertion: 'Exercise a real repro and assert evidence-before-finding, stable artifact paths, and report/fix mode boundaries.',
  },
  debug: {
    id: 'workflow.debug.root-cause-contract',
    assertion: 'Reproduce the fault and assert investigation evidence precedes the smallest verified fix.',
  },
  review: {
    id: 'judgment.review.precision-contract',
    assertion: 'Run seeded true-positive and false-positive diffs and assert calibrated findings with file-and-line evidence.',
  },
  ship: {
    id: 'workflow.ship.state-machine-contract',
    assertion: 'Replay clean, dirty, failing-CI, reviewer-gated, and deploy-failure states without skipping an irreversible gate.',
  },
  'runtime-paths-state': {
    id: 'runtime.paths-state.matrix-contract',
    assertion: 'Resolve paths and process state across supported OS, shell, install-root, environment, and stale-state fixtures.',
  },
  'runtime-browser': {
    id: 'runtime.browser.lifecycle-contract',
    assertion: 'Launch, attach, act, capture evidence, recover from a busy daemon, and shut down without losing live session state.',
  },
  'runtime-ios': {
    id: 'runtime.ios.device-contract',
    assertion: 'Connect, authorize, inspect, act, capture, reconnect, and clean up against a device/bridge contract fixture.',
  },
  'runtime-context-dev': {
    id: 'runtime.context-isolation-contract',
    assertion: 'Round-trip context and learning state across project, branch, user, expiry, malformed-state, and concurrent-writer fixtures.',
  },
  'runtime-pdf-diagram': {
    id: 'runtime.artifact-render-contract',
    assertion: 'Generate, render, reopen, and visually verify deterministic PDF/diagram artifacts with hostile text and page-size fixtures.',
  },
  'installation-migration': {
    id: 'installation.host-matrix-contract',
    assertion: 'Install, upgrade, relink, and uninstall from standard and custom roots on every supported host without shadowing user content.',
  },
  'docs-governance': {
    id: 'docs.generated-source-contract',
    assertion: 'Regenerate canonical docs/catalogs and assert source ownership, link integrity, freshness, and an evidence-backed intake decision.',
  },
};

const COMPONENT_RULES: ComponentRule[] = [
  {
    id: 'installation-migration',
    component: 'installation-migration',
    rootCauseFamily: 'installation-and-migration',
    category: 'infrastructure',
    title: /\b(setup|install(?:er|ation|ing)?|uninstall|upgrade|migration|relink|symlink|plugin|marketplace|skill(?:s)?\.sh|distribution|package manager)\b/i,
    body: /(?:install|setup|upgrade).{0,100}(?:root|path|host|symlink)|(?:symlink|plugin).{0,100}(?:missing|broken|shadow)/is,
  },
  {
    id: 'runtime-browser',
    component: 'runtime-browser',
    rootCauseFamily: 'browser-control-and-evidence',
    category: 'infrastructure',
    title: /\b(browse|browser|chrome|chromium|playwright|puppeteer|cookie|cdp|extension|sidebar|headless|screenshot|snapshot|scrape)\b/i,
    body: /(?:browser|chrome|chromium|playwright).{0,100}(?:daemon|session|launch|attach|cookie|screenshot)|(?:screenshot|snapshot).{0,100}(?:browser|evidence)/is,
  },
  {
    id: 'runtime-ios',
    component: 'runtime-ios',
    rootCauseFamily: 'device-control-and-evidence',
    category: 'infrastructure',
    title: /\b(iOS|iPhone|SwiftUI|Xcode|CoreDevice|Tailscale|mobile|Appium|device bridge)\b/i,
    body: /(?:iOS|iPhone|SwiftUI|Xcode|CoreDevice|Appium).{0,100}(?:device|bridge|test|screen|connect)/is,
  },
  {
    id: 'runtime-pdf-diagram',
    component: 'runtime-pdf-diagram',
    rootCauseFamily: 'artifact-generation-and-rendering',
    category: 'workflow',
    title: /\b(PDF|diagram|mermaid|excalidraw|SVG|typst|pandoc|artifact render(?:er|ing)?|render(?:er|ing)? (?:PDF|diagram|SVG))\b/i,
    body: /(?:PDF|diagram|mermaid|excalidraw).{0,100}(?:render|layout|export|artifact)/is,
  },
  {
    id: 'runtime-context-dev',
    component: 'runtime-context-dev',
    rootCauseFamily: 'context-memory-and-isolation',
    category: 'context',
    title: /\b(context|memory|gbrain|learning|learnings|retro|profile|taste|preference|resume|restore|session intelligence|compaction|transcript)\b/i,
    body: /(?:context|memory|gbrain|learning|preference).{0,100}(?:state|store|persist|isolation|branch|session|stale)/is,
  },
  {
    id: 'ship',
    component: 'ship',
    rootCauseFamily: 'workflow-orchestration-and-handoffs',
    category: 'workflow',
    title: /\b(ship|shipping|deploy|deployment|land-and-deploy|canary|release|merge|version(?:ing)?|changelog|pull request|\bPR\b|CI\/CD|GitHub Actions)\b/i,
    body: /(?:ship|deploy|merge|release|pull request).{0,100}(?:gate|workflow|reviewer|version|failure|state)/is,
  },
  {
    id: 'review',
    component: 'review',
    rootCauseFamily: 'judgment-quality-and-calibration',
    category: 'judgment',
    title: /\b(review|reviewer|security|CSO|threat|OWASP|health check|outside voice|codex|claude challenge|audit finding)\b/i,
    body: /(?:review|security|audit).{0,100}(?:finding|false positive|checklist|threat|trust|diff)/is,
  },
  {
    id: 'debug',
    component: 'debug',
    rootCauseFamily: 'workflow-orchestration-and-handoffs',
    category: 'workflow',
    title: /\b(investigat(?:e|ion)|debug(?:ger|ging)?|root cause|bisect|stack trace|reproduc(?:e|tion)|bug fixer)\b/i,
    body: /(?:debug|investigate|root cause|bisect).{0,100}(?:repro|evidence|fix|regression)/is,
  },
  {
    id: 'qa',
    component: 'qa',
    rootCauseFamily: 'verification-and-regression-coverage',
    category: 'workflow',
    title: /\b(QA|qa-only|test(?:ing|s)?|eval(?:uation|s)?|benchmark|performance|regression|evidence|fixture|coverage|devex|developer experience)\b/i,
    body: /(?:test|eval|QA|benchmark|evidence).{0,100}(?:fixture|assert|regression|coverage|finding|performance)/is,
  },
  {
    id: 'design',
    component: 'design',
    rootCauseFamily: 'judgment-quality-and-calibration',
    category: 'judgment',
    title: /\b(design|UI|UX|aesthetic|visual|CSS|HTML|font|typography|color|layout|wireframe|responsive|accessibility)\b/i,
    body: /(?:design|UI|UX|aesthetic|visual).{0,100}(?:system|review|layout|hierarchy|accessibility|HTML|CSS)/is,
  },
  {
    id: 'plan',
    component: 'plan',
    rootCauseFamily: 'judgment-quality-and-calibration',
    category: 'judgment',
    title: /\b(plan|planning|autoplan|office.hours|CEO|founder|engineering review|architecture|spec(?:ification)?|scope|brainstorm|consultation|data model|schema)\b/i,
    body: /(?:plan|scope|architecture|specification|data model).{0,100}(?:decision|review|tradeoff|phase|recommendation)/is,
  },
  {
    id: 'docs-governance',
    component: 'docs-governance',
    rootCauseFamily: 'documentation-and-discoverability',
    category: 'governance',
    title: /\b(doc(?:s|umentation)?|README|tutorial|how-to|reference|translation|localization|locale|language|catalog|frontmatter|license|governance|community)\b/i,
    body: /(?:docs|documentation|README|translation|catalog).{0,100}(?:missing|stale|generate|link|language|discover)/is,
  },
  {
    id: 'runtime-paths-state',
    component: 'runtime-paths-state',
    rootCauseFamily: 'path-state-and-lifecycle',
    category: 'infrastructure',
    title: /\b(path|state|Windows|Linux|macOS|WSL|shell|bash|PowerShell|Bun|process|lockfile|environment variable|env var|filesystem|directory|runtime)\b/i,
    body: /(?:path|state|process|runtime|filesystem|directory).{0,100}(?:Windows|Linux|macOS|shell|lock|stale|environment|root)/is,
  },
];

const REQUIRED_OVERRIDES: Record<number, Omit<Mapping, 'disposition' | 'replacementTest' | 'classification'>> = {
  610: { rootCauseFamily: 'judgment-quality-and-calibration', component: 'review', relatedJudgmentModule: 'core-review', category: 'judgment' },
  645: { rootCauseFamily: 'judgment-quality-and-calibration', component: 'review', relatedJudgmentModule: 'core-review', category: 'judgment' },
  679: { rootCauseFamily: 'documentation-and-discoverability', component: 'docs-governance', relatedJudgmentModule: 'docs', category: 'UX' },
  884: { rootCauseFamily: 'security-trust-and-governance', component: 'ship', relatedJudgmentModule: 'land-deploy', category: 'governance' },
  1071: { rootCauseFamily: 'judgment-quality-and-calibration', component: 'plan', relatedJudgmentModule: 'engineering-review', category: 'judgment' },
  1484: { rootCauseFamily: 'verification-and-regression-coverage', component: 'qa', relatedJudgmentModule: 'web-qa', category: 'workflow' },
  1636: { rootCauseFamily: 'context-memory-and-isolation', component: 'runtime-context-dev', relatedJudgmentModule: 'none', category: 'context' },
  1777: { rootCauseFamily: 'context-memory-and-isolation', component: 'runtime-context-dev', relatedJudgmentModule: 'none', category: 'context' },
  1920: { rootCauseFamily: 'judgment-quality-and-calibration', component: 'design', relatedJudgmentModule: 'live-review', category: 'judgment' },
  2014: { rootCauseFamily: 'workflow-orchestration-and-handoffs', component: 'plan', relatedJudgmentModule: 'plan-review', category: 'judgment' },
  2023: { rootCauseFamily: 'judgment-quality-and-calibration', component: 'plan', relatedJudgmentModule: 'plan-review', category: 'judgment' },
  2030: { rootCauseFamily: 'context-memory-and-isolation', component: 'runtime-context-dev', relatedJudgmentModule: 'none', category: 'context' },
  2037: { rootCauseFamily: 'verification-and-regression-coverage', component: 'runtime-context-dev', relatedJudgmentModule: 'none', category: 'context' },
  2141: { rootCauseFamily: 'judgment-quality-and-calibration', component: 'review', relatedJudgmentModule: 'core-review', category: 'judgment' },
  2186: { rootCauseFamily: 'security-trust-and-governance', component: 'debug', relatedJudgmentModule: 'investigation', category: 'governance' },
  2189: { rootCauseFamily: 'verification-and-regression-coverage', component: 'design', relatedJudgmentModule: 'consultation', category: 'judgment' },
};

function parseArgs(argv: string[]) {
  const result = {
    snapshotDir: '/tmp',
    portPrDir: '/tmp/gstack2-port-prs',
    output: path.resolve(import.meta.dir, '../../docs/gstack-2/BACKLOG-MAP.json'),
    baseSha: DEFAULT_BASE_SHA,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--snapshot-dir' && value) result.snapshotDir = value;
    else if (argument === '--port-pr-dir' && value) result.portPrDir = value;
    else if (argument === '--output' && value) result.output = path.resolve(value);
    else if (argument === '--base-sha' && value) result.baseSha = value;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  return result;
}

function readJSON(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isGitHubRecord(value: unknown): value is GitHubRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isInteger(candidate.number) && typeof candidate.title === 'string';
}

function isLabelRecord(value: unknown): value is { name: string; color?: string; description?: string | null; default?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === 'string' && typeof candidate.color === 'string' && !('number' in candidate);
}

function isFileRecord(value: unknown): value is GitHubFileRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>).filename === 'string';
}

function flattenMatching<T>(value: unknown, predicate: (candidate: unknown) => candidate is T): T[] {
  if (Array.isArray(value)) return value.flatMap((entry) => flattenMatching(entry, predicate));
  if (predicate(value)) return [value];
  if (!value || typeof value !== 'object') return [];
  const envelope = value as Record<string, unknown>;
  for (const key of ['items', 'nodes', 'data', 'results', 'pages']) {
    if (key in envelope) return flattenMatching(envelope[key], predicate);
  }
  return [];
}

function pageCount(value: unknown): number {
  if (!Array.isArray(value)) return 1;
  if (value.length === 0) return 0;
  return value.every(Array.isArray) ? value.length : 1;
}

function repoFromRecord(record: GitHubRecord, fallback: string): string {
  if (typeof record.repository_url === 'string') {
    const match = record.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
    if (match) return match[1];
  }
  const baseRepo = record.base?.repo?.full_name;
  if (baseRepo) return baseRepo;
  const html = record.html_url ?? record.url;
  if (html) {
    const match = html.match(/(?:github\.com|api\.github\.com\/repos)\/([^/]+\/[^/]+)/);
    if (match) return match[1];
  }
  return fallback;
}

function replacementTest(component: Component): string {
  return REPLACEMENT_TESTS[component].id;
}

function relatedJudgmentModule(component: Component, text: string): JudgmentModule {
  if (/office.hours/i.test(text)) return 'office-hours';
  if (/\bCEO\b|founder/i.test(text)) return 'ceo-review';
  if (/plan.eng|engineering review|architecture|data model|schema|JSONField/i.test(text)) return 'engineering-review';
  if (/plan.devex|\bdx\b|developer experience|devex/i.test(text)) return 'dx-review';
  if (/\bspec(?:ification)?\b/i.test(text)) return 'specification';
  if (/design.consultation|design system/i.test(text)) return 'consultation';
  if (/design.shotgun|alternative|variant/i.test(text)) return 'alternatives';
  if (/design.html|html generation/i.test(text)) return 'html-generation';
  if (/plan.design|design plan|autoplan/i.test(text)) return 'plan-review';
  if (/ios.design|\bHIG\b/i.test(text)) return 'ios-hig-review';
  if (/design.review|visual audit/i.test(text)) return 'live-review';
  if (/qa.only|report.only/i.test(text)) return 'report-only';
  if (/ios.qa/i.test(text)) return 'ios-qa';
  if (/devex.review|developer experience/i.test(text)) return 'developer-experience';
  if (/benchmark|performance/i.test(text)) return 'performance';
  if (/ios.fix/i.test(text)) return 'ios-fix';
  if (/investigat|debug|bisect|root cause/i.test(text)) return 'investigation';
  if (/\bCSO\b|security|OWASP|threat/i.test(text)) return 'security-review';
  if (/health/i.test(text)) return 'health';
  if (/outside voice|codex|claude challenge/i.test(text)) return 'outside-voice';
  if (/land.and.deploy|deploy|merge gate/i.test(text)) return 'land-deploy';
  if (/canary/i.test(text)) return 'canary';
  if (/docs|documentation|README|tutorial/i.test(text)) return 'docs';
  const defaults: Partial<Record<Component, JudgmentModule>> = {
    plan: 'plan-review',
    design: 'live-review',
    qa: /fix/i.test(text) ? 'fix-and-verify' : 'web-qa',
    debug: 'investigation',
    review: 'core-review',
    ship: 'release',
    'docs-governance': 'docs',
  };
  return defaults[component] ?? 'none';
}

function isNotCoreTitle(title: string): boolean {
  const normalized = title.trim();
  return /^(eh|hi|hello|hi bro[^a-z]*|test|testing|سلام|你好|hola)[.!?\s\p{Emoji_Presentation}]*$/iu.test(normalized)
    || /\b(airdrop|casino|gambling|loan offer|crypto pump|buy followers|dating service)\b/i.test(normalized);
}

function dispositionFor(record: GitHubRecord, repo: string, category: Category): { value: Disposition; rule: string } {
  const title = record.title;
  const labels = (record.labels ?? []).map((label) => label.name ?? '').join(' ');
  const isPR = Boolean(record.pull_request || record.base || record.head);
  if (repo === 'time-attack/gstack') return { value: 'RETAIN_INTERNAL', rule: 'time-attack-internal' };
  if (category === 'not-core' || /\b(invalid|wontfix)\b/i.test(labels)) return { value: 'NOT_CORE', rule: 'not-core-signal' };
  if (/\b(duplicate|duplicated|boilerplate|consolidat|same frontmatter name|alias.+shadow|shadow.+alias)\b/i.test(title)) {
    return { value: 'SUPERSEDED_BY_CONSOLIDATION', rule: 'consolidation-signal' };
  }
  if (/\b(translation|localization|locale|add (?:initial )?support for|adapter|new host|community skill|language pack)\b/i.test(title)
    && !/\b(fix|bug|broken|crash|fail|missing)\b/i.test(title)) {
    return { value: 'DEFER_COMMUNITY', rule: 'community-expansion' };
  }
  if (!isPR && /\b(fix|bug|broken|breaks?|crash(?:es)?|fail(?:s|ure|ing)?|missing|leak(?:s|ed)?|silently|stale|incorrect|cannot|can't|doesn't|does not|hangs?|corrupt)\b/i.test(title)) {
    return { value: 'FIX_IN_GSTACK_2', rule: 'open-bug' };
  }
  return { value: 'NEEDS_EVIDENCE', rule: isPR ? 'unvetted-community-pr' : 'ambiguous-open-issue' };
}

function classify(record: GitHubRecord, repo: string): Mapping {
  if (repo === 'garrytan/gstack' && REQUIRED_PORT_PRS.includes(record.number as typeof REQUIRED_PORT_PRS[number])) {
    const override = REQUIRED_OVERRIDES[record.number];
    return {
      ...override,
      disposition: 'PORT_JUDGMENT',
      replacementTest: replacementTest(override.component),
      classification: {
        rule: `required-port-pr-${record.number}`,
        input: 'manual-required-pr',
        note: 'Explicitly selected port candidate; mapping reviewed against its detail and changed-file snapshots.',
      },
    };
  }

  if (isNotCoreTitle(record.title)) {
    return {
      rootCauseFamily: 'out-of-scope-or-insufficient-signal',
      component: 'docs-governance',
      disposition: repo === 'time-attack/gstack' ? 'RETAIN_INTERNAL' : 'NOT_CORE',
      replacementTest: replacementTest('docs-governance'),
      relatedJudgmentModule: 'none',
      category: 'not-core',
      classification: {
        rule: 'obvious-no-signal-or-spam-title',
        input: 'title',
        note: 'Only exact low-information greetings/tests and explicit spam terms are classified not-core.',
      },
    };
  }

  const title = record.title;
  const body = typeof record.body === 'string' ? record.body.slice(0, 12_000) : '';
  let selected = COMPONENT_RULES.find((rule) => rule.title.test(title));
  let input: Mapping['classification']['input'] = 'title';
  if (!selected) {
    selected = COMPONENT_RULES.find((rule) => rule.body?.test(body));
    input = selected ? 'title+body' : 'fallback';
  }

  if (!selected) {
    const disposition = dispositionFor(record, repo, 'governance');
    return {
      rootCauseFamily: 'out-of-scope-or-insufficient-signal',
      component: 'docs-governance',
      disposition: disposition.value,
      replacementTest: replacementTest('docs-governance'),
      relatedJudgmentModule: 'none',
      category: 'governance',
      classification: {
        rule: `fallback:${disposition.rule}`,
        input: 'fallback',
        note: 'No conservative title or two-signal body rule matched; retained for governance triage.',
      },
    };
  }

  let rootCauseFamily = selected.rootCauseFamily;
  let category = selected.category;
  if (/\b(security|untrusted|secret|credential|injection|auth(?:entication|orization)?|permission|OWASP|threat|vulnerab|CVE|API key|key bytes)\b/i.test(title)) {
    rootCauseFamily = 'security-trust-and-governance';
    category = 'governance';
  } else if (/\b(test|eval|regression|fixture|assertion|coverage|false positive|false negative|evidence)\b/i.test(title)) {
    rootCauseFamily = 'verification-and-regression-coverage';
  } else if (/\b(host|adapter|Windows|Linux|macOS|WSL|Codex|Claude|Gemini|OpenCode|Cursor|Kiro|Copilot|Antigravity)\b/i.test(title)
    && ['installation-migration', 'runtime-paths-state'].includes(selected.component)) {
    rootCauseFamily = 'host-capability-and-portability';
  }
  if (/\b(language|translation|localization|locale|accessibility|responsive|user-facing|UX)\b/i.test(title)) category = 'UX';

  const disposition = dispositionFor(record, repo, category);
  return {
    rootCauseFamily,
    component: selected.component,
    disposition: disposition.value,
    replacementTest: replacementTest(selected.component),
    relatedJudgmentModule: relatedJudgmentModule(selected.component, title),
    category,
    classification: {
      rule: `${selected.id}:${disposition.rule}`,
      input,
      note: input === 'title+body'
        ? 'Title was ambiguous; a narrow two-signal body rule selected the component.'
        : 'First matching ordered title rule selected the component; disposition remained conservative.',
    },
  };
}

function sortedCount<T extends string>(values: T[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotSpecs: SnapshotSpec[] = [
    { id: 'time-attack/open-items', repo: 'time-attack/gstack', kind: 'open-items', file: path.join(args.snapshotDir, 'gstack2-open-items-pages.json') },
    { id: 'time-attack/open-prs', repo: 'time-attack/gstack', kind: 'open-prs', file: path.join(args.snapshotDir, 'gstack2-open-prs-pages.json') },
    { id: 'time-attack/labels', repo: 'time-attack/gstack', kind: 'labels', file: path.join(args.snapshotDir, 'gstack2-label-pages.json') },
    { id: 'garrytan/open-items', repo: 'garrytan/gstack', kind: 'open-items', file: path.join(args.snapshotDir, 'gstack2-upstream-open-items-pages.json') },
    { id: 'garrytan/open-prs', repo: 'garrytan/gstack', kind: 'open-prs', file: path.join(args.snapshotDir, 'gstack2-upstream-open-prs-pages.json') },
    { id: 'garrytan/labels', repo: 'garrytan/gstack', kind: 'labels', file: path.join(args.snapshotDir, 'gstack2-upstream-label-pages.json') },
  ];

  const sourceSnapshots: Array<Record<string, unknown>> = [];
  const labelsByRepo = new Map<string, Array<Record<string, unknown>>>();
  const accumulators = new Map<string, {
    repo: string;
    number: number;
    record: GitHubRecord;
    sources: Set<string>;
    openItemSeen: boolean;
    openPrSeen: boolean;
    requiredDetailSeen: boolean;
    files: GitHubFileRecord[];
  }>();

  let openEndpointRecords = 0;
  for (const spec of snapshotSpecs) {
    const raw = readJSON(spec.file);
    if (spec.kind === 'labels') {
      const labels = flattenMatching(raw, isLabelRecord)
        .map((label) => ({ name: label.name, color: label.color ?? null, description: label.description ?? null, default: label.default ?? false }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      labelsByRepo.set(spec.repo, labels);
      sourceSnapshots.push({ id: spec.id, path: spec.file, sha256: sha256File(spec.file), pageArrays: pageCount(raw), flattenedRecords: labels.length });
      continue;
    }

    const records = flattenMatching(raw, isGitHubRecord);
    openEndpointRecords += records.length;
    sourceSnapshots.push({ id: spec.id, path: spec.file, sha256: sha256File(spec.file), pageArrays: pageCount(raw), flattenedRecords: records.length });
    for (const record of records) {
      const repo = repoFromRecord(record, spec.repo);
      const key = `${repo}#${record.number}`;
      const existing = accumulators.get(key);
      if (existing) {
        existing.record = { ...existing.record, ...record };
        existing.sources.add(spec.id);
        if (spec.kind === 'open-items') existing.openItemSeen = true;
        if (spec.kind === 'open-prs') existing.openPrSeen = true;
      } else {
        accumulators.set(key, {
          repo,
          number: record.number,
          record: { ...record },
          sources: new Set([spec.id]),
          openItemSeen: spec.kind === 'open-items',
          openPrSeen: spec.kind === 'open-prs',
          requiredDetailSeen: false,
          files: [],
        });
      }
    }
  }

  for (const number of REQUIRED_PORT_PRS) {
    const detailFile = path.join(args.portPrDir, `${number}.json`);
    const filesFile = path.join(args.portPrDir, `${number}-files.json`);
    const rawDetail = readJSON(detailFile);
    const rawFiles = readJSON(filesFile);
    const detailRecords = flattenMatching(rawDetail, isGitHubRecord);
    const fileRecords = flattenMatching(rawFiles, isFileRecord)
      .map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes }))
      .sort((left, right) => left.filename.localeCompare(right.filename));
    if (detailRecords.length !== 1) throw new Error(`Expected one PR detail record for #${number}, found ${detailRecords.length}`);
    const detail = detailRecords[0];
    const repo = repoFromRecord(detail, 'garrytan/gstack');
    const key = `${repo}#${number}`;
    const existing = accumulators.get(key);
    if (!existing) throw new Error(`Required PR ${key} is absent from the open snapshots`);
    existing.record = { ...existing.record, ...detail };
    existing.sources.add(`required-port/${number}`);
    existing.requiredDetailSeen = true;
    existing.files = fileRecords;
    sourceSnapshots.push({ id: `required-port/${number}/detail`, path: detailFile, sha256: sha256File(detailFile), pageArrays: pageCount(rawDetail), flattenedRecords: 1 });
    sourceSnapshots.push({ id: `required-port/${number}/files`, path: filesFile, sha256: sha256File(filesFile), pageArrays: pageCount(rawFiles), flattenedRecords: fileRecords.length });
  }

  const items = [...accumulators.values()]
    .sort((left, right) => left.repo.localeCompare(right.repo) || left.number - right.number)
    .map((entry) => {
      const record = entry.record;
      const mapping = classify(record, entry.repo);
      const isPR = entry.openPrSeen || Boolean(record.pull_request || record.base || record.head);
      const body = typeof record.body === 'string' ? record.body : '';
      const portTrace = entry.requiredDetailSeen ? {
        required: true,
        detailSnapshot: path.join(args.portPrDir, `${entry.number}.json`),
        filesSnapshot: path.join(args.portPrDir, `${entry.number}-files.json`),
        changedFileCount: entry.files.length,
        files: entry.files,
      } : null;
      return {
        id: `${entry.repo}#${entry.number}`,
        repo: entry.repo,
        number: entry.number,
        kind: isPR ? 'pull-request' : 'issue',
        title: record.title,
        url: record.html_url ?? record.url ?? null,
        author: record.user?.login ?? null,
        dates: {
          createdAt: record.created_at ?? null,
          updatedAt: record.updated_at ?? null,
          closedAt: record.closed_at ?? null,
          mergedAt: record.merged_at ?? null,
        },
        state: record.state ?? null,
        stateReason: record.state_reason ?? null,
        draft: isPR ? (record.draft ?? false) : null,
        baseRef: isPR ? (record.base?.ref ?? null) : null,
        headRef: isPR ? (record.head?.ref ?? null) : null,
        labels: (record.labels ?? []).map((label) => label.name).filter(Boolean).sort(),
        bodyPresent: body.length > 0,
        bodyLength: body.length,
        sourceOccurrences: [...entry.sources].sort(),
        sourceReconciliation: {
          openItems: entry.openItemSeen,
          openPRs: entry.openPrSeen,
          requiredDetail: entry.requiredDetailSeen,
        },
        portTrace,
        ...mapping,
      };
    });

  const requiredPortPRs = REQUIRED_PORT_PRS.map((number) => {
    const item = items.find((candidate) => candidate.repo === 'garrytan/gstack' && candidate.number === number);
    if (!item || !item.portTrace) throw new Error(`Required port trace missing for garrytan/gstack#${number}`);
    return {
      number,
      itemId: item.id,
      title: item.title,
      url: item.url,
      author: item.author,
      dates: item.dates,
      component: item.component,
      relatedJudgmentModule: item.relatedJudgmentModule,
      replacementTest: item.replacementTest,
      detailSnapshot: item.portTrace.detailSnapshot,
      filesSnapshot: item.portTrace.filesSnapshot,
      changedFileCount: item.portTrace.changedFileCount,
      traced: true,
    };
  });

  const endpointOccurrenceCount = items.reduce((total, item) => total + Number(item.sourceReconciliation.openItems) + Number(item.sourceReconciliation.openPRs), 0);
  const snapshotAsOf = items
    .map((item) => item.dates.updatedAt)
    .filter((date): date is string => typeof date === 'string')
    .sort()
    .at(-1) ?? null;

  const output = {
    schemaVersion: 1,
    purpose: 'Deterministic evidence map from the frozen time-attack/gstack and garrytan/gstack open-backlog snapshots into GStack 2.0 ownership and verification contracts.',
    baseSha: args.baseSha,
    snapshotAsOf,
    generator: 'scripts/gstack2/generate-backlog-map.ts',
    methodology: {
      flattening: 'Recursively flatten array pages and common items/nodes/data/results/pages envelopes; never select only the first page.',
      reconciliation: 'The issues endpoint includes PRs. Records are keyed by repo#number, PR-specific fields enrich issue records, and sourceOccurrences/sourceReconciliation retain raw endpoint provenance.',
      heuristics: 'Ordered title rules first. Bodies are capped at 12,000 characters and used only by narrow two-signal expressions. No network, LLM, label mutation, or repository mutation occurs.',
      fallback: 'Ambiguous items remain in docs-governance intake with NEEDS_EVIDENCE and out-of-scope-or-insufficient-signal; this is triage ownership, not a claim that the item is documentation work.',
      requiredPorts: 'Only the enumerated required PRs receive hand-reviewed PORT_JUDGMENT overrides; their detail and changed-file snapshots are traced below and on each item.',
    },
    taxonomy: {
      categories: CATEGORIES,
      components: COMPONENTS,
      dispositions: DISPOSITIONS,
      relatedJudgmentModules: JUDGMENT_MODULES,
      rootCauseFamilies: ROOT_CAUSE_FAMILIES,
      replacementTests: Object.fromEntries(COMPONENTS.map((component) => [REPLACEMENT_TESTS[component].id, { component, assertion: REPLACEMENT_TESTS[component].assertion }])),
      dispositionMeaning: {
        PORT_JUDGMENT: 'Required, explicitly traced judgment/policy candidate; port intent, not a blind patch application.',
        FIX_IN_GSTACK_2: 'Clear open defect signal to solve in the consolidated architecture.',
        SUPERSEDED_BY_CONSOLIDATION: 'Duplicate/shadow/boilerplate concern absorbed by the consolidated architecture.',
        RETAIN_INTERNAL: 'Existing time-attack/gstack work that remains part of the internal baseline.',
        DEFER_COMMUNITY: 'Additive host/language/community expansion held behind core parity.',
        NEEDS_EVIDENCE: 'Plausible but unverified; requires repro, contract, or product decision before implementation.',
        NOT_CORE: 'Obvious no-signal/spam or explicitly invalid/wontfix work.',
      },
    },
    summary: {
      uniqueItems: items.length,
      openEndpointRecords,
      reconciledEndpointOccurrences: endpointOccurrenceCount,
      duplicateEndpointRecords: openEndpointRecords - items.length,
      requiredPortPRs: requiredPortPRs.length,
      requiredPortPRsTraced: requiredPortPRs.filter((entry) => entry.traced).length,
      labelCatalogRecords: [...labelsByRepo.values()].reduce((total, labels) => total + labels.length, 0),
      byRepo: sortedCount(items.map((item) => item.repo)),
      byKind: sortedCount(items.map((item) => item.kind)),
      byCategory: sortedCount(items.map((item) => item.category)),
      byComponent: sortedCount(items.map((item) => item.component)),
      byDisposition: sortedCount(items.map((item) => item.disposition)),
      byRootCauseFamily: sortedCount(items.map((item) => item.rootCauseFamily)),
      byRelatedJudgmentModule: sortedCount(items.map((item) => item.relatedJudgmentModule)),
    },
    sourceSnapshots,
    labelCatalogs: Object.fromEntries([...labelsByRepo.entries()].sort(([left], [right]) => left.localeCompare(right))),
    requiredPortPRs,
    items,
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Wrote ${items.length} mapped items to ${args.output}\n`);
}

main();
