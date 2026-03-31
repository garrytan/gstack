import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, runId, describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E, createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-review-army');

// Helper: create a git repo with a feature branch
function setupRepo(prefix: string): { dir: string; run: (cmd: string, args: string[]) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${prefix}-`));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  return { dir, run };
}

// Helper: copy review skill files to test dir
function copyReviewFiles(dir: string) {
  fs.copyFileSync(path.join(ROOT, 'review', 'SKILL.md'), path.join(dir, 'review-SKILL.md'));
  fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(dir, 'review-checklist.md'));
  fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(dir, 'review-greptile-triage.md'));
  // Copy specialist checklists
  const specDir = path.join(dir, 'review-specialists');
  fs.mkdirSync(specDir, { recursive: true });
  const specialistsRoot = path.join(ROOT, 'review', 'specialists');
  for (const f of fs.readdirSync(specialistsRoot)) {
    fs.copyFileSync(path.join(specialistsRoot, f), path.join(specDir, f));
  }
}

// --- Review Army: Migration Safety ---

describeIfSelected('Review Army: Migration Safety', ['review-army-migration-safety'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-migration');
    dir = repo.dir;

    // Base commit
    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    // Feature branch with unsafe migration
    repo.run('git', ['checkout', '-b', 'feature/drop-columns']);
    fs.mkdirSync(path.join(dir, 'db', 'migrate'), { recursive: true });
    const migrationContent = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'review-army-migration.sql'), 'utf-8'
    );
    fs.writeFileSync(path.join(dir, 'db', 'migrate', '20260330_drop_columns.sql'), migrationContent);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'drop email and phone columns']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-migration-safety', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with a database migration that drops columns.
Read review-SKILL.md for instructions. Also read review-checklist.md.
The specialist checklists are in review-specialists/ (testing.md, security.md, performance.md, data-migration.md, etc.).

Skip the preamble, lake intro, telemetry sections.
Run Step 4 (Critical pass) then Step 4.5 (Review Army — Specialist Dispatch).
The base branch is main. Run gstack-diff-scope style analysis on the changed files.
Since db/migrate/ files changed, the Data Migration specialist should activate.

For the specialist dispatch, instead of launching subagents, just read review-specialists/data-migration.md
and apply it yourself against the diff (git diff main...HEAD).

Write your findings to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-army-migration-safety',
      runId,
    });

    logCost('/review army migration', result);
    recordE2E(evalCollector, '/review army migration safety', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    // Verify migration issues were caught
    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      const hasMigrationFinding =
        content.includes('drop') ||
        content.includes('data loss') ||
        content.includes('reversib') ||
        content.includes('migration') ||
        content.includes('column');
      expect(hasMigrationFinding).toBe(true);
    }
  }, 210_000);
});

// --- Review Army: N+1 Performance ---

describeIfSelected('Review Army: N+1 Performance', ['review-army-perf-n-plus-one'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-n-plus-one');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/add-posts-index']);
    const n1Content = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'review-army-n-plus-one.rb'), 'utf-8'
    );
    fs.writeFileSync(path.join(dir, 'posts_controller.rb'), n1Content);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add posts controller']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-perf-n-plus-one', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with a Ruby controller that has N+1 queries.
Read review-SKILL.md for instructions. Also read review-checklist.md.
The specialist checklists are in review-specialists/ (testing.md, performance.md, etc.).

Skip the preamble, lake intro, telemetry sections.
Run Step 4 (Critical pass) then Step 4.5 (Review Army).
The base branch is main. This is a Ruby backend file, so Performance specialist should activate.

For the specialist dispatch, read review-specialists/performance.md and apply it against the diff.

Write your findings to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-army-perf-n-plus-one',
      runId,
    });

    logCost('/review army n+1', result);
    recordE2E(evalCollector, '/review army N+1 detection', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      const hasN1Finding =
        content.includes('n+1') ||
        content.includes('n + 1') ||
        content.includes('eager') ||
        content.includes('includes') ||
        content.includes('preload') ||
        content.includes('query') ||
        content.includes('loop');
      expect(hasN1Finding).toBe(true);
    }
  }, 210_000);
});

// --- Review Army: Delivery Audit ---

describeIfSelected('Review Army: Delivery Audit', ['review-army-delivery-audit'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-delivery');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/three-features']);

    // Write a plan file promising 3 features
    fs.writeFileSync(path.join(dir, 'PLAN.md'), `# Feature Plan

## Implementation Items
1. Add user authentication with login/logout
2. Add user profile page with avatar upload
3. Add email notification system for new signups

## Test Items
- Test login flow
- Test profile page rendering
- Test email sending
`);
    repo.run('git', ['add', 'PLAN.md']);
    repo.run('git', ['commit', '-m', 'add plan']);

    // Implement only 2 of 3 features
    fs.writeFileSync(path.join(dir, 'auth.rb'), `class AuthController
  def login
    # authenticate user
    session[:user_id] = user.id
  end

  def logout
    session.delete(:user_id)
  end
end
`);
    fs.writeFileSync(path.join(dir, 'profile.rb'), `class ProfileController
  def show
    @user = User.find(params[:id])
  end

  def update_avatar
    @user.avatar.attach(params[:avatar])
  end
end
`);
    // NOTE: email notification system is NOT implemented (intentionally missing)
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'implement auth and profile features']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-delivery-audit', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on branch feature/three-features.
There is a PLAN.md file that promises 3 features: auth, profile, and email notifications.
The diff (git diff main...HEAD) only implements 2 of them (auth and profile).

Read review-SKILL.md for the review workflow. Focus on the Plan Completion Audit section.
The plan file is at ./PLAN.md. Cross-reference it against the diff.

For each plan item, classify as DONE, PARTIAL, NOT DONE, or CHANGED.
The email notification system should be classified as NOT DONE.

Write your completion audit to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 15,
      timeout: 120_000,
      testName: 'review-army-delivery-audit',
      runId,
    });

    logCost('/review army delivery', result);
    recordE2E(evalCollector, '/review army delivery audit', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      // Should identify email notifications as NOT DONE
      const hasNotDone =
        content.includes('not done') ||
        content.includes('not_done') ||
        content.includes('missing') ||
        content.includes('not implemented');
      const mentionsEmail =
        content.includes('email') ||
        content.includes('notification');
      expect(hasNotDone).toBe(true);
      expect(mentionsEmail).toBe(true);
    }
  }, 150_000);
});

// --- Review Army: Quality Score ---

describeIfSelected('Review Army: Quality Score', ['review-army-quality-score'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-quality');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/add-controller']);
    // Code with obvious issues for quality score computation
    fs.writeFileSync(path.join(dir, 'user_controller.rb'), `class UserController
  def create
    # SQL injection
    User.where("name = '#{params[:name]}'")
    # Magic number
    if users.count > 42
      raise "too many"
    end
  end
end
`);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add user controller']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-quality-score', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo with a vulnerable user controller.
Read review-SKILL.md and review-checklist.md.
Skip preamble, lake intro, telemetry.

Run the Critical pass (Step 4) against the diff (git diff main...HEAD).
Then compute the PR Quality Score as described in the Review Army merge step:
quality_score = max(0, 10 - (critical_count * 2 + informational_count * 0.5))

Write your findings AND the computed quality score to ${dir}/review-output.md
Include the line: "PR Quality Score: X/10" where X is the computed score.`,
      workingDirectory: dir,
      maxTurns: 15,
      timeout: 120_000,
      testName: 'review-army-quality-score',
      runId,
    });

    logCost('/review army quality', result);
    recordE2E(evalCollector, '/review army quality score', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      // Should contain a quality score
      const hasScore =
        content.toLowerCase().includes('quality score') ||
        content.match(/\d+\/10/);
      expect(hasScore).toBeTruthy();
    }
  }, 150_000);
});

