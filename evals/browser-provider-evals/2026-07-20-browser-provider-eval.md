# Browser-provider routing eval — 2026-07-20

## Scope

Report-only evaluation of GStack 2 just-in-time browser-provider selection on
macOS. No product files, host settings, extensions, browser profiles, or managed
runtime components were changed. No `./setup` command was run.

The inventory covers the seven installer-verified GStack 2 hosts plus Gemini
CLI: Claude Code, OpenAI Codex, Kimi Code CLI, Cursor, Pi, OpenClaw, GitHub
Copilot/VS Code, and Gemini CLI.

## Installation-path reproduction

The reported loaded path was:

```text
.agents/skills/gstack/qa/SKILL.md
```

That is the cloned GStack 1 compatibility tree. Its `qa/SKILL.md` still contains
an instruction to run `cd <SKILL_DIR> && ./setup`. The canonical GStack 2 path is:

```text
.agents/skills/qa/SKILL.md
```

The canonical source is `skills/qa/SKILL.md`; it routes browser setup through
`references/BROWSER-PROVIDERS.md` and explicitly forbids `./setup` in a
standards-installed skill directory.

## Official provider inventory

| Host | Interactive browser capability | Classification | Setup/readiness constraint |
|---|---|---|---|
| Claude Code | Claude in Chrome | Native extension | Chrome extension, paid direct Anthropic plan, site permission, and live connector discovery are required. |
| OpenAI Codex Desktop | In-app Browser; optional Codex Chrome connection | Native in-app | The in-app browser must be opened and exposed to the active task; CLI presence is not readiness. |
| Gemini CLI | Experimental bundled browser agent | Native experimental agent | Disabled by default, requires Chrome 144+, one-time consent, and can use isolated, persistent, or existing-browser modes. |
| Cursor | Chrome DevTools provider was live in the evaluated CLI session | Host-provided MCP | Must be discovered from the current tool surface and pass the common readiness journey. Current public Cursor tool docs do not establish universal availability. |
| GitHub Copilot / VS Code | Integrated browser agent tools | Native in-app | Browser tools must be enabled in the tool picker and may be controlled by organization policy. Agent-created pages use isolated in-memory state. |
| OpenClaw | Bundled browser plugin | Native bundled plugin | Plugin/tool policy must expose it; the default managed profile is isolated from the personal profile. |
| Kimi Code CLI | WebSearch and FetchURL only | No native interactive automation | `kimi web` is the session UI, not an agent-controlled browser. |
| Pi | No core browser; optional community packages exist | Extension-only | A third-party package install is required and must never be inferred or performed silently. |

Primary documentation:

- Claude: https://code.claude.com/docs/en/chrome
- Codex: https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app
- Gemini: https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md
- GitHub Copilot / VS Code: https://code.visualstudio.com/docs/agents/guides/browser-agent-testing-guide
- OpenClaw: https://docs.openclaw.ai/browser
- Kimi: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/tools.html
- Pi: https://pi.dev/docs/latest

## Provider-selection eval

All runnable agents received the same clean-room prompt, canonical project-local
QA skill, and fresh `GSTACK_HOME`. The prompt prohibited installation, settings
changes, extension enablement, profile attachment, consent acceptance, and
`./setup`.

| Host run | Version | Result | Key evidence |
|---|---:|---|---|
| Claude Code | 2.1.214 | PASS | Correctly found no Claude-in-Chrome tool surface, rejected unrelated installed binaries as readiness, and offered native setup, GStack preview/install, evidence-free continuation, or defer. |
| Codex CLI | 0.144.5 | PASS | Live provider discovery returned no browser in the CLI task; it correctly offered activation of Codex Desktop Browser and the other three choices without installing. |
| Gemini CLI | 0.51.0 | FAIL | Twice misidentified itself as Codex by reading inherited `CODEX_*`/desktop environment signals. It never inspected a callable Gemini browser tool and omitted Gemini's own experimental browser agent. |
| Cursor Agent | 2026.07.16-899851b | PASS WITH CONTRACT AMBIGUITY | Discovered a live Chrome DevTools peer and completed functional tests, but initially emitted `currently_usable: true` before the readiness journey had passed. |
| Pi | 0.80.9 | PASS | Correctly classified the read-only session as no native automation and offered all four choices. |
| Kimi | 1.49.0 | BLOCKED | Existing credential returned HTTP 401 before the agent could evaluate the skill. |
| OpenClaw | not installed | UNTESTED LIVE | Official documentation establishes a bundled browser plugin; no local executable was available. |
| GitHub Copilot / VS Code | VS Code 3.12.17 | UNTESTED LIVE | Official documentation establishes integrated browser tools; the active task did not expose a Copilot agent session. |

