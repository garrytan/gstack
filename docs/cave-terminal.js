/**
 * CaveTerminal — Interactive terminal demo for CaveStack landing page.
 * Pure vanilla JS, zero dependencies. Progressive enhancement over static HTML.
 *
 * Usage:
 *   const term = new CaveTerminal(document.getElementById('cave-terminal'));
 *   term.start();
 */

/* ── SCENARIOS ── */

const SCENARIOS = [
  {
    command: '/review',
    mode: 'split',
    verbose: `# patch /review

Analyzing your changes...

I'll review the changes in auth/middleware.ts and provide
comprehensive feedback on the implementation.

## Summary

This pull request modifies the authentication middleware
to add token expiry validation. The changes look generally
good, but I have several observations and recommendations
that I'd like to share with you.

## Detailed Analysis

### Finding 1: Token Expiry Check (Medium)

In auth/middleware.ts:47, the token expiry comparison
uses a strict less-than operator (<) when it should
use less-than-or-equal-to (<=). This means tokens
that expire at exactly the current timestamp will
incorrectly be treated as valid. While this is a small
window, it could potentially allow expired tokens to
be used for a brief moment.

Recommendation: Change the comparison operator from
< to <= to ensure tokens are invalidated at exactly
their expiry time.

### Finding 2: Missing Error Context (Low)

The error response at line 52 returns a generic 401
without including any diagnostic information that would
help developers understand why their token was rejected.
Consider adding a "reason" field to the error response.

## Overall Assessment

The changes demonstrate a solid understanding of the
authentication flow. With the operator fix applied,
this should be ready to merge.`,

    caveman: `# patch /review

## Findings: 2

1. auth/middleware.ts:47 — token expiry check
   use < not <=. Token at exact expiry time
   passes validation. Fix:

   - if (token.exp < now) {
   + if (token.exp <= now) {

2. auth/middleware.ts:52 — 401 response
   missing reason field. Add:

   { error: "unauthorized", reason: "token_expired" }

Status: Fix #1, merge.`,
    typeSpeed: 12,
    pauseAfter: 3000
  },
  {
    command: '/investigate',
    mode: 'split',
    verbose: `# investigating: API timeout on /users endpoint

I'll systematically investigate this issue using a
structured debugging approach. Let me start by examining
the symptoms, then work through potential causes.

## Phase 1: Symptom Analysis

The /users endpoint is returning 504 Gateway Timeout
errors intermittently. Based on the error logs, this
started occurring approximately 2 hours ago. The
endpoint was previously responding in under 200ms.

## Phase 2: Hypothesis Formation

There are several potential causes we should consider:

1. Database query performance degradation
2. Connection pool exhaustion
3. External service dependency timeout
4. Memory leak causing garbage collection pauses

Let me investigate each of these hypotheses
systematically, starting with the most likely cause.

## Phase 3: Investigation

After examining the database slow query log, I found
that the users table query is performing a full table
scan. The index on created_at appears to have been
dropped during yesterday's migration.

## Phase 4: Root Cause

The migration at 2026-04-15 14:30 UTC dropped the
idx_users_created_at index. This caused the query
planner to fall back to a sequential scan, which
degrades exponentially with table size.

## Recommended Fix

Recreate the index and add a migration guard.`,

    caveman: `# /users endpoint 504s

Root cause: index dropped.

Migration 2026-04-15 14:30 UTC dropped
idx_users_created_at. Query planner fell
back to sequential scan.

Fix:
  CREATE INDEX idx_users_created_at
  ON users(created_at);

Add migration guard to prevent index drops
without explicit --allow-index-drop flag.

Verify: EXPLAIN ANALYZE on /users query
should show Index Scan, not Seq Scan.`,
    typeSpeed: 12,
    pauseAfter: 3000
  },
  {
    command: 'CaveRock',
    mode: 'single',
    caveman: `$ claude

CAVEMAN MODE ACTIVE — level: full

> Explain database connection pooling.

Pool reuse open DB connections. No new
connection per request. Skip handshake
overhead. Config: min=5, max=20,
idle_timeout=30s. Monitor: active count,
wait queue depth, avg checkout time.

> Why React component re-render?

New object ref each render. Inline object
prop = new ref = re-render. Wrap in useMemo.
Or extract to module-level const if static.

> stop caveman

Caveman mode deactivated. Returning to
standard verbose output.`,
    typeSpeed: 18,
    pauseAfter: 3000
  }
];

/* ── HERO MINI TERMINAL ── */

const HERO_LINES = [
  { cmd: '/review', out: 'Bug in auth:47. Token expiry. Fix:' },
  { cmd: '/investigate', out: 'Root cause: stale cache. Clear + retry.' },
  { cmd: '/qa', out: '3 bugs found. 3 fixed. 0 remaining.' }
];

