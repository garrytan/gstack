# Cross-Platform Development Guidelines for gstack

**Target Audience**: Contributors and developers modifying gstack  
**Updated**: April 20, 2026

---

## Quick Reference

### When Writing Code

| Scenario | ❌ Don't | ✅ Do |
|----------|--------|-----|
| Home directory | `process.env.HOME` | `os.homedir()` |
| Config dir | `~/.gstack` | `getConfigDir()` from lib/paths.ts |
| Temp dir | `/tmp/file` | `path.join(getTempDir(), 'file')` |
| Path joining | `a/b/c` or `a + '/' + b` | `path.join(a, b, c)` |
| Path splitting | `path.split('/')` | `path.split(path.sep)` |
| Binary finding | Hardcoded paths | `findBinary()` from lib/binary-locator.ts |
| Shell scripts | Bash-only syntax | POSIX sh compatible |

### Import Patterns

```typescript
// Path utilities
import * as path from 'path';
import * as os from 'os';
import { 
  getConfigDir, 
  getTempDir, 
  getHomeDir,
  isPathWithin,
  expandHome 
} from '../lib/paths';

// Binary locator
import { 
  findBinary, 
  findBinaryOrThrow,
  getSearchPaths,
  describeSearchPaths 
} from '../lib/binary-locator';
```

---

## Rules for Cross-Platform Code

### Rule 1: Always Use `path.join()` for Path Construction

