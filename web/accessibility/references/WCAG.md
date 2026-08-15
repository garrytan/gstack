# WCAG 2.2 Quick Reference

## Success criteria by level

### Level A (minimum)

| Criterion | Description |
|-----------|-------------|
| **1.1.1** Non-text Content | All images, icons have text alternatives |
| **1.2.1** Audio-only/Video-only | Provide transcript or audio description |
| **1.2.2** Captions | Video with audio has captions |
| **1.2.3** Audio Description | Video has audio description |
| **1.3.1** Info and Relationships | Information conveyed through presentation is available programmatically |
| **1.3.2** Meaningful Sequence | Reading order is logical |
| **1.3.3** Sensory Characteristics | Instructions don't rely solely on shape, color, size, location, orientation, or sound |
| **1.4.1** Use of Color | Color is not the only visual means of conveying information |
| **1.4.2** Audio Control | Audio playing automatically can be paused/stopped |
| **2.1.1** Keyboard | All functionality available via keyboard |
| **2.1.2** No Keyboard Trap | Keyboard focus can be moved away from any component |
| **2.1.4** Character Key Shortcuts | Single-key shortcuts can be turned off or remapped |
| **2.2.1** Timing Adjustable | Time limits can be extended |
| **2.2.2** Pause, Stop, Hide | Moving/blinking content can be paused |
| **2.3.1** Three Flashes | Nothing flashes more than 3 times per second |
| **2.4.1** Bypass Blocks | Skip link or landmark navigation available |
| **2.4.2** Page Titled | Pages have descriptive titles |
| **2.4.3** Focus Order | Focus order preserves meaning |
| **2.4.4** Link Purpose | Link purpose clear from link text or context |
| **2.5.1** Pointer Gestures | Multi-point gestures have single-pointer alternatives |
| **2.5.2** Pointer Cancellation | Down-event doesn't trigger action (use up-event or click) |
| **2.5.3** Label in Name | Accessible name contains visible label text |
| **2.5.4** Motion Actuation | Motion-triggered functions have alternatives |
| **3.1.1** Language of Page | Default language specified in HTML |
| **3.2.1** On Focus | Focus doesn't trigger unexpected changes |
| **3.2.2** On Input | Input doesn't trigger unexpected changes |
| **3.2.6** Consistent Help | Help mechanisms appear in the same relative order across pages |
| **3.3.1** Error Identification | Input errors clearly described |
| **3.3.2** Labels or Instructions | Form inputs have labels or instructions |
| **3.3.7** Redundant Entry | Information previously entered is auto-populated or available to select |
| **4.1.2** Name, Role, Value | UI components have accessible names and correct roles |

### Level AA (standard)

| Criterion | Description |
|-----------|-------------|
| **1.2.4** Captions (Live) | Live audio has captions |
| **1.2.5** Audio Description | Pre-recorded video has audio description |
| **1.3.4** Orientation | Content doesn't restrict orientation |
| **1.3.5** Identify Input Purpose | Input purpose can be programmatically determined |
| **1.4.3** Contrast (Minimum) | 4.5:1 for normal text, 3:1 for large text |
| **1.4.4** Resize Text | Text can be resized to 200% without loss of functionality |
| **1.4.5** Images of Text | Text used instead of images of text |
| **1.4.10** Reflow | Content reflows at 320px width without horizontal scroll |
| **1.4.11** Non-text Contrast | UI components have 3:1 contrast |
| **1.4.12** Text Spacing | Content adapts to text spacing changes |
| **1.4.13** Content on Hover/Focus | Additional content is dismissible, hoverable, persistent |
| **2.4.5** Multiple Ways | Multiple ways to find pages |
| **2.4.6** Headings and Labels | Headings and labels are descriptive |
| **2.4.7** Focus Visible | Focus indicator is visible |
| **2.4.11** Focus Not Obscured (Minimum) | Focused element is not entirely hidden by author-created content |
| **2.5.7** Dragging Movements | Dragging actions have single-pointer alternatives |
| **2.5.8** Target Size (Minimum) | Interactive targets are at least 24×24 CSS pixels (with exceptions) |
| **3.1.2** Language of Parts | Language changes are marked |
| **3.2.3** Consistent Navigation | Navigation is consistent across pages |
| **3.2.4** Consistent Identification | Same functionality uses same labels |
| **3.3.3** Error Suggestion | Error corrections suggested when known |
| **3.3.4** Error Prevention (Legal) | Actions can be reversed or confirmed |
| **3.3.8** Accessible Authentication (Minimum) | No cognitive function test for login unless an alternative or assistance is provided |
| **4.1.3** Status Messages | Status messages announced to screen readers |

### Level AAA (enhanced)

