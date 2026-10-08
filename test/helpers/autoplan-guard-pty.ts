/**
 * A hermetic live session for the /autoplan publication guard: a disposable
 * HOME whose ~/.claude/skills/gstack is this checkout, a clean Claude config
 * (default settings, no fork-subagent override), and one project skill that
 * carries /autoplan's own PreToolUse hook block and allowed tools. Its body is
 * a minimal scripted phase boundary: init, Phase 1 entry, a prepared close
 * packet, the report published with the `true autoplan-published` no-op, then the
 * Phase 2 entry in a later message and the Phase 2 reviewer. The restore point
 * and phase artifacts live in the project's `.gstack/tmp/autoplan/`, as /autoplan
 * Step 1 places them. Outcomes come from the guard decision log and the journals.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildSeedConfig } from './hermetic-env';

const ROOT = fs.realpathSync(path.join(import.meta.dir, '..', '..'));
export const GUARD_SKILL = 'autoplan-guard-transition';

/** The rendered hooks block from autoplan/SKILL.md's frontmatter, unchanged. */
export function autoplanHookFrontmatter(): string {
  const skill = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf8');
  const front = skill.slice(0, skill.indexOf('\n---', 4));
  const start = front.indexOf('\nhooks:\n');
  if (start < 0) throw new Error('autoplan/SKILL.md frontmatter has no hooks block');
  return front.slice(start + 1);
}

export interface GuardSession {
  base: string; home: string; config: string; project: string; stateRoot: string;
  env: Record<string, string>; log: string; prompt: string;
  readLog(): Array<Record<string, any>>;
  /** Content-bounded journal summary for a failure message: tool names, inputs' first keys, result heads. */
  journalSummary(): string[];
  /** Parent tool calls from the first background completion notice on, the notice count, and reviewers' successful Read paths. */
  noticeEvidence(): { notices: number; afterNotice: string[]; reviewerReads: string[] };
  cleanup(): void;
}