/* ── UTILITY ── */

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── CAVE TERMINAL CLASS ── */

class CaveTerminal {
  constructor(el, options = {}) {
    this.el = el;
    this.options = options;
    this.currentScenario = 0;
    this.animationTimers = [];
    this.animationIntervals = [];
    this.isAnimating = false;
  }

  start() {
    if (prefersReducedMotion) {
      this.renderStatic(SCENARIOS[0]);
      return;
    }
    this.playScenario(0);
  }

  cancelCurrentAnimation() {
    this.animationTimers.forEach(id => clearTimeout(id));
    this.animationIntervals.forEach(id => clearInterval(id));
    this.animationTimers = [];
    this.animationIntervals = [];
    this.isAnimating = false;
  }

  switchScenario(index) {
    if (index === this.currentScenario && this.isAnimating) return;
    this.cancelCurrentAnimation();
    this.currentScenario = index;

    // Update tabs
    const tabs = this.el.closest('section')?.querySelectorAll('[role="tab"]');
    if (tabs) {
      tabs.forEach((tab, i) => {
        tab.setAttribute('aria-selected', i === index ? 'true' : 'false');
        tab.classList.toggle('active', i === index);
      });
    }

    if (prefersReducedMotion) {
      this.renderStatic(SCENARIOS[index]);
    } else {
      this.playScenario(index);
    }
  }

  renderStatic(scenario) {
    const content = this.el.querySelector('.terminal-content');
    if (!content) return;

    if (scenario.mode === 'split') {
      content.innerHTML = this.buildSplitHTML(scenario, true);
      this.updateCounter(scenario, true);
    } else {
      content.innerHTML = this.buildSingleHTML(scenario, true);
      this.hideCounter();
    }
  }

  playScenario(index) {
    const scenario = SCENARIOS[index];
    const content = this.el.querySelector('.terminal-content');
    if (!content) return;
    this.isAnimating = true;

    if (scenario.mode === 'split') {
      content.innerHTML = this.buildSplitHTML(scenario, false);
      const verboseEl = content.querySelector('.pane-verbose pre');
      const cavemanEl = content.querySelector('.pane-caveman pre');
      const verbosePane = content.querySelector('.pane-verbose');

      // Both panes animate simultaneously.
      // Verbose: fast line-by-line (not per-char) to show wall of text filling up.
      // Caveman: slower per-char typewriter to emphasize how little text there is.
      // The contrast is the point: verbose floods while caveman finishes quickly.

      // Auto-scroll verbose pane ONLY while lines are still being added.
      // Uses a simple counter: verbose has N lines, scroll stops at line N.
      const totalLines = scenario.verbose.split('\n').length;
      let linesRendered = 0;
      const scrollInterval = setInterval(() => {
        if (verbosePane) verbosePane.scrollTop = verbosePane.scrollHeight;
        if (linesRendered >= totalLines) clearInterval(scrollInterval);
      }, 50);
      this.animationIntervals.push(scrollInterval);

      this.typewriteLines(verboseEl, scenario.verbose, 80, () => {
        linesRendered = totalLines; // signal scroll to stop
      });

      // Caveman starts after a short beat (400ms) so the eye sees verbose first
      const cavemanDelay = setTimeout(() => {
        this.typewrite(cavemanEl, scenario.caveman, scenario.typeSpeed, () => {
          this.isAnimating = false;
        });
        this.animateCounter(scenario);
      }, 400);
      this.animationTimers.push(cavemanDelay);
    } else {
      content.innerHTML = this.buildSingleHTML(scenario, false);
      const outputEl = content.querySelector('.pane-single pre');
      this.hideCounter();
      this.typewrite(outputEl, scenario.caveman, scenario.typeSpeed, () => {
        this.isAnimating = false;
      });
    }
  }

  typewrite(el, text, speed, onComplete) {
    if (!el) return;
    el.textContent = '';
    let i = 0;
    const tick = () => {
      if (i < text.length) {
        el.textContent += text[i];
        i++;
        const id = setTimeout(tick, speed);
        this.animationTimers.push(id);
      } else if (onComplete) {
        onComplete();
      }
    };
    tick();
  }

  typewriteLines(el, text, msPerLine, onComplete) {
    if (!el) return;
    el.textContent = '';
    const lines = text.split('\n');
    let i = 0;
    const tick = () => {
      if (i < lines.length) {
        el.textContent += (i > 0 ? '\n' : '') + lines[i];
        i++;
        const id = setTimeout(tick, msPerLine);
        this.animationTimers.push(id);
      } else if (onComplete) {
        onComplete();
      }
    };
    tick();
  }

