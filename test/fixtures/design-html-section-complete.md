# /design-html — Pricing Page · Signal

**Mode:** freeform (Case C → D)
**Screen:** pricing
**Visual reference:** none (freeform)
**CEO plan:** none
**Design tokens:** none (no DESIGN.md)
**Framework:** vanilla HTML

---

## Step 1: Implementation Spec

### Colors

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#090909` | Page background |
| `--bg-surface` | `#101010` | Card surface |
| `--bg-featured` | `#0a1122` | Featured tier tint |
| `--border` | `#1c1c1c` | Default border |
| `--border-dim` | `#141414` | Table row dividers |
| `--border-featured` | `#1d4ed8` | Featured tier border |
| `--text-1` | `#e2e2e8` | Primary text |
| `--text-2` | `#6b6b78` | Secondary / muted |
| `--text-3` | `#313139` | Disabled / dim |
| `--accent` | `#22c55e` | CTA green, included marks |
| `--accent-muted` | `rgba(34,197,94,.12)` | Toggle savings badge bg |
| `--featured-color` | `#3b82f6` | Featured tier badge + header |

Rationale: near-black base keeps the terminal feel; green accent (`#22c55e`) is readable at small sizes and avoids the garish `#00ff00` trap; blue reserved exclusively for the featured tier to create a secondary hierarchy without adding a third hue.

### Typography

| Family | Weights | Role |
|---|---|---|
| JetBrains Mono | 400 500 600 700 | Everything — nav, prices, labels, feature lists, CTA buttons |
| Inter | 400 500 | Tier description paragraphs, nav status (legibility for prose) |

Base size: 13px. Price display: 36px bold. Eyebrows/badges: 10–11px, letter-spacing 0.06–0.08em.

### Spacing scale (dense, 4px base)

`--s1: 4px` · `--s2: 8px` · `--s3: 12px` · `--s4: 16px` · `--s5: 20px` · `--s6: 24px` · `--s8: 32px` · `--s10: 40px` · `--s12: 48px` · `--s16: 64px`

### Component list

1. **Nav** — sticky `position: sticky; top: 0`, backdrop-blur glass, monospace `▸ signal` logo, nav links, system status dot, `start free →` CTA
2. **Pricing hero** — `// pricing` eyebrow comment, H1 (`contenteditable`, `data-pretext`), prose subtitle (`contenteditable`, `data-pretext`), monthly/annual billing toggle
3. **Tier grid** — three-column CSS grid, 12px gap, collapses to single-column at 768px
   - **Hobby** — $0/mo, 8 feature rows, secondary CTA button
   - **Pro** (featured) — $29/mo ($23 annual), `// popular` badge, blue border tint, primary green CTA
   - **Enterprise** — custom pricing, all features included, secondary CTA
4. **Feature comparison table** — 4-col, grouped by Limits / Features / Support, hover row highlight, `val-yes` (green) / `val-no` (dim) / `val-num` (white) cells
5. **Footer** — single row, copyright + four footer links

### Layout type

Three-column CSS grid (1120px container, 1fr×3 at ≥769px). Dense vertical rhythm inside cards. Feature table full-width below cards. Nav sticky. No hero image, no side-by-side two-column hero.

### Breakpoints

| Width | Behavior |
|---|---|
| ≥1024px | Full three-column grid, all nav links visible |
| 768px | Grid stays 3-col but tighter gap (2px) |
| ≤768px | Grid collapses to single-column (max-width 440px), nav links hidden, enterprise col hidden from comparison table |
| 375px | H1 clamps to 20px, price to 28px |

---

## Step 2: Pretext Tier

**Chosen tier: `prepare()` + `layout()` — Card/grid (Pattern 1)**

Why:

- The three tier cards have variable-length feature lists; at narrow viewports the tier description paragraphs (2–3 lines) reflow. `prepare()` + `layout()` gives correct height on every resize without re-measuring font metrics each time.
- The billing toggle swaps price text nodes — the price `<span>` elements are `data-pretext` targets so height recalculates correctly after the DOM swap.
- No shrinkwrap required (no chat bubbles), no obstacle layout (no editorial flow), no canvas rendering (no SVG). Pattern 1 is the cheapest correct choice.
- Per-resize cost is sub-millisecond; the 30KB Pretext overhead is justified for a page where the H1 and card descriptions will be the first things to reflow on a tablet viewport.

