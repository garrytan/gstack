# Gemini gstack: Team of Specialists for Gemini CLI

This directory contains a port of the [gstack](https://github.com/garrytan/gstack) toolkit for Gemini CLI. 

gstack transforms Gemini CLI from a general-purpose assistant into a team of opinionated specialists.

## Port Features
- **Native Gemini Skills:** Fully integrated using the Gemini CLI Skill system.
- **Stateful Playwright Runner:** A specialized browser automation engine that persists sessions and handles complex SPA rendering.
- **Chrome Cookie Integration:** Seamlessly import authenticated sessions from your local Chrome browser into the agent's headless environment.
- **Production-Grade Roles:** Refined prompts for CEO, Tech Lead, and Paranoid Reviewer modes.

## Installation

1.  **Clone the repository.**
2.  **Install dependencies for the browser tools:**
    ```bash
    cd gstack-browse && npm install
    cd ../gstack-setup-browser-cookies && npm install
    ```
3.  **Install the skills into your Gemini workspace:**
    If you are on a different OS (e.g. Linux/Windows) than the one used to package these skills, you should rebuild the packages from source to ensure native dependencies like `sqlite3` are compatible:
    ```bash
    # From the root of this port
    # Optional: Rebuild packages if you encounter native module errors
    node /path/to/skill-creator/scripts/package_skill.cjs gstack-browse
    node /path/to/skill-creator/scripts/package_skill.cjs gstack-setup-browser-cookies
    
    gemini skills install gstack-ceo.skill --scope workspace
    # ... and so on
    ```
4.  **Reload your Gemini session:**
    ```text
    /skills reload
    ```

## Roles

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

## Technical Implementation Notes

### Stateful Browsing
Unlike the original Claude gstack which requires a persistent Bun daemon, this Gemini port uses a **chained command architecture** in Playwright. This allows the agent to perform a sequence of actions (goto -> click -> fill -> screenshot) in a single execution context, preserving the DOM state perfectly without needing a background process.

### Cookie Extraction
The `gstack-setup-browser-cookies` skill utilizes the macOS Keychain to decrypt local Chrome cookies. It applies strict Playwright-compatible normalization to ensure attributes like `SameSite` and `Expires` are correctly ingested into the agent's persistent profile.

---
*Ported by Rémi Al Ajroudi.*
