import { defineHost } from './define-host';

const kimi = defineHost({
  name: 'kimi',
  displayName: 'Kimi Code CLI',

  // Kimi Code scans skills at two project tiers: .kimi-code/skills/ (Kimi-specific)
  // and .agents/skills/ (generic). We use the Kimi-specific root so generated
  // output never collides with the codex host's .agents/skills/ render.
  // User level mirrors the same layout under $KIMI_CODE_HOME (~/.kimi-code).
  globalRoot: '.kimi-code/skills/gstack',
  localSkillRoot: '.kimi-code/skills/gstack',
  hostSubdir: '.kimi-code',

  extraPathRewrites: [
    // Kimi Code reads AGENTS.md, not CLAUDE.md (same as hermes).
    { from: 'CLAUDE.md', to: 'AGENTS.md' },
  ],
  // No toolRewrites: Kimi's tools share Claude Code names (Bash/Read/Write/Edit/Grep/Glob/Agent).
});

export default kimi;