// --- Review Army: JSON Findings ---

describeIfSelected('Review Army: JSON Findings', ['review-army-json-findings'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-json');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/vuln']);
    fs.writeFileSync(path.join(dir, 'search.rb'), `class SearchController
  def index
    # SQL injection via string interpolation
    results = ActiveRecord::Base.connection.execute(
      "SELECT * FROM products WHERE name LIKE '%#{params[:q]}%'"
    )
    render json: results
  end
end
`);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add search']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-json-findings', async () => {
    const result = await runSkillTest({
      prompt: `You are reviewing a git diff with a SQL injection vulnerability.
Read review-specialists/security.md for the security checklist.

Apply the checklist against this diff (git diff main...HEAD).
Output your findings as JSON objects, one per line, following the schema:
{"severity":"CRITICAL","confidence":9,"path":"search.rb","line":4,"category":"injection","summary":"SQL injection via string interpolation","fix":"Use parameterized query","fingerprint":"search.rb:4:injection","specialist":"security"}

Write ONLY JSON findings (no preamble) to ${dir}/findings.json`,
      workingDirectory: dir,
      maxTurns: 12,
      timeout: 90_000,
      testName: 'review-army-json-findings',
      runId,
    });

    logCost('/review army json', result);
    recordE2E(evalCollector, '/review army JSON findings', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const findingsPath = path.join(dir, 'findings.json');
    if (fs.existsSync(findingsPath)) {
      const content = fs.readFileSync(findingsPath, 'utf-8').trim();
      const lines = content.split('\n').filter(l => l.trim());
      // At least one finding
      expect(lines.length).toBeGreaterThanOrEqual(1);
      // Each line should be valid JSON with required fields
      for (const line of lines) {
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        // Required fields per schema
        expect(parsed).toHaveProperty('severity');
        expect(parsed).toHaveProperty('confidence');
        expect(parsed).toHaveProperty('path');
        expect(parsed).toHaveProperty('category');
        expect(parsed).toHaveProperty('summary');
        expect(parsed).toHaveProperty('specialist');
        break; // One valid line is enough for the gate test
      }
    }
  }, 120_000);
});

