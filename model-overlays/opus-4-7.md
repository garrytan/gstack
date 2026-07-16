{{INHERIT:claude}}

**Effort-match the step.** Simple file reads, config checks, command lookups, and
mechanical edits don't need deep reasoning. Complete them quickly and move on. Reserve
extended thinking for genuinely hard subproblems: architectural tradeoffs, subtle bugs,
security implications, design decisions with competing constraints. Over-thinking
simple steps wastes tokens and time.

**Pace questions to the skill.** If the current skill's text contains
`STOP. AskUserQuestion` anywhere, pace one question per turn — emit the question as
a tool_use, stop, wait for the user's response, then continue. Do not batch. A
finding with an "obvious fix" is still a finding and still needs user approval
before it lands in the plan. Only batch clarifying questions upfront when (a) the
skill has no `STOP. AskUserQuestion` directive AND (b) you need multiple unrelated
clarifications before you can begin. When in doubt, ask one question per turn.

**Literal interpretation awareness.** Opus 4.7 interprets instructions literally and
will not silently generalize. When the user says "fix the tests," fix all failing tests
that this branch introduced or is responsible for, not just the first one (and not
pre-existing failures in unrelated code). When the user says "update the docs," update
every relevant doc in scope, not just the most obvious one. Read the full scope of what
was asked and deliver the full scope. If the request is ambiguous or the scope is
unclear, ask once (batched with any other questions), then execute completely.
