---
description: Onboard a new or existing project to gstack in one command.
---

# /gstack init

You are the `init` skill for gstack. Your job is to onboard a project — whether it's an empty directory (Greenfield) or an existing codebase (Brownfield) — by detecting the situation, scaffolding if needed, auto-detecting the stack, generating `.gstack.json`, and scaffolding a review checklist and AI context file.

Follow these steps precisely:

---

## Step 0: Pre-flight Checks

- Check if you are currently executing inside a gstack installation directory itself (e.g., if `./setup` and `browse/src/cli.ts` exist relative to the root). If you are, abort and tell the user they cannot run `/gstack init` on gstack itself.
- Look for an existing `.gstack.json` in the current project root directory. If it exists, use the `AskUserQuestion` tool to ask the user if they want to overwrite it or partially update it. If they decline, abort.

---

## Step 1: Detect Project Mode

List the files in the current directory. Determine the mode:

- **Greenfield Mode**: The directory is empty, or contains only `.git`, `.gitignore`, `README.md`, `.DS_Store`, or similar boilerplate. There are no language-specific project files.
- **Brownfield Mode**: The directory contains project files like `package.json`, `Gemfile`, `go.mod`, `Cargo.toml`, `pyproject.toml`, etc.

If Greenfield, proceed to **Step 2**. If Brownfield, skip directly to **Step 5**.

---

## Step 2 (Greenfield): Ask What to Build

Use the `AskUserQuestion` tool to prompt:

> "It looks like you're starting a new project! What are you building and what tech stack would you like to use?"
>
> Examples: "A SaaS dashboard with Next.js and Tailwind", "A CLI tool in Go", "A REST API with Rails"

---

## Step 3 (Greenfield): Scaffold the Project

Based on the user's answer, determine and execute the correct scaffolding command **in the current directory**. Examples:

| Stack | Command |
|---|---|
| Next.js | `npx -y create-next-app@latest . --use-npm` |
| Vite (React) | `npm create vite@latest . -- --template react-ts` |
| Rails | `rails new . --skip-git` |
| Go | `go mod init <module-name>` |
| Rust | `cargo init .` |
| Python | `mkdir -p src && touch src/__init__.py && python3 -m venv .venv` |

Use the table above as guidance, but reason about the best command based on what the user actually asked for. Always scaffold into the current directory (`.`), not a subdirectory. If the scaffold command requires interactive input, prefer flags that skip prompts (e.g., `--yes`, `--use-npm`, `--skip-git`).

After execution, verify the scaffold succeeded by checking that new project files were created.

---

## Step 4 (Greenfield): Scaffold AI Context File

Create an `AGENTS.md` file in the project root with conventions tailored to the chosen stack. This file helps AI coding agents understand the project's patterns. Example content for a Next.js project:

```markdown
# AI Agent Context

## Stack
- Next.js (App Router) with TypeScript
- Styling: Tailwind CSS

## Conventions
- Use React Server Components by default; add "use client" only when needed
- Use the App Router (`app/` directory), not Pages Router
- Prefer server actions over API routes for mutations
- Use `next/image` for all images
- Keep components in `src/components/`, utilities in `src/lib/`
```

Tailor the content to whatever stack the user chose. Keep it concise (under 30 lines) and focused on patterns that an AI agent would need to know.

---

## Step 5 (Brownfield): Auto-detect Stack from Project Files

- Look at the files in the current root directory (`package.json`, `Gemfile`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `build.gradle`, etc.).
- Identify the primary language and framework. For monorepos, multiple stacks can match; pick the root or dominant one.

---

## Step 6: Inspect Actual Commands

- Examine the configuration files from the detected stack to determine the correct test and build/eval commands.
- For Node.js/TypeScript: Check `package.json` for `scripts.test`, `scripts.build`, etc.
- For Ruby on Rails: Look for `bin/test` or `rspec` in `Gemfile`.
- For Go: Assume `go test ./...` if `go.mod` is present.
- For Rust: Assume `cargo test` if `Cargo.toml` is present.
- For Python: Look at `pyproject.toml` or `tox.ini` for `pytest` or `tox`.
- **Crucial step**: Search for CI configuration files (e.g., `.github/workflows/*.yml` or `.gitlab-ci.yml`) to see exactly how tests are run in CI. Extract those commands if they are robust, as CI is the ground truth.

---

## Step 7: Generate `.gstack.json`

- Present the detected test and eval commands to the user using the `AskUserQuestion` tool to confirm before writing them.
- Once confirmed (or adjusted by the user), generate the `.gstack.json` file in the current root directory using the following schema (include `evalCommand` as `null` if none, and an empty array for `evalPatterns` if none):
  ```json
  {
    "testCommand": "<detected or user-supplied command>",
    "evalCommand": "<detected or null>",
    "evalPatterns": [],
    "reviewChecklist": ".claude/skills/review/checklist.md"
  }
  ```

---

## Step 8: Scaffold Review Checklist if Missing

- Check if `.claude/skills/review/checklist.md` exists in the current project.
- If it does NOT exist, create the directory `.claude/skills/review/` if necessary.
- Read the universal default checklist from the gstack installation at `.claude/skills/gstack/review/checklists/default.md`.
- Write the exact contents of that file to `.claude/skills/review/checklist.md` in the current project.

---

## Step 9: Summary Output

- Output a short, helpful summary of what was detected and created (e.g., "Project scaffolded with Next.js", ".gstack.json created", "checklist.md scaffolded", "AGENTS.md created").
- Conclude by telling the user: "You are now ready to use gstack! Use `/review` to review your code, and `/ship` to ship it."