  animateCounter(scenario) {
    const counterEl = this.el.querySelector('.word-counter');
    if (!counterEl) return;
    counterEl.style.display = '';

    const verboseWords = countWords(scenario.verbose);
    const cavemanWords = countWords(scenario.caveman);
    const diff = verboseWords - cavemanWords;
    const pct = Math.round((diff / verboseWords) * 100);

    let current = 0;
    const step = Math.max(1, Math.floor(diff / 40));
    const tick = () => {
      if (current < diff) {
        current = Math.min(current + step, diff);
        counterEl.textContent = `${current} fewer words (${Math.round((current / verboseWords) * 100)}% less)`;
        const id = setTimeout(tick, 30);
        this.animationTimers.push(id);
      } else {
        counterEl.textContent = `${diff} fewer words (${pct}% less)`;
      }
    };
    tick();
  }

  updateCounter(scenario, instant) {
    const counterEl = this.el.querySelector('.word-counter');
    if (!counterEl) return;

    if (scenario.mode === 'single') {
      this.hideCounter();
      return;
    }

    counterEl.style.display = '';
    const verboseWords = countWords(scenario.verbose);
    const cavemanWords = countWords(scenario.caveman);
    const diff = verboseWords - cavemanWords;
    const pct = Math.round((diff / verboseWords) * 100);
    counterEl.textContent = `${diff} fewer words (${pct}% less)`;
  }

  hideCounter() {
    const counterEl = this.el.querySelector('.word-counter');
    if (counterEl) counterEl.style.display = 'none';
  }

  buildSplitHTML(scenario, withContent) {
    return `
      <div class="terminal-split">
        <div class="pane-verbose" role="log" aria-label="Verbose output">
          <div class="pane-label">Default verbose</div>
          <pre>${withContent ? this.escapeHTML(scenario.verbose) : ''}</pre>
        </div>
        <div class="terminal-divider"></div>
        <div class="pane-caveman" role="log" aria-label="Caveman output" aria-live="polite">
          <div class="pane-label">CaveStack (caveman mode)</div>
          <pre>${withContent ? this.escapeHTML(scenario.caveman) : ''}</pre>
        </div>
      </div>`;
  }

  buildSingleHTML(scenario, withContent) {
    return `
      <div class="terminal-single">
        <div class="pane-single" role="log" aria-label="CaveRock demo" aria-live="polite">
          <pre>${withContent ? this.escapeHTML(scenario.caveman) : ''}</pre>
        </div>
      </div>`;
  }

  escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy() {
    this.cancelCurrentAnimation();
  }
}

/* ── HERO MINI TERMINAL LOOP ── */

function initHeroTerminal() {
  const output = document.getElementById('hero-typewriter');
  if (!output) return;

  if (prefersReducedMotion) {
    output.textContent = HERO_LINES.map(l => `${l.cmd} \u2192 ${l.out}`).join(' \u00b7 ');
    return;
  }

  let lineIndex = 0;
  const timers = [];

  function playLine() {
    const line = HERO_LINES[lineIndex];
    const fullText = `${line.cmd} \u2192 ${line.out}`;
    output.textContent = '';
    let i = 0;

    function tick() {
      if (i < fullText.length) {
        output.textContent += fullText[i];
        i++;
        timers.push(setTimeout(tick, 35));
      } else {
        timers.push(setTimeout(() => {
          lineIndex = (lineIndex + 1) % HERO_LINES.length;
          playLine();
        }, 3000));
      }
    }
    tick();
  }

  playLine();
}

/* ── INIT ── */

document.addEventListener('DOMContentLoaded', () => {
  // Main terminal demo
  const termEl = document.getElementById('cave-terminal');
  if (termEl) {
    const terminal = new CaveTerminal(termEl);
    terminal.start();

    // Tab switching
    document.querySelectorAll('[data-scenario]').forEach(tab => {
      tab.addEventListener('click', () => {
        terminal.switchScenario(parseInt(tab.dataset.scenario, 10));
      });
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          terminal.switchScenario(parseInt(tab.dataset.scenario, 10));
        }
      });
    });
  }

  // CaveRock mini terminal
  const crEl = document.getElementById('caverock-terminal');
  if (crEl) {
    const crTerminal = new CaveTerminal(crEl);
    crTerminal.switchScenario(2); // CaveRock scenario
  }

  // Hero mini terminal
  initHeroTerminal();

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmdEl = btn.closest('.install-box')?.querySelector('.cmd');
      if (cmdEl) {
        navigator.clipboard.writeText(cmdEl.textContent.trim());
        btn.textContent = 'Done';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
    });
  });
});
