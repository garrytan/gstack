# Gemini gstack: Team of Specialists for Gemini CLI

This directory ports the [gstack](https://github.com/garrytan/gstack) toolkit to Gemini CLI.

gstack transforms Gemini CLI from a general-purpose assistant into a team of opinionated specialists.

## Architecture

Only two components live permanently in this directory — the ones that are genuinely Gemini-specific:

| Directory | What it is |
| :--- | :--- |
| `gstack-browse/` | Stateful Playwright browser engine for Gemini CLI |
| `gstack-setup-browser-cookies/` | macOS Keychain cookie extractor for authenticated testing |

The 6 "content" skills (ship, reviewer, qa, retro, ceo, eng-lead) are **generated at install time** from the main gstack repo. `install.sh` strips Claude-specific frontmatter and tooling from each SKILL.md and links the result into Gemini CLI. There is no duplication — the main repo is the single source of truth.

## Installation

```bash
# From the gstack repo root:
bash gemini-port/install.sh

# Or with workspace scope (installs for a single Gemini workspace):
bash gemini-port/install.sh --scope workspace
```

Then reload in Gemini:
```
/skills reload
```

That's it. The script handles npm deps, skill generation, and `gemini skills link` for all 8 skills.

## Updating

When the main gstack skills evolve, regenerate the Gemini versions by re-running:

```bash
bash gemini-port/install.sh
```

## Skills

| Command | Role | Focus |
| :--- | :--- | :--- |
| `gstack-ceo` | **CEO / Founder** | Product vision, 10-star experience, problem scoping. |
| `gstack-eng-lead` | **Tech Lead** | Architecture, state machines, test matrices, Mermaid diagrams. |
| `gstack-reviewer` | **Paranoid Reviewer** | Structural audit, race conditions, N+1 queries, security. |
| `gstack-ship` | **Release Engineer** | Git sync, test execution, PR creation. |
| `gstack-browse` | **QA Engineer** | Stateful browser automation via Playwright. |
| `gstack-qa` | **QA Lead** | Automated regression testing based on git diffs. |
| `gstack-setup-browser-cookies` | **Session Manager** | macOS Keychain cookie extraction for authenticated testing. |
| `gstack-retro` | **EM Retro** | Data-driven weekly engineering retrospectives. |

## Technical Notes

### Stateful Browsing

Unlike the original Claude gstack (which requires a persistent Bun daemon), this port uses a **chained command architecture** in Playwright. A sequence of actions (`goto -> click -> fill -> screenshot`) runs in a single Node.js execution context, preserving DOM state without a background process.

### Cookie Extraction

`gstack-setup-browser-cookies` uses the macOS Keychain to decrypt local Chrome cookies, normalizing `SameSite` and `Expires` attributes for Playwright ingestion.

### Skill Generation

`install.sh` applies the following transforms to each main SKILL.md:

1. Strip Claude frontmatter (`allowed-tools`, `version`)
2. Add minimal Gemini frontmatter (`name`, `description`)
3. Remove the update-check block (Claude-specific self-upgrade logic)
4. Replace the `$B` binary discovery block with `B="node $HOME/.gemini/skills/gstack-browse/scripts/browse.js"`
5. Remove HTML generator comments

Generated files land in `generated/` (gitignored — they are build artifacts).

## Rebuilding Skill Bundles

The `.skill` files are pre-packaged archives for `gemini skills install` (offline use). After modifying source files, rebuild with:

```bash
# Rebuild gstack-browse
node /path/to/skill-creator/scripts/package_skill.cjs gstack-browse

# Rebuild gstack-setup-browser-cookies
node /path/to/skill-creator/scripts/package_skill.cjs gstack-setup-browser-cookies
```

The `SKILL.md` files in each skill subdirectory are the authoritative source. The `.skill` bundles are distribution artifacts.

---
*Ported by Rémi Al Ajroudi from [gstack](https://github.com/garrytan/gstack).*

