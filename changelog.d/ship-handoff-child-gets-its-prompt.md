---
important: blocker
---
- **A `/ship` with a token cap on Claude Code no longer stops at its first handoff.** When the budget handed steps to a fresh child, `gstack-ship-budget launch` started `claude -p` with `--allowedTools <list>` right before the prompt. Claude Code reads every argument after that option as one more tool name, so the child got no prompt, exited with "Input must be provided either through stdin or as a prompt argument", and the run stopped. The launch now ends the options with `--` before the prompt, which Claude Code 2.1.292 and 2.1.326 both read as the prompt. Thanks to @exGeni for the report and diagnosis (#4448).