export function prepareGuardSession(apiKey: string | undefined): GuardSession {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-guard-pty-')));
  const home = path.join(base, 'home'), config = path.join(home, '.claude'), project = path.join(base, 'project');
  const stateRoot = path.join(base, 'state'), artifacts = path.join(project, '.gstack', 'tmp', 'autoplan');
  for (const dir of [config, project, stateRoot, artifacts, path.join(config, 'skills')]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(ROOT, path.join(config, 'skills', 'gstack'), 'dir');
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify(buildSeedConfig({ apiKey, trustedDirs: [project] })));

  const source = path.join(project, 'PLAN.md'), active = path.join(project, 'ACTIVE.md'), restore = path.join(artifacts, 'restore.md');
  fs.writeFileSync(source, '# Plan: greet\nAdd a greet command that prints "hello".\n');
  // Stands in for the CEO review the scripted boundary skips: methodology,
  // checkpoint, accepted block and close packet, made after the model's own init,
  // then the Phase 2 reviewer input, so no helper Bash runs after the first notice.
  const review = path.join(base, 'review.ts'), skills = path.join(base, 'review-skills');
  for (const name of ['plan-ceo-review', 'plan-design-review']) {
    fs.mkdirSync(path.join(skills, name), { recursive: true });
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\n---\n## Review Sections\nApply every current review criterion.\n`);
  }
  fs.writeFileSync(review, `import { appendFileSync, writeFileSync } from 'node:fs';
import { prepareMethodology, createSnapshot, preparePhaseClose } from ${JSON.stringify(path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts'))};
const [active, restore, skills, artifacts] = ${JSON.stringify([active, restore, skills, artifacts])};
const method = prepareMethodology('ceo', skills + '/plan-ceo-review/SKILL.md', restore).methodologyPath;
const snapshot = createSnapshot('ceo', active, restore, method), checkpoint = snapshot.snapshotPath;
writeFileSync(artifacts + '/dispatch-ceo.txt', snapshot.nativeDispatchPrompt);
appendFileSync(active, '<!-- autoplan-accepted:ceo -->\\nNone: retain the current behavior.\\n<!-- /autoplan-accepted:ceo -->\\n');
const close = preparePhaseClose('ceo', active, checkpoint, restore, method).closePacketPath;
const design = prepareMethodology('design', skills + '/plan-design-review/SKILL.md', restore).methodologyPath;
writeFileSync(artifacts + '/dispatch-design.txt', createSnapshot('design', active, restore, design).nativeDispatchPrompt);
console.log(close);
`);

  const tool = path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts');
  const sections = path.join(config, 'skills', 'gstack', 'autoplan', 'sections');
  const body = [
    'Run this scripted phase boundary exactly. Each numbered step is its own assistant message; do nothing else.',
    `1. Run this Bash command alone: bun "${tool}" init "${source}" "${active}" "${restore}"`,
    `2. Read the file ${path.join(sections, 'ceo-phase.md')} with offset 1 and limit 20.`,
    `3. Run this Bash command alone: bun "${review}"`,
    `4. Run this Bash command alone: cat "${path.join(artifacts, 'dispatch-ceo.txt')}"`,
    '5. Call the Agent tool once with these inputs: prompt = the exact, complete output of step 4 (every line, unchanged), ' +
      'description "CEO review", subagent_type "general-purpose", and run_in_background false. Include run_in_background even ' +
      'if the tool schema lacks it. If the agent runs in the background, end your turn and wait for its completion notification.',
    '6. Read the file whose path step 3 printed, completely (no offset or limit).',
    '7. In one message, write exactly this line as your own text: **Phase 1 complete.** and make exactly one tool call in that ' +
      'same message: the Bash command `true autoplan-published ceo`.',
    `8. In a later message, Read the file ${path.join(sections, 'design-phase.md')} with offset 1 and limit 20.`,
    `9. Run this Bash command alone: cat "${path.join(artifacts, 'dispatch-design.txt')}"`,
    '10. Call the Agent tool once with these inputs: prompt = the exact, complete output of step 9 (every line, unchanged), ' +
      'description "Design review", subagent_type "general-purpose". If the agent runs in the background, end your turn and wait ' +
      'for its completion notification.',
    '11. Reply with the single word DONE. If any tool call is denied, quote the denial text and stop.',
  ].join('\n');
  const skillDir = path.join(project, '.claude', 'skills', GUARD_SKILL);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${GUARD_SKILL}\ndescription: Scripted /autoplan phase boundary for the guard eval.\n` +
    `allowed-tools:\n  - Bash\n  - Read\n${autoplanHookFrontmatter()}\n---\n${body}\n`);

  const log = path.join(stateRoot, 'analytics', 'autoplan-guard.jsonl');
  return {
    base, home, config, project, stateRoot, log, prompt: `/${GUARD_SKILL}`,
    env: { HOME: home, CLAUDE_CONFIG_DIR: config, GSTACK_STATE_ROOT: stateRoot, GSTACK_HOME: stateRoot, DISABLE_AUTOUPDATER: '1' },
    journalSummary: () => {
      const projects = path.join(config, 'projects');
      if (!fs.existsSync(projects)) return ['(no journal)'];
      return fs.readdirSync(projects).flatMap(dir => fs.readdirSync(path.join(projects, dir)).filter(f => f.endsWith('.jsonl'))
        .flatMap(f => fs.readFileSync(path.join(projects, dir, f), 'utf8').split('\n').filter(Boolean).flatMap(line => {
          const r = JSON.parse(line);
          return (Array.isArray(r.message?.content) ? r.message.content : []).map((b: any) => b.type === 'tool_use'
            ? `use ${b.name} ${JSON.stringify(b.input).slice(0, 160)}`
            : b.type === 'tool_result' ? `result${b.is_error ? ' ERROR' : ''} ${JSON.stringify(b.content).slice(0, 240)}`
            : b.type === 'text' ? `text ${String(b.text).slice(0, 80)}` : b.type);
        })));
    },
    noticeEvidence: () => {
      const projects = path.join(config, 'projects'), sub = `${path.sep}subagents${path.sep}`;
      const files = fs.existsSync(projects) ? fs.readdirSync(projects, { recursive: true }).map(String)
        .filter(f => f.endsWith('.jsonl')).map(f => path.join(projects, f)) : [];
      const rows = (file: string): any[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const blocks = (rs: any[], type: string): any[] => rs.flatMap(r => Array.isArray(r.message?.content) ? r.message.content.filter((b: any) => b.type === type) : []);
      const parent = files.filter(f => !f.includes(sub)).flatMap(rows);
      const notice = parent.findIndex(r => r.origin?.kind === 'task-notification');
      const afterNotice = notice < 0 ? [] : blocks(parent.slice(notice), 'tool_use')
        .map(b => `${b.name} ${b.input?.file_path ?? b.input?.command ?? b.input?.description ?? ''}`);
      const reviewerReads = files.filter(f => f.includes(sub)).flatMap(f => {
        const rs = rows(f), ok = new Set(blocks(rs, 'tool_result').filter(b => !b.is_error).map(b => b.tool_use_id));
        return blocks(rs, 'tool_use').filter(b => b.name === 'Read' && ok.has(b.id)).map(b => String(b.input?.file_path));
      });
      return { notices: parent.filter(r => r.origin?.kind === 'task-notification').length, afterNotice, reviewerReads };
    },
    readLog: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
