# AI Slop Detection Guide
**Language-Agnostic Patterns for /review and /cso**
Date: 2026-04-07

---

## Why This Exists

AI-assisted code has statistically measurable quality problems. The numbers:

- **1.7x more issues per PR** -- AI-authored PRs contain 1.7x as many issues as human PRs
  (CodeRabbit analysis of 470 PRs, 2024)
- **Copy/paste rose from 8.3% to 12.3%** -- a 48% increase in duplicated code blocks since
  AI tools went mainstream (GitClear, 211M lines of production code, 2024)
- **36-40% of AI-generated snippets contain security vulnerabilities** -- across real codebases
  in production use (Snyk State of AI Security, 2024)
- **90-100% of AI-generated repos exhibit "comments everywhere"** -- mass documentation of
  trivial, self-evident code, a reliable AI telltale (OX Security, 300 open-source projects, 2024)

The patterns below teach /review and /cso how to catch what AI tools are trained to produce
but not trained to question. Every pattern includes why it matters beyond "it looks bad."

---

## Category 1: Safety Slop

### P1 -- Unhandled Errors

**Why It Is Slop**
AI models trained on tutorial code absorb the tutorial habit of wrapping things in try/catch
without doing anything useful in the catch block. Silent swallowing converts a recoverable error
into a phantom: the caller believes success, the system is in an undefined state. Real incidents
(the 2021 Facebook outage, the 2022 Cloudflare BGP event) involved silent error suppression that
allowed cascading failure because no alert fired and no retry was triggered.

**Bad Example**
```typescript
async function saveUser(user: User): Promise<void> {
  try {
    await db.users.insert(user);
  } catch (e) {
    // TODO: handle this
  }
}
```

**Correct Approach**
```typescript
async function saveUser(user: User): Promise<User> {
  try {
    return await db.users.insert(user);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'Failed to save user');
    throw new DatabaseError('User save failed', { cause: err });
  }
}
```

**Detection**
- catch block containing only a comment, console.log, or nothing at all
- catch (_) or catch (e) where e is never referenced in the handler
- Python: `except: pass` or `except Exception: pass`
- Ruby: `rescue nil` or `rescue => e` with empty body
- Go: `if err != nil { _ = err }` or empty if-err block with no return/panic

---

### P2 -- Missing Input Validation

**Why It Is Slop**
AI models generate parsing and business logic code that assumes well-formed input because the
training examples assumed well-formed input. System boundaries -- HTTP handlers, CLI argument
parsers, message queue consumers, file readers -- are where attacker-controlled data enters.
Skipping validation here means every downstream function operates on untrusted data.
OWASP A03:2021 (Injection) and A04:2021 (Insecure Design) both trace to missing boundary checks.

**Bad Example**
```javascript
app.post('/transfer', async (req, res) => {
  const { fromAccount, toAccount, amount } = req.body;
  await bank.transfer(fromAccount, toAccount, amount);
  res.json({ ok: true });
});
```

**Correct Approach**
```javascript
import { z } from 'zod';

const TransferSchema = z.object({
  fromAccount: z.string().uuid(),
  toAccount: z.string().uuid(),
  amount: z.number().positive().max(100_000),
});

app.post('/transfer', async (req, res) => {
  const result = TransferSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }
  await bank.transfer(result.data.fromAccount, result.data.toAccount, result.data.amount);
  res.json({ ok: true });
});
```

**Detection**
- HTTP handler bodies that destructure req.body / request.json() without any schema parse
- CLI tools that read process.argv or sys.argv and use values directly without type checks
- Functions at module boundaries whose parameters are typed as any, unknown, or object
  but are never narrowed before use

---

### P3 -- Unsafe Type Coercion

**Why It Is Slop**
Implicit coercions are a class of subtle bugs that AI generates freely because the code looks
right at a glance. JavaScript == operator, Python silent int() truncation, Ruby automatic
string-to-number coercions, and TypeScript "as" casts all allow data to change shape silently.
Lost precision in financial calculations, truncated IDs, and widened security surfaces are
common consequences.

**Bad Example**
```typescript
function applyDiscount(price: any, discount: any): number {
  return price - discount; // silently NaN if discount is "10%"
}

// Elsewhere:
const userId = req.params.id as number; // req.params is always string
```

