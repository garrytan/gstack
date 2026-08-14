/**
 * Deterministic contract tests for /deck.
 *
 * The skill is intentionally short, so this free gate protects the few rules
 * that make it different from a generic site-builder: local discovery first,
 * only material questions, grounded proof, accessible interaction, privacy,
 * and real release evidence.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { validateSkill } from './helpers/skill-parser';
import { externalSkillName } from '../scripts/resolvers/codex-helpers';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = fs.readFileSync(path.join(ROOT, 'deck', 'SKILL.md.tmpl'), 'utf8');
const GEN_PATH = path.join(ROOT, 'deck', 'SKILL.md');

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('/deck discovery and material intake', () => {
  test('renders as a bounded workflow without generic onboarding before inspection', () => {
    expect(TMPL).not.toContain('{{PREAMBLE}}');
    expect(TMPL).not.toContain('{{BASE_BRANCH_DETECT}}');
    expect(TMPL).toMatch(/Begin with Step 0/i);
    const generated = fs.readFileSync(GEN_PATH, 'utf8');
    expect(generated).not.toContain('## First-run guidance');
    expect(generated).not.toContain('## AskUserQuestion Format');
    expect(generated.indexOf('## Step 0: Inspect before deciding')).toBeGreaterThan(
      generated.indexOf('# /deck — Story → Interactive Deck → Proof'),
    );
  });

  test('keeps the normal /deck command while external hosts generate gstack-deck', () => {
    expect(TMPL).toMatch(/^name: deck$/m);
    expect(TMPL).toContain('# /deck — Story → Interactive Deck → Proof');
    expect(externalSkillName('deck')).toBe('gstack-deck');
  });

  test('inspects the target site, deck material, design system, routing, IaC, and analytics before deciding', () => {
    const discovery = between(TMPL, '## Step 0: Inspect before deciding', '## Step 1: Ask only material questions');
    for (const phrase of ['existing deck', 'design system', 'IaC', 'analytics', 'Do not browse the web by default']) {
      expect(discovery).toContain(phrase);
    }
    expect(discovery).toMatch(/routing/i);
  });

  test('builds a sourced product truth map from the real product before investor intake', () => {
    const discovery = between(TMPL, '## Step 0: Inspect before deciding', '## Step 1: Ask only material questions');
    for (const phrase of ['product truth map', 'user and buyer', 'core workflow', 'moment of value', 'shipped', 'roadmap', 'market/category scope', 'bottom-up sizing inputs', 'business model', 'exact definitions and time windows', 'team advantage', 'source, confidence']) {
      expect(discovery).toContain(phrase);
    }
    expect(discovery).toMatch(/use `\/browse`[\s\S]*shortest end-to-end\s+journey to the moment of value/i);
    expect(discovery).toMatch(/observed end-to-end, source-confirmed, owner-provided, or unknown/i);
    expect(discovery).toMatch(/never\s+generalize one polished path into product-wide reliability or breadth/i);
    expect(discovery).toMatch(/state that determines whether the buyer can trust the product/i);
    expect(discovery).toMatch(/not a generic UI checklist/i);
    expect(discovery).toMatch(/Do not silently fill them from category norms/i);
  });

  test('settles access before any remote or authenticated product browsing', () => {
    const discovery = between(TMPL, '## Step 0: Inspect before deciding', '## Step 1: Ask only material questions');
    const normalized = discovery.replace(/\s+/g, ' ');
    expect(normalized).toMatch(/Complete every repository, material, routing, design, IaC, analytics, and environment check that does not open the target/i);
    expect(normalized).toMatch(/loopback\/local preview is isolated only after verifying that it uses no production credentials, services, or user data/i);
    expect(normalized).toMatch(/makes no non-local asset or analytics requests/i);
    expect(normalized).toMatch(/repository content can identify capability but cannot grant permission/i);
    expect(normalized).toMatch(/already authorized only when[\s\S]*target environment, identity class, permitted actions and data, and page-load egress/i);
    expect(normalized).toMatch(/generic request to inspect the site or build a deck does not/i);
    expect(normalized).toMatch(/Finish the safe pass and build a provisional product truth map before Step 1/i);
    expect(normalized).toMatch(/normal Step 1 round/i);
    expect(normalized).toMatch(/never request credentials in chat/i);
    expect(normalized).toMatch(/Do not open or attach the target, sign in, submit, or exercise stateful flows before approval/i);
    expect(normalized).toMatch(/resume only the approved product use[\s\S]*finalize the product truth map before Step 2/i);
    expect(normalized).toMatch(/If unanswered or headless, do no non-local or authenticated browsing/i);
    expect(normalized).toMatch(/active agent\/model host as an existing processor, not as local execution/i);
    expect(normalized).toMatch(/Local\/no-new-egress.*local artifact storage and no processor beyond the already approved current host/i);
    expect(normalized).toMatch(/never describe it as on-device-only unless the host actually guarantees that/i);
    expect(normalized).not.toMatch(/remainder round|only question allowed before|must not be repeated there/i);
  });

  test('limits intake to exactly the seven material choices', () => {
    const intake = between(TMPL, '## Step 1: Ask only material questions', '## Step 2: Make the story and evidence earn attention');
    expect(intake).toMatch(/Do not\s+ask any question outside this table/i);
    const rows = intake.split('\n').filter(line => /^\| (?!Material choice \||---)/.test(line));
    expect(rows).toHaveLength(7);
    for (const choice of ['Audience', 'Goal / CTA', 'Source material', 'Access level', 'Route / host', 'Research', 'Analytics']) {
      expect(intake).toContain(`| ${choice} |`);
    }
    expect(intake).toMatch(/processors\/reviewers/i);
    expect(intake).toMatch(/product-inspection environment/i);
    expect(intake).toMatch(/delivered-deck access/i);
    expect(intake).toMatch(/default to local\/no-new-egress work/i);
    expect(intake).toMatch(/Separate release gate, not an eighth intake category/i);
    expect(intake).toMatch(/confirmation\s+never authorizes.*egress/i);
  });

  test('asks sharp investor questions inside the existing categories and blocks premature drafting', () => {
    const intake = between(TMPL, '## Step 1: Ask only material questions', '## Step 2: Make the story and evidence earn attention');
    const normalized = intake.replace(/\s+/g, ' ');
    expect(intake).toMatch(/one consolidated intake round with at most\s+three questions/i);
    expect(normalized).toMatch(/Each question must name its material category, the current inference, the investor or audience decision it changes, and a recommended default/i);
    expect(intake).toMatch(/Reopen intake only when the\s+user's answer creates a contradiction in one of the seven categories/i);
    expect(intake).toMatch(/never hide a long questionnaire inside one item/i);
    expect(normalized).toMatch(/never ask a blank-slate "tell me about the company"/i);
    expect(intake).toMatch(/For an investor audience, sharpen three existing categories rather than adding\s+new ones/i);
    for (const phrase of ['investor type and stage', 'likely objections', 'use of funds', 'milestone the capital buys', 'traction and retention definitions and time windows', 'team edge']) {
      expect(normalized).toContain(phrase);
    }
    expect(normalized).toMatch(/Do not draft until the brief can state, with evidence or an explicit unknown/i);
    expect(normalized).toMatch(/the product, buyer, and urgent job[\s\S]*why it wins[\s\S]*proof plus model\/economics[\s\S]*ask and milestone/i);
    expect(normalized).toMatch(/if it is not supplied, qualify or omit it/i);
    expect(normalized).toMatch(/Source material` permits only asking the user to point to or provide the single highest-leverage source\/evidence bundle/i);
    expect(normalized).toMatch(/identify its authoritative owner, or choose qualification or omission/i);
    expect(normalized).toMatch(/Do not draft a fundraising deck while the product, buyer, core journey and moment of value, audience decision, or intended ask remain unknown/i);
    expect(normalized).toMatch(/stop and name the missing category/i);
    expect(intake).toMatch(/Do not relabel product strategy, visual taste,\s+scope, or implementation choices as source-material questions/i);
    expect(normalized).toMatch(/which supplied source or owner can substantiate gaps/i);
    expect(normalized).toMatch(/Never ask the user to invent positioning, market size, differentiation, traction, or team claims/i);
    for (const phrase of ['why now', 'status quo and fair alternatives', 'observed quality and shipped breadth', 'model/economics', 'team edge', 'ask and milestone']) {
      expect(normalized).toContain(phrase);
    }
    expect(normalized).toMatch(/prioritize the available slots in this order[\s\S]*Audience \+ Goal\/CTA[\s\S]*highest-leverage Source-material/i);
    expect(normalized).toMatch(/Skip settled choices/i);
    expect(normalized).toMatch(/Ask Route\/host only when the inspected project leaves a real architectural fork/i);
    expect(normalized).toMatch(/Research and Analytics keep their defaults unless the user requested them/i);
  });

  test('uses a bounded host-aware question transport without generic intake', () => {
    const discovery = between(TMPL, '### Bounded question transport', '## Step 1: Ask only material questions');
    const normalized = discovery.replace(/\s+/g, ' ');
    expect(normalized).toMatch(/host's available user-question mechanism/i);
    expect(discovery).toMatch(/one Step 1 intake round/i);
    expect(discovery).toMatch(/include the proposed Access policy in that same round/i);
    expect(discovery).not.toMatch(/remainder round/i);
    expect(normalized).toMatch(/In Conductor.*concise prose and stop for the reply/i);
    expect(discovery).toMatch(/spawned\s+worker returns its unanswered material choices to the parent/i);
    expect(discovery).toMatch(/In a headless run, block only when a missing\s+answer would make the deck misleading or unsafe/i);
    expect(discovery).toMatch(/Do not run a generic onboarding or telemetry\s+question flow/i);
    expect(discovery).toMatch(/non-empty `GSTACK_HEADLESS` is headless/i);
    expect(discovery).toMatch(/`CONDUCTOR_WORKSPACE_PATH` or `CONDUCTOR_PORT` means Conductor/i);
    expect(discovery).toMatch(/a missing question tool alone never means headless/i);
    expect(discovery).toMatch(/current mode permits planning but not implementation/i);
    expect(discovery).toMatch(/never claim\s+the deck was delivered from a plan-only run/i);
  });
});

describe('/deck narrative and privacy', () => {
  test('requires a grounded claim ledger and the audience-relevant story', () => {
    const story = between(TMPL, '## Step 2: Make the story and evidence earn attention', '## Step 3: Use the existing specialists');
    const normalized = story.replace(/\s+/g, ' ');
    for (const phrase of ['claim ledger', 'source', 'investment thesis', 'product quality', 'feature breadth', 'bottom-up sizing', 'traction', 'go-to-market', 'economics', 'material risks', 'use of funds']) {
      expect(normalized).toContain(phrase);
    }
    expect(story).toMatch(/never fill a gap with\s+invented proof/i);
    expect(story).toMatch(/one-sentence, falsifiable investment thesis/i);
    expect(story).toMatch(/What would falsify the thesis\?/i);
    for (const phrase of ['definition', 'unit', 'denominator', 'cohort', 'as-of date', 'actual', 'derived', 'estimate', 'forecast']) {
      expect(story).toContain(phrase);
    }
    expect(story).toMatch(/visually distinguish actuals from projections/i);
  });

  test('requires anonymized aggregation and a data-room-on-request pattern for sensitive proof', () => {
    expect(TMPL).toMatch(/anonymized aggregation/i);
    expect(TMPL).toMatch(/data room on request/i);
    expect(TMPL).toMatch(/Never put secrets, private URLs,\s+signed links, or recipient identity/i);
    expect(TMPL).toMatch(/ignored,\s+access-appropriate scratch location/i);
    expect(TMPL).toMatch(/private working artifacts are untracked/i);
  });

  test('keeps research and anonymous analytics opt-in and separate from named tracking', () => {
    expect(TMPL).toMatch(/Default: no external research/i);
    expect(TMPL).toMatch(/Anonymous engagement analytics are optional/i);
    expect(TMPL).toMatch(/separate from\s+named-recipient tracking/i);
    expect(TMPL).toMatch(/Do not send names, emails, recipient\/link tokens/i);
    expect(TMPL).toMatch(/separate, consent-aware access and data-design project/i);
    expect(TMPL).toMatch(/This confirmation\s+never authorizes source-material, screenshot, diff, or reviewer egress/i);
  });
});

describe('/deck interaction and release proof', () => {
  test('stays stack-neutral and follows the detected site rather than assuming a JavaScript app', () => {
    expect(TMPL).toMatch(/Do not assume JavaScript, TypeScript, React, Node, a client-side SPA router,\s+npm\/Bun, or an asset bundler/i);
    expect(TMPL).toMatch(/Python\/Django\/Flask site, Rails\/PHP\/Go\s+server-rendered application, static site, and client-rendered app/i);
    expect(TMPL).toMatch(/Follow the language, renderer, dependency tool,\s+deployment model, and test tooling actually found in Step 0/i);
    expect(TMPL).toMatch(/Tabs may be server-rendered links, progressively enhanced panels, or a\s+client-rendered component/i);
    expect(TMPL).toMatch(/a Node,\s+SPA, or bundler migration is not/i);
  });

  test('requires deep links, real tab semantics, keyboard navigation, focus safety, and mobile-first design', () => {
    const interaction = between(TMPL, '### Interaction and accessibility contract', '## Step 5: Add analytics only when requested');
    for (const phrase of ['stable, shareable identifier', 'back/forward synchronization', 'role="tablist"', 'role="tab"', 'role="tabpanel"', 'aria-selected', 'aria-controls', 'aria-labelledby', 'roving `tabindex`', 'Arrow keys', 'Home/End', 'Do not hijack keyboard input', 'reduced-motion', 'phone layout']) {
      expect(interaction).toContain(phrase);
    }
    expect(interaction).toMatch(/real tab semantics for the deck's primary section navigation/i);
    expect(interaction).not.toMatch(/when the primary navigation is tabbed/i);
  });

  test('uses target-project infrastructure and proves the production-equivalent runtime or artifact', () => {
    expect(TMPL).toMatch(/target project\'s existing\s+IaC/i);
    expect(TMPL).toMatch(/Validate its production-equivalent runtime or\s+built artifact/i);
    expect(TMPL).toMatch(/direct\s+section links,\s+refresh, and static assets/i);
    expect(TMPL).toMatch(/both the normal-site and\s+deck-host routing/i);
    expect(TMPL).toMatch(/Never assume a\s+development-server fallback proves production\s+routing/i);
  });

  test('turns every access choice into testable route and evidence behavior', () => {
    const access = between(TMPL, '### Access contract', '## Step 5: Add analytics only when requested');
    const normalized = access.replace(/\s+/g, ' ');
    for (const phrase of ['Authenticated', 'Limited-share', 'Data-room-on-request', 'Public', 'existing authentication and authorization', 'cannot open the deck or a deep link', 'distribution control, not', 'global navigation and sitemaps', '`noindex`', 'referrer and cache controls', 'public shell', 'source map']) {
      expect(normalized).toContain(phrase);
    }
    expect(access).toMatch(/Keep the deck and its assets public-safe if forwarded or\s+crawled/i);
    expect(access).toMatch(/Never promise these prevent\s+sharing, capture, or indexing/i);
    const proof = between(TMPL, '## Step 6: Prove it before calling it done', '## Step 7: External-change gate and delivery report');
    expect(proof).toMatch(/selected Access contract/i);
    expect(proof).toMatch(/denied and allowed deep links for authenticated/i);
    expect(proof).toMatch(/non-discovery controls and public-safe assets for limited-share/i);
    expect(proof).toMatch(/absence of detailed evidence files for data-room-on-request/i);
  });

  test('requires behavior tests, screenshots for every section, specialist reviews, and fresh Copilot feedback', () => {
    const proof = between(TMPL, '## Step 6: Prove it before calling it done', '## Step 7: External-change gate and delivery report');
    for (const phrase of ['Direct valid section links', 'keyboard navigation', 'Mobile layout', 'desktop and phone screenshot\nfor **every section**', '/design-review', '/qa', '/review', 'independent second-opinion', 'fresh** Copilot', '/document-release']) {
      expect(proof).toContain(phrase);
    }
    expect(proof).toMatch(/use\s+`\/codex review <deck-specific focus>` where available and permitted/i);
    expect(proof).toMatch(/never\s+fabricate a `\/codex` result/i);
    expect(proof).toMatch(/label self-review independent/i);
    expect(proof).toMatch(/If Copilot is unavailable[\s\S]*never fabricate Copilot\s+feedback/i);
    expect(proof).toMatch(/within the approved access boundary/i);
    expect(proof).toMatch(/supports GitHub Copilot[\s\S]*external processing is approved/i);
    expect(proof).toMatch(/After any review-driven change, rerun the affected tests, browser and\s+visual proof/i);
    expect(proof).toMatch(/repeat final source plus fresh\s+independent\/Copilot review/i);
    expect(proof).toMatch(/A review of a superseded diff does not count/i);
    expect(proof).toMatch(/Do not install Node, Bun, or a browser-test\s+framework solely to test a non-JavaScript project/i);
  });

  test('resolves specialist checkpoints through the current host rather than assuming a command exists', () => {
    expect(TMPL).toMatch(/Resolve by the current host's skill catalog and declared name first/i);
    expect(TMPL).toMatch(/Treat `gstack-\*` as a generated\s+directory or display name only when the host exposes it/i);
    expect(TMPL).toMatch(/never execute a slash\s+name as a shell command/i);
    for (const skill of ['/browse', '/plan-ceo-review', '/plan-design-review', '/plan-eng-review', '/plan-devex-review', '/autoplan', '/cso', '/benchmark', '/design-shotgun', '/diagram', '/make-pdf', '/design-review', '/qa', '/review', '/codex', '/document-release', '/setup-deploy']) {
      expect(TMPL).toContain(skill);
    }
    expect(TMPL).toMatch(/For a fundraising deck, always use `\/plan-ceo-review`/i);
    expect(TMPL).toMatch(/Do not force a specialist or its output format/i);
    expect(TMPL).toMatch(/`\/deck` owns intake/i);
    expect(TMPL).toMatch(/allowed-tools:[\s\S]*\n  - Agent\n/i);
    expect(TMPL).toMatch(/No user questions[\s\S]*commit\/stash choices[\s\S]*external mutations/i);
    expect(TMPL).toMatch(/A\s+child's mandatory prompt never overrides Step 1/i);
    expect(TMPL).toMatch(/reuse\s+`\/autoplan`'s CEO → design → eng → DX order/i);
    expect(TMPL).toMatch(/Never invoke bare `\/codex`/i);
    expect(TMPL).toMatch(/fresh-context child on the\s+current already-approved host/i);
    expect(TMPL).toMatch(/label it self-review, not independent review/i);
  });

  test('requires explicit confirmation immediately before external deployment or configuration changes', () => {
    const gate = between(TMPL, '## Step 7: External-change gate and delivery report', 'Finish with a compact evidence report:');
    expect(gate).toMatch(/Before changing any external deployment, DNS, cloud resource, production routing,\s+analytics-provider configuration, or live privacy setting/i);
    expect(gate).toMatch(/Obtain explicit confirmation/i);
    expect(gate).toMatch(/An unclear boundary means no new egress/i);
    expect(gate).toMatch(/reopen Step 1 only when new evidence\s+actually contradicts the settled Access level decision/i);
  });

  test('generated skill has no invalid browser commands', () => {
    expect(fs.existsSync(GEN_PATH)).toBe(true);
    const result = validateSkill(GEN_PATH);
    expect(result.invalid).toEqual([]);
    expect(result.snapshotFlagErrors).toEqual([]);
  });
});
