# Cross-Platform Migration Guide for gstack

**Status**: Foundation complete, migration in progress  
**Target**: Full Windows, macOS, and Linux support  
**Last Updated**: April 20, 2026

---

## Quick Start

### For Users
1. **macOS/Linux**: Run `./setup` (existing bash script)
2. **Windows**: Run `setup.bat` or `node setup.ts`
3. **Any platform**: Run `bun run build` to compile for your current OS

### For Developers
- Use the new path utilities: `import { getConfigDir, getTempDir } from '../lib/paths'`
- Use the binary locator: `import { findBinary } from '../lib/binary-locator'`
- Always use `path.join()` for path construction, never hardcode `/` or `\`

---

## New Files Added

### Core Libraries
- **`lib/paths.ts`** — Platform-aware path resolution
  - `getConfigDir()` → `~/.gstack` (cross-platform)
  - `getHomeDir()` → home directory (cross-platform)
  - `getTempDir()` → temp directory (cross-platform)
  - `expandHome()`, `isPathWithin()`, etc.

- **`lib/binary-locator.ts`** — Find executables on any platform
  - `findBinary(command)` → returns path or null
  - `findBinaryOrThrow(command)` → throws descriptive error
  - Platform-specific search paths (Windows, macOS, Linux)

### Setup Scripts
- **`setup`** — Existing bash script (improved with cross-platform notes)
- **`setup.ts`** — Node.js version (works on Windows, macOS, Linux)
- **`setup.bat`** — Windows batch version (alternative to bash)

---

## Migration Checklist for Developers

### Phase 1: Update Path References (In Progress)

#### In TypeScript Files
```typescript
// ❌ BAD (hardcoded path)
const configFile = `${process.env.HOME}/.gstack/config.json`;
const tempFile = `/tmp/gstack-${Date.now()}`;

