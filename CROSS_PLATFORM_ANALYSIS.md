# Cross-Platform Analysis Report: gstack Repository

**Generated**: April 20, 2026  
**Current State**: macOS-centric (arm64 Mach-O binaries only)  
**Target**: Windows, macOS, and Linux universal support

---

## Executive Summary

The gstack repository currently supports macOS only due to:
1. **Binaries compiled for macOS arm64 only** (Mach-O format)
2. **Hardcoded Unix paths** throughout (100+ instances of `~/.gstack`, `~/.claude`)
3. **Bash-specific shell scripts** that won't run on Windows
4. **Unix-specific system paths** (e.g., `/usr/local/bin/pdftotext`)

This report details all issues found and provides a remediation roadmap.

---

## Critical Issues (Blockers for Windows/Linux)

### 1. Binary Compilation — Mach-O Only
| Issue | File | Impact | Effort |
|-------|------|--------|--------|
| Binaries not cross-platform | `package.json` build script | Won't run on Windows/Linux | M |
| No Windows arm64 support | Build config | Can't run on Windows ARM | S |
| Hardcoded output paths | `package.json` | Single platform target | S |

**Details**:
```json
"build": "...bun build --compile browse/src/cli.ts --outfile browse/dist/browse..."
```
- Compiles to `browse/dist/browse`, `design/dist/design` only
- No platform detection in output filename (should be: `browse-darwin-arm64`, `browse-win32-x64`, etc.)
- No parallel builds for multiple platforms

**Fix Approach**:
1. Use Bun's `--target` flag to compile for all platforms in one build
2. Rename outputs to include platform/arch: `browse-${platform}-${arch}`
3. Create platform-detection logic in wrapper scripts

---

### 2. Hardcoded Unix Home Paths (100+ instances)
| Pattern | Count | Files | Example |
|---------|-------|-------|---------|
| `~/.gstack/` | 50+ | SKILL.md files, bin scripts | `~/.gstack/.proactive-prompted` |
| `~/.claude/skills/gstack` | 30+ | Multiple files | Preamble template |
| `~/.codex/`, `~/.factory/` | 10+ | Setup scripts | Host-specific paths |
| `/tmp/` | 5+ | Source code | `TEMP_DIR = '/tmp'` |
| `/usr/local/bin/` | 3+ | make-pdf | pdftotext binary lookup |

**Impact**:
- **Windows**: `~/.` is not valid Windows path syntax; creates `~\` weirdness
- **Cross-shell**: Some shells don't expand `~`; should use `$HOME` or programmatic homedir()
- **Path separators**: Using `/` on Windows creates invalid paths

**Example Issues**:
- `make-pdf/src/setup.ts` line 45: `process.stderr.write("  cd ~/.claude/skills/gstack && ./setup\n");`
- `make-pdf/src/pdftotext.ts` line 64: `"/usr/local/bin/pdftotext"` — not in PATH on Windows
- All SKILL.md files: `mkdir -p ~/.gstack/analytics` won't work on Windows

**Fix Approach**:
1. Create `lib/paths.ts` with platform-aware getters:
   - `getConfigDir()` → `~/.gstack` (or Windows equivalent)
   - `getHomeDir()` → uses `os.homedir()`
   - `getTempDir()` → uses `os.tmpdir()`
2. Replace all hardcoded `~/.gstack` with calls to these utilities
3. Update SKILL.md templates to use variables instead of literals

---

### 3. Bash-Only Setup Script
| Issue | Details |
|-------|---------|
| Shebang | `#!/usr/bin/env bash` — won't run on Windows CMD/PowerShell |
| Syntax | Uses process substitution `<()`, extended test operators, source/eval |
| No Windows alternative | Single setup script, no .bat or Node.js fallback |

**Impact**:
- Windows users must use WSL or Cygwin/MSYS2 to run setup
- CI/CD pipelines that run on Windows can't use this script

**Example bash-specific syntax**:
```bash
source <(~/.claude/skills/gstack/bin/gstack-repo-mode 2>/dev/null) || true
if [ "$HOST" = "codex" ]; then ...
```

**Fix Approach**:
1. Port setup script to Node.js (`setup.ts` or `setup.js`)
2. Or create platform-aware wrapper: `setup` (on Unix) calls `setup.ts`, `setup.bat` (on Windows) calls Node.js
3. Replace all `source <()` calls with proper command substitution

---

### 4. Unix-Specific System Paths
| Tool | Current Path | Windows Equivalent | Impact |
|------|--------------|-------------------|--------|
| pdftotext | `/usr/local/bin/pdftotext` | `pdftotext.exe` in PATH | Binary not found on Windows |
| bash | Implicit via shebang | `sh.exe` or `bash.exe` (WSL) | Scripts don't run natively |

**Fix Approach**:
1. Use `which` command to find binaries (cross-platform)
2. Check multiple standard locations per platform
3. Fail gracefully with helpful error message

---

## Medium-Priority Issues

### 5. Path Separator Not Abstracted
**Issue**: Code uses hardcoded `/` instead of `path.sep`
**Impact**: On Windows, paths like `src/foo` are valid but `/` should be normalized
**Example**: 
```typescript
// BAD: hardcoded /
const filePath = `src/folder/file.ts`;

// GOOD: use path module
const filePath = path.join('src', 'folder', 'file.ts');
```

**Status**: `browse/src/platform.ts` has `isPathWithin()` using `path.sep`, but not used consistently elsewhere.

---

## Existing Cross-Platform Support (Good News!)

