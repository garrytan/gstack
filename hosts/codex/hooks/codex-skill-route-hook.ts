#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * codex-skill-route-hook — the skill-routing hook on Codex (GST-3172). The same UserPromptSubmit hook as Claude
 * Code's (hosts/claude/hooks/skill-route-hook.ts) with host codex: it scans ${CODEX_HOME:-~/.codex}/skills, names
 * skills as Codex lists them (by their SKILL.md name, so gstack-review/ is review), words the hint for Codex, and
 * never routes a prompt that starts with `$` (a Codex skill mention) or `/`. Same switch (skill_routing), same deadline, same trace log.
 * Docs: docs/skill-routing-and-contracts.md#codex.
 */
import { runSkillRouteHook } from '../../claude/hooks/skill-route-hook.ts';

runSkillRouteHook('codex');
