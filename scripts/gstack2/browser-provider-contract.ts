export type BrowserProviderKind =
  | 'native-extension'
  | 'native-in-app'
  | 'native-agent'
  | 'native-plugin'
  | 'native-mcp'
  | 'extension-only'
  | 'no-native-automation';

export interface BrowserProviderContract {
  id: 'claude' | 'codex' | 'gemini' | 'cursor' | 'github-copilot' | 'openclaw' | 'kimi' | 'pi';
  label: string;
  kind: BrowserProviderKind;
  setup: readonly string[];
  readiness: readonly string[];
  unavailable: string;
}

export const BROWSER_PROVIDER_CONTRACTS: readonly BrowserProviderContract[] = [
  {
    id: 'claude',
    label: 'Claude in Chrome',
    kind: 'native-extension',
    setup: [
      'Explain that Claude in Chrome requires Google Chrome, a paid Claude plan, the user-installed extension, the same signed-in Claude account, granted site permissions, and an enabled connector.',
      'Ask whether the user wants to configure it now. Never install the extension, grant permissions, enable a connector, sign in, or attach a Chrome profile for them.',
      'After the user completes setup, retry the active host tab/context discovery rather than treating the presence of the Claude CLI as browser readiness.',
    ],
    readiness: [
      'The Claude in Chrome tool surface is visible to the active Claude Code session.',
      'Tab/context discovery returns an attached browser peer instead of a missing-extension or no-peer error.',
      'The common local readiness journey completes through the Claude browser tools.',
    ],
    unavailable: 'Offer GStack local browser or continue without browser evidence; do not substitute a different extension or remote browser.',
  },
  {
    id: 'codex',
    label: 'Codex built-in browser',
    kind: 'native-in-app',
    setup: [
      'Explain that the built-in browser is a ChatGPT desktop-app surface on macOS and Windows and uses its own browser state.',
      'Ask the user to open it from the Work/Codex toolbar (Command-Shift-B on macOS or Control-Shift-B on Windows) and approve the test site when prompted.',
      'Do not infer readiness from the Codex CLI or skill installation; the active session must expose an in-app browser provider.',
    ],
    readiness: [
      'Active browser discovery returns the in-app browser provider instead of an empty provider list.',
      'A tab can be created or selected after the user opens the browser surface.',
      'The common local readiness journey completes through the Codex browser tools.',
    ],
    unavailable: 'Offer GStack local browser or defer browser work; do not claim that restarting a browser-less session will create the missing host capability.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI browser agent',
    kind: 'native-agent',
    setup: [
      'Explain that Gemini CLI has an experimental bundled `browser_agent`, disabled by default, which requires a recent local Chrome and displays a first-run consent dialog.',
      'Ask whether the user wants to enable it themselves. Never edit Gemini settings, accept its consent dialog, attach an existing Chrome session, or infer readiness from the Gemini executable.',
      'Prefer Gemini isolated browser mode for public or localhost QA unless the user explicitly needs and approves an existing signed-in browser session.',
    ],
    readiness: [
      'The active Gemini session exposes the callable `browser_agent` tool rather than only `google_web_search` or `web_fetch`.',
      'The user has completed Gemini\'s own enablement and one-time consent without GStack acting on their behalf.',
      'The common local readiness journey completes through the Gemini browser agent.',
    ],
    unavailable: 'Offer the consented GStack local browser, evidence-limited fetch/search, or deferral; do not install a browser MCP because Gemini already bundles its experimental browser agent.',
  },
  {
    id: 'cursor',
    label: 'Cursor interactive browser provider',
    kind: 'native-mcp',
    setup: [
      'Inspect the active Cursor tool surface for an interactive provider such as Chrome DevTools; Cursor CLI presence and parent-process environment variables are not provider evidence.',
      'If an interactive provider is exposed, explain its current session/profile boundary and ask whether to use it. Never add or approve an MCP server, extension, or browser profile for the user.',
      'If no interactive provider is exposed in this Cursor session, offer GStack local browser rather than assuming every Cursor installation has the same browser tools.',
    ],
    readiness: [
      'The active Cursor session exposes callable navigation, page-reading, and interaction tools and returns a live browser peer.',
      'The selected browser session does not require silently attaching the user\'s personal profile.',
      'The common local readiness journey completes through the discovered Cursor provider.',
    ],
    unavailable: 'Offer GStack local browser, evidence-limited web access, or deferral; do not turn one machine\'s configured Chrome DevTools MCP into a universal Cursor capability claim.',
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot and VS Code integrated browser',
    kind: 'native-in-app',
    setup: [
      'Explain that current VS Code can expose built-in browser agent tools, subject to the `workbench.browser.enableChatTools` organization setting and the user\'s active tool selection.',
      'Ask the user to enable the Built-in > Browser tools in the active agent session when they want to use them. Never change VS Code or organization settings for them.',
      'Prefer an agent-created isolated browser page; sharing an existing browser page or its signed-in state requires the user\'s explicit action.',
    ],
    readiness: [
      'The active Copilot/VS Code agent session exposes callable browser tools such as page navigation, reading, screenshot, and interaction.',
      'An isolated browser page can be opened without silently sharing an existing tab or cookie store.',
      'The common local readiness journey completes through the VS Code integrated browser tools.',
    ],
    unavailable: 'Offer GStack local browser or defer; distinguish organization-policy disablement from a transient missing browser tab.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw browser plugin',
    kind: 'native-plugin',
    setup: [
      'Explain that OpenClaw includes a browser plugin with a dedicated managed profile, while its `user` profile can attach to an existing browser session.',
      'Inspect the active OpenClaw tool policy for the callable browser tool. Never edit `plugins.allow`, enable the plugin, or attach the `user` profile without explicit user action.',
      'Prefer the isolated managed profile for public and localhost QA; use an existing signed-in profile only when the user explicitly selects it.',
    ],
    readiness: [
      'The active OpenClaw agent exposes the browser tool after its plugin and tool-policy checks.',
      'Browser doctor/status and tab discovery succeed for the explicitly selected profile.',
      'The common local readiness journey completes through OpenClaw browser actions.',
    ],
    unavailable: 'Offer GStack local browser or defer; do not silently repair OpenClaw plugin policy or attach a personal browser profile.',
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    kind: 'no-native-automation',
    setup: [
      'Explain that Kimi Code loads standard Agent Skills and provides WebSearch/FetchURL when configured, but does not currently document a native interactive browser-automation harness.',
      'Do not describe `kimi web` as browser automation: it is the browser-based user interface for the Kimi session.',
      'Offer GStack local browser when interactive navigation, clicking, screenshots, console, or network evidence is required.',
    ],
    readiness: [
      'Kimi discovers the canonical GStack skills through its standard Agent Skills directories.',
      'Fetch/search-only work may use Kimi host tools when their limitations satisfy the task.',
      'Interactive browser readiness is tested against GStack local browser, not `kimi web`.',
    ],
    unavailable: 'Continue with fetch/search-only evidence or offer the consented GStack local browser; never silently add a browser MCP or alternate backend.',
  },
  {
    id: 'pi',
    label: 'Pi coding agent',
    kind: 'extension-only',
    setup: [
      'Explain that Pi intentionally has no core interactive browser tool; browser automation is available only through optional third-party packages or an already exposed host tool.',
      'Inspect the active Pi tool surface. Never install a Pi package, run its browser installer, or treat a package listing as a live browser peer.',
      'Offer GStack local browser when no already-configured interactive provider is callable.',
    ],
    readiness: [
      'An explicitly user-installed Pi browser extension exposes a callable browser tool in the active session.',
      'The extension returns a live isolated session without triggering an unapproved Chromium download or profile attachment.',
      'The common local readiness journey completes through that active tool.',
    ],
    unavailable: 'Offer GStack local browser, evidence-limited continuation, or deferral; never recommend or install a third-party Pi browser package automatically.',
  },
] as const;