**Correct Approach**
```typescript
function applyDiscount(price: number, discount: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(discount)) {
    throw new TypeError(`applyDiscount: expected finite numbers, got ${price}, ${discount}`);
  }
  return price - discount;
}

const rawId = req.params.id;
const userId = parseInt(rawId, 10);
if (Number.isNaN(userId)) {
  return res.status(400).json({ error: 'Invalid user ID' });
}
```

**Detection**
- TypeScript "as T" casts on values that cross a trust boundary (HTTP, file system, env vars)
- JavaScript == with values of different inferred types
- Python int(x) without a try/except ValueError where x comes from external input
- Ruby .to_i on strings where empty string silently becomes 0

---

### P4 -- Silent Failure Paths

**Why It Is Slop**
AI code generators excel at the happy path. When generating conditional logic they often include
the success branch and omit -- or leave as a comment -- the failure branch. The result is code
that returns undefined/nil/None in error cases instead of raising, logging, or triggering a
fallback, making bugs invisible until production.

**Bad Example**
```python
def find_config(path: str) -> dict:
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    # no else: returns None implicitly
```

**Correct Approach**
```python
def find_config(path: str) -> dict:
    if not os.path.exists(path):
        raise FileNotFoundError(
            f'Config not found at {path}. '
            f'Copy config.example.json to {path} to get started.'
        )
    with open(path) as f:
        return json.load(f)
```

**Detection**
- Functions with multiple code paths where not all paths have an explicit return/throw/raise
- if without else where the else case changes program correctness (not just a guard clause)
- TypeScript return type T but function has a path that returns undefined without annotation
- Optional chaining chains that never check the final undefined before use

---

### P5 -- SQL and Command Injection

**Why It Is Slop**
String interpolation in queries and shell commands is the single most well-documented class of
vulnerability in software history (OWASP A03, 30+ years of CVEs). AI still generates it because
it is the simplest syntactic pattern to produce. It appears in scaffolding, migrations, admin
scripts, and helper utilities -- precisely the code that gets less scrutiny than application code.

**Injection-vulnerable patterns to detect (NEVER generate these):**

SQL injection: building query strings via template literals or string concatenation with
user-controlled values instead of using parameterized queries or query builders.

Command injection: passing user-controlled values into shell-execution functions (subprocess.run
with shell=True in Python, exec/execSync in Node.js with interpolated strings, Ruby backtick
with variables) instead of using argument arrays (execFile, spawn, subprocess.run with a list
argument and shell=False).

**Correct Approach -- SQL**
```javascript
// Parameterized query via query builder
const users = await db('users').where({ email }).select('*');

// Alternatively with tagged template literals (Kysely, Drizzle, etc.)
const users = await db.selectFrom('users').where('email', '=', email).selectAll().execute();
```

**Correct Approach -- Shell commands**
```javascript
// Always use argument arrays, never shell string interpolation
import { execFileSync } from 'node:child_process';
execFileSync('convert', [inputFile, '-resize', '800x', outputFile]);
// execFile defaults to shell: false which prevents shell injection entirely
```

**Detection**
- Template literals or string concatenation used to build SQL query strings
- subprocess.run / Popen with shell=True and any variable in the command argument
- Ruby backtick strings or %x{...} containing variables
- db.raw(...), knex.raw(...), or ActiveRecord.find_by_sql(...) with interpolated variables
- Any shell-execution function whose command argument is built from user-supplied values

---

## Category 2: Performance Slop

### P6 -- N+1 Queries

**Why It Is Slop**
The N+1 pattern is the most common performance antipattern in AI-generated data access code.
AI models learn from ORM tutorials that show "for post in posts: post.comments" without
explaining that each access fires a query. In production, this degrades linearly with data size:
a page that loads 100 posts fires 101 queries, typically discovered only when a customer reports
slowness at scale.

**Bad Example**
```javascript
const posts = await Post.findAll();
for (const post of posts) {
  const comments = await Comment.findAll({ where: { postId: post.id } }); // N queries
  post.dataValues.comments = comments;
}
```

**Correct Approach**
```javascript
const posts = await Post.findAll({
  include: [{ model: Comment, as: 'comments' }], // 1 JOIN query
});
```

**Detection**
- await inside a for / forEach loop where the awaited call is a database or HTTP query
- ORM .find(), .findAll(), .where(), .fetch() inside loops
- Array of IDs followed by a loop calling single-ID lookups -- should be a whereIn / batch fetch
- Django: queryset iteration with field access that triggers lazy loading inside a loop

---

### P7 -- Unnecessary Data Copying