// ✅ GOOD (use utilities)
import { getConfigDir, getTempDir } from '../lib/paths';
const configFile = path.join(getConfigDir(), 'config.json');
const tempFile = path.join(getTempDir(), `gstack-${Date.now()}`);
```

#### In Shell Scripts / SKILL.md Templates
```bash
# ❌ BAD
mkdir -p ~/.gstack/analytics
ls ~/.claude/skills/gstack/bin/*

# ✅ GOOD (using environment variable)
source <(~/.claude/skills/gstack/bin/gstack-config export GSTACK_DIR) 2>/dev/null || true
mkdir -p "$GSTACK_DIR/analytics"
ls "$GSTACK_DIR/bin"/*
```

#### In SKILL.md.tmpl Templates
```markdown
# ❌ BAD
source <(~/.claude/skills/gstack/bin/gstack-slug)
eval "$(~/.claude/skills/gstack/bin/gstack-repo-mode)"

# ✅ GOOD (with fallback)
if [ -n "$GSTACK_BIN" ]; then
  source <("$GSTACK_BIN/gstack-slug")
  eval "$("$GSTACK_BIN/gstack-repo-mode")"
else
  # Fallback: find gstack dynamically
  GSTACK_BIN="$(~/.claude/skills/gstack/bin/gstack-global-discover 2>/dev/null)" || true
fi
```

### Phase 2: Update Binary References

#### For make-pdf and other tools
```typescript
// ❌ BAD
const paths = ['/usr/local/bin/pdftotext', '/usr/bin/pdftotext'];
const pdftotext = paths.find(p => fs.existsSync(p));

// ✅ GOOD
import { findBinary } from '../lib/binary-locator';
const pdftotext = await findBinary('pdftotext');
if (!pdftotext) {
  throw new Error('pdftotext not found. Install with: brew install poppler');
}
```

### Phase 3: Update SKILL.md Files

Run regeneration after updating templates:
```bash
bun run gen:skill-docs
```

This generates platform-aware SKILL.md files from the updated templates.

---

## File-by-File Migration Status

### Core Infrastructure
| File | Status | Notes |
|------|--------|-------|
| `lib/paths.ts` | ✅ New | Core path utilities |
| `lib/binary-locator.ts` | ✅ New | Binary finding |
| `setup` | 🟡 Updated | Added cross-platform notes |
| `setup.ts` | ✅ New | Node.js version |
| `setup.bat` | ✅ New | Windows version |

### High Priority (Blocks Windows)
| File | Status | Work |
|------|--------|------|
| `package.json` (build script) | 🔴 TODO | Add cross-platform compilation |
| `make-pdf/src/pdftotext.ts` | 🔴 TODO | Use binary locator |
| `make-pdf/src/setup.ts` | 🔴 TODO | Use path utilities |
| `browse/src/cli.ts` | 🔴 TODO | Handle platform binary names |

### Medium Priority (Path References)
| Files | Status | Count |
|-------|--------|-------|
| `*.md.tmpl` files | 🔴 TODO | 20+ hardcoded paths |
| `bin/*` scripts | 🔴 TODO | 10+ scripts need updates |
| TypeScript files | 🟡 Partial | ~5 files need path.join() |

### Documentation
| File | Status |
|------|--------|
| `CROSS_PLATFORM_ANALYSIS.md` | ✅ Created |
| This guide | ✅ Created |
| `README.md` | 🔴 TODO |

---

## Platform-Specific Patterns

### Path Construction
```typescript
// ❌ DON'T: hardcoded separators
const dir = `src/folder/file.ts`;
const home = `${process.env.HOME}/.config`;

// ✅ DO: use path module
import * as path from 'path';
const dir = path.join('src', 'folder', 'file.ts');
const home = path.join(process.env.HOME || os.homedir(), '.config');
```

### Binary Detection
```typescript
// ❌ DON'T: hardcoded paths
const which = process.platform === 'darwin' ? '/usr/local/bin/which' : 'which';

// ✅ DO: use system which/where
import { findBinary } from '../lib/binary-locator';
const binary = await findBinary('git');
```

### Home Directory
```typescript
// ❌ DON'T: hardcoded tilde
const config = `~/.gstack/config.json`;

// ✅ DO: use utilities
import { getConfigDir } from '../lib/paths';
const config = path.join(getConfigDir(), 'config.json');
```

### Temporary Files
```typescript
// ❌ DON'T: hardcoded /tmp
const tmp = `/tmp/gstack-${Date.now()}`;

// ✅ DO: use getTempDir()
import { getTempDir } from '../lib/paths';
const tmp = path.join(getTempDir(), `gstack-${Date.now()}`);
```

### Shell Scripts
```bash
# ❌ DON'T: hardcoded paths and bash-only syntax
source <(~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null) || true
mkdir -p ~/.gstack/projects

# ✅ DO: use environment variables and POSIX-compatible syntax
if [ -x "$GSTACK_BIN/gstack-slug" ]; then
  eval "$("$GSTACK_BIN/gstack-slug")" || true
fi
mkdir -p "$GSTACK_CONFIG_DIR/projects"
```

---

## Testing on Multiple Platforms

### macOS (Intel and ARM)
```bash
# Test setup
./setup --host claude

# Test binaries work
./browse/dist/browse --help
./design/dist/design --help
```

### Linux (Ubuntu/Debian)
```bash
# Test setup
bash setup --host claude

# Test binaries work
./browse/dist/browse --help
```

### Windows (PowerShell or Command Prompt)
```cmd
# Test setup
setup.bat

# OR use Node.js version
node setup.ts --host claude

# Test binaries work
.\browse\dist\browse.exe --help
```

---

## Common Patterns to Replace

### Pattern 1: ~/.gstack References
**Before**:
```bash
mkdir -p ~/.gstack/analytics
[ -f ~/.gstack/.telemetry-prompted ] && echo "yes"
```

**After**:
```bash
# Source gstack config to get GSTACK_CONFIG_DIR
source <(~/.claude/skills/gstack/bin/gstack-config export) 2>/dev/null || true
mkdir -p "$GSTACK_CONFIG_DIR/analytics"
[ -f "$GSTACK_CONFIG_DIR/.telemetry-prompted" ] && echo "yes"
```

### Pattern 2: ~/.claude References
**Before**:
```typescript
const skillsDir = path.join(process.env.HOME, '.claude', 'skills');
```

**After**:
```typescript
import { getClaudeSkillsDir } from '../lib/paths';
const skillsDir = getClaudeSkillsDir();
```

### Pattern 3: /tmp References
**Before**:
```typescript
const tmpFile = `/tmp/gstack-${Date.now()}`;
```

**After**:
```typescript
import { getTempDir } from '../lib/paths';
const tmpFile = path.join(getTempDir(), `gstack-${Date.now()}`);
```

### Pattern 4: Hardcoded Separators
**Before**:
```typescript
const joined = `src/folder/file.ts`;
const split = input.split('/');
```

**After**:
```typescript
const joined = path.join('src', 'folder', 'file.ts');
const split = input.split(path.sep);
```

---

## Verifying Your Changes

After updating a file:

1. **Check imports**
   ```bash
   grep -n "~/\|\.gstack\|\.claude" your-file.ts
   # Should only find comments or error messages
   ```

2. **Check hardcoded separators**
   ```bash
   grep -n "\.split('/')" your-file.ts
   # Should use path.sep instead
   ```

3. **Run tests**
   ```bash
   bun test your-file.test.ts
   ```

4. **Lint with slop-scan**
   ```bash
   npx slop-scan scan . --file your-file.ts
   ```

---

## Known Limitations (Current)

1. **Binary Compilation** — Bun doesn't have built-in cross-compilation
   - Workaround: Run build on each target platform
   - Alternative: Use matrix builds in CI

2. **Shell Scripts in Windows** — Bash-specific syntax won't work natively
   - Solution: Provide Node.js alternative (setup.ts)
   - Alternative: Use WSL for Windows development

3. **Path Environment Expansion** — Some shells don't expand `~`
   - Solution: Use `expandHome()` utility or `$HOME` variable

---

## Next Steps

### Immediate (Week 1)
- [ ] Update `package.json` build script for multi-platform compilation
- [ ] Fix `make-pdf/src/pdftotext.ts` to use binary locator
- [ ] Update `make-pdf/src/setup.ts` to use path utilities

### Short Term (Week 2-3)
- [ ] Audit all SKILL.md.tmpl files for hardcoded paths
- [ ] Create pattern examples for template authors
- [ ] Update gen-skill-docs to substitute path variables

### Medium Term (Week 4)
- [ ] Test setup on Windows, macOS, Linux
- [ ] Update CI to test on all three platforms
- [ ] Update README with platform-specific setup instructions

### Long Term
- [ ] Bun cross-compilation support (when available)
- [ ] Native Windows shell script support
- [ ] Windows-specific optimizations

---

## Resources

- [Node.js path module](https://nodejs.org/api/path.html)
- [Node.js os module](https://nodejs.org/api/os.html)
- [Bun compilation](https://bun.sh/docs/bundler/executables)
- [Cross-platform JavaScript](https://github.com/sindresorhus/os-name)

---

## Questions?

See `CROSS_PLATFORM_ANALYSIS.md` for detailed analysis.  
See `lib/paths.ts` for API documentation.  
See `lib/binary-locator.ts` for binary finding patterns.