### Files with Correct Patterns
1. **browse/src/platform.ts** ✓
   - `IS_WINDOWS` constant
   - `TEMP_DIR` resolution  
   - `isPathWithin()` with `path.sep`

2. **browse/src/cookie-import-browser.ts** ✓
   - Detects platform: `process.platform === 'darwin' | 'linux' | 'win32'`
   - Handles macOS/Linux/Windows differences in browser data directories
   - Uses `os.homedir()` and proper path joining

3. **lib/worktree.ts** ✓
   - Consistent use of `path.join()`
   - No hardcoded separators
   - Proper home directory resolution with `os.homedir()`

**Approach**: Extend these good patterns to the rest of the codebase.

---

## Remediation Roadmap

### Phase 1: Path Infrastructure (Foundation)
**Effort**: 4-6 hours | **Priority**: Critical
- [ ] Create `lib/paths.ts` with platform-aware path utilities
- [ ] Update all TypeScript files to import and use these utilities
- [ ] Update all shell scripts to use proper home directory resolution
- [ ] Test on Windows, macOS, Linux

### Phase 2: Binary Cross-Compilation
**Effort**: 6-8 hours | **Priority**: Critical
- [ ] Update build script to compile for all platforms
- [ ] Create platform detection in wrapper scripts
- [ ] Update `package.json` bin field with platform-specific paths
- [ ] Test builds on CI for Windows, macOS, Linux

### Phase 3: Script Portability
**Effort**: 8-12 hours | **Priority**: High
- [ ] Port setup script to Node.js (or create Windows .bat version)
- [ ] Update SKILL.md.tmpl files to use cross-platform syntax
- [ ] Test setup on Windows, macOS, Linux
- [ ] Update documentation with setup instructions per platform

### Phase 4: System Path Resolution
**Effort**: 3-4 hours | **Priority**: High
- [ ] Create binary locator utility for tools like pdftotext
- [ ] Update make-pdf to use cross-platform binary lookup
- [ ] Test on systems without standard paths

### Phase 5: SKILL.md References
**Effort**: 4-5 hours | **Priority**: Medium
- [ ] Audit all SKILL.md.tmpl for hardcoded paths
- [ ] Create template variables for dynamic path substitution
- [ ] Regenerate all SKILL.md files
- [ ] Test skill invocations on Windows

### Phase 6: CI/CD and Documentation
**Effort**: 3-4 hours | **Priority**: Medium
- [ ] Add Windows and Linux to CI matrix
- [ ] Update README with platform-specific setup instructions
- [ ] Document cross-platform conventions for contributors

---

## Files Requiring Changes

### Critical Path Changes
| File | Issue | Change | Effort |
|------|-------|--------|--------|
| `lib/paths.ts` | NEW | Create utilities | S |
| `package.json` | build script | Add cross-compilation | M |
| `setup` | bash only | Port to Node.js or add .bat | M |
| `make-pdf/src/pdftotext.ts` | hardcoded paths | Use binary locator | S |
| `browse/src/cli.ts` | bin resolution | Handle platform binaries | S |

### High-Impact Changes
| Files | Issue | Change | Count |
|-------|-------|--------|-------|
| `*.md.tmpl` | hardcoded paths | Use variables | 20+ |
| `bin/*` scripts | bash-only | make portable or replace | 10+ |
| TypeScript files | path construction | Use path.join() | 5+ |

---

## Testing Checklist

Before merging cross-platform changes:

- [ ] Setup on macOS (Intel and ARM)
- [ ] Setup on Windows 11/10 (native PowerShell, not WSL)
- [ ] Setup on Ubuntu/Debian Linux
- [ ] Build binaries on each platform
- [ ] Binaries run on native systems (cross-platform verification)
- [ ] All skill invocations work on each platform
- [ ] Configuration files created in correct platform directories
- [ ] Paths in generated files use correct separators

---

## Success Criteria

✅ When complete:
1. User can install gstack on Windows, macOS, or Linux with one setup command
2. Binaries run natively on their platform (not WSL/MSYS)
3. Configuration stored in platform-appropriate locations
4. All skills work on all platforms
5. No hardcoded paths in shell scripts or generated files
6. CI tests run on Windows, macOS, and Linux

---

## Appendix A: Hardcoded Path Examples (Sample)

```
SKILL.md files (50+ instances):
- mkdir -p ~/.gstack/sessions
- mkdir -p ~/.gstack/analytics  
- [ -f ~/.gstack/.proactive-prompted ]
- touch ~/.gstack/.telemetry-prompted
- find ~/.gstack/analytics -mmin -120

Scripts:
- cd ~/.claude/skills/gstack && ./setup
- ~/.claude/skills/gstack/bin/gstack-config

Source files:
- const sessionsDir = path.join(homedir(), ".codex", "sessions");
- const dataDir = path.join(os.homedir(), 'Library', 'Application Support');  // macOS-specific
```

---

## Appendix B: Platform Feature Matrix

| Feature | Windows | macOS | Linux | Notes |
|---------|---------|-------|-------|-------|
| Binary (Mach-O) | ✗ | ✓ | ✗ | Current state |
| Binary (PE/COFF) | ✗ | ✗ | ✗ | Needed for Windows |
| Binary (ELF) | ✗ | ✗ | ✗ | Needed for Linux |
| Home directory detection | ✓* | ✓ | ✓ | *Needs testing |
| Shell script execution | ✗ | ✓ | ✓ | *Bash only |
| Path separators | ✗ | ✓ | ✓ | Hardcoded `/` |

*After fixes applied

---

**Next Steps**: 
1. Review this report
2. Prioritize phases
3. Begin Phase 1 (Path Infrastructure)