**Why It Is Slop**
AI code frequently clones entire objects "to be safe" -- a defensive habit that is correct in
mutable state scenarios but wasteful when the original is never mutated. Deep clones of large
data structures are particularly expensive: they allocate O(N) memory and take O(N) time for
every call.

**Bad Example**
```javascript
function processItems(items: Item[]): Summary {
  const copy = JSON.parse(JSON.stringify(items)); // deep clone -- never mutated
  return copy.reduce((acc, item) => {
    acc.total += item.price;
    return acc;
  }, { total: 0 });
}
```

**Correct Approach**
```javascript
function processItems(items: readonly Item[]): Summary {
  return items.reduce((acc, item) => ({
    ...acc,
    total: acc.total + item.price,
  }), { total: 0 });
}
```

**Detection**
- JSON.parse(JSON.stringify(...)) where the result is only read, never mutated
- structuredClone(...) / _.cloneDeep(...) followed by read-only operations
- Python copy.deepcopy(x) where x is iterated but not modified
- Ruby .dup or .clone on large arrays/hashes used only for reading

---

### P8 -- Collect-Then-Iterate

**Why It Is Slop**
AI models see arrays as the universal data structure and materialize them by default. Collecting
all items into memory before processing them is wasteful when the source is a generator,
database cursor, or stream, and the consumer only needs one item at a time or an aggregate.
This pattern causes OOM crashes on large datasets.

**Bad Example**
```python
# Loads all 10M rows into memory before summing
all_records = list(db.execute("SELECT amount FROM transactions"))
total = sum(row['amount'] for row in all_records)
```

**Correct Approach**
```python
# Streams: never materializes the full result set
total = sum(row['amount'] for row in db.execute("SELECT amount FROM transactions"))
```

**Detection**
- list(generator) or Array.from(iterable) immediately iterated and discarded
- [...spreadOfLargeStream] used only for .forEach or .reduce
- Python list(cursor.fetchall()) followed by a single-pass iteration
- Ruby relation.to_a.each where relation.each would stream

---

### P9 -- Allocation in Hot Loops

**Why It Is Slop**
Object and array allocation inside tight loops is generated freely by AI because each line looks
innocent in isolation. At runtime, each iteration allocates heap memory that must be garbage
collected, turning O(n) logic into O(n) GC pressure. In Node.js, Python, and Ruby this causes
GC pauses that manifest as p99 latency spikes.

**Bad Example**
```typescript
function renderRows(data: Row[]): string[] {
  return data.map(row => {
    const formatted = { ...row, date: row.date.toISOString() }; // new object per row
    return JSON.stringify(formatted);
  });
}
```

**Correct Approach**
```typescript
// When the loop is genuinely hot (>100K iterations), pre-allocate result array
// and avoid creating unnecessary intermediate objects:
function renderRows(data: Row[]): string[] {
  const result = new Array<string>(data.length);
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    result[i] = JSON.stringify({ ...row, date: row.date.toISOString() });
  }
  return result;
}
```

**Detection**
- new SomeClass(...) or object spread inside a loop body over large arrays (>10K items)
- .map(() => ({ ... })) chained with another .map() -- intermediate array allocated and discarded
- Python list comprehensions creating tuples/dicts inside tight loops that are then aggregated
- Regex compilation inside a loop: new RegExp(...) or re.compile(...) per iteration

---

### P10 -- String Concatenation in Loops

**Why It Is Slop**
Strings are immutable in most languages. Concatenating strings in a loop creates a new string
object on every iteration, giving O(n^2) time and space complexity. AI generates this pattern
because it reads naturally and tests (which use small inputs) pass. In production with thousands
of items it becomes the slowest function in the codebase.

**Bad Example**
```ruby
def build_csv(rows)
  result = ""
  rows.each do |row|
    result += row.join(",") + "\n"  # O(n^2) allocations
  end
  result
end
```

**Correct Approach**
```ruby
def build_csv(rows)
  rows.map { |row| row.join(",") }.join("\n") + "\n"
  # For large datasets: use Ruby's CSV library or StringIO for true streaming
end
```

**Detection**
- result += string or result = result + string inside a loop
- JavaScript str += ... in a for/while loop body
- Python s = s + chunk in a loop (fix: ''.join(parts))
- PHP $html .= ... inside foreach

---

## Category 3: Structure Slop

### P11 -- God Functions

