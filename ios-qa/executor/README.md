# XCUITest execution contract

This directory separates a logical iOS QA flow from where it runs. The same
semantic flow is routed to an iOS Simulator or a provisioned physical device.
It emits an `xcodebuild` argv specification; it does not invoke a shell, alter
signing, or provision a phone.

The checked-in XCUITest runner consumes inline base64 JSON from
`GSTACK_IOS_QA_FLOW_JSON_BASE64` on physical devices, because a device test
runner cannot open a path on the Mac. Simulator runs may also consume
`GSTACK_IOS_QA_FLOW_PATH`. It resolves each selector in
`selectorCandidates()` order, waits for hittability, performs the action, and
evaluates the optional post-action verification. A runner must return a
blocked/unsupported step result rather than falling back to screen coordinates.

Generate a plan:

```bash
bun ios-qa/executor/cli.ts flow.json target.json runner.json
```

The JSON result is either `ready` with an argument-safe `xcodebuild` command,
`blocked` with remediation, or `unsupported` with the offending step id.