export function renderBrowserProviderContract(): string {
  const sections = BROWSER_PROVIDER_CONTRACTS.map((provider) => `## ${provider.label}

Classification: \`${provider.kind}\`

Setup:

${provider.setup.map((step, index) => `${index + 1}. ${step}`).join('\n')}

Readiness evidence:

${provider.readiness.map((step) => `- ${step}`).join('\n')}

If unavailable: ${provider.unavailable}`).join('\n\n');

  return `# Browser provider setup and readiness

Browser setup is optional and consented. The Agent Skills installer owns skill placement; this flow never enrolls another host. At onboarding, offer this flow only when the user asks to configure browser capabilities now. Otherwise run it just in time when a selected workflow first needs interactive browser evidence.

## Routing flow

1. Identify the active host and provider from callable tools in the current session, not from unrelated installed binaries, parent-application environment variables, documentation, or guessed host names. Inherited \`CODEX_*\`, bundle identifiers, and similar process metadata never override the actual agent/tool surface.
2. Show the detected provider, what user-controlled setup it requires, and the GStack local-browser fallback.
3. Ask whether to use the host-native provider, set up GStack local browser, continue without browser evidence, or defer. A selection is not permission to install another product or attach private browser state.
4. For a host-native selection, follow the matching provider section below. Never install an extension, grant site access, sign in, add an MCP server, attach an existing profile, or change host settings without the user's explicit action.
5. After setup, run the common readiness journey. Tool names or metadata alone are insufficient evidence.
6. If the journey fails, report \`needs-user-action\`, \`unavailable\`, or \`failed\` with the exact observed cause and offer the local GStack browser. Do not silently fall back.

## Provider states

- \`available\`: the current session exposes callable navigation, reading, and interaction tools, but readiness has not yet been proven.
- \`needs-user-action\`: the host has a documented provider, but the user must enable, open, approve, or connect it.
- \`ready\`: the selected provider passed the common local readiness journey in this session.
- \`unavailable\`: no suitable interactive tool is exposed in the current session.
- \`failed\`: a callable provider attempted the readiness journey and failed; include the exact failing step.

Never report \`ready\` merely because a browser binary, CLI, plugin, extension, MCP name, settings entry, or documentation exists. Present one provider decision, then continue through the selected path. Do not run \`./setup\`; it is not a GStack 2 browser setup command.

## Common local readiness journey

Start the dependency-free fixture from this skill root with:

\`node references/support/browser-provider-smoke.mjs\`

The process prints one JSON line containing a loopback URL and remains alive. Through the selected browser provider:

1. Open that exact URL.
2. Verify the heading \`GStack browser readiness\`.
3. Click \`Complete readiness check\`.
4. Verify the page status becomes \`READY\`.
5. When supported, confirm the console message \`gstack-browser-readiness:ready\` and the successful \`POST /proof\` request.
6. Stop the fixture process and confirm it releases its listener.

Mark the provider \`ready\` only after navigation, page reading, and interaction all succeed. The fixture binds to \`127.0.0.1\`, uses a per-run random token, sends no repository data, and does not persist cookies or credentials.

${sections}

## GStack local browser fallback

GStack's existing local Chromium/Playwright implementation remains the only bundled browser backend. Follow \`RUNTIME.md\` for preview and separate install consent, run \`gstack doctor\`, then run the same readiness journey with the \`browse\` launcher. Do not run \`./setup\`, add a cloud browser, remote provider, alternate local backend, or personal-profile attachment as a fallback.
`;
}
