/** Extract the installed review workflow, handling carved and inline host renders. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSkillSections } from './skill-fixture';

export function installOutsideReviewFixture(rendered: string, host: 'claude' | 'codex', repo: string, runtimeRoot: string): string {
  const source = host === 'claude' ? join(rendered, 'review') : join(rendered, '.agents', 'skills', 'gstack-review');
  const name = host === 'claude' ? 'review' : 'gstack-review';
  const destination = join(repo, host === 'claude' ? '.claude' : '.agents', 'skills', name);
  mkdirSync(destination, { recursive: true });
  const head = extractSkillSections(source, ['Step 0: Detect platform and base branch', 'Step 3: Get the diff']);
  const sectionPath = join(source, 'sections', 'adversarial.md');
  const section = existsSync(sectionPath) ? readFileSync(sectionPath, 'utf8')
    : extractSkillSections(source, ['Step 5.7: Adversarial review (always-on)']).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  if (!section.includes('Adversarial review (always-on)')) throw new Error(`Missing adversarial workflow: ${source}`);
  // Runtime paths are the only fixture substitution. Provider selection,
  // caller controls, prompt, probes, and execution code stay generated verbatim.
  const content = (head + '\n' + section)
    .replaceAll('~/.claude/skills/gstack', runtimeRoot)
    .replaceAll('$HOME/.claude/skills/gstack', runtimeRoot)
    .replaceAll('${GSTACK_BIN}', join(runtimeRoot, 'bin'))
    .replaceAll('$GSTACK_BIN', join(runtimeRoot, 'bin'))
    .replaceAll('$GSTACK_ROOT', runtimeRoot);
  writeFileSync(join(destination, 'SKILL.md'), content);
  return destination;
}

// Each paid invocation must begin at the same committed authorization defect.
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
}

export function createOutsideReviewRepo(fixtureRoot: string, host: 'claude' | 'codex'): string {
  // Bun retries reuse beforeAll state; each attempt needs a new git repository.
  const dir = fs.mkdtempSync(path.join(fixtureRoot, `${host}-`));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'eval@example.com');
  git(dir, 'config', 'user.name', 'Outside Voice Eval');
  const safe = `export async function readPrivateInvoice(db, actor, invoiceId) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return null;
  if (invoice.ownerId !== actor.id) throw new Error('Forbidden');
  return { amount: invoice.amount, bankAccount: invoice.bankAccount };
}
`;
  fs.writeFileSync(path.join(dir, 'invoice.ts'), safe);
  git(dir, 'add', 'invoice.ts');
  git(dir, 'commit', '-m', 'Protect private invoices by owner');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-b', 'feature/invoice-lookup');
  fs.writeFileSync(path.join(dir, 'invoice.ts'), safe.replace("  if (invoice.ownerId !== actor.id) throw new Error('Forbidden');\n", ''));
  git(dir, 'add', 'invoice.ts');
  git(dir, 'commit', '-m', 'Simplify invoice lookup');
  return dir;
}
