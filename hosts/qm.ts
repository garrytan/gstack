/**
 * QM edition: one gstack skill (gstack-plan) in QM's own skill format.
 *
 * QM (a work assistant) lists skills in a name-and-description index with a
 * 12,000-char budget and loads a body only when the agent asks for it through
 * its `skill` tool, which also syncs the skill's files into
 * `.agent-skills/<conversation>/<name>/`. Tool results over about 16,384
 * chars are cut, and QM's `read` tool has no offset, so every file here must
 * be readable whole. QM's sandbox has no bun, no gstack checkout and no
 * install hook, so every command a skill names is a POSIX utility, git, or a
 * POSIX sh script shipped inside the skill.
 *
 * This is not a HostConfig in hosts/index.ts: it renders its skills by
 * section selection, without the shared preamble, instead of the whole
 * catalog through gen-skill-docs. scripts/gen-qm-edition.ts reads this spec
 * and writes qm/sandbox/skills/<id>/ plus qm/edition.json; test/qm-edition.test.ts enforces the
 * limits and the command rule. Self-contained: tests copy hosts/*.ts alone.
 */

export interface QmPart {
  /** Template or reference file, relative to the gstack root. */
  file: string;
  /** Exact heading text (without the leading #s) whose section is kept, subsections included. */
  heading: string;
  /** Output heading level for the kept heading; its subsections shift with it. */
  level: number;
  /** Subsection headings removed from the kept section. */
  skipHeadings?: string[];
  /** A paragraph, list item or fenced block containing any of these strings is removed. */
  dropBlocks?: string[];
  /** Exact text replaced in the kept section, after drops; each must match. */
  replaceText?: Array<[string, string]>;
}

export interface QmSkill {
  /** QM skill name and folder: qm/sandbox/skills/<id>/. */
  id: string;
  /** The gstack skill this one is derived from. */
  source: string;
  /** Index description: when to use it, within limits.descriptionChars. */
  description: string;
  /** QM-authored start: title and the first step, a command that runs in QM's sandbox. */
  header: string;
  parts: QmPart[];
  /** The first command the header tells QM to run, and a regex over QM's executed command that marks it ran. */
  firstStep: { command: string; marker: string };
  /** Scripts shipped in the skill: output name -> file under QM_EDITION.scriptSourceDir. */
  scripts: Record<string, string>;
}

/** POSIX.1-2017 utilities and sh special/regular builtins the edition may name. */
export const QM_POSIX_COMMANDS: readonly string[] = [
  'alias', 'awk', 'basename', 'break', 'cat', 'cd', 'chmod', 'cmp', 'command', 'comm', 'continue', 'cp', 'cut',
  'date', 'diff', 'dirname', 'echo', 'env', 'eval', 'exec', 'exit', 'export', 'expr', 'false', 'find', 'getopts',
  'grep', 'head', 'id', 'kill', 'ln', 'ls', 'mkdir', 'mktemp', 'mv', 'nl', 'od', 'paste', 'printf', 'ps', 'pwd',
  'read', 'readonly', 'return', 'rm', 'rmdir', 'sed', 'set', 'sh', 'shift', 'sleep', 'sort', 'tail', 'tee', 'test',
  'touch', 'tr', 'trap', 'true', 'uname', 'uniq', 'unset', 'wait', 'wc', 'xargs', ':', '.', '[',
];

/** Non-POSIX binaries the edition relies on QM's sandbox image to have. */
export const QM_IMAGE_COMMANDS: readonly string[] = ['git'];

