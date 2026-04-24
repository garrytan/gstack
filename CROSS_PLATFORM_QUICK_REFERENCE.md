# Cross-Platform Quick Reference

## For Users: How to Install on Your Platform

### macOS
```bash
./setup --host claude
```

### Linux
```bash
bash setup --host claude
```

### Windows (PowerShell or Command Prompt)
```batch
setup.bat
```

Or with Node.js:
```bash
node setup.ts --host claude
```

---

## For Developers: Quick Patterns

### Import Utilities
```typescript
import * as path from 'path';
import * as os from 'os';
import { getConfigDir, getTempDir, getHomeDir } from '../lib/paths';
import { findBinary } from '../lib/binary-locator';
```

### Common Operations

| Need | Code |
|------|------|
| Config directory | `getConfigDir()` → `~/.gstack` |
| Temp directory | `getTempDir()` → `/tmp` or `%TEMP%` |
| Home directory | `os.homedir()` → `$HOME` or `%USERPROFILE%` |
| Join paths | `path.join(a, b, c)` |
| Find binary | `await findBinary('git')` |
| Expand ~ | `expandHome('~/file')` |

### Pattern: Config File
```typescript
import { getConfigDir } from '../lib/paths';
const configFile = path.join(getConfigDir(), 'config.json');
```

### Pattern: Binary Lookup
```typescript
import { findBinaryOrThrow } from '../lib/binary-locator';
const pdftotext = await findBinaryOrThrow('pdftotext');
```

### Pattern: Temp File
```typescript
import { getTempDir } from '../lib/paths';
const tmpFile = path.join(getTempDir(), `gstack-${Date.now()}`);
```

---

## For Shell Scripts: POSIX Guidelines

### Use: POSIX Shell
```bash
#!/bin/sh  # NOT #!/bin/bash (unless bash features essential)
```

### Available: POSIX Features
```bash
if [ "$var" = "value" ]; then
  mkdir -p "$dir"
  [ -f "$file" ] && rm "$file"
fi
```

### NOT Available: Bash Features
```bash
# Don't use:
[[ -d "$dir" ]]           # Use: [ -d "$dir" ]
source <(command)         # Use: eval "$(command)"
pushd / popd              # Use: (cd dir && ...)
+=                        # Use: var="${var}text"
```

---

## Quick Decision Tree

**I'm working with files/directories:**
→ Use `path.join()` for all paths

**I need the user's home directory:**
→ Use `os.homedir()` (not `process.env.HOME`)

**I need gstack config directory (~/.gstack):**
→ Use `getConfigDir()` from lib/paths.ts

**I need a temporary file:**
→ Use `path.join(getTempDir(), filename)`

**I need to find an external tool:**
→ Use `await findBinary('toolname')`

**I'm writing a shell script:**
→ Use POSIX sh syntax (no bash features)

**I'm splitting a file path:**
→ Use `path.split(path.sep)` (not `/`)

---

## Documentation Map

| Doc | Purpose | Read When |
|-----|---------|-----------|
| `CROSS_PLATFORM_ANALYSIS.md` | Issue inventory | You want to understand all problems |
| `CROSS_PLATFORM_MIGRATION.md` | Implementation guide | You're migrating code |
| `CROSS_PLATFORM_CONTRIBUTING.md` | Developer rules | You're writing code |
| `CROSS_PLATFORM_SUMMARY.md` | Project status | You want an overview |
| `EXAMPLE_MAKE_PDF_UPDATE.ts` | Working example | You need a pattern to follow |
| `EXAMPLE_BROWSE_UPDATE.ts` | Another example | You need different pattern |
| `lib/paths.ts` | API docs | You need function signatures |
| `lib/binary-locator.ts` | API docs | You need binary finding API |

---

## Support Matrix

### Currently Supported
| OS | Bit | Status |
|----|-----|--------|
| macOS | ARM64 | ✅ Works |
| macOS | x64 | 🔄 Needs testing |
| Linux | x64 | 🔄 Needs setup testing |
| Linux | ARM64 | 🔄 Needs setup testing |
| Windows | x64 | 🔄 Needs testing |
| Windows | ARM64 | 🔴 Not yet |

### What Works Today
- ✅ Path utilities on all platforms
- ✅ Binary locator on all platforms
- ✅ Setup scripts on all platforms
- 🔄 Binary execution (needs compilation)
- 🔄 SKILL.md templates (need path updates)

---

## Gotchas to Avoid

1. **Don't use `process.env.HOME`**
   - It's empty on Windows
   - Use `os.homedir()` instead

2. **Don't hardcode `/` in paths**
   - Breaks on Windows
   - Use `path.join()` instead

3. **Don't use bash-specific syntax in sh scripts**
   - Won't work on Windows
   - Stick to POSIX sh

4. **Don't assume `/tmp` exists**
   - Missing on Windows
   - Use `getTempDir()` instead

5. **Don't hardcode tool paths like `/usr/local/bin/pdftotext`**
   - Different on each platform
   - Use `findBinary('pdftotext')`

---

## File Locations Quick Reference

### Config Directories
```
~/.gstack          → getConfigDir()
~/.claude          → getClaudeConfigDir()
~/.claude/skills   → getClaudeSkillsDir()
~/.codex           → getCodexConfigDir()
~/.factory         → getFactoryConfigDir()
```

### Special Directories
```
/tmp               → getTempDir()
~                  → getHomeDir()
~/.gstack-dev      → getDevDir()
~/.gstack/projects → getProjectsDir()
```

---

## Testing Checklist

Before committing:
- [ ] `grep -n "\.split('/')"` — check path splitting uses `path.sep`
- [ ] `grep -n "~/"` — check paths don't hardcode tilde
- [ ] `grep -n "/usr/local/bin"` — check no hardcoded tool paths
- [ ] `grep -n "process.env.HOME"` — check uses `os.homedir()`
- [ ] `shellcheck script.sh` — check shell syntax

---

## Need Help?

| Question | File |
|----------|------|
| What's the problem? | `CROSS_PLATFORM_ANALYSIS.md` |
| How do I fix code? | `CROSS_PLATFORM_MIGRATION.md` |
| What are the rules? | `CROSS_PLATFORM_CONTRIBUTING.md` |
| What's the status? | `CROSS_PLATFORM_SUMMARY.md` |
| How do I use the API? | `lib/paths.ts` and `lib/binary-locator.ts` |
| Show me an example | `EXAMPLE_MAKE_PDF_UPDATE.ts` |

---

## One-Liner Cheat Sheet

```typescript
// Import
import { getConfigDir, getTempDir } from '../lib/paths';
import { findBinary } from '../lib/binary-locator';

// Path
const cfg = path.join(getConfigDir(), 'file.json');

// Temp
const tmp = path.join(getTempDir(), 'file.tmp');

// Binary
const git = await findBinary('git');

// Home
const home = os.homedir();
```

That's it! You now have cross-platform support.
