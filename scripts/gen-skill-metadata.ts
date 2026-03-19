#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const SKILLS = [
  { dir: '.', displayName: 'gstack Codex', shortDescription: 'Use the shared gstack-codex browser toolkit and workflow bundle.', defaultPrompt: 'Use gstack-codex to browse, QA, review, or ship work with the Codex-native workflow that best fits the task.' },
  { dir: 'browse', displayName: 'Browse', shortDescription: 'Drive the persistent Playwright browser for QA, screenshots, and app exploration.', defaultPrompt: 'Use the gstack-codex browse runtime to inspect the target app, interact with it, and gather evidence.' },
  { dir: 'qa', displayName: 'QA', shortDescription: 'Run the QA workflow, fix bugs you find, and re-verify the result.', defaultPrompt: 'Run the full gstack-codex QA workflow, fix issues found in scope, and verify each fix.' },
  { dir: 'qa-only', displayName: 'QA Only', shortDescription: 'Run report-only QA without making code changes.', defaultPrompt: 'Run the report-only gstack-codex QA workflow and return a clear bug report without changing code.' },
  { dir: 'review', displayName: 'Review', shortDescription: 'Perform a pre-landing review of the current diff against the base branch.', defaultPrompt: 'Review the current diff, surface real issues, auto-fix the mechanical ones, and summarize the rest clearly.' },
  { dir: 'ship', displayName: 'Ship', shortDescription: 'Run the pre-merge ship workflow for the current branch.', defaultPrompt: 'Run the gstack-codex ship workflow, check release readiness, and carry the branch through the shipping checklist.' },
  { dir: 'plan-ceo-review', displayName: 'Plan CEO Review', shortDescription: 'Review a plan for product ambition, user value, and strategic clarity.', defaultPrompt: 'Review the plan like a product-minded CEO and tighten the ambition, user value, and clarity.' },
  { dir: 'plan-eng-review', displayName: 'Plan Eng Review', shortDescription: 'Review a plan for architecture, implementation risk, and test completeness.', defaultPrompt: 'Review the plan from an engineering angle, tighten scope, and call out missing implementation and test details.' },
  { dir: 'plan-design-review', displayName: 'Plan Design Review', shortDescription: 'Review a plan for UX, interaction design, and visual completeness.', defaultPrompt: 'Review the plan from a design perspective and add the missing UX and visual-system decisions.' },
  { dir: 'design-consultation', displayName: 'Design Consultation', shortDescription: 'Research and propose an intentional design direction before implementation.', defaultPrompt: 'Research the design space, propose a coherent direction, and capture a practical design system for the project.' },
  { dir: 'design-review', displayName: 'Design Review', shortDescription: 'Audit the rendered product for design quality, UX, and polish.', defaultPrompt: 'Run the design review workflow, audit the experience visually, and recommend the highest-leverage improvements.' },
  { dir: 'setup-browser-cookies', displayName: 'Setup Browser Cookies', shortDescription: 'Import cookies from a local browser so browse/QA workflows can access authenticated pages.', defaultPrompt: 'Set up authenticated browser access by importing cookies from the local browser into gstack-codex.' },
  { dir: 'retro', displayName: 'Retro', shortDescription: 'Run a retrospective over recent work in the repository.', defaultPrompt: 'Run the retro workflow on recent project activity and summarize what to keep, change, and follow up on.' },
  { dir: 'document-release', displayName: 'Document Release', shortDescription: 'Update project docs and release notes after shipping changes.', defaultPrompt: 'Audit the repository docs after shipping, update the accurate ones, and summarize the documentation changes cleanly.' },
  { dir: 'gstack-upgrade', displayName: 'gstack Upgrade', shortDescription: 'Upgrade the local gstack-codex install and manage upgrade settings.', defaultPrompt: 'Handle the gstack-codex upgrade flow, update the local install, and explain any follow-up clearly.' },
];

function buildMetadata(displayName: string, shortDescription: string, defaultPrompt: string): string {
  return `interface:
  display_name: "${displayName}"
  short_description: "${shortDescription}"
  default_prompt: "${defaultPrompt}"
`;
}

let hasChanges = false;

for (const skill of SKILLS) {
  const metadataDir = path.join(ROOT, skill.dir, 'agents');
  const metadataPath = path.join(metadataDir, 'openai.yaml');
  const yaml = buildMetadata(skill.displayName, skill.shortDescription, skill.defaultPrompt);
  const relPath = path.relative(ROOT, metadataPath);

  if (DRY_RUN) {
    const existing = fs.existsSync(metadataPath) ? fs.readFileSync(metadataPath, 'utf-8') : '';
    if (existing === yaml) {
      console.log(`FRESH: ${relPath}`);
    } else {
      console.log(`STALE: ${relPath}`);
      hasChanges = true;
    }
    continue;
  }

  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(metadataPath, yaml);
  console.log(`GENERATED: ${relPath}`);
}

if (DRY_RUN && hasChanges) {
  process.exitCode = 1;
}
