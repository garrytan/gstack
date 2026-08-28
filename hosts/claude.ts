import { defineHost } from './define-host';

const claude = defineHost({
  name: 'claude',
  displayName: 'Claude Code',

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
    stripFields: ['sensitive', 'voice-triggers', 'interactive', 'benefits-from'],
    descriptionLimit: null,
  },

  generation: {
    generateMetadata: false,
    skipSkills: ['claude'],  // the /claude outside-voice skill is for non-Claude hosts; /codex stays (it IS a Claude skill wrapping codex exec)
  },

  pathRewrites: [],  // Claude is the primary host — no rewrites needed
  toolRewrites: {},

  install: {
    linkingStrategy: 'real-dir-symlink',
  },

  coAuthorTrailer: 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>',
  learningsMode: 'full',
});

export default claude;