The cross-model harness dry-run recognized Claude and Codex but incorrectly
reported Gemini OAuth as unavailable. The Claude/Codex selection run completed
without a paid quality judge:

| Model | Latency | Input → output tokens | Estimated cost | Tool calls |
|---|---:|---:|---:|---:|
| Claude Opus 4.7 | 69.8 s | 8 → 4,801 | $0.52 | 5 |
| GPT-5.4 | 43.1 s | 190,996 → 1,398 | $0.49 | 9 |

## Functional public-web eval

Two providers were already available without installation or profile attachment:
Codex In-app Browser and Cursor's Chrome DevTools provider. Both passed the same
four journeys:

1. TodoMVC: add a todo, mark it complete, open the Completed filter, and verify
   retained state plus zero active items.
2. Selenium Web Form: fill text, choose option Two, check the default checkbox,
   submit, and verify `Form submitted` plus `Received!`.
3. The Internet JavaScript Error: capture the deliberate `TypeError` from the
   console with its source URL.
4. TodoMVC responsive: emulate 375×812 and capture screenshot evidence.

Both providers also passed the local common-readiness fixture: exact loopback
navigation, heading read, button interaction, `READY` state, console marker,
successful `POST /proof`, fixture shutdown, and released listener.

Evidence:

- Codex TodoMVC: `/tmp/gstack-browser-provider-evals/codex-in-app/todomvc-completed.png`
- Codex Selenium form: `/tmp/gstack-browser-provider-evals/codex-in-app/selenium-form-submitted.png`
- Codex console-error page: `/tmp/gstack-browser-provider-evals/codex-in-app/javascript-error.png`
- Codex mobile: `/tmp/gstack-browser-provider-evals/codex-in-app/todomvc-mobile.png`
- Cursor mobile: `/tmp/gstack-browser-provider-evals/cursor/todomvc-375x812.png`

## Findings

1. **P0 onboarding path ambiguity:** cloning the repository under
   `.agents/skills/gstack` exposes the legacy compatibility skill and its
   `./setup` instruction. A clean GStack 2 evaluation must use the standards
   installer and load `.agents/skills/qa/SKILL.md`.
2. **P1 provider registry is incomplete:** `BROWSER-PROVIDERS.md` names only
   Claude, Codex, and Kimi. It is missing Gemini, Cursor/runtime-discovered MCP,
   GitHub Copilot/VS Code, OpenClaw, and Pi's explicit no-core-browser case.
3. **P1 host inference is unsafe:** Gemini demonstrated that environment
   variables inherited from the parent application can identify the wrong host.
   Provider selection must use active callable tool discovery first.
4. **P1 readiness state is underspecified:** `available`, `needs-user-action`,
   and `ready` must be separate states. Cursor called the provider usable before
   the readiness fixture had run.
5. **P1 benchmark detection misses Gemini OAuth:** the model benchmark's auth
   detector disagreed with a successful direct Gemini run.
6. **P2 no cross-host setup copy:** the user-facing decision should be generated
   from a common state machine, with host-specific setup text supplied by an
   internal registry rather than hand-authored branching in each specialist.

## Recommended decision contract

```text
QA requires an interactive browser.

Detected: <provider> — <ready | needs user action | unavailable>

A) Use the detected agent browser
B) Preview the isolated GStack browser download, then ask separately to install
C) Continue without browser evidence (interactive claims will be unverified)
D) Defer
```

Selection is not readiness. Readiness is granted only after the common fixture
proves navigation, page reading, interaction, console/network evidence when
supported, and clean shutdown. GStack local browser preview and installation
remain two separate approvals. `./setup` is never a valid GStack 2 response.

## Untested surfaces

- Claude in Chrome functional automation: no extension peer was attached and no
  permission was granted to attach a signed-in profile.
- Gemini browser-agent functional automation: enabling it and accepting its
  first-run consent would change isolated host settings and requires explicit
  approval.
- GitHub Copilot/VS Code and OpenClaw live journeys: their agent tool surfaces
  were not active on this machine.
- Kimi provider-selection judgment: authentication failed before inference.
