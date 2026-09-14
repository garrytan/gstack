# Plan: Snapshot Dropdown/Autocomplete Interactive Element Detection

## Problem

`snapshot -i` misses dropdown/autocomplete items on modern web apps. These elements:
1. Are often `<div>`/`<li>` with click handlers but no semantic ARIA roles
2. Live inside dynamically-created portals/popovers (floating containers)
3. Don't appear in Playwright's accessibility tree (`ariaSnapshot()`)

The `-C` flag (cursor-interactive scan) was designed for this but:
- Requires separate flag — agents using `-i` don't get it automatically
- Skips elements that HAVE an ARIA role (even if the ARIA tree missed them)
- Doesn't prioritize popover/portal containers where dropdown items live

## Root Cause

Playwright's `ariaSnapshot()` builds from the browser's accessibility tree. Dynamically-rendered popovers (React portals, Radix Popover, etc.) may not be in the accessibility tree if:
- The component doesn't set ARIA roles
- The portal renders outside the scoped `body` locator's subtree timing
- The browser hasn't updated the accessibility tree yet after DOM mutation

## Changes

### 1. Auto-enable cursor-interactive scan with `-i` flag

**File:** `browse/src/snapshot.ts`

When `-i` (interactive) is passed, automatically include the cursor-interactive scan. This means agents always see clickable non-ARIA elements when they ask for interactive elements.

The `-C` flag remains as a standalone option for non-interactive snapshots.

```
if (opts.interactive) {
  opts.cursorInteractive = true;
}
```

### 2. Add popover/portal priority scanning

**File:** `browse/src/snapshot.ts` (inside cursor-interactive evaluate block)

Before the general cursor:pointer scan, specifically scan for visible floating containers (popovers, dropdowns, menus) and include ALL their direct children as interactive:

Detection heuristics for floating containers:
- `position: fixed` or `position: absolute` with `z-index >= 10`
- Has `role="listbox"`, `role="menu"`, `role="dialog"`, `role="tooltip"`, `[data-radix-popper-content-wrapper]`, `[data-floating-ui-portal]`, etc.
- Appeared recently in the DOM (not in initial page load)
- Is visible (`offsetParent !== null` or `position: fixed`)

For each floating container, include child elements that:
- Have text content
- Are visible
- Have cursor:pointer OR onclick OR role="option" OR role="menuitem"
- Tag with reason `popover-child` for clarity

### 3. Remove the `hasRole` skip in cursor-interactive scan

**File:** `browse/src/snapshot.ts`

Currently: `if (hasRole) continue;` — skips any element with an ARIA role, assuming the ARIA tree already captured it.

Problem: if the ARIA tree MISSED the element (timing, portal, bad DOM structure), it falls through both systems.

Fix: Only skip if the element's role is in `INTERACTIVE_ROLES` AND it was actually captured in the main refMap. Otherwise include it.

Since we can't easily check the refMap from inside `page.evaluate()`, the simpler fix: remove the `hasRole` skip entirely for elements inside detected floating containers. For elements outside floating containers, keep the `hasRole` skip as-is (to avoid duplicates in normal page content).

### 4. Add dropdown test fixture and tests

**File:** `browse/test/fixtures/dropdown.html`

HTML page with:
- A combobox input that shows a dropdown on focus/type
- Dropdown items as `<div>` with click handlers (no ARIA roles)
- Dropdown items as `<li>` with `role="option"`
- A React-portal-style container (`position: fixed`, high z-index)

**File:** `browse/test/snapshot.test.ts`

New test cases:
- `snapshot -i` on dropdown page finds dropdown items via cursor scan
- `snapshot -i` on dropdown page includes popover-child elements
- `@c` refs from dropdown scan are clickable
- Elements inside floating containers with ARIA roles are captured even when ARIA tree misses them

## Rollout Risk

**Low.** The `-C` scan is additive — it only adds `@c` refs, never removes `@e` refs. The change to auto-enable it with `-i` increases output size but agents already handle mixed ref types.

**One concern:** The `-C` scan queries ALL elements (`document.querySelectorAll('*')`) which can be slow on heavy pages. For the popover-specific scan, we limit to elements inside detected floating containers, which is fast (small subtree).

## Testing

```bash
cd /data/gstack/browse && bun test snapshot
```

## Files Changed

1. `browse/src/snapshot.ts` — auto-enable -C with -i, popover scanning, remove hasRole skip in floating containers
2. `browse/test/fixtures/dropdown.html` — new test fixture
3. `browse/test/snapshot.test.ts` — new dropdown/popover test cases