**Why It Is Slop**
AI models generate complete, working implementations in a single function because that minimizes
the tokens needed to express a solution. The result is functions that validate input, fetch data,
transform it, apply business rules, format output, and log -- all in one body. God functions are
the leading cause of untestable code and the leading predictor of future bugs (Yamashita and
Moonen, 2013: god class/method presence correlates with 3.8x higher bug density in subsequent
releases).

**Bad Example**
```typescript
async function handleCheckout(req: Request, res: Response) {
  // 80+ lines: validate cart, check inventory, apply discounts,
  // charge payment, send email, update analytics, return response
  const { userId, cartId } = req.body;
  if (!userId || !cartId) { return res.status(400).json({ error: 'Missing fields' }); }
  const cart = await db.carts.findById(cartId);
  const items = cart.items.filter(i => i.quantity > 0);
  let discount = 0;
  if (items.length > 5) discount = 0.1;
  // ... 60 more lines mixing concerns
}
```

**Correct Approach**
```typescript
async function handleCheckout(req: Request, res: Response) {
  const params = validateCheckoutRequest(req.body);
  const cart = await CartService.getValidatedCart(params.cartId, params.userId);
  const order = await OrderService.createFromCart(cart);
  await PaymentService.charge(order);
  await NotificationService.sendOrderConfirmation(order);
  res.json(OrderSerializer.toResponse(order));
}
```

**Detection**
- Functions >50 lines of non-comment, non-blank code
- Functions containing more than two distinct concerns
- More than 3 levels of nesting (if inside for inside if inside try)
- Functions with more than 4 parameters (use a parameter object)

---

### P12 -- Copy-Paste Duplication

**Why It Is Slop**
The GitClear study showing copy/paste rising from 8.3% to 12.3% maps directly to how AI
generates code: it writes what you asked for, not what already exists in your codebase. The
result is reimplemented formatDate, truncate, parseError, and buildUrl utilities that diverge
over time, have inconsistent edge case handling, and must be fixed in multiple places when a
bug is found.

**Bad Example**
```javascript
// utils/orders.js
function formatCurrency(amount) {
  return '$' + (amount / 100).toFixed(2);
}

// utils/invoices.js -- identical logic, written by AI without searching the codebase
function formatPrice(cents) {
  return '$' + (cents / 100).toFixed(2);
}
```

**Correct Approach**
```javascript
// lib/formatting.ts -- single source of truth
export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(cents / 100);
}
```

**Detection**
- Two functions >10 lines with >80% structural similarity (same operations, different variable names)
- Utilities that duplicate lodash/stdlib functions
- Date formatting, currency formatting, or URL building done more than once with different implementations
- Duplicated security utility logic (two token validators, two HMAC verifiers)

---

### P13 -- Premature Abstraction

**Why It Is Slop**
AI generates abstractions because abstractions look sophisticated. An interface with one
implementation, a plugin system with one plugin, a strategy pattern with one strategy -- all
add indirection without benefit. The abstraction cost is real (more files to understand, more
places a bug can hide, more boilerplate) while the flexibility benefit is theoretical.

**Bad Example**
```typescript
// Three files for what is used in exactly one place, ever
interface UserNotifier {
  notify(user: User, message: string): Promise<void>;
}

class EmailUserNotifier implements UserNotifier {
  async notify(user: User, message: string): Promise<void> {
    await sendEmail(user.email, message);
  }
}

container.bind<UserNotifier>('UserNotifier').to(EmailUserNotifier);
```

**Correct Approach**
```typescript
// Until there is a second notifier, this is the right amount of abstraction:
async function notifyUser(user: User, message: string): Promise<void> {
  await sendEmail(user.email, message);
}
```

**Detection**
- Interface / abstract class / protocol with exactly one implementation and no planned second
- Strategy or factory pattern where the factory always returns the same type
- Dependency injection for a class instantiated in exactly one place
- Generic type parameters where the type is only ever bound to one concrete type in the codebase

---

### P14 -- Debugging Residue

**Why It Is Slop**
AI-assisted development cycles generate intermediate artifacts: variant files (handler_v2.ts,
handler_backup.js), commented-out attempts, console.log / print / puts debugging statements,
and TODO comments that were never TODOs -- just placeholders the AI left because it ran out of
context. These residues confuse future readers, inflate binary size, and occasionally expose
sensitive data via debug logs that reach production.