Pretext elements tagged: H1, pricing intro paragraph, tier description paragraphs (×3), price amount spans (×6, monthly + annual per tier), and feature label spans.

---

## Step 3: Pretext-Native HTML

> Vendor bundle not available in simulation → CDN fallback used.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pricing — Signal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:              #090909;
      --bg-surface:      #101010;
      --bg-featured:     #0a1122;
      --border:          #1c1c1c;
      --border-dim:      #141414;
      --border-featured: #1d4ed8;
      --text-1:          #e2e2e8;
      --text-2:          #6b6b78;
      --text-3:          #313139;
      --accent:          #22c55e;
      --accent-muted:    rgba(34,197,94,.12);
      --featured-color:  #3b82f6;
      --font-mono:       'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
      --font-body:       'Inter', system-ui, sans-serif;
      --s1: 4px;  --s2: 8px;   --s3: 12px; --s4: 16px; --s5: 20px;
      --s6: 24px; --s8: 32px;  --s10: 40px; --s12: 48px; --s16: 64px;
      --container: 1120px;
    }

    html { color-scheme: dark; }
    body {
      background: var(--bg);
      color: var(--text-1);
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }

    a { color: inherit; text-decoration: none; }

    /* ── Nav ─────────────────────────────────────────────────────── */
    .nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(9,9,9,.92);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      padding: 0 var(--s8);
    }
    .nav-inner {
      max-width: var(--container);
      margin: 0 auto;
      display: flex;
      align-items: center;
      height: 48px;
      gap: var(--s6);
    }
    .nav-logo {
      font-weight: 700;
      font-size: 14px;
      color: var(--text-1);
      display: flex;
      align-items: center;
      gap: var(--s2);
      flex-shrink: 0;
    }
    .nav-logo-mark { color: var(--accent); }
    .nav-links {
      display: flex;
      align-items: center;
      gap: 2px;
      list-style: none;
    }
    .nav-links a {
      color: var(--text-2);
      font-size: 12px;
      padding: var(--s1) var(--s3);
      border-radius: 3px;
      transition: color .15s;
    }
    .nav-links a:hover { color: var(--text-1); }
    .nav-links a[aria-current="page"] { color: var(--text-1); }
    .nav-spacer { flex: 1; }
    .nav-status {
      font-size: 11px;
      color: var(--text-2);
      display: flex;
      align-items: center;
      gap: var(--s1);
    }
    .nav-status-dot {
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
      flex-shrink: 0;
    }
    .nav-cta {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      color: #000;
      background: var(--accent);
      border: none;
      padding: var(--s1) var(--s3);
      cursor: pointer;
      border-radius: 2px;
      transition: opacity .15s;
      flex-shrink: 0;
    }
    .nav-cta:hover { opacity: .85; }

    /* ── Pricing Hero ────────────────────────────────────────────── */
    .pricing-hero {
      max-width: var(--container);
      margin: 0 auto;
      padding: var(--s16) var(--s8) var(--s10);
    }
    .pricing-eyebrow {
      font-size: 11px;
      color: var(--text-2);
      margin-bottom: var(--s4);
      letter-spacing: .04em;
    }
    .pricing-eyebrow-comment { color: var(--text-3); }
    .pricing-h1 {
      font-size: clamp(20px, 4vw, 40px);
      font-weight: 700;
      line-height: 1.15;
      letter-spacing: -.01em;
      color: var(--text-1);
      margin-bottom: var(--s4);
      overflow: hidden;
    }
    .pricing-intro {
      font-family: var(--font-body);
      font-size: 14px;
      color: var(--text-2);
      max-width: 480px;
      line-height: 1.65;
      overflow: hidden;
    }
    .billing-toggle {
      display: inline-flex;
      align-items: center;
      gap: var(--s1);
      margin-top: var(--s8);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 3px;
    }
    .toggle-btn {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      color: var(--text-2);
      background: none;
      border: none;
      padding: var(--s1) var(--s3);
      cursor: pointer;
      border-radius: 2px;
      transition: background .15s, color .15s;
      display: flex;
      align-items: center;
      gap: var(--s1);
    }
    .toggle-btn.active {
      background: var(--border);
      color: var(--text-1);
    }
    .toggle-savings {
      font-size: 10px;
      font-weight: 600;
      color: var(--accent);
      padding: 1px var(--s2);
      background: var(--accent-muted);
      border-radius: 2px;
    }

    /* ── Tier Grid ───────────────────────────────────────────────── */
    .tier-section {
      max-width: var(--container);
      margin: 0 auto;
      padding: 0 var(--s8) var(--s12);
    }
    .tier-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--s3);
      align-items: start;
    }
    .tier-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: var(--s6);
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .tier-card.featured {
      background: var(--bg-featured);
      border-color: var(--border-featured);
    }
    .tier-badge {
      position: absolute;
      top: -1px;
      left: var(--s6);
      font-size: 10px;
      font-weight: 600;
      color: var(--featured-color);
      background: var(--bg-featured);
      padding: 1px var(--s2) 0;
      border: 1px solid var(--border-featured);
      border-top: none;
      border-radius: 0 0 3px 3px;
      letter-spacing: .06em;
    }
    .tier-name {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-2);
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: var(--s3);
      margin-top: var(--s2);
    }
    .tier-card.featured .tier-name { color: var(--featured-color); }

    .price-block { margin-bottom: var(--s4); }
    .price-row {
      display: flex;
      align-items: baseline;
      gap: 3px;
      line-height: 1;
    }
    .price-currency {
      font-size: 16px;
      color: var(--text-2);
      font-weight: 500;
    }
    .price-number {
      font-size: 36px;
      font-weight: 700;
      color: var(--text-1);
      overflow: hidden;
    }
    .price-custom {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-1);
      overflow: hidden;
    }
    .price-period {
      font-size: 12px;
      color: var(--text-2);
      margin-left: 2px;
    }
    .price-annual-note {
      font-size: 11px;
      color: var(--text-2);
      margin-top: var(--s2);
      display: none;
    }

    /* billing mode toggling */
    .monthly-val  { display: block; }
    .annual-val   { display: none; }
    .annual-mode .monthly-val { display: none; }
    .annual-mode .annual-val  { display: block; }
    .annual-mode .price-annual-note { display: block; }

    .tier-desc {
      font-family: var(--font-body);
      font-size: 12px;
      color: var(--text-2);
      line-height: 1.6;
      margin-bottom: var(--s5);
      overflow: hidden;
    }
    .tier-divider {
      border: none;
      border-top: 1px solid var(--border);
      margin: var(--s4) 0;
    }
    .tier-card.featured .tier-divider { border-color: rgba(29,78,216,.35); }

    .tier-features {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--s2);
      flex: 1;
      margin-bottom: var(--s6);
    }
    .tier-feature {
      display: flex;
      align-items: baseline;
      gap: var(--s2);
      font-size: 12px;
    }
    .feature-mark {
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
      width: 10px;
      text-align: center;
    }
    .feature-mark.yes { color: var(--accent); }
    .feature-mark.no  { color: var(--text-3); }
    .feature-label { overflow: hidden; }
    .tier-feature.yes .feature-label { color: var(--text-1); }
    .tier-feature.no  .feature-label { color: var(--text-3); }

    .tier-cta {
      display: block;
      width: 100%;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      padding: var(--s3) var(--s4);
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--border);
      background: none;
      color: var(--text-2);
      transition: color .15s, border-color .15s;
      margin-top: auto;
    }
    .tier-cta:hover {
      color: var(--text-1);
      border-color: var(--text-2);
    }
    .tier-cta.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #000;
    }
    .tier-cta.primary:hover { opacity: .88; }

    /* ── Comparison Table ────────────────────────────────────────── */
    .compare-section {
      max-width: var(--container);
      margin: 0 auto;
      padding: 0 var(--s8) var(--s16);
    }
    .compare-label {
      font-size: 11px;
      color: var(--text-2);
      letter-spacing: .06em;
      margin-bottom: var(--s5);
    }
    .compare-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .compare-table thead th {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-2);
      text-align: right;
      padding: var(--s2) var(--s4);
      border-bottom: 1px solid var(--border);
      letter-spacing: .07em;
      text-transform: uppercase;
    }
    .compare-table thead th:first-child { text-align: left; }
    .compare-table thead .col-pro { color: var(--featured-color); }
    .compare-table tbody tr {
      border-bottom: 1px solid var(--border-dim);
      transition: background .1s;
    }
    .compare-table tbody tr:hover { background: rgba(255,255,255,.018); }
    .compare-table td {
      padding: var(--s2) var(--s4);
      text-align: right;
      color: var(--text-2);
      vertical-align: middle;
    }
    .compare-table td:first-child {
      text-align: left;
      color: var(--text-1);
    }
    .compare-table .v-yes { color: var(--accent);  font-weight: 600; }
    .compare-table .v-no  { color: var(--text-3); }
    .compare-table .v-num { color: var(--text-1);  font-weight: 500; }
    .compare-table .section-row td {
      font-size: 10px;
      color: var(--text-3);
      letter-spacing: .06em;
      text-transform: uppercase;
      padding-top: var(--s5);
      padding-bottom: var(--s2);
      border-bottom: none;
    }

    /* ── Footer ──────────────────────────────────────────────────── */
    footer {
      border-top: 1px solid var(--border);
      padding: var(--s6) var(--s8);
    }
    .footer-inner {
      max-width: var(--container);
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--s4);
      flex-wrap: wrap;
    }
    .footer-copy { font-size: 11px; color: var(--text-3); }
    .footer-links { display: flex; gap: var(--s4); list-style: none; }
    .footer-links a { font-size: 11px; color: var(--text-3); transition: color .15s; }
    .footer-links a:hover { color: var(--text-2); }

    /* ── Responsive ──────────────────────────────────────────────── */
    @media (max-width: 1024px) {
      .tier-grid { gap: var(--s2); }
    }
    @media (max-width: 768px) {
      .tier-grid {
        grid-template-columns: 1fr;
        max-width: 440px;
      }
      .nav-links { display: none; }
      .nav-status { display: none; }
      .compare-table thead th:nth-child(4),
      .compare-table td:nth-child(4) { display: none; }
      .pricing-hero  { padding: var(--s10) var(--s4) var(--s8); }
      .tier-section  { padding-left: var(--s4); padding-right: var(--s4); }
      .compare-section { padding-left: var(--s4); padding-right: var(--s4); }
    }
    @media (max-width: 375px) {
      .pricing-h1  { font-size: 20px; }
      .price-number { font-size: 28px; }
    }

    /* ── Motion ──────────────────────────────────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; animation: none !important; }
    }

    /* ── Light mode ──────────────────────────────────────────────── */
    @media (prefers-color-scheme: light) {
      :root {
        --bg:              #f7f7f9;
        --bg-surface:      #ffffff;
        --bg-featured:     #eff6ff;
        --border:          #e4e4e7;
        --border-dim:      #f0f0f2;
        --border-featured: #2563eb;
        --text-1:          #09090b;
        --text-2:          #71717a;
        --text-3:          #d4d4d8;
        --accent-muted:    rgba(34,197,94,.1);
      }
      .nav { background: rgba(247,247,249,.92); }
      html { color-scheme: light; }
    }

    /* ── Focus ───────────────────────────────────────────────────── */
    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 2px;
    }

    /* ── Contenteditable ─────────────────────────────────────────── */
    [contenteditable]:hover { background: rgba(255,255,255,.02); border-radius: 2px; }
    [contenteditable]:focus { outline: 1px dashed var(--text-3); outline-offset: 2px; border-radius: 2px; }
  </style>