**Why**: Handles path separators (`/` vs `\`) automatically

```typescript
// ❌ Never hardcode separators
const filePath = `src/folder/file.ts`;
const dir = `${baseDir}/subfolder`;

// ✅ Always use path.join()
const filePath = path.join('src', 'folder', 'file.ts');
const dir = path.join(baseDir, 'subfolder');
```

### Rule 2: Use `os.homedir()` or Path Utilities

**Why**: Works on Windows, macOS, and Linux; expands correctly

```typescript
// ❌ Never use process.env.HOME (empty on Windows)
const configDir = `${process.env.HOME}/.config`;

// ✅ Use os.homedir() or path utilities
import { getConfigDir } from '../lib/paths';
const configDir = getConfigDir(); // ~/.gstack on all platforms

// Or if you need the home directory
import * as os from 'os';
const homeDir = os.homedir();
```

### Rule 3: Use `path.sep` for Splitting Paths

**Why**: Handles Windows `\` vs Unix `/` differences

```typescript
// ❌ Never hardcode /
const parts = filePath.split('/');

// ✅ Use path.sep
const parts = filePath.split(path.sep);
```

### Rule 4: Use `getTempDir()` for Temporary Files

**Why**: Returns correct platform temp directory

```typescript
import { getTempDir } from '../lib/paths';
import * as path from 'path';

// ❌ Hardcoded Unix path
const tmpFile = `/tmp/gstack-${Date.now()}`;

// ✅ Platform-aware
const tmpFile = path.join(getTempDir(), `gstack-${Date.now()}`);
```

### Rule 5: Use Binary Locator for External Tools

**Why**: Finds tools in platform-specific locations

```typescript
import { findBinary, findBinaryOrThrow } from '../lib/binary-locator';

// ❌ Hardcoded Unix paths
const pdftotext = '/usr/local/bin/pdftotext';

// ✅ Cross-platform lookup
const pdftotext = await findBinaryOrThrow('pdftotext');
```

### Rule 6: Write POSIX-Compatible Shell Scripts

**Why**: Bash-specific features don't work on Windows

```bash
# ❌ Bash-specific features
source <(command 2>/dev/null) || true
[[ -d "$dir" ]] && rm -rf "$dir"
pushd "$dir"

# ✅ POSIX-compatible alternatives
eval "$(command 2>/dev/null)" || true
[ -d "$dir" ] && rm -rf "$dir"
(cd "$dir" && ...)  # Instead of pushd/popd
```

### Rule 7: Use Environment Variables in SKILL.md Templates

**Why**: Allows dynamic path substitution at runtime

```markdown
# ❌ Hardcoded paths in SKILL.md
mkdir -p ~/.gstack/analytics
source <(~/.claude/skills/gstack/bin/gstack-config get ...) || true

# ✅ Use environment variables or dynamic discovery
mkdir -p "$GSTACK_CONFIG_DIR/analytics"
if [ -x "$GSTACK_BIN/gstack-config" ]; then
  eval "$("$GSTACK_BIN/gstack-config")"
fi
```

### Rule 8: Test on Multiple Platforms

**Why**: Code that works on macOS might fail on Windows or Linux

```bash
# Before committing code that touches paths, binaries, or shell:
# 1. Test on macOS (Intel and ARM if possible)
# 2. Test on Windows (PowerShell and WSL)
# 3. Test on Linux (Ubuntu/Debian preferred)
```

---

## File Type Guidelines

### TypeScript Files

```typescript
import * as path from 'path';
import * as os from 'os';
import { getConfigDir, getTempDir } from '../lib/paths';
import { findBinary } from '../lib/binary-locator';

// ✓ Use path utilities
const configFile = path.join(getConfigDir(), 'config.json');
const tempDir = getTempDir();

// ✓ Use findBinary for external tools
const git = await findBinary('git');
```

### Shell Scripts (in templates or bin/)

```bash
#!/bin/sh  # ← Use 'sh' not 'bash' for maximum compatibility
# (or #!/usr/bin/env bash if bash features are essential)

# ✓ Use POSIX-compatible syntax
if [ -d "$dir" ]; then
  echo "found"
fi

# ✓ Use environment variables
mkdir -p "$CONFIG_DIR"

# ✗ Avoid bash-specific syntax
# Don't use: [[ ]], source <(), pushd/popd, +=
```

### SKILL.md Templates

```markdown
## Step 0: Detect platform and base branch

# ✓ Use dynamic path resolution
mkdir -p ~/.gstack/sessions

# ✓ Provide fallback for missing tools
if [ -x ~/.claude/skills/gstack/bin/gstack-config ]; then
  eval "$(~/.claude/skills/gstack/bin/gstack-config)"
fi

# ✓ Use environment variables if available
if [ -n "$GSTACK_BIN" ]; then
  source <("$GSTACK_BIN/gstack-config" export)
fi
```

### Tests

```typescript
import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { IS_WINDOWS, getTempDir } from '../lib/paths';

describe('cross-platform', () => {
  test('works on all platforms', () => {
    // ✓ Test with platform utilities
    const tmpDir = getTempDir();
    expect(tmpDir).toBeTruthy();
    
    // ✓ Conditional tests for platform-specific behavior
    if (IS_WINDOWS) {
      expect(tmpDir).toMatch(/^[A-Z]:/);
    } else {
      expect(tmpDir).toBe('/tmp');
    }
  });
});
```

---

## Checklist Before Committing

- [ ] No hardcoded paths with `/` or `\`
- [ ] All paths use `path.join()` for construction
- [ ] All path splitting uses `path.sep`
- [ ] No direct use of `process.env.HOME`
- [ ] Used `getConfigDir()` for config paths
- [ ] Used `getTempDir()` for temp paths
- [ ] Used `findBinary()` for external tools
- [ ] Tested on macOS, Windows, and Linux (or added `[skip-platform]` comment)
- [ ] Shell scripts use POSIX sh syntax (or bash explicitly)
- [ ] No hardcoded `/usr/local/bin/` or Windows-specific paths
- [ ] SKILL.md templates use variables instead of hardcoded paths

### Commands to Run Before Committing

```bash
# Check for hardcoded paths
grep -n "~/" your-file.ts your-file.sh
grep -n "/usr/local/bin" your-file.ts
grep -n "\.split('/')" your-file.ts

# Check for non-POSIX shell syntax
shellcheck your-file.sh

# Run tests
bun test

# Check with slop-scan
npx slop-scan scan . --file your-file.ts
```

---

## Common Pitfalls

### Pitfall 1: Using `process.env.HOME`
```typescript
// ❌ Empty on Windows
const home = process.env.HOME;

// ✅ Works on all platforms
const home = os.homedir();
```

### Pitfall 2: Hardcoding Path Separators
```typescript
// ❌ Breaks on Windows
const file = `src/subfolder/file.ts`;
const split = path.split('/');

// ✅ Works on all platforms
const file = path.join('src', 'subfolder', 'file.ts');
const split = path.split(path.sep);
```

### Pitfall 3: Bash-Specific Syntax in Shell Scripts
```bash
# ❌ Only works with bash
source <(echo "export VAR=value")
[[ -d "$dir" ]] && cd "$dir"

# ✅ Works with any POSIX shell
eval "$(echo 'export VAR=value')"
[ -d "$dir" ] && cd "$dir"
```

### Pitfall 4: Forgetting to Handle Spaces in Paths
```typescript
// ❌ Breaks if path has spaces
execSync(`${binary} ${arg}`);

// ✅ Quotes or execFile
execFileSync(binary, [arg]);
```

### Pitfall 5: Case-Sensitive File Operations
```typescript
// ❌ Works on Linux but not macOS/Windows
if (fs.existsSync('/Users/username/file.txt'))

// ✅ Use path utilities to normalize
const file = path.normalize(filePath);
```

---

## Platform Detection When Necessary

```typescript
import { IS_WINDOWS, IS_MAC, IS_LINUX } from '../lib/paths';

if (IS_WINDOWS) {
  // Windows-specific code
} else if (IS_MAC) {
  // macOS-specific code
} else if (IS_LINUX) {
  // Linux-specific code
}
```

**Use sparingly** — most code should be platform-agnostic.

---

## Resources

- [Node.js path module docs](https://nodejs.org/api/path.html)
- [Node.js os module docs](https://nodejs.org/api/os.html)
- [POSIX sh standard](https://pubs.opengroup.org/onlinepubs/9699919799/)
- [shellcheck](https://www.shellcheck.net/) — Shell script linter
- [lib/paths.ts](./lib/paths.ts) — Cross-platform path utilities
- [lib/binary-locator.ts](./lib/binary-locator.ts) — Binary finding

---

## Examples in the Codebase

### ✅ Good Examples
- `browse/src/platform.ts` — Platform-aware constants
- `browse/src/cookie-import-browser.ts` — Platform-specific browser detection
- `lib/worktree.ts` — Consistent use of path.join()

### 🔄 Being Updated
- `make-pdf/src/pdftotext.ts` — Switching to binary locator
- `browse/src/cli.ts` — Handling platform-specific binary names
- SKILL.md templates — Using environment variables for paths

---

## Questions?

1. Read [CROSS_PLATFORM_MIGRATION.md](./CROSS_PLATFORM_MIGRATION.md) for detailed migration patterns
2. Check [lib/paths.ts](./lib/paths.ts) for complete API
3. Check [lib/binary-locator.ts](./lib/binary-locator.ts) for binary finding examples
4. See EXAMPLE_*.ts files for working implementations
