import { defineHost } from './define-host';

const claude = defineHost({
  name: 'claude',
  displayName: 'Claude Code',
  tier: 'full',
  capabilities: { toolExecution: true, questions: 'native', planMode: true, delegation: true, browser: true, safetyHooks: 'enforced' },

  usesEnvVars: false,  // primary host — literal ~ paths, no $GSTACK_ROOT env vars

  frontmatter: {
    mode: 'denylist',
    // interactive + benefits-from are gen-time inputs (buildContext reads them
    // from the .tmpl); no runtime or test reader consumes them from the
    // GENERATED file (verified: e2e-harness-audit reads .tmpl; benefits-from
    // tests assert rendered prose; the host reads name/description/
    // allowed-tools/hooks; bin/gstack-brain-context-load reads gbrain: — which
    // is why gbrain and hooks are NOT stripped). Stripping them trims the
    // always-on frontmatter catalog every session loads.
    stripFields: ['sensitive', 'manual_only', 'voice-triggers', 'interactive', 'benefits-from', 'codex_default_prompt'],
    descriptionLimit: null,
    conditionalFields: [
      { if: { manual_only: true }, add: { 'disable-model-invocation': true } },
    ],
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['claude-code'],  // An outside reviewer must use a different harness.
  },

  pathRewrites: [],  // Claude is the primary host — no rewrites needed
  toolRewrites: {},

  install: {
    linkingStrategy: 'real-dir-symlink',
  },

  coAuthorTrailer: 'Co-Authored-By: Claude <noreply@anthropic.com>',
  learningsMode: 'full',

  transcripts: {
    root: '~/.claude/projects/<slug>/*.jsonl',
    layout: 'one folder per workspace; <slug> is the workspace path with every character that is not a letter or digit turned into "-"',
  },
});

export default claude;
