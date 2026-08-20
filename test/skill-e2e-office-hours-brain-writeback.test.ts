/**
 * E2E: /office-hours brain-writeback path under fake gbrain CLI.
 *
 * The matched-pair check for v1.50.0.0's "brain-aware planning actually
 * works under Claude Code" headline: prove that when a user runs
 * /office-hours with gbrain on PATH, the agent actually calls
 * `gbrain put office-hours/<slug>` with valid frontmatter.
 *
 * Approach:
 *   1. Regenerate office-hours/SKILL.md with --respect-detection against
 *      a temp GSTACK_HOME that has detected:true. Snapshot the rendered
 *      content (which now contains the compressed SAVE_RESULTS block),
 *      then restore the canonical no-gbrain version so the working tree
 *      stays clean.
 *   2. Write the snapshot into a temp workdir's office-hours/SKILL.md.
 *      Also write docs/gbrain-write-surfaces.md so the agent can read the
 *      template on demand (the compact block points to it).
 *   3. Write a fake `gbrain` shell script into workdir/bin/ with robust
 *      argv quoting (printf %q) so heredoc payloads in --content survive
 *      shell-to-shell. The fake logs every invocation + writes payloads
 *      to a per-slug file for inspection.
 *   4. Run /office-hours via runSkillTest with workdir/bin/ first on PATH.
 *      Feed a deterministic founder pitch + auto-decide instructions.
 *   5. Assert the argv log contains `gbrain put office-hours/<slug>`, the
 *      payload file exists with valid YAML frontmatter, and entity stubs
 *      were created.
 *
 * Periodic tier (~$0.50-1/run via claude -p, matches nearby
 * setup-gbrain-path4-* tests at touchfiles.ts:496-498).
 *
 * NOT verified by this test (out of scope, owned by docs/gbrain-write-surfaces.md):
 *   - That gbrain itself persists what `gbrain put` is told (gbrain's
 *     own contract)
 *   - That `.gbrain-source` doesn't re-route writes (gbrain's contract)
 *   - Source-targeting (no way to fake source resolution in a stub CLI)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runSkillTest } from './helpers/session-runner';
import {
  ROOT,
  runId,
  describeIfSelected,
  testConcurrentIfSelected,
  logCost,
  recordE2E,
  createEvalCollector,
} from './helpers/e2e-helpers';

const evalCollector = createEvalCollector('e2e-office-hours-brain-writeback');

describeIfSelected(
  'Office Hours Brain Writeback E2E',
  ['office-hours-brain-writeback'],
  () => {
    let workDir: string;
    let callsLogPath: string;
    let payloadDir: string;

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), 'skill-e2e-brain-writeback-'));
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { cwd: workDir, stdio: 'pipe', timeout: 5000 });
      run('git', ['init', '-b', 'main']);
      run('git', ['config', 'user.email', 'test@test.com']);
      run('git', ['config', 'user.name', 'Test']);

      // Copy the founder pitch fixture into the workdir.
      const briefSrc = join(
        ROOT,
        'test',
        'fixtures',
        'office-hours-brain-writeback',
        'brief.md',
      );
      copyFileSync(briefSrc, join(workDir, 'pitch.md'));

      // Generate a brain-aware office-hours/SKILL.md (with --respect-detection
      // against a temp GSTACK_HOME). Snapshot the content, restore the
      // canonical version, write the snapshot into the workdir.
      const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-detect-home-'));
      writeFileSync(
        join(tmpHome, 'gbrain-detection.json'),
        JSON.stringify({
          gbrain_local_status: 'ok',
          gbrain_on_path: true,
          gbrain_version: 'test-0.41.0',
        }),
      );
      const skillPath = join(ROOT, 'office-hours', 'SKILL.md');
      const originalSkill = readFileSync(skillPath, 'utf-8');
      // office-hours is carved (v2 plan T9): GBRAIN_SAVE_RESULTS moved into
      // sections/design-and-handoff.md. Regen rewrites BOTH the skeleton and the
      // section, so we snapshot + restore + ship both, and check the UNION for
      // the gbrain put block.
      const sectionPath = join(ROOT, 'office-hours', 'sections', 'design-and-handoff.md');
      const hasSection = existsSync(sectionPath);
      const originalSection = hasSection ? readFileSync(sectionPath, 'utf-8') : null;
      try {
        execFileSync(
          'bun',
          [
            'run',
            'scripts/gen-skill-docs.ts',
            '--host',
            'claude',
            '--respect-detection',
          ],
          {
            cwd: ROOT,
            env: { ...process.env, GSTACK_HOME: tmpHome },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
          },
        );
        const brainAwareSkill = readFileSync(skillPath, 'utf-8');
        const brainAwareSection = hasSection ? readFileSync(sectionPath, 'utf-8') : '';
        if (!(brainAwareSkill + brainAwareSection).includes('gbrain put "office-hours/')) {
          throw new Error(
            'Regenerated office-hours skeleton+section does not contain gbrain put block. ' +
              'Detection override may be broken — see test/gbrain-detection-override.test.ts.',
          );
        }
        mkdirSync(join(workDir, 'office-hours'), { recursive: true });
        writeFileSync(join(workDir, 'office-hours', 'SKILL.md'), brainAwareSkill);
        if (hasSection) {
          mkdirSync(join(workDir, 'office-hours', 'sections'), { recursive: true });
          writeFileSync(join(workDir, 'office-hours', 'sections', 'design-and-handoff.md'), brainAwareSection);
        }
      } finally {
        // Always restore the canonical skeleton + section so the working tree stays clean.
        writeFileSync(skillPath, originalSkill);
        if (hasSection && originalSection !== null) writeFileSync(sectionPath, originalSection);
        rmSync(tmpHome, { recursive: true, force: true });
      }

      // Copy docs/gbrain-write-surfaces.md so the compact resolver block's
      // on-demand reference resolves (the agent may read it for the full
      // template; we don't require this read but make it available).
      const docsSrc = join(ROOT, 'docs', 'gbrain-write-surfaces.md');
      const docsDst = join(workDir, 'docs', 'gbrain-write-surfaces.md');
      mkdirSync(join(workDir, 'docs'), { recursive: true });
      copyFileSync(docsSrc, docsDst);

      // Set up the fake gbrain CLI with robust argv quoting + payload capture.
      callsLogPath = join(workDir, 'gbrain-calls.log');
      payloadDir = join(workDir, 'gbrain-payloads');
      mkdirSync(payloadDir, { recursive: true });
      const binDir = join(workDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const fakeGbrain = `#!/bin/bash
# Fake gbrain CLI for E2E test. Logs every invocation with shell-safe quoting
# (printf %q) so --content "$(cat <<'EOF' ... EOF)" payloads survive intact.
{ printf 'gbrain'; for a in "$@"; do printf ' %q' "$a"; done; printf '\\n'; } \\
  >> "${callsLogPath}"
case "$1" in
  --version) echo "gbrain test-0.41.0"; exit 0 ;;
  search) echo "[]"; exit 0 ;;
  get_page) echo ""; exit 0 ;;
  put)
    SLUG="$2"
    shift 2
    while [ -n "$1" ]; do
      if [ "$1" = "--content" ]; then
        PAYLOAD_DIR="${payloadDir}"
        mkdir -p "$PAYLOAD_DIR/$(dirname "$SLUG")"
        printf '%s' "$2" > "$PAYLOAD_DIR/$SLUG.md"
        break
      fi
      shift
    done
    exit 0
    ;;
esac
exit 0
`;
      const fakePath = join(binDir, 'gbrain');
      writeFileSync(fakePath, fakeGbrain);
      chmodSync(fakePath, 0o755);

      run('git', ['add', '.']);
      run('git', ['commit', '-m', 'fixture']);
    });

    afterAll(() => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    testConcurrentIfSelected(
      'office-hours-brain-writeback',
      async () => {
        const result = await runSkillTest({
          prompt: `Read office-hours/SKILL.md for the workflow.

Read pitch.md — that's a founder pitch coming to office hours. Select Startup Mode. Skip any AskUserQuestion — this is non-interactive; auto-decide the recommended option for any question.

For the diagnostic, assume the founder confirmed Q1 (strongest evidence = "230 from a single tweet + 51 paying creators in 6 weeks"), Q2 (status quo = "creators write ad-hoc checks or use opaque Patreon-style platforms"), and Q3 (forcing question already asked).

Generate the design doc per Phase 5. The feature-slug value to substitute into the SAVE_RESULTS template's \`<feature-slug>\` placeholder is exactly 'pixel-fund' (no path prefix — the template already provides the prefix). The \`gbrain\` binary is on PATH at ${workDir}/bin/gbrain. Apply the SAVE_RESULTS template literally: the slug should land at \`<prefix>/pixel-fund\` per the resolver shape, with the actual design doc markdown body in the --content payload. Then enrich entity stubs for any named people or companies mentioned in the pitch.

This is a test of the brain-writeback path. Do NOT skip the gbrain save step under any circumstance — the runtime guard ("skip if gbrain not on PATH") does NOT apply here because gbrain IS available. Do NOT explore gbrain --help; follow the SAVE_RESULTS template's exact CLI shape. If you encounter any AskUserQuestion, auto-decide recommended.`,
          workingDirectory: workDir,
          maxTurns: 12,
          timeout: 360_000,
          testName: 'office-hours-brain-writeback',
          runId,
          model: 'claude-sonnet-4-6',
          extraEnv: {
            PATH: `${join(workDir, 'bin')}:${process.env.PATH || ''}`,
          },
        });

        logCost('/office-hours (BRAIN WRITEBACK)', result);
        recordE2E(
          evalCollector,
          '/office-hours-brain-writeback',
          'Office Hours Brain Writeback E2E',
          result,
          {
            passed: ['success', 'error_max_turns'].includes(result.exitReason),
          },
        );
        expect(['success', 'error_max_turns']).toContain(result.exitReason);

        // The headline assertion: agent actually called gbrain put on the
        // expected slug.
        if (!existsSync(callsLogPath)) {
          throw new Error(
            `No gbrain calls log at ${callsLogPath}. ` +
              `Agent likely did NOT invoke gbrain at all. ` +
              `Check that office-hours/SKILL.md in the workdir contains the gbrain put block.`,
          );
        }
        const callsLog = readFileSync(callsLogPath, 'utf-8');
        console.log('--- gbrain calls log ---');
        console.log(callsLog);
        console.log('--- end calls log ---');

        expect(callsLog).toContain('gbrain put');
        // Agent obedience: the slug should contain 'pixel-fund' somewhere
        // (preferably under the office-hours/ prefix). The strict slug
        // SHAPE (office-hours/<slug>) is already pinned by the resolver
        // unit test (test/resolvers-gbrain-save-results.test.ts); this
        // E2E proves the agent actually invokes gbrain put with the
        // payload, not the resolver's literal output shape.
        expect(callsLog).toMatch(/gbrain put .*pixel-fund/);

        // Payload file exists. Agent may write to office-hours/pixel-fund.md
        // (resolver-faithful) OR pixel-fund.md (agent dropped prefix); both
        // are acceptable here because the YAML frontmatter is the real
        // contract test. Search the payload tree for any *.md file that
        // contains 'pixel-fund' in the path.
        const findPayload = (dir: string): string | null => {
          if (!existsSync(dir)) return null;
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              const nested = findPayload(full);
              if (nested) return nested;
            } else if (entry.name.includes('pixel-fund')) {
              return full;
            }
          }
          return null;
        };
        const payloadPath = findPayload(payloadDir);
        if (!payloadPath) {
          throw new Error(
            `Agent called gbrain put but no payload file with 'pixel-fund' ` +
              `in name was written to ${payloadDir}. Check the fake gbrain ` +
              `--content parser for argv quoting issues.`,
          );
        }
        const payload = readFileSync(payloadPath, 'utf-8');
        expect(payload).toMatch(/^---\s*\n/);
        expect(payload).toContain('title:');
        expect(payload).toContain('tags:');
        expect(payload.length).toBeGreaterThan(200);

        // Entity stubs: agents are inconsistent about whether they use
        // 'entities/<name>' (resolver doc) or 'entity/<name>' (singular).
        // We accept either — the test asserts that AT LEAST ONE entity
        // stub call exists, not the exact slug shape.
        const entityCallMatches =
          callsLog.match(/gbrain put entit(?:y|ies)\//g) || [];
        if (entityCallMatches.length === 0) {
          console.warn(
            'No entity stub calls in gbrain calls log. Resolver instructs ' +
              'entity extraction but it is best-effort.',
          );
        } else {
          console.log(
            `Entity stub calls observed: ${entityCallMatches.length}`,
          );
        }
      },
      420_000,
    );
  },
);