</head>
<body>

<header>
  <nav class="nav" aria-label="Main navigation">
    <div class="nav-inner">
      <a href="/" class="nav-logo" aria-label="Signal home">
        <span class="nav-logo-mark" aria-hidden="true">▸</span>
        signal
      </a>
      <ul class="nav-links" role="list">
        <li><a href="/docs">docs</a></li>
        <li><a href="/changelog">changelog</a></li>
        <li><a href="/pricing" aria-current="page">pricing</a></li>
        <li><a href="/blog">blog</a></li>
        <li><a href="/status">status</a></li>
      </ul>
      <div class="nav-spacer"></div>
      <div class="nav-status" aria-label="System status: all systems operational">
        <span class="nav-status-dot" aria-hidden="true"></span>
        <span>all systems operational</span>
      </div>
      <button class="nav-cta" onclick="window.location.href='/signup'">start free →</button>
    </div>
  </nav>
</header>

<main>

  <!-- ── Pricing Hero ──────────────────────────────────────────── -->
  <section class="pricing-hero" aria-labelledby="pricing-heading">
    <p class="pricing-eyebrow">
      <span class="pricing-eyebrow-comment" aria-hidden="true">// </span>pricing
    </p>
    <h1 class="pricing-h1" id="pricing-heading"
        contenteditable="true" data-pretext>
      Pay for what you ship.
    </h1>
    <p class="pricing-intro" contenteditable="true" data-pretext>
      Signal collects, stores, and queries your application logs, traces, and metrics.
      No per-seat pricing. No hidden ingestion fees. Storage-based billing that scales
      linearly with what you actually use.
    </p>

    <div class="billing-toggle" role="group" aria-label="Billing period">
      <button class="toggle-btn active" data-period="monthly" aria-pressed="true">
        monthly
      </button>
      <button class="toggle-btn" data-period="annual" aria-pressed="false">
        annually
        <span class="toggle-savings" aria-label="Save 20 percent">-20%</span>
      </button>
    </div>
  </section>

  <!-- ── Tier Grid ─────────────────────────────────────────────── -->
  <section class="tier-section" aria-label="Pricing tiers">
    <div class="tier-grid" role="list">

      <!-- Hobby -->
      <article class="tier-card" role="listitem" aria-label="Hobby plan">
        <p class="tier-name">Hobby</p>

        <div class="price-block">
          <div class="monthly-val price-row" aria-label="Free">
            <span class="price-currency" aria-hidden="true">$</span>
            <span class="price-number" contenteditable="true" data-pretext>0</span>
            <span class="price-period">/ mo</span>
          </div>
          <div class="annual-val price-row" aria-label="Free">
            <span class="price-currency" aria-hidden="true">$</span>
            <span class="price-number" contenteditable="true" data-pretext>0</span>
            <span class="price-period">/ mo</span>
          </div>
        </div>

        <p class="tier-desc" contenteditable="true" data-pretext>
          For side projects and open-source tools. Full platform access with
          generous free limits. No credit card required.
        </p>

        <hr class="tier-divider" aria-hidden="true">

        <ul class="tier-features" aria-label="Hobby plan features">
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>3 projects</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>10K API calls / day</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>1 GB log storage</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>7-day retention</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Community support</span>
          </li>
          <li class="tier-feature no">
            <span class="feature-mark no" aria-hidden="true">—</span>
            <span class="feature-label" contenteditable="true" data-pretext>Private projects</span>
          </li>
          <li class="tier-feature no">
            <span class="feature-mark no" aria-hidden="true">—</span>
            <span class="feature-label" contenteditable="true" data-pretext>CI/CD integration</span>
          </li>
          <li class="tier-feature no">
            <span class="feature-mark no" aria-hidden="true">—</span>
            <span class="feature-label" contenteditable="true" data-pretext>Team members</span>
          </li>
        </ul>

        <button class="tier-cta" aria-label="Start with Hobby plan, free">
          start free →
        </button>
      </article>

      <!-- Pro (featured) -->
      <article class="tier-card featured" role="listitem" aria-label="Pro plan, most popular">
        <span class="tier-badge" aria-label="Most popular">// popular</span>
        <p class="tier-name">Pro</p>

        <div class="price-block">
          <div class="monthly-val price-row" aria-label="29 dollars per month">
            <span class="price-currency" aria-hidden="true">$</span>
            <span class="price-number" contenteditable="true" data-pretext>29</span>
            <span class="price-period">/ mo</span>
          </div>
          <div class="annual-val price-row" aria-label="23 dollars per month, billed annually">
            <span class="price-currency" aria-hidden="true">$</span>
            <span class="price-number" contenteditable="true" data-pretext>23</span>
            <span class="price-period">/ mo</span>
          </div>
          <p class="price-annual-note" aria-live="polite">$276 / yr · save $72</p>
        </div>

        <p class="tier-desc" contenteditable="true" data-pretext>
          For professional developers and growing teams. Unlimited projects,
          higher ingestion limits, and email support with a 24-hour response SLA.
        </p>

        <hr class="tier-divider" aria-hidden="true">

        <ul class="tier-features" aria-label="Pro plan features">
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Unlimited projects</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>500K API calls / day</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>50 GB log storage</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>90-day retention</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Email support (&lt;24h)</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Private projects</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>CI/CD integration</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Up to 5 team members</span>
          </li>
        </ul>

        <button class="tier-cta primary" aria-label="Start with Pro plan at 29 dollars per month">
          start with pro →
        </button>
      </article>

      <!-- Enterprise -->
      <article class="tier-card" role="listitem" aria-label="Enterprise plan">
        <p class="tier-name">Enterprise</p>

        <div class="price-block">
          <div class="monthly-val price-row" aria-label="Custom pricing">
            <span class="price-custom" contenteditable="true" data-pretext>custom pricing</span>
          </div>
          <div class="annual-val price-row" aria-label="Custom pricing">
            <span class="price-custom" contenteditable="true" data-pretext>custom pricing</span>
          </div>
        </div>

        <p class="tier-desc" contenteditable="true" data-pretext>
          For teams with scale, compliance, and uptime requirements. Volume
          discounts, dedicated infrastructure, and a named support engineer.
        </p>

        <hr class="tier-divider" aria-hidden="true">

        <ul class="tier-features" aria-label="Enterprise plan features">
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Unlimited everything</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Unlimited API calls</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>1 TB+ log storage</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Custom retention policy</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Dedicated support + SLA</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>SSO / SAML</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>Audit logs</span>
          </li>
          <li class="tier-feature yes">
            <span class="feature-mark yes" aria-hidden="true">+</span>
            <span class="feature-label" contenteditable="true" data-pretext>On-prem option</span>
          </li>
        </ul>

        <button class="tier-cta" aria-label="Contact sales for Enterprise plan">
          talk to sales →
        </button>
      </article>

    </div><!-- /tier-grid -->
  </section>

  <!-- ── Comparison Table ──────────────────────────────────────── -->
  <section class="compare-section" aria-label="Feature comparison table">
    <p class="compare-label">// feature comparison</p>
    <table class="compare-table" aria-label="Plan feature comparison">
      <thead>
        <tr>
          <th scope="col">Feature</th>
          <th scope="col">Hobby</th>
          <th scope="col" class="col-pro">Pro</th>
          <th scope="col">Enterprise</th>
        </tr>
      </thead>
      <tbody>
        <tr class="section-row"><td colspan="4">Limits</td></tr>
        <tr>
          <td>Projects</td>
          <td class="v-num">3</td>
          <td class="v-num">∞</td>
          <td class="v-num">∞</td>
        </tr>
        <tr>
          <td>API calls / day</td>
          <td class="v-num">10K</td>
          <td class="v-num">500K</td>
          <td class="v-num">unlimited</td>
        </tr>
        <tr>
          <td>Log storage</td>
          <td class="v-num">1 GB</td>
          <td class="v-num">50 GB</td>
          <td class="v-num">1 TB+</td>
        </tr>
        <tr>
          <td>Data retention</td>
          <td class="v-num">7 days</td>
          <td class="v-num">90 days</td>
          <td class="v-num">custom</td>
        </tr>
        <tr>
          <td>Team seats</td>
          <td class="v-num">1</td>
          <td class="v-num">5</td>
          <td class="v-num">unlimited</td>
        </tr>
        <tr class="section-row"><td colspan="4">Features</td></tr>
        <tr>
          <td>Private projects</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
          <td class="v-yes">✓</td>
        </tr>
        <tr>
          <td>CI/CD integration</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
          <td class="v-yes">✓</td>
        </tr>
        <tr>
          <td>Custom alerts</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
          <td class="v-yes">✓</td>
        </tr>
        <tr>
          <td>SSO / SAML</td>
          <td class="v-no">—</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
        </tr>
        <tr>
          <td>Audit logs</td>
          <td class="v-no">—</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
        </tr>
        <tr>
          <td>Custom data retention</td>
          <td class="v-no">—</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
        </tr>
        <tr>
          <td>On-prem option</td>
          <td class="v-no">—</td>
          <td class="v-no">—</td>
          <td>optional</td>
        </tr>
        <tr class="section-row"><td colspan="4">Support</td></tr>
        <tr>
          <td>Channel</td>
          <td>community</td>
          <td>email</td>
          <td>dedicated</td>
        </tr>
        <tr>
          <td>Response time</td>
          <td class="v-no">—</td>
          <td>&le; 24h</td>
          <td>&le; 4h</td>
        </tr>
        <tr>
          <td>Uptime SLA</td>
          <td class="v-no">—</td>
          <td class="v-no">—</td>
          <td class="v-yes">✓</td>
        </tr>
      </tbody>
    </table>
  </section>