// --- Review Army: Red Team (periodic) ---

describeIfSelected('Review Army: Red Team', ['review-army-red-team'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-redteam');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/large-change']);
    // Create a large diff (300+ lines)
    const lines: string[] = ['class LargeController'];
    for (let i = 0; i < 100; i++) {
      lines.push(`  def method_${i}`);
      lines.push(`    data = params[:input_${i}]`);
      lines.push(`    process(data)`);
      lines.push('  end');
      lines.push('');
    }
    lines.push('end');
    fs.writeFileSync(path.join(dir, 'large_controller.rb'), lines.join('\n'));
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add large controller']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-red-team', async () => {
    const result = await runSkillTest({
      prompt: `You are reviewing a large diff (300+ lines). Read review-SKILL.md.
Skip preamble, lake intro, telemetry.

The diff is large enough to activate the Red Team specialist.
Read review-specialists/red-team.md and apply it against the diff (git diff main...HEAD).
Focus on finding issues that other specialists might miss.

Write your red team findings to ${dir}/review-output.md
Start the file with "RED TEAM REVIEW" on the first line.`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-army-red-team',
      runId,
    });

    logCost('/review army red-team', result);
    recordE2E(evalCollector, '/review army red team', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      expect(content.toLowerCase()).toMatch(/red team|adversarial/);
    }
  }, 210_000);
});

// --- Review Army: Consensus (periodic) ---

describeIfSelected('Review Army: Consensus', ['review-army-consensus'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-consensus');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/vuln-auth']);
    // SQL injection that both security AND testing specialists should flag
    fs.writeFileSync(path.join(dir, 'auth_controller.rb'), `class AuthController
  def login
    user = User.find_by("email = '#{params[:email]}' AND password = '#{params[:password]}'")
    if user
      session[:user_id] = user.id
      redirect_to root_path
    else
      flash[:error] = "Invalid credentials"
      render :login
    end
  end
end
`);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add auth controller']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-consensus', async () => {
    const result = await runSkillTest({
      prompt: `You are reviewing a git diff with a SQL injection in an auth controller.
Read review-SKILL.md, review-checklist.md, and the specialist checklists in review-specialists/.

This vulnerability should be caught by BOTH the security specialist (injection vector)
AND the testing specialist (no test for auth bypass).

Run the review. In your output, if a finding is flagged by multiple perspectives,
mark it as "MULTI-SPECIALIST CONFIRMED" with the confirming categories.

Write findings to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-army-consensus',
      runId,
    });

    logCost('/review army consensus', result);
    recordE2E(evalCollector, '/review army consensus', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      // Should catch the SQL injection
      const hasSqlFinding =
        content.includes('sql') ||
        content.includes('injection') ||
        content.includes('interpolat');
      expect(hasSqlFinding).toBe(true);
    }
  }, 210_000);
});

// Finalize eval collector
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
