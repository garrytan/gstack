# gstack-review

Use this mode for a findings-first pre-landing review of the current diff against `main`.

## Contract

- Primary references: `review/checklist.md`, `review/greptile-triage.md`, `review/TODOS-format.md`
- Focus: correctness, trust boundaries, data safety, test gaps, and release risk
- Default posture: review non-interactively and only ask for user input when there is a real tradeoff that blocks action

## Workflow

1. Confirm the branch is not `main` and that there is a diff to review.
2. Read `review/checklist.md` before writing any findings.
3. Review the full diff against the latest `origin/main`.
4. Cross-reference `TODOS.md` when it exists.
5. If Greptile review comments are relevant, apply `review/greptile-triage.md`.

## Operating rules

- Findings come first, ordered by severity, with file and line references.
- Do not generate busywork. Skip style nits unless they create real risk.
- Use Codex-native user input only for blocking decisions such as “fix now vs acknowledge”.
- Never depend on Claude-only tool names or slash-command behavior.
