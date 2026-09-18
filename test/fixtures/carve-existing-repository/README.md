# Counter repository

This private TypeScript workspace module serves the reconciliation CLI. Its
developers are teammates writing small Bun batch jobs. There is no public package,
HTTP API, tenant data, or browser UI. Bun is the CLI's existing runtime; SQLite is
built in. No dependency install, credentials, or database server is needed.

## Try the current API

Run `bun run example.ts`. It writes a counter and prints `2 2 undefined`: two reads
of the known key and one absent key. Both known-key reads currently query SQLite.

```ts
import { Database } from 'bun:sqlite';
import { CounterRepository } from './src/repository';
const db = new Database(':memory:');
const counters = new CounterRepository(db);
counters.set('orders', 2);
console.log(counters.get('orders'), counters.get('orders'), counters.get('missing'));
db.close();
```

## Contract

`get(key)` returns a number or `undefined`. `set(key, value)` commits before
returning. These synchronous methods are the only reads and writes of the table,
owned by this one CLI process. Values are scalars; keys are explicit strings with
no ambient user, tenant, or locale context. The repository has no list queries,
external writers, or asynchronous transaction callbacks.

An empty or overlong key throws `TypeError: Counter key must contain 1-128
characters`. A nonfinite value throws `TypeError: Counter value must be a finite
number`. SQLite errors propagate to the caller, which fails the batch job; they
are never represented as a missing counter. Always close the database after use.

The cache in PLAN.md is proposed work. The current module, example, runtime,
calling convention and error contract above are the baseline to review against.