**Bad Example**
```python
def process_payment(amount, card):
    print(f"DEBUG: processing {amount}")  # partial data in logs
    # result = old_process(amount, card)  # keeping this just in case
    result = new_process(amount, card)
    print(f"DEBUG: result was {result}")
    return result
```

**Correct Approach**
```python
def process_payment(amount: Decimal, card: CardToken) -> PaymentResult:
    logger.info('Processing payment', extra={'amount': str(amount), 'card_last4': card.last4})
    return payment_gateway.charge(amount, card)
```

**Detection**
- console.log, print(, puts, p, pp, debugger; in non-test production code
- Files named *_v2.*, *_backup.*, *_old.*, *_copy.*
- Commented-out code blocks longer than 3 lines
- TODO / FIXME / HACK comments without a linked ticket or owner
- Debug calls that log credential-adjacent fields (card numbers, tokens, passwords, API keys)

---

### P15 -- Feature Flag Without Cleanup Plan

**Why It Is Slop**
AI generates feature flags as afterthought scaffolding: if (FLAGS.newCheckout). Without a
removal date, owner, and cleanup ticket, feature flags accumulate. Research by Stripe (2022)
found teams accumulating 100+ "temporary" flags over 18 months, each adding a code path that
must be tested. Flags become permanent, the old code path never dies, and the codebase forks
into two parallel realities.

**Bad Example**
```javascript
if (featureFlags.get('new_payment_flow')) {
  return newPaymentFlow(cart);
} else {
  return legacyPaymentFlow(cart);
}
// No expiry date. No linked ticket. No owner.
```

**Correct Approach**
```javascript
// Flag created: 2026-04-07, owner: @payments-team
// Removal ticket: https://linear.app/acme/issue/PAY-892
// Removal date: 2026-05-01 (after 100% rollout confirmed)
if (featureFlags.get('new_payment_flow')) {
  return newPaymentFlow(cart);
} else {
  return legacyPaymentFlow(cart);
}
```

**Detection**
- featureFlags.get(...) / isEnabled(...) / flag(...) calls with no adjacent comment containing
  owner + removal date
- Feature flag names that appear in the codebase but not in a flags registry or config file
- Flags that have been 100% on in production config for more than 30 days (old branch is dead code)

---

## Category 4: Idiomatic Slop

### P16 -- Wrong Abstraction Level

**Why It Is Slop**
AI models trained on Java and C++ enterprise patterns generate class hierarchies and design
patterns in contexts where the language idiom is a function or a module. JavaScript does not
need a UserRepositoryFactory; Python does not need a StrategyPatternVisitorAdapter. These
patterns add conceptual overhead without the compile-time safety benefits that make them
worthwhile in statically typed OOP languages.

**Bad Example**
```javascript
// Java-style factory in Node.js
class UserRepositoryFactory {
  static create(db) {
    return new UserRepository(db);
  }
}

class UserRepository {
  constructor(db) { this.db = db; }
  async findById(id) { return this.db.users.findById(id); }
}

const repo = UserRepositoryFactory.create(db);
```

**Correct Approach**
```javascript
// Module-level functions: idiomatic Node.js / TypeScript
import { db } from './db.js';

export async function findUserById(id: string): Promise<User | null> {
  return db.users.findById(id);
}
```

**Detection**
- Singleton classes with only static methods -- should be a module
- Factory classes that create one type of object -- use a constructor function
- Abstract classes in Python that only raise NotImplementedError -- use Protocol or duck typing
- Classes with only one method that is not a constructor -- should be a function

---

### P17 -- Verbose Patterns Where Idioms Exist

**Why It Is Slop**
AI fills context windows with what it was asked to produce, not with the idiomatic shorthand
the language designer intended. Verbose null checks instead of optional chaining, manual
array-building instead of map/filter, explicit promise chaining instead of async/await -- all
tell the reviewer that the model was optimizing for correctness-at-first-glance rather than
readability.

**Bad Example**
```javascript
// Manual null guard chain
let city = null;
if (user !== null && user !== undefined) {
  if (user.address !== null && user.address !== undefined) {
    city = user.address.city;
  }
}

// Manual array filter and map
const results = [];
for (let i = 0; i < items.length; i++) {
  if (items[i].active) {
    results.push(items[i].name.toUpperCase());
  }
}
```

**Correct Approach**
```javascript
const city = user?.address?.city ?? null;

const results = items
  .filter(item => item.active)
  .map(item => item.name.toUpperCase());
```

**Detection**
- !== null && !== undefined checks where optional chaining would suffice
- for loops that build result arrays -- prefer map/filter/reduce
- .then().then() promise chains in async functions -- should be await
- Python: result = []; for x in xs: if cond: result.append(...) -- should be list comprehension

---

### P18 -- Stringly-Typed APIs

**Why It Is Slop**
AI generates string literals for enumerated states because it is the fastest way to express
the concept without defining a type. status === 'active' scattered across 12 files means a
typo ('actve') produces no compile error and no runtime error -- just a silent wrong branch.
This pattern scales catastrophically: the more AI code you ship, the more magic strings
accumulate, and the more refactors require grep-and-pray.

**Bad Example**
```typescript
function handleOrder(order: { status: string }) {
  if (order.status === 'pending') { /* ... */ }
  if (order.status === 'fulfilled') { /* ... */ }
  if (order.status === 'cancelled') { /* ... */ }
}

// Elsewhere: order.status = 'cancled'; // typo, no compiler error
```

**Correct Approach**
```typescript
const OrderStatus = {
  PENDING: 'pending',
  FULFILLED: 'fulfilled',
  CANCELLED: 'cancelled',
} as const;
type OrderStatus = typeof OrderStatus[keyof typeof OrderStatus];

function handleOrder(order: { status: OrderStatus }) {
  if (order.status === OrderStatus.CANCELLED) { /* ... */ }
}
```

**Detection**
- String literals used in === comparisons for status, type, role, or state fields
- Function parameters typed as string where the valid values are a closed set
- Switch statements on string values with no default that throws or exhaustively handles all cases
- Python string comparisons for event types / states scattered across multiple files

---

### P19 -- Inconsistent Naming

**Why It Is Slop**
AI generates names in the style of whatever it last saw in context. Within a single file it
may switch between camelCase, snake_case, and PascalCase. Abbreviations appear without
convention: usr, u, user, and userObj for the same concept. This makes grep and semantic
search unreliable, makes code review slower, and signals that multiple "authors" touched the
file without reconciling style.

**Bad Example**
```python
def process_UserData(usr_obj, API_key, maxRetries):
    user_name = usr_obj['userName']
    usrEmail = usr_obj['email_address']
    APIresponse = call_api(API_key, user_name, usrEmail, maxRetries)
    return APIresponse
```

**Correct Approach**
```python
def process_user_data(user: UserData, api_key: str, max_retries: int) -> ApiResponse:
    return call_api(api_key, user['username'], user['email'], max_retries)
```

**Detection**
- Mixed camelCase and snake_case within the same file (except language boundary crossings like JSON keys)
- Parameter names with Hungarian notation (strName, boolIsActive, intCount)
- Abbreviations shorter than 4 characters that are not universally standard
- Inconsistent plurality: item and items and itemList for the same concept in the same scope

---

## Category 5: Documentation Slop

### P20 -- Echo Comments

**Why It Is Slop**
The OX Security study finding that 90-100% of AI repos have "comments everywhere" points to a
specific failure mode: the AI comments every line because that is what tutorial code does. Echo
comments restate the code in English without adding information. They create maintenance debt
(the comment and code diverge), pad files (inflating token counts for future AI reads), and
crowd out the comments that actually matter: the why, the tradeoffs, the non-obvious invariants.

**Bad Example**
```javascript
// Increment the counter
counter++;

// Check if the user is active
if (user.isActive) {
  // Send the welcome email
  sendWelcomeEmail(user);
}
```

**Correct Approach**
```javascript
counter++;

// We only send welcome emails to active users because soft-deleted accounts
// retain their email address; sending to them triggers unsubscribe complaints.
if (user.isActive) {
  sendWelcomeEmail(user);
}
```

**Detection**
- Comments that use only words already present in the adjacent identifier names
- Comment density above 1 comment per 3 lines in non-configuration code
- Comments on single-expression lines where the expression is a standard stdlib call
- The word "simply" in comments: "simply increments the counter"

---

### P21 -- Missing Docs on Public API

**Why It Is Slop**
While AI over-documents implementation details, it under-documents behavioral contracts --
exactly the information consumers need. Public functions without documented parameters, return
values, error conditions, and side effects shift the documentation burden to callers, who read
the source to discover what a unit test or type signature should tell them.

**Bad Example**
```typescript
export function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  // 40 lines of retry logic with no JSDoc
}
```

**Correct Approach**
```typescript
/**
 * Retries an async function with exponential backoff.
 *
 * @param fn - The async function to retry. Must be idempotent.
 * @param options.maxAttempts - Maximum attempts before rejecting (default: 3)
 * @param options.baseDelayMs - Initial delay in ms, doubled each attempt (default: 100)
 * @param options.retryOn - Predicate to determine if an error warrants a retry.
 *   Defaults to retrying on all errors.
 * @returns The resolved value of the first successful attempt.
 * @throws The error from the final failed attempt.
 */
export function retry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
```

**Detection**
- Exported functions/classes/types with no JSDoc / docstring / YARD / godoc
- Functions that throw more than one error type with no documentation of which conditions trigger which
- @param present but @throws absent on functions that visibly throw
- Public module with no module-level docstring explaining purpose and usage

---

### P22 -- Hallucinated References

**Why It Is Slop**
AI models cite modules, functions, and documentation URLs that do not exist. In code, this
produces imports that fail at runtime. In comments and documentation, it produces references
to library APIs that changed several versions ago, or never existed. These references are
particularly dangerous in security-sensitive contexts where a developer might trust the AI's
cited "best practice" without verifying.

**Bad Example**
```typescript
// Using the recommended Node.js crypto.scryptSync for password hashing as per
// https://nodejs.org/api/crypto.html#passwordhashing (this URL does not exist)
import { hashPassword } from 'node:crypto/passwords'; // this module does not exist
```

**Correct Approach**
```typescript
// Node.js crypto.scrypt: https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen
import { scrypt, randomBytes } from 'node:crypto';
```

**Detection**
- Import paths that reference sub-paths not present in the package's actual exports
- URLs in comments that should be verified (curl -I or browser check)
- References to @deprecated APIs cited as current best practice
- Function names in comments that do not exist in the imported module's public API

---

### P23 -- AI Vocabulary in Prose

**Why It Is Slop**
Certain words appear in AI output at rates far above their base frequency in human writing.
These words signal that prose was generated without the author having a specific point to make:
the text is filler dressed as content. In code comments and PR descriptions, filler wastes
reader time and erodes trust in the documentation's accuracy.

**Blacklisted words for code docs and PR descriptions:**
delve, leverage, robust, seamless, crucial, facilitate, utilize, comprehensive, innovative,
cutting-edge, paramount, harness, streamline, synergy, holistic, paradigm, empower,
transformative, unlock, game-changing

**Bad Example**
```
This PR leverages a robust, seamless approach to facilitate comprehensive user authentication,
utilizing cutting-edge paradigms to empower the team to harness synergistic transformations.
```

**Correct Approach**
```
This PR adds token-based authentication to the /api routes. Tokens expire after 24 hours.
Refresh tokens are stored in HttpOnly cookies to prevent XSS theft.
```

**Detection**
- Any blacklisted word appearing in PR title, PR body, or code comments
- PR descriptions with more than 20% sentences containing no specific technical nouns
  (file names, function names, error codes)
- Commit messages containing "ensure", "leverage", or "utilize"

---

## Category 6: Testing Slop

### P24 -- Happy-Path-Only Tests

**Why It Is Slop**
AI generates tests that mirror the implementation: "given valid input, verify expected output."
The cases that actually catch bugs are the ones AI skips: empty inputs, boundary values, invalid
types, network failures, partial writes, concurrent access. A test suite with 90% coverage and
zero error-path tests is a false confidence instrument -- it proves the happy path works while
leaving all failure modes unverified.

**Bad Example**
```javascript
describe('createUser', () => {
  it('creates a user successfully', async () => {
    const user = await createUser({ name: 'Alice', email: 'alice@example.com' });
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Alice');
  });
  // No test for: duplicate email, missing name, invalid email format,
  // DB connection failure, empty string name, name >255 chars
});
```

**Correct Approach**
```javascript
describe('createUser', () => {
  it('creates a user with valid input', async () => { /* ... */ });
  it('rejects duplicate email with UserExistsError', async () => { /* ... */ });
  it('rejects missing name with ValidationError', async () => { /* ... */ });
  it('rejects email without @ with ValidationError', async () => { /* ... */ });
  it('truncates name at 255 chars', async () => { /* ... */ });
  it('propagates DB errors as DatabaseError', async () => { /* ... */ });
});
```

**Detection**
- Test files where more than 80% of it()/test() blocks use the words "successfully", "works", "correctly"
- Test files with no use of rejects, throws, toThrow, assertRaises, expect_raises
- Mocked dependencies configured only for success -- no mock for the error path
- Zero tests covering 4xx/5xx response handling in API client code

---

### P25 -- Tests That Test the Mock

**Why It Is Slop**
When AI generates tests with mocks, it sometimes generates assertions on the mock itself rather
than on the behavior the mock is standing in for. The test passes because the mock returns what
it was told to return and the assertion verifies it returned that value -- a tautology. Real
behavior (error handling, data transformation, side effects) is untested. This is the most
insidious category because 100% of these tests always pass.

**Bad Example**
```javascript
it('sends a welcome email on signup', async () => {
  const mockSend = jest.fn().mockResolvedValue({ success: true });
  emailService.send = mockSend;

  await signup({ email: 'alice@example.com' });

  // Only tests that we called the mock with these args.
  // Does NOT test email content, from address, or failure handling.
  expect(mockSend).toHaveBeenCalledWith({
    to: 'alice@example.com',
    subject: 'Welcome!',
  });
});
```

**Correct Approach**
```javascript
it('sends a welcome email on signup', async () => {
  const sentEmails: Email[] = [];
  const fakeEmailService = { send: async (email: Email) => { sentEmails.push(email); } };
  const app = createApp({ emailService: fakeEmailService });

  await app.signup({ email: 'alice@example.com', name: 'Alice' });

  expect(sentEmails).toHaveLength(1);
  expect(sentEmails[0].to).toBe('alice@example.com');
  expect(sentEmails[0].subject).toContain('Welcome');
  expect(sentEmails[0].body).toContain('Alice'); // verifies personalization
});

it('handles email send failure gracefully', async () => {
  const failingEmailService = { send: async () => { throw new Error('SMTP timeout'); } };
  const app = createApp({ emailService: failingEmailService });
  // Verifies signup resolves even if email fails -- tests behavior, not mock
  await expect(app.signup({ email: 'alice@example.com' })).resolves.toBeDefined();
});
```

**Detection**
- Tests where the only assertion is expect(mockFn).toHaveBeenCalledWith(...) with no assertion
  on return value or state change
- Mocks that are never configured for failure scenarios
- Tests that would pass if the implementation simply called the mock directly with its arguments
- jest.spyOn / sinon.stub patterns where the spy return value is what the test asserts

---

## PR Review Checklist

Use this checklist when running /review or /cso --code. Each item maps to a pattern above.

### Safety
- [ ] P1: No bare catch blocks -- every catch logs and re-throws or returns a typed error
- [ ] P2: All system boundaries (HTTP handlers, CLI args, queue consumers) validate input with a schema
- [ ] P3: No unsafe "as T" casts or == comparisons across type boundaries
- [ ] P4: All conditional branches return, throw, or have an explicit else
- [ ] P5: No string interpolation in SQL queries or shell-execution calls

### Performance
- [ ] P6: No database or HTTP calls inside loops -- batch fetches only
- [ ] P7: No JSON.parse(JSON.stringify(...)) or cloneDeep(...) on read-only data
- [ ] P8: Large collections are streamed, not collected into memory before iteration
- [ ] P9: No object or array allocation inside loops over large collections (>10K items)
- [ ] P10: No string concatenation in loops -- use join() or a builder

### Structure
- [ ] P11: No function >50 lines or with more than 2 distinct responsibilities
- [ ] P12: No utility reimplemented when a stdlib or existing helper does the same thing
- [ ] P13: No interface/abstract class with exactly one implementation
- [ ] P14: No debug print statements or commented-out code in non-test files
- [ ] P15: Every feature flag has a comment with owner, creation date, and removal ticket

### Idioms
- [ ] P16: No factory patterns where a module function is appropriate
- [ ] P17: No manual null-guard chains where optional chaining or safe navigation applies
- [ ] P18: No string literals for closed-set values -- use enums or const maps
- [ ] P19: Naming convention is consistent throughout the file (no mixed case styles)

### Documentation
- [ ] P20: No echo comments -- every comment adds information not present in the code
- [ ] P21: All exported functions have parameter, return type, and error documentation
- [ ] P22: All cited URLs and function references exist and are current
- [ ] P23: No AI vocabulary (leverage, robust, seamless, delve, etc.) in any prose

### Testing
- [ ] P24: Error paths tested -- at minimum one test per distinct exception the function can throw
- [ ] P25: Mock assertions verify behavior (state change, return value) not just invocation
