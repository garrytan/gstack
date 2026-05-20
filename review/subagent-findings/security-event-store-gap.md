Severity: high
File: lib/factory-event-store.ts:129
Issue: The event-log recovery path accepts any sequentially valid tail beyond manifest.eventCount (and ignores a malformed line after it) as recoverable state, then promotes that tail into committed history instead of failing closed.
Why it matters: Anyone who can append to events.jsonl can forge run events/state transitions that become authoritative on read without a matching manifest commit, undermining the event log’s integrity boundary.
Recommendation: Only recover the specific crash pattern the writer can produce, never advance manifest/eventCount from unexpected tail data, and hard-fail on any extra post-commit content outside that narrow recovery case.