| Criterion | Description |
|-----------|-------------|
| **1.4.6** Contrast (Enhanced) | 7:1 for normal text, 4.5:1 for large text |
| **1.4.8** Visual Presentation | Foreground/background colors can be selected |
| **1.4.9** Images of Text (No Exception) | No images of text |
| **2.1.3** Keyboard (No Exception) | All functionality keyboard accessible |
| **2.2.3** No Timing | No time limits |
| **2.2.4** Interruptions | Interruptions can be postponed |
| **2.2.5** Re-authenticating | Data preserved on re-authentication |
| **2.2.6** Timeouts | Users warned about data loss from inactivity |
| **2.3.2** Three Flashes | No content flashes more than 3 times |
| **2.3.3** Animation from Interactions | Motion animation can be disabled |
| **2.4.8** Location | User location within site is available |
| **2.4.9** Link Purpose (Link Only) | Link purpose clear from link text alone |
| **2.4.10** Section Headings | Sections have headings |
| **2.4.12** Focus Not Obscured (Enhanced) | No part of the focused element is hidden by author-created content |
| **2.4.13** Focus Appearance | Focus indicator has sufficient area, contrast, and is not obscured |
| **3.1.3** Unusual Words | Definitions available for unusual words |
| **3.1.4** Abbreviations | Abbreviations expanded |
| **3.1.5** Reading Level | Alternative content for complex text |
| **3.1.6** Pronunciation | Pronunciation available where needed |
| **3.2.5** Change on Request | Changes initiated only by user |
| **3.3.5** Help | Context-sensitive help available |
| **3.3.6** Error Prevention (All) | All form submissions can be reviewed |
| **3.3.9** Accessible Authentication (Enhanced) | No cognitive function test for login (no object or personal content recognition exceptions) |

## Common ARIA patterns

### Buttons
```html
<button>Label</button>
<!-- or -->
<button aria-label="Close dialog">×</button>
```

### Links
```html
<a href="/page">Descriptive link text</a>
<!-- External links -->
<a href="https://external.com" target="_blank" rel="noopener">
  External site
  <span class="visually-hidden">(opens in new tab)</span>
</a>
```

### Form fields
```html
<label for="email">Email address</label>
<input type="email" id="email" aria-describedby="email-hint">
<p id="email-hint">We'll never share your email.</p>
```

### Error states
```html
<label for="email">Email</label>
<input type="email" id="email" aria-invalid="true" aria-describedby="email-error">
<p id="email-error" role="alert">Please enter a valid email address.</p>
```

### Navigation
```html
<nav aria-label="Main">
  <ul>
    <li><a href="/" aria-current="page">Home</a></li>
    <li><a href="/about">About</a></li>
  </ul>
</nav>
```

### Modals
```html
<div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
  <h2 id="dialog-title">Confirm Action</h2>
  <!-- content -->
</div>
```

### Live regions
```html
<!-- Polite (waits for pause in speech) -->
<div aria-live="polite">Status update here</div>

<!-- Assertive (interrupts immediately) -->
<div aria-live="assertive" role="alert">Error message here</div>

<!-- Status (polite, implicit) -->
<div role="status">Loading complete</div>
```

## What changed from 2.1 to 2.2

| Change | Criterion | Level |
|--------|-----------|-------|
| **Removed** | 4.1.1 Parsing | A |
| **Added** | 2.4.11 Focus Not Obscured (Minimum) | AA |
| **Added** | 2.4.12 Focus Not Obscured (Enhanced) | AAA |
| **Added** | 2.4.13 Focus Appearance | AAA |
| **Added** | 2.5.7 Dragging Movements | AA |
| **Added** | 2.5.8 Target Size (Minimum) | AA |
| **Added** | 3.2.6 Consistent Help | A |
| **Added** | 3.3.7 Redundant Entry | A |
| **Added** | 3.3.8 Accessible Authentication (Minimum) | AA |
| **Added** | 3.3.9 Accessible Authentication (Enhanced) | AAA |

## Testing tools

| Tool | Type | URL |
|------|------|-----|
| axe DevTools | Browser extension | [deque.com/axe](https://www.deque.com/axe/) |
| WAVE | Browser extension | [wave.webaim.org](https://wave.webaim.org/) |
| Lighthouse | Built into Chrome | DevTools → Lighthouse |
| NVDA | Screen reader (Windows) | [nvaccess.org](https://www.nvaccess.org/) |
| VoiceOver | Screen reader (Mac) | Built into macOS |
| Colour Contrast Analyser | Desktop app | [tpgi.com](https://www.tpgi.com/color-contrast-checker/) |

## Sources

- [WCAG 2.2 W3C Recommendation](https://www.w3.org/TR/WCAG22/)
- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)
- [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)
