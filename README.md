# gstack - Antigravity Fork

This repository is a specialized fork of [garrytan/gstack](https://github.com/garrytan/gstack), engineered to seamlessly integrate with the **Antigravity AI Agent** while retaining 100% parity with Garry Tan's original tools. 

Original gstack documentation is preserved in [`UPSTREAM_README.md`](./UPSTREAM_README.md).

---

## 🚀 Features specific to this Fork
By utilizing an Antigravity environment (`.agents/`), this fork tracks its own independent capabilities:
- **Zero-Conflict Synchronizations:** Rebase-driven workflows ensure pulling the newest updates never accidentally corrupts your tool chains or forces a merge conflict.
- **Agent Initialization:** Quickly bootstrap your environment locally using conversational agent requests instead of hunting for terminal scripts.

## 🛠 Installation

To install `gstack` exactly like upstream and integrate its tools globally into your own terminal/AI sessions:

### Quick Install
Run this secure one-liner to clone the fork and automatically configure everything:
```bash
curl -fsSL https://raw.githubusercontent.com/<YOUR-GITHUB-USERNAME>/gstack/main/.agents/scripts/ag-install.sh | bash -s <YOUR-GITHUB-USERNAME>
```

### Manual Install

1. Connect Antigravity or navigate to this folder.
2. If first boot, instruct Antigravity via Slash Command `/bootstrap-ag` (or run `./.agents/scripts/ag-setup.sh` followed by `bun install && bun run build`).
3. Run the global init script:
   ```bash
   ./setup
   ```
4. Claude Code users, or CLI environments relying on `./setup`, will instantly receive access to all `gstack` features like `/qa`, `/ship`, `/investigate`.

---

## 🔄 Keeping Updated with Upstream
Because this is a fork, `gstack` receives frequent updates from its creator. To smoothly receive those updates without destroying this Antigravity setup:

**Do NOT run `git pull` blindly!**
Instead, simply tell your Antigravity agent:
> "Run `/sync-upstream`"

Under the hood, the automated `.agents/workflows/sync-upstream.md` handles safely fetching changes from Garry Tan, and intelligently rebases this fork’s integration commits directly on top of the newest codebase. 

---

## Modifying Agent Parameters
To add custom agent directives to this fork, add them to `.agents/ANTIGRAVITY.md`. 
To build new workflows, define them in `.agents/workflows/*.md` utilizing the `// turbo` paradigm.
