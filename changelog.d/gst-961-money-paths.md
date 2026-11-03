### Fixed

- **A docs or data PR no longer gets a money reader because a file name says "cost", and reading a `cost_usd` field no longer counts as money code (GST-961, GST-962).** On gstack-evals#138, a results write-up planned as docs at light depth still dispatched a second, targeted money reader, because `wiki/.../cost-gstack-full.tsv` has "cost" in its name. On gstack-evals#139, an analysis module that only sums and prints per-trial `cost_usd` raised the money class. A data file that no code reads now never counts as money, by its name or its rows, and a `_usd` or `Usd` name counts only when it says cap, limit, max, budget, spend, price, fee, bill or payment, or when a `<` or `>` compares it. Spend caps, budgets, billing paths and paid-provider calls still count. Every other class still reads unread data files. Over the last 100 main commits, no commit's depth, class, risk classes or targeted classes changed.

### Tests

- `test/review-targeted.test.ts`: #138's file list plans no targeted reader, and the same file read by code still plans money. Neither a `cost_usd` read nor a `cost_usd` report names money. Positive controls: caps, budgets, limits, spend checks, comparisons, `spend_cap`, a billing path, a provider client, and a secret in an unread data file.
- `test/review-risk-redos.test.ts`: `usdMoney` stays under 250 ms on 100,000-character lines of `_usd` names, comparisons and member chains.
