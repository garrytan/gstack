# Plan: ordered batch reads for the reconciliation CLI

## Context and scope

Read `README.md`, `src/repository.ts`, and `example.ts` for the existing private
CounterRepository, its runtime, and its error contract. The CLI currently calls
`get` separately for each counter. Add a convenient ordered batch-read method;
this is an API convenience, not a database-load or latency optimization. The
existing methods and runnable example must keep working.

## Proposed behavior — subject to this review

Add `getMany(keys: readonly string[]): Array<number | undefined>` to
CounterRepository. This method is not implemented or approved. The proposed
implementation calls the existing `get` once for each input key, in input order.
Return one result per key in that same order, retaining duplicate keys and
`undefined` results for absent counters. An empty input returns an empty array
without querying SQLite.

Each nonempty read must use the existing key validation and SQLite read path.
Propagate the first validation or database error unchanged; do not convert an
error into `undefined` or return partial success. In particular, reading a key
after the database closes must still fail. Do not cache values, copy the caller's
write values, or change `get`/`set` behavior. This sequence of point reads does not
promise an atomic snapshot or add a transaction.

The caller is this TypeScript CLI and supplies a dense `readonly string[]`.
This change adds no runtime contract for a non-array argument or sparse arrays.
Every supplied key still goes through `get`, including invalid keys; do not add
a separate batch-level key validator or change the existing error messages.

The concrete implementation proposed for review is an empty result array and a
`for...of` loop that pushes `this.get(key)` for each key, then returns the array.
With no keys the loop performs no reads, including when the database is closed.
Do not add a separate empty-input branch or a size cap. Review these steps for
actual incompatibilities; they are specified proposals, not implementation that
already exists or authority to overlook a defect.

The CLI integration is the existing `example.ts`: propose replacing its three
point reads with `getMany(['orders', 'orders', 'missing'])` and printing the three
returned elements. Its visible output remains `2 2 undefined`; no second CLI,
package export, or new call site is needed.

## Implementation and proof to plan

The plan author has selected the following test runner and acceptance recipe for this change. These are accepted requirements to review against, not an existing test suite, completed review, or claim that tests pass. Preserve this recipe; if the proposed implementation conflicts with it or a required proof is missing, surface the concrete issue through the normal decision procedure. The implementation itself remains proposed and unapproved.

The author delegates routine mechanics for this fixed implementation package to
the reviewer: the proposed method, existing CLI call-site integration, the full
acceptance recipe, and synchronization of existing contract documentation and
examples that those changes would otherwise make false. Choose the smallest
complete approach using this repository's existing conventions. Interchangeable
code organization, test mechanics and documentation placement are delegated
implementation details, not separate scope or approval questions. Record their
concrete findings and disposition; carry the necessary code, tests and docs
together without constructing alternative polish packages.

This authority covers requirements and routine planning choices only. It does
not approve the proposed implementation, authorize implementation-file writes,
or declare any review or test complete. Optional polish, duplicate contract
surfaces, new instrumentation and independent proof projects remain excluded.
A material contract change, missing required proof, or conflict with the author's
authority still requires the normal decision procedure. The standing plan-author
actor must select a complete permitted resolution or report the unresolved
conflict; delegation cannot approve an incompatible alternative or erase a
finding. Preserve every required review section, artifact and verification.

- Use Bun's existing built-in `bun test` runner and a new `src/repository.test.ts`. Each test opens an in-memory SQLite database and closes it during cleanup. No dependency, package.json or runner configuration is added.
- Pin the existing regression contract: integer, float, zero and negative get/set round trips; overwrite; missing key yields `undefined`; invalid empty, overlong and non-string keys retain the exact existing TypeError message; NaN and either infinity retain the exact value TypeError message. A second repository over the same database observes the stored value. An integration test runs the existing `example.ts` under Bun and asserts exit 0 and exactly `2 2 undefined\n`. The intentional example change is its proposed `getMany` call; existing get/set and error behavior remain unchanged.
- Pin `getMany` acceptance: empty input returns `[]` on open and closed databases without querying; mixed known/missing results preserve order and length; an uncast readonly tuple call returns the expected ordered results; adjacent and non-adjacent duplicates are retained; a stored zero differs from an absent key. Invalid keys in first, middle and last positions throw the existing error and return no array. A 128-character key succeeds and a 129-character key fails. A nonempty batch after database close throws; a missing table throws rather than returning `undefined` (do not pin an undocumented SQLite error message). The write-between-batches trace observes `[1]`, then after a write observes `[5, 5]`.


The readonly tuple must also be accepted by the TypeScript signature. This is a
required static proof during review, separate from runtime test execution:
verify the proposed declaration is `getMany(keys: readonly string[]): Array<number | undefined>`
and the uncast call `const keys = ['orders', 'missing'] as const; repo.getMany(keys)`.
Explain why that readonly tuple is assignable to `readonly string[]`. Reject a
mutable `string[]` parameter, a cast that removes readonly, or `any` that bypasses
the required type contract. Keep the tuple call in `src/repository.test.ts` to
assert `[2, undefined]` at runtime. `bun test` executes TypeScript without
checking assignability; do not claim it proves the static signature or that a
compiler ran. No checker dependency, config or future-checker promise replaces
this required static proof. A genuine type incompatibility still requires the
normal decision procedure; this clarification does not approve implementation.


Review the method's type and control flow, its call-site use in the CLI, and all
acceptance requirements above. These are required tests to plan, not tests
already implemented or passing.

The proposed implementation performs one SELECT per input key and allocates an
output array proportional to the input length. Assess that cost and any relevant
limits for this internal synchronous API; do not claim a measured speedup.
Caching, shared invalidation state, SQL batching, new public packaging, and
background processing are outside this change. Surface any real incompatibility
with the requested method rather than assuming the baseline contract away.

This review plans the required proofs above; it does not add a benchmark project,
an arbitrary large-batch acceptance target, or TODOs for the excluded features.
Keep the review's complete architecture, code-quality, test and performance
outcomes, required diagrams, test-plan artifact and final review report. The
method remains unimplemented until the plan is approved and implemented.
