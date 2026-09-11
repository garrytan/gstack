import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT=path.join(import.meta.dir,'..');
const read=(relative:string)=>fs.readFileSync(path.join(ROOT,relative),'utf8');

describe('/ship documentation synchronization ordering',()=>{
  test('documentation dispatch requires its own exact grant and excludes Git delivery', () => {
    for (const file of ['ship/SKILL.md.tmpl', 'ship/SKILL.md']) {
      const content = read(file);
      const docs = content.slice(content.indexOf('## Step 11.5:'), content.indexOf('## Step 12:'));
      expect(docs).toContain('separate current-task `document_release` grant');
      expect(docs).toContain('gstack-effect-scope document-release prepare');
      expect(docs).toContain('gstack-effect-scope document-release finish');
      expect(docs).toContain('`grant_id`');
      expect(docs).toContain('`preimage_sha256`');
      expect(docs).toContain('`content_sha256`');
      expect(docs).toContain('Only `status: "verified"` permits Step 12');
      expect(docs).toContain('ProcessLocalGrant alone cannot prevent cross-process replay');
      expect(docs).toContain('Missing or invalid authority means no helper');
      expect(docs).toContain('Do not stage, commit, push, post replies, or invoke a paid model');
      expect(docs).toContain('"commit_sha":null,"pushed":false');
      expect(docs).not.toContain('"pushed":true');
      expect(docs).not.toContain('including CHANGELOG clobber protection, doc\n> exclusions, risky-change gates, and named staging');
    }
  });

  test('the skeleton dispatches documentation before the release transaction',()=>{
    for(const file of ['ship/SKILL.md.tmpl','ship/SKILL.md']){
      const content=read(file);const docs=content.indexOf('## Step 11.5: Documentation sync');const release=content.indexOf('## Step 12: Resolve and apply the release decision');
      expect(docs).toBeGreaterThan(-1);expect(release).toBeGreaterThan(docs);
      expect(content).toContain('before the release');expect(content).toContain('transaction and final ship commit/push');
      expect(content).toContain('"documentation_section"');
      expect(content).toContain('"files_updated"');
      expect(content).toContain('"commit_sha"');
      expect(content).toContain('"pushed"');
      expect(content).toContain('You are executing the /document-release workflow');
      expect(content).toContain('.claude/skills/gstack/document-release/SKILL.md');
      expect(content).toContain('Warn, retain no section, and continue only after the workspace is stable');
      expect(content).toMatch(/never\s+dispatch a second documentation helper/);
    }
  });

  test('the carved PR section is mutation-free and only reuses the earlier result',()=>{
    for(const file of ['ship/sections/pr-body.md.tmpl','ship/sections/pr-body.md']){
      const content=read(file);expect(content).toContain('## Step 18: Documentation handoff');expect(content).toContain('already completed in Step 11.5');expect(content).not.toContain('Dispatch /document-release as a subagent');expect(content).not.toContain('subagent_type: "general-purpose"');
      const docHeading=content.indexOf('\n## Documentation\n');const testPlan=content.indexOf('\n## Test plan\n',docHeading);expect(docHeading).toBeGreaterThan(-1);expect(testPlan).toBeGreaterThan(docHeading);
    }
  });

  test('the section trigger and generated host projections describe reuse, not a late dispatch',()=>{
    const manifest=JSON.parse(read('ship/sections/manifest.json'));const prBody=manifest.sections.find((item:{id:string})=>item.id==='pr-body');expect(prBody.trigger).toContain('reusing the Step 11.5 documentation result');
    const factory=read('test/fixtures/golden/factory-ship-SKILL.md');expect(factory.indexOf('## Step 11.5: Documentation sync')).toBeLessThan(factory.indexOf('## Step 12: Resolve and apply the release decision'));expect(factory).toContain('## Step 18: Documentation handoff');
    const codex=read('test/fixtures/golden/codex-ship-SKILL.md');expect(codex).toContain('## Step 11.5: Documentation sync');expect(codex).toContain('gstack-section-delivery resolve --skill ship --stage pr-body --json');
  });
});
