# Memory-brain extension point

gstack stores its memory (learnings, timeline, checkpoints) as plain files
under `${GSTACK_HOME:-$HOME/.gstack}/projects/<slug>/`. Anyone writing a
memory brain can observe those writes in real time by dropping an
executable into `~/.gstack/hooks/`.

The contract is three files, all optional:

| Hook path | Fires when | Payload on stdin |
|---|---|---|
| `~/.gstack/hooks/on-learning-written` | A new learning is appended to `learnings.jsonl` | The validated JSON line (one line, newline-terminated) |
| `~/.gstack/hooks/on-timeline-written` | A new event is appended to `timeline.jsonl` | The validated JSON line (one line, newline-terminated) |
| `~/.gstack/hooks/on-checkpoint-written` | A checkpoint markdown file is saved | The absolute path to the written file |

## Contract

- **Optional.** If the hook file is missing or not executable, gstack
  behaves byte-identically to today.
- **Non-blocking.** Every hook invocation is backgrounded. gstack never
  waits for the hook to finish.
- **Non-fatal.** Exit codes are ignored. A broken hook never breaks a
  skill.
- **Untrusted.** Hook output is not piped back into gstack's workflow.
  Fire-and-forget. No new prompt-injection surface.

## Example: write every learning to a sentinel file

```bash
#!/usr/bin/env bash
# ~/.gstack/hooks/on-learning-written
cat >> /tmp/gstack-learnings-sink.jsonl
```

```bash
chmod +x ~/.gstack/hooks/on-learning-written
```

That is the whole integration surface.

## Reference implementation

[Dhee](https://github.com/Sankhya-AI/Dhee) is one memory brain that
consumes this contract. After `dhee install gstack`, Dhee registers
hooks at these three paths and ingests gstack's writes into its own
semantic retrieval layer. gstack files are never mutated.

The contract is provider-neutral. Any brain with a shell binary can
consume it.
