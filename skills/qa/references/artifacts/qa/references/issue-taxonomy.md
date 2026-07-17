# QA Issue Taxonomy

## Severity Levels

| Severity | Definition | Examples |
|----------|------------|----------|
| **critical** | Blocks a core workflow, causes data loss, or crashes the app | Form submit causes error page, checkout flow broken, data deleted without confirmation |
| **high** | Major feature broken or unusable, no workaround | Search returns wrong results, file upload silently fails, auth redirect loop |
| **medium** | Feature works but with noticeable problems, workaround exists | Slow page load (>5s), form validation missing but submit still works, layout broken on mobile only |
| **low** | Minor cosmetic or polish issue | Typo in footer, 1px alignment issue, hover state inconsistent |

## Categories

### 1. Visual/UI
- Layout breaks (overlapping elements, clipped text, horizontal scrollbar)
- Broken or missing images
- Incorrect z-index (elements appearing behind others)
- Font/color inconsistencies
- Animation glitches (jank, incomplete transitions)
- Alignment issues (off-grid, uneven spacing)
- Dark mode / theme issues

### 2. Functional
- Broken links (404, wrong destination)
- Dead buttons (click does nothing)
- Form validation (missing, wrong, bypassed)
- Incorrect redirects
- State not persisting (data lost on refresh, back button)
- Race conditions (double-submit, stale data)
- Search returning wrong or no results

### 3. UX
- Confusing navigation (no breadcrumbs, dead ends)
- Missing loading indicators (user doesn't know something is happening)
- Slow interactions (>500ms with no feedback)
- Unclear error messages ("Something went wrong" with no detail)
- No confirmation before destructive actions
- Inconsistent interaction patterns across pages
- Dead ends (no way back, no next action)

### 4. Content
- Typos and grammar errors
- Outdated or incorrect text
- Placeholder / lorem ipsum text left in
- Truncated text (cut off without ellipsis or "more")
- Wrong labels on buttons or form fields
- Missing or unhelpful empty states

### 5. Performance
- Slow page loads (>3 seconds)
- Janky scrolling (dropped frames)
- Layout shifts (content jumping after load)
- Excessive network requests (>50 on a single page)
- Large unoptimized images
- Blocking JavaScript (page unresponsive during load)

### 6. Console/Errors
- JavaScript exceptions (uncaught errors)
- Failed network requests (4xx, 5xx)
- Deprecation warnings (upcoming breakage)
- CORS errors
- Mixed content warnings (HTTP resources on HTTPS)
- CSP violations

### 7. Accessibility
- Missing alt text on images
- Unlabeled form inputs
- Keyboard navigation broken (can't tab to elements)
- Focus traps (can't escape a modal or dropdown)
- Missing or incorrect ARIA attributes
- Insufficient color contrast
- Content not reachable by screen reader

## Per-Page Exploration Checklist

For each page visited during a QA session:

1. **Visual scan** — Take annotated screenshot (`snapshot -i -a -o`). Look for layout issues, broken images, alignment.
2. **Interactive elements** — Click every button, link, and control. Does each do what it says?
3. **Forms** — Fill and submit. Test empty submission, invalid data, edge cases (long text, special characters).
4. **Navigation** — Check all paths in/out. Breadcrumbs, back button, deep links, mobile menu.
5. **States** — Check empty state, loading state, error state, full/overflow state.
6. **Console** — Run `console --errors` after interactions. Any new JS errors or failed requests?
7. **Responsiveness** — If relevant, check mobile and tablet viewports.
8. **Auth boundaries** — What happens when logged out? Different user roles?
