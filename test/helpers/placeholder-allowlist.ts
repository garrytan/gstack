/**
 * Reviewed identifier placeholders for generated bash (CEO-12, DX-5, ENG-8).
 *
 * A `<placeholder>` the model fills in may appear in a command only when it is
 * listed here. Free text (bodies, titles, messages, briefs, prompts, error
 * output, reviewer or diff text) is never listed: it reaches a command only as
 * the contents of a `mktemp` file the agent writes with its file-write tool.
 *
 * Each entry names the grammar a value must match before the skill uses it; a
 * value that fails is not used. `quoted` entries may appear only inside single
 * or double quotes (or a quoted heredoc), and their grammar excludes every
 * character that can end or expand those quotes: `'`, `"`, backtick, `$`, `\`
 * and newline. Every other entry may appear unquoted, so its grammar also
 * excludes `;|&()<>?[]{}!#` and, unless it is a `list`, whitespace and `*`. test/generated-bash-placeholders
 * .test.ts proves each grammar rejects those characters.
 */

/** `list`: a space-separated list where word splitting is intended (spaces, and `*` globs, allowed). */
export interface IdentifierGrammar { grammar: RegExp; what: string; quoted?: true; list?: true }

const NUM = /^[0-9]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Shell-safe subset of git ref names; the posting skills also run `git check-ref-format --branch`. */
const REF = /^[\p{L}\p{N}_][\p{L}\p{N}._/@+-]*$/u;
const PATH = /^[\p{L}\p{N}._/@+:,%=~-]+$/u;
/** Space-separated path lists (word splitting intended); `*` may glob. */
const PATHS = /^[\p{L}\p{N}._/@+:,%=~* -]+$/u;
/** Inside quotes only: anything that cannot end or expand the quotes. */
const QUOTED = /^[^'"`$\\\n]+$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const NUMBER = /^-?[0-9]+(?:\.[0-9]+)?$/;
const URL = /^https?:\/\/[^'"`$\\\s<>]+$/;
const oneOf = (...alts: string[]) => new RegExp(`^(?:${alts.map(a => a.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('|')})$`);

export const IDENTIFIER_PLACEHOLDERS: Record<string, IdentifierGrammar> = {
  // Enumerations: the value is one of the listed literals.
  '<approval|clarification|routing|cherry-pick|feedback-loop>': { grammar: oneOf('approval', 'clarification', 'routing', 'cherry-pick', 'feedback-loop'), what: 'question category' },
  '<one-way|two-way>': { grammar: oneOf('one-way', 'two-way'), what: 'door type' },
  '<never-ask|always-ask|ask-only-for-one-way>': { grammar: oneOf('never-ask', 'always-ask', 'ask-only-for-one-way'), what: 'question preference' },
  '<pref>': { grammar: oneOf('never-ask', 'always-ask', 'ask-only-for-one-way'), what: 'question preference' },
  '<clean|flagged>': { grammar: oneOf('clean', 'flagged'), what: 'semantic review outcome' },
  '<N|null>': { grammar: /^(?:[0-9]+(?:\.[0-9]+)?|null)$/, what: 'health score or null' },
  '<platform>': { grammar: oneOf('github', 'gitlab', 'unknown'), what: 'detected git platform' },

  // Ids, keys and numbers.
  '<id>': { grammar: ID, what: 'question or record id (kebab-case)' },
  '<key>': { grammar: ID, what: 'option key' },
  '<summary-slug>': { grammar: ID, what: 'question summary as a kebab-case slug' },
  '<comment-id>': { grammar: NUM, what: 'GitHub comment id from the fetched JSON' },
  '<issue-number>': { grammar: /^[0-9]*$/, what: 'filed issue number, or empty when none was filed' },
  '<check-number>': { grammar: NUM, what: 'canary check number' },
  '<run-id>': { grammar: NUM, what: 'GitHub Actions run id' },
  '<PID>': { grammar: NUM, what: 'process id printed by an earlier block' },
  '<retained-owner-token>': { grammar: ID, what: 'freeze owner token printed by acquire' },
  '<RUN_ID>': { grammar: ID, what: 'run id printed by Setup' },
  '<RUN_ID from Setup>': { grammar: ID, what: 'run id printed by Setup' },
  '<PHASE>': { grammar: oneOf('ceo', 'design', 'dx', 'eng'), what: 'autoplan phase' },
  '<VARIANT>': { grammar: /^[A-Z]$/, what: 'variant letter' },
  '<SCREEN>': { grammar: ID, what: 'screen name slug' },
  '<screen-name>': { grammar: ID, what: 'screen name slug' },
  '<page-name>': { grammar: ID, what: 'page name slug' },
  '<name>': { grammar: ID, what: 'slug' },
  '<slug>': { grammar: ID, what: 'slug' },
  '<dimension>': { grammar: ID, what: 'design dimension slug' },
  '<dim>': { grammar: ID, what: 'profile dimension name' },
  '<new_value>': { grammar: NUMBER, what: 'profile dimension value' },
  '<Q1_VALUE>': { grammar: NUMBER, what: 'profile answer value' },
  '<Q2_VALUE>': { grammar: NUMBER, what: 'profile answer value' },
  '<Q3_VALUE>': { grammar: NUMBER, what: 'profile answer value' },
  '<Q4_VALUE>': { grammar: NUMBER, what: 'profile answer value' },
  '<Q5_VALUE>': { grammar: NUMBER, what: 'profile answer value' },
  '<actual-harness>': { grammar: oneOf('claude', 'codex'), what: 'harness name' },
  '<suite>': { grammar: ID, what: 'eval suite name' },
  '<picked-models>': { grammar: /^[A-Za-z0-9._:,-]+$/, what: 'comma-separated model ids' },
  '<github-username>': { grammar: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, what: 'GitHub login' },
  '<gitlab-username>': { grammar: /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, what: 'GitLab username' },

  // Dates.
  '<today>': { grammar: DATE, what: 'YYYY-MM-DD' },
  '<start_date>': { grammar: DATE, what: 'YYYY-MM-DD' },
  '<since>': { grammar: /^[0-9]+[dhwm]$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, what: 'retro window (7d, 24h, 2w) or date' },
  '<window>': { grammar: /^[0-9]+[dhwm]$/, what: 'retro window (7d, 24h, 2w)' },

  // Git refs. Branch names from remote data travel as data (ENG-8), never through this list.
  '<base>': { grammar: REF, what: 'base branch detected by the skill' },
  '<default>': { grammar: REF, what: 'default branch detected by the skill' },
  '<diff-base>': { grammar: REF, what: 'diff base ref detected by the skill' },
  '<detected-base-branch>': { grammar: REF, what: 'base branch detected by the skill' },
  '<branch-name>': { grammar: REF, what: 'current branch (git branch --show-current)' },
  '<prior-review-commit>': { grammar: /^[0-9a-f]{7,40}$/, what: 'commit sha' },

  // Paths printed by earlier gstack blocks or chosen by the skill.
  '<body-file-name>': { grammar: ID, what: 'basename of the mktemp body file printed by the previous block' },
  '<title-file-name>': { grammar: ID, what: 'basename of the mktemp title file printed by the previous block' },
  '<reply-file-name>': { grammar: ID, what: 'basename of the mktemp reply file printed by the previous block' },
  '<redact-file-name>': { grammar: ID, what: 'basename of the mktemp draft file printed by the free-text block' },
  '<approach-file-name>': { grammar: ID, what: 'basename of the mktemp approach file printed by the free-text block' },
  '<greptile-dir>': { grammar: PATH, what: 'mktemp directory printed by the Greptile fetch block' },
  '<SNAPSHOT_TOOL>': { grammar: QUOTED, what: 'snapshot tool path printed by autoplan', quoted: true },
  '<SOURCE_PLAN>': { grammar: QUOTED, what: 'plan path', quoted: true },
  '<ACTIVE_PLAN>': { grammar: QUOTED, what: 'plan path', quoted: true },
  '<RESTORE_PATH>': { grammar: QUOTED, what: 'restore path printed by autoplan', quoted: true },
  '<methodologyPath>': { grammar: QUOTED, what: 'methodology path printed by autoplan', quoted: true },
  '<CEO_STEP0_CHECKPOINT>': { grammar: QUOTED, what: 'checkpoint path printed by autoplan', quoted: true },
  '<AMENDMENT_CHECKPOINT>': { grammar: QUOTED, what: 'checkpoint path printed by autoplan', quoted: true },
  '<prepared-prompt-file>': { grammar: QUOTED, what: 'prompt file path printed by the prepare step', quoted: true },
  '<run-dir>': { grammar: QUOTED, what: 'run directory printed by an earlier block', quoted: true },
  '<ASIDE_DIR>': { grammar: QUOTED, what: 'Aside output directory printed by an earlier block', quoted: true },
  '<ASIDE_DIR or $_TMP>': { grammar: QUOTED, what: 'Aside output directory printed by an earlier block', quoted: true },
  '<REPORT_DIR from Setup>': { grammar: QUOTED, what: 'report directory printed by Setup', quoted: true },
  '<the FILE path printed above>': { grammar: QUOTED, what: 'file path printed by the previous block', quoted: true },
  '<install dir from Step 2>': { grammar: QUOTED, what: 'install directory printed by Step 2', quoted: true },
  '<APPROVED path>': { grammar: QUOTED, what: 'approved design path', quoted: true },
  '<first path from the printed saved list>': { grammar: QUOTED, what: 'image path printed by the design tool', quoted: true },
  '<design-path>': { grammar: QUOTED, what: 'design doc path', quoted: true },
  '<review-directory>': { grammar: QUOTED, what: 'review directory printed by mktemp', quoted: true },
  '<round-1.json>': { grammar: QUOTED, what: 'round file path', quoted: true },
  '<round-1.json if present>': { grammar: QUOTED, what: 'round file path', quoted: true },
  '<round-2.json if present>': { grammar: QUOTED, what: 'round file path', quoted: true },
  '<round-3.json if present>': { grammar: QUOTED, what: 'round file path', quoted: true },
  '<source-dir>': { grammar: QUOTED, what: 'app source directory', quoted: true },
  '<user-provided-path>': { grammar: QUOTED, what: 'directory the user named', quoted: true },
  '<detected-directory>': { grammar: QUOTED, what: 'directory detected by the skill', quoted: true },
  '<staged>': { grammar: QUOTED, what: 'staged HTML path', quoted: true },
  '<stagedDir>': { grammar: QUOTED, what: 'staged directory printed by an earlier block', quoted: true },
  '<outdir>': { grammar: PATH, what: 'output directory' },
  '<path>': { grammar: PATH, what: 'repository path from discovery' },
  '<sketch-dir>': { grammar: PATH, what: 'sketch directory printed by an earlier block' },
  '<path-to-finalized.html>': { grammar: PATH, what: 'finalized HTML path' },
  '<finalized.html>': { grammar: PATH, what: 'finalized HTML path' },
  '<approved-variant.png>': { grammar: PATH, what: 'approved variant image path' },
  '<failing-test-file>': { grammar: PATH, what: 'test file path' },
  '<source-file-under-test>': { grammar: PATH, what: 'source file path' },
  '<affected-files>': { grammar: PATHS, what: 'space-separated file paths', list: true },
  '<only-changed-files>': { grammar: PATHS, what: 'space-separated file paths', list: true },
  '<only-verified-source-and-regression-files>': { grammar: PATHS, what: 'space-separated file paths', list: true },
  '<scope>': { grammar: PATHS, what: 'path or glob', list: true },

  '<project eval command>': { grammar: /^[A-Za-z0-9._/@+:,%=~ -]+$/, what: 'the eval command the project documents (words and flags only)', list: true },

  // Quoted-only values: URLs, selectors, search words and commands.
  '<url>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<page-url>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<base-url>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<target-url>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<affected-url>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<TARGET_URL>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<site>': { grammar: URL, what: 'http(s) URL', quoted: true },
  '<selector>': { grammar: QUOTED, what: 'CSS selector', quoted: true },
  '<row-selector>': { grammar: QUOTED, what: 'CSS selector', quoted: true },
  '<title-selector>': { grammar: QUOTED, what: 'CSS selector', quoted: true },
  '<your-keyword>': { grammar: QUOTED, what: 'search words', quoted: true },
  '<keywords>': { grammar: QUOTED, what: 'search words', quoted: true },
  '<keyword1>': { grammar: QUOTED, what: 'search word', quoted: true },
  '<keyword2>': { grammar: QUOTED, what: 'search word', quoted: true },
  '<keyword3>': { grammar: QUOTED, what: 'search word', quoted: true },
  '<tests>': { grammar: QUOTED, what: 'test command', quoted: true },
  '<vitest>': { grammar: QUOTED, what: 'test command', quoted: true },

  // External-host renders: Claude Code outside voice and the gbrain page save.
  '<gstack-runtime-root>': { grammar: QUOTED, what: 'installed runtime path', quoted: true },
  '<fresh-or-resume>': { grammar: oneOf('fresh', 'resume'), what: 'Claude Code session mode' },
  '<feature-slug>': { grammar: ID, what: 'feature slug for the gbrain page' },
  '<page-file>': { grammar: QUOTED, what: 'mktemp page file path printed by the previous command', quoted: true },

  // A3 group 1 (Aside prompts, design briefs, design approval feedback): mktemp basenames.
  '<prompt-file-name>': { grammar: ID, what: 'basename of the mktemp prompt file (Aside, Codex, benchmark) printed by the previous block' },
  '<brief-file-name>': { grammar: ID, what: 'basename of the mktemp design brief file printed by the free-text block' },
  '<feedback-file-name>': { grammar: ID, what: 'basename of the mktemp design feedback file printed by the previous block' },

  // A3 group 2 (Codex prompts and misc): mktemp basenames, mode switches,
  // the benchmark prompt path and the sync-gbrain orchestrator flags.
  '<focus-file-name>': { grammar: ID, what: 'basename of the mktemp Codex review focus file printed by the free-text block' },
  '<receipt line>': { grammar: /^OFFICE_HOURS_VERDICT round=[1-3] sha256=[0-9a-f]{64} path=\/[^'"`$\\\n]+$/, what: 'office-hours reviewer verdict receipt (one line)', quoted: true },
  '<body-top-file-name>': { grammar: ID, what: 'basename of the mktemp PR body draft (through ## Documentation) printed by the free-text block' },
  '<body-rest-file-name>': { grammar: ID, what: 'basename of the mktemp PR body draft (after the documentation section) printed by the free-text block' },
  '<rejected-file-name>': { grammar: ID, what: 'basename of the mktemp rejected-test list printed by the free-text block' },
  '<new|resume>': { grammar: oneOf('new', 'resume'), what: 'Codex consult session mode' },
  '<prompt-path>': { grammar: QUOTED, what: 'benchmark prompt file path', quoted: true },
  '<user-args>': {
    grammar: /^(?:(?:--(?:incremental|full|dry-run|quiet|no-code|no-memory|no-brain-sync|code-only|dream|no-dream|allow-reclone|prune-gone-worktrees)|--sources [a-z][a-z0-9_,-]*)(?: (?=-)|$))*$/,
    what: 'gstack-gbrain-sync flags (space-separated; --sources takes one comma-separated type list)',
    list: true,
  },
};