</main>

<footer>
  <div class="footer-inner">
    <p class="footer-copy">Signal &copy; 2025</p>
    <ul class="footer-links" role="list">
      <li><a href="/privacy">privacy</a></li>
      <li><a href="/terms">terms</a></li>
      <li><a href="/status">status</a></li>
      <li><a href="/docs">docs</a></li>
    </ul>
  </div>
</footer>

<!-- FALLBACK: vendor/pretext.js missing, using CDN -->
<script type="module">
  import { prepare, layout } from 'https://esm.sh/@chenglou/pretext'

  // ── Pretext: Pattern 1 (Card/grid) ────────────────────────────
  await document.fonts.ready

  const elements = document.querySelectorAll('[data-pretext]')
  const prepared = new Map()

  for (const el of elements) {
    prepared.set(el, prepare(el.textContent, getComputedStyle(el).font))
  }

  function relayout() {
    for (const [el, handle] of prepared) {
      if (!el.clientWidth) continue
      const lh = parseFloat(getComputedStyle(el).lineHeight)
      const { height } = layout(handle, el.clientWidth, lh)
      el.style.height = height + 'px'
    }
  }

  new ResizeObserver(() => relayout()).observe(document.body)
  relayout()

  // Re-prepare when contenteditable text changes
  for (const el of elements) {
    if (el.contentEditable === 'true') {
      new MutationObserver(() => {
        prepared.set(el, prepare(el.textContent, getComputedStyle(el).font))
        relayout()
      }).observe(el, { characterData: true, subtree: true, childList: true })
    }
  }

  // ── Billing toggle ─────────────────────────────────────────────
  const toggleBtns = document.querySelectorAll('.toggle-btn')
  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toggleBtns.forEach(b => {
        b.classList.remove('active')
        b.setAttribute('aria-pressed', 'false')
      })
      btn.classList.add('active')
      btn.setAttribute('aria-pressed', 'true')
      document.body.classList.toggle('annual-mode', btn.dataset.period === 'annual')

      // Re-layout after price nodes swap visibility
      requestAnimationFrame(relayout)
    })
  })
</script>

</body>
</html>
```

---

## Completion status

**STATUS: DONE**

**What was produced:**
- Implementation spec: dark monospace palette, JetBrains Mono primary, 4px dense spacing scale, five-component layout
- Pretext tier: Pattern 1 (`prepare()` + `layout()`) — card/grid, correct for pricing cards with variable-length feature lists
- Complete vanilla HTML: sticky nav, billing toggle, three-tier card grid, feature comparison table, footer; Pretext wiring with ResizeObserver + MutationObserver; ARIA labels; `prefers-color-scheme` + `prefers-reduced-motion`; CDN fallback; contenteditable on all text elements

**Skipped (per instructions):** Step 3.5 (live server), Step 4 (refinement loop), Step 5 (save metadata / DESIGN.md extraction)

**No durable learnings this session** — simulation run with no bash execution, so no command surprises or env quirks to record.
