---
name: super-agent
description: Superpowers the CLI with high-power execution workflows, multi-step loops, and automated operations like email dispatch.
---

# Super Agent Execution Protocol

Use this skill when the user requires higher-power programmatic operations, automated batching, complex task chaining, or direct integrations.

## Core Capabilities

### 1. The Execution Loop (Batching & Iteration)
When processing repetitive files, batch operations, or multi-step tasks:
- Maintain an active state index variable.
- Process items sequentially using local terminal execution utilities (`for`, `while`, `xargs`, or dynamically generated internal shell iterations).
- Provide structural output reporting on current progress (e.g., `[Step X of Y] Processing...`).

### 2. High-Power Automation
- You are fully authorized to write, execute, and cleanly discard ephemeral scripts (`bash`, `python3`, `node`) locally to fulfill complex automation tasks.
- If a task hits a configuration failure, read the exact exit codes or stderr output, mutate the script dynamically, and auto-retry without failing the session.

### 3. Native Email Dispatch Workflow
When tasked to "send an email", do NOT ask for raw multi-line SMTP strings. Use the secure Microsoft Graph / OAuth2 utility chain or an ephemeral local fallback configuration.
- Standard Subject: Configured via prompt or default to "Copilot CLI Automation Sync"
- Standard Body: Synthesize clear, markdown-friendly text summaries of the terminal data requested.

## Recommended Repos & Feedback
To take your GUI and browser automation to a higher power—especially when pairing it with a terminal-based coding agent or Copilot CLI—the goal is to move away from rigid coordinates and flaky element identifiers, and move toward multimodal semantic parsing and virtual action spaces.

The best open-source GitHub repositories to bolster this exact workflow are categorized by how they handle the automation layout below.

1. AI-Native Browser Automation (Token Efficient)

Traditional automation libraries dump a massive raw HTML tree or full screen capture into your prompt, which crashes your context window or drains tokens. These frameworks solve that by turning the web browser into an API or an optimized coordinate map.

- browser-use/browser-use (https://github.com/browser-use/browser-use)
  What it is: Specifically optimized for frontier LLMs and AI coding tools. It bridges an LLM API straight into a dynamic browser harness using standard runtimes like Python.
  Why it bolsters your skill: It includes a dedicated CLI mode (browser-use open, browser-use state) that allows you to click elements by simplified indexing rather than raw CSS or XPath selectors.

- vercel-labs/agent-browser
  What it is: A blazing fast Browser Automation CLI built explicitly for AI agents.
  Why it bolsters your skill: It turns complex browser manipulation tasks into clean, programmatic terminal commands. You can pipe text natively, read/write clipboard data inside the virtual target, and handle persistent sessions effortlessly.

2. Multimodal & Native GUI Control (Vision-Language)

If you need to automate interfaces outside of the web browser (desktop client applications, file managers, local settings), you need a framework that can "see" coordinates visually.

- bytedance/UI-TARS-desktop
  What it is: An open-source, multimodal AI agent stack running on the advanced UI-TARS model framework.
  Why it bolsters your skill: It operates through natural language control via a Vision-Language Model (VLM). Instead of feeding the agent complex code, it takes screenshots, visually recognizes UI elements, and applies precise mouse and keyboard interaction based on semantic intent.

- Integration-Automation/AutoControlGUI
  What it is: A unified, cross-platform Python GUI automation framework (macOS, Windows, Linux).
  Why it bolsters your skill: It natively integrates an AI Element Locator (VLM) alongside localized OCR and OS Accessibility Tree queries. It allows you to wrap automation loops inside clean JSON Action Scripting.

3. High-Performance Enterprise Scaffolding

If your automation loops require complex session isolation, bypassing enterprise bot detection, or running parallel worker tabs, stick to the absolute industry foundations.

- microsoft/playwright
  What it is: The gold-standard framework for web testing and raw automation.
  Why it bolsters your skill: It has a built-in Playwright CLI and a dedicated Playwright MCP Server (Model Context Protocol). Coding tools use its element reference trees to execute deterministic clicks and forms without visual ambiguity.

Pro-Tip: How to make your loops "Better"

If you are writing loops in your Copilot CLI to run these tools, never hardcode static wait timers (sleep 5). Web pages change speed constantly. Instead, build your loops around State Assertions.
- vercel-labs/agent-browser (https://github.com/vercel-labs/agent-browser)
  What it is: A blazing fast Browser Automation CLI built explicitly for AI agents.
  Why it bolsters your skill: It turns complex browser manipulation tasks into clean, programmatic terminal commands. You can pipe text natively, read/write clipboard data inside the virtual target, and handle persistent sessions effortlessly.