export const QM_EDITION = {
  outDir: 'qm/sandbox/skills',
  scriptSourceDir: 'hosts/qm/scripts',
  manifest: 'qm/edition.json',
  limits: {
    /** Per shipped file, under QM's ~16,384-char inline tool-result cap with headroom. */
    fileChars: 15_000,
    descriptionChars: 160,
    /** The edition's share of QM's 12,000-char skills index (name + description per skill). */
    indexChars: 600,
  },
  /** Applied to kept gstack text, in order: host tool names become QM's. */
  rewrites: [
    ['use AskUserQuestion', 'ask the user'],
    ['AskUserQuestion', 'ask the user'],
    ['the Bash tool', 'the execute tool'],
    ['the Read tool', 'the read tool'],
  ] as Array<[string, string]>,
  /** Text that points at gstack machinery or files the edition does not ship. */
  forbiddenText: ['~/.claude', '$GSTACK', 'GSTACK_', '{{', 'CLAUDE_SKILL_DIR', '<skill dir>', 'checklist.md', 'greptile',
    'review-log', 'Step 4.', 'Step 5.8', 'Review Army', 'Outside Voice', 'Decision procedure', 'Aside'],
  /** Template placeholders a kept section may contain; anything else fails generation. */
  dropResolvers: [
    'LEARNINGS_LOG', 'GBRAIN_SAVE_RESULTS', 'FLAKE_FIX_NUMBER', 'SHARED_LIBS_RUBRIC', 'TEST_COVERAGE_AUDIT_PLAN',
    'PLAN_REALITY_ROWS', 'CODEX_PLAN_REVIEW', 'CONFIDENCE_CALIBRATION',
  ],
  skills: [] as QmSkill[],
};

QM_EDITION.skills.push(
  {
    id: 'gstack-plan',
    source: 'plan-eng-review',
    description: 'Use before building a feature: challenge the scope, then review architecture, code quality, tests and performance, and end with a plan to build. (gstack)',
    header: [
      '# Plan a feature: scope first, then the engineering review',
      '',
      'Review a plan, not code: do not build the feature. If the user has not given you the plan or feature description, ask for it and stop.',
      '',
      '**Start here.** In the repository (`cd` into it first: the shell starts in the workspace root), run with `execute` to see what already exists:',
      '',
      '```sh',
      'git log --oneline -10',
      'ls',
      '```',
      '',
      'Then read the files the plan touches. Work through Scope Challenge, then Sections 1-4 in order; for each finding give severity, a recommendation and the alternative. Ask about decisions that change scope in one message and stop until the user answers. Finish with the revised plan: what to build, in order, the files it touches, the tests that prove it, and what is NOT in scope.',
    ].join('\n'),
    parts: [
      { file: 'plan-eng-review/SKILL.md.tmpl', heading: 'My engineering preferences (use these to guide your recommendations):', level: 2 },
      {
        file: 'plan-eng-review/sections/review-sections.md.tmpl', heading: 'A. Assess the target', level: 2,
        dropBlocks: ['Search check', 'TODOS cross-reference', 'CC+gstack'],
        replaceText: [
          ['Complete these checks before the complexity decision in B. Do not apply scope\nchanges or write findings into the plan yet.', 'Complete these checks before proposing scope changes. Do not write findings into the plan yet.'],
          [' Use these counts in B.', ' At 8+ files or 2+ new classes or services, propose a smaller arrangement and ask before changing scope.'],
        ],
      },
      {
        file: 'plan-eng-review/sections/review-sections.md.tmpl', heading: 'Review Sections (after scope is agreed)', level: 2,
        skipHeadings: ['Continue after Outside Voice'],
        dropBlocks: ['Decision procedure', 'Test Plan Artifact', 'Confidence Calibration format'],
        replaceText: [
          [', using the rubric below', ''],
          ['Rejected extractions still need coverage for real duplicated-code defects.', 'Rejected extractions still need coverage for real duplicated-code defects.\n\nFor every new codepath, branch and error path in the plan, name the test that proves it (unit, integration or end-to-end) and the regression it would catch. Missing tests become plan items.'],
        ],
      },
    ],
    firstStep: { command: 'git log --oneline -10', marker: '\\bgit\\s+log\\b' },
    scripts: {},
  },
);
