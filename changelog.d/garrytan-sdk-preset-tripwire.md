### Fixed

- Agent SDK evals can no longer run on the SDK's bare stub prompt by accident. Every `runAgentSdkTest` and direct SDK `query()` caller now passes Claude Code's preset or names why it doesn't. The runner refuses a missing, empty or bare-string prompt, and a free tripwire test scans test/ and scripts/ for the same mistake. docs/TESTING_INTERNALS.md#agent-sdk-system-prompt says to record which prompt each arm used, and to treat a null result from an arm on the stub as FIX-METHOD.
