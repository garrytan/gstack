#!/usr/bin/env bun
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  recommendSawyerSkillAutopilot,
  type AutopilotMode,
  type SawyerSkillAutopilotInput,
} from '../lib/sawyer-skill-autopilot';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const parsed = await parseArgs(process.argv.slice(2));
  const mode = parsed.force ? 'suggest' : readMode();

  if (mode === 'off') {
    print({
      enabled: false,
      mode,
      action: 'none',
      reason: 'Sawyer skill autopilot is off. Enable with: gstack-config set sawyer_skill_autopilot suggest',
    });
    return;
  }

  const recommendation = recommendSawyerSkillAutopilot(parsed.input);
  print({
    enabled: true,
    mode,
    ...recommendation,
    strict: mode === 'strict',
  });
}

function readMode(): AutopilotMode {
  const envMode = process.env.GSTACK_SAWYER_SKILL_AUTOPILOT;
  const configured = envMode || spawnSync(join(__dirname, 'gstack-config'), ['get', 'sawyer_skill_autopilot'], {
    encoding: 'utf-8',
    env: process.env,
    timeout: 5000,
  }).stdout.trim();

  if (configured === 'suggest' || configured === 'strict') return configured;
  return 'off';
}

async function parseArgs(args: string[]): Promise<{ input: SawyerSkillAutopilotInput; force: boolean }> {
  let force = false;
  let json = '';
  const input: SawyerSkillAutopilotInput = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? '';
    switch (arg) {
      case '--force':
        force = true;
        break;
      case '--json':
        json = next();
        break;
      case '--prompt':
        input.prompt = next();
        break;
      case '--last-skill':
        input.lastSkill = next();
        break;
      case '--last-outcome':
        input.lastOutcome = next();
        break;
      case '--pr-state':
        input.prState = next();
        break;
      case '--deploy-status':
        input.deployStatus = next();
        break;
      case '--runtime-proof':
        input.runtimeProof = parseRuntimeProof(next());
        break;
      case '--docs-changed':
        input.docsChanged = parseBoolean(next());
        break;
      case '--developer-facing':
        input.developerFacing = parseBoolean(next());
        break;
      case '--help':
      case '-h':
        help();
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          throw new Error(`unknown argument: ${arg}`);
        }
        input.prompt = [input.prompt, arg].filter(Boolean).join(' ');
    }
  }

  if (!json && !process.stdin.isTTY) {
    const stdin = (await Bun.stdin.text()).trim();
    if (stdin) json = stdin;
  }

  return {
    input: json ? { ...input, ...JSON.parse(json) } : input,
    force,
  };
}

function parseBoolean(value: string): boolean {
  return /^(1|true|yes)$/i.test(value);
}

function parseRuntimeProof(value: string): SawyerSkillAutopilotInput['runtimeProof'] {
  if (/^(1|true|present|verified)$/i.test(value)) return 'present';
  if (/^(0|false|missing|absent)$/i.test(value)) return 'missing';
  return 'unknown';
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write(`gstack-sawyer-skill-autopilot

Local-only skill router for Sawyer-style cross-repo loops. It recommends the
first or next skill; it never pushes, merges, deploys, or edits files.

Config:
  gstack-config set sawyer_skill_autopilot off      # default
  gstack-config set sawyer_skill_autopilot suggest  # emit recommendations
  gstack-config set sawyer_skill_autopilot strict   # agent should follow or stop

Usage:
  gstack-sawyer-skill-autopilot --prompt "ship this"
  gstack-sawyer-skill-autopilot --json '{"lastSkill":"ship","prState":"open"}'
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

