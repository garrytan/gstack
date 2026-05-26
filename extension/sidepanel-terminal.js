/**
 * Terminal sidebar tab — interactive Claude Code PTY in xterm.js.
 *
 * Lifecycle (per plan + codex review):
 *   1. Sidebar opens. Terminal is the default-active tab.
 *   2. Bootstrap card shows "Press any key to start Claude Code."
 *   3. On first keystroke (lazy spawn — codex finding #8): the extension
 *      a) POSTs /pty-session on the browse server with the AUTH_TOKEN to
 *         mint a short-lived HttpOnly cookie scoped to the terminal-agent.
 *      b) Opens ws://127.0.0.1:<terminalPort>/ws — the cookie travels
 *         automatically. Terminal-agent validates the cookie + the
 *         chrome-extension:// Origin (codex finding #9), then spawns
 *         claude in a PTY.
 *   4. Bytes pump both ways. Resize observer sends {type:"resize"} text
 *      frames; tab-switch hooks send {type:"tabSwitch"} frames.
 *   5. PTY exits or WS closes -> we show "Session ended" with a restart
 *      button. We do NOT auto-reconnect (codex finding #8: auto-reconnect
 *      = burn fresh claude session every time).
 *
 * Keep this file dependency-free. xterm.js + xterm-addon-fit are loaded
 * via <script src> tags in sidepanel.html (window.Terminal, window.FitAddon).
 */
(function () {
  'use strict';

  const Terminal = window.Terminal;
  const FitAddonModule = window.FitAddon;
  if (!Terminal) {
    console.error('[gstack terminal] xterm not loaded');
    return;
  }

  const els = {
    bootstrap: document.getElementById('terminal-bootstrap'),
    bootstrapStatus: document.getElementById('terminal-bootstrap-status'),
    installCard: document.getElementById('terminal-install-card'),
    installRetry: document.getElementById('terminal-install-retry'),
    mount: document.getElementById('terminal-mount'),
    ended: document.getElementById('terminal-ended'),
    restart: document.getElementById('terminal-restart'),
    restartNow: document.getElementById('terminal-restart-now'),
  };

  /** State machine. */
  const STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    LIVE: 'live',
    ENDED: 'ended',
    NO_CLAUDE: 'no-claude',
    RECONNECTING: 'reconnecting',  // v1.44 Commit 3 — re-attach loop active
  };
  let state = STATE.IDLE;

  let term = null;
  let fitAddon = null;
  let ws = null;
  /**
   * Sticky abort flag for tryAutoConnect's polling loop. Set when we
   * receive an unrecoverable signal (auth invalid → 401, claude not
   * found, fatal server error) so the loop doesn't keep retrying and
   * spamming the user with the same failure message every 2s. Cleared
   * by forceRestart() so the user can re-enter the polling loop after
   * fixing whatever was wrong.
   */
  let autoConnectAborted = false;
  /**
   * v1.44 session identity. The stable, non-secret sessionId minted by
   * /pty-session and surfaced back via window.gstackPtySession so the
   * sidepanel.js pagehide handler can sendBeacon /pty-dispose for THIS
   * specific session. forceRestart sends this to /pty-restart so the
   * server can scope the disposal to one terminal rather than all.
   */
  let currentSessionId = null;
  /**
   * Commit 3 re-attach loop. Set true while a re-attach is in flight so
   * concurrent ws.close events (e.g. user clicks Restart mid-reconnect)
   * can short-circuit. Reset by every state transition out of RECONNECTING.
   */
  let reattachInFlight = false;
  /**
   * Set true after a {type:"reattach-begin"} text frame and reset after
   * the next binary frame is treated as replay payload. The flag is what
   * lets the message handler distinguish "this binary is the scrollback
   * replay, write RIS first to clear xterm" from "this is live PTY
   * output, just feed it through."
   */
  let nextBinaryIsReplay = false;
  /**
   * Re-attach backoff schedule (ms). 1s, 2s, 4s, 8s, then 8s steady until
   * 60s total elapsed (Commit 3 detach window). If all attempts fail,
   * fall through to ENDED state and the user clicks Restart for a fresh
   * session.
   */
  const REATTACH_BACKOFF_MS = [1000, 2000, 4000, 8000];
  const REATTACH_WINDOW_MS = 60_000;
  /**
   * 25s client-side WS keepalive interval (v1.44+). Belt-and-suspenders with
   * the server-side ping in terminal-agent.ts: server pings cover most
   * idle-NAT cases, client keepalive frames also defend against Chromium's
   * MV3-adjacent panel suspension heuristics that can pause our timers.
   * Started on ws.open, cleared on ws.close. The agent silently accepts
   * `{type:"keepalive"}` text frames.
   */
  let keepaliveInterval = null;
  const KEEPALIVE_INTERVAL_MS = 25000;

  function show(el) { el.style.display = ''; }
  function hide(el) { el.style.display = 'none'; }

  function setState(next, opts = {}) {
    state = next;
    switch (next) {
      case STATE.IDLE:
        show(els.bootstrap);
        hide(els.installCard);
        hide(els.mount);
        hide(els.ended);
        els.bootstrapStatus.textContent = opts.message || 'Press any key to start Claude Code.';
        break;
      case STATE.CONNECTING:
        show(els.bootstrap);
        hide(els.installCard);
        hide(els.mount);
        hide(els.ended);
        els.bootstrapStatus.textContent = 'Connecting...';
        break;
      case STATE.LIVE:
        hide(els.bootstrap);
        hide(els.installCard);
        show(els.mount);
        hide(els.ended);
        break;
      case STATE.ENDED:
        hide(els.bootstrap);
        hide(els.installCard);
        hide(els.mount);
        show(els.ended);
        break;
      case STATE.NO_CLAUDE:
        show(els.bootstrap);
        show(els.installCard);
        hide(els.mount);
        hide(els.ended);
        els.bootstrapStatus.textContent = '';
        break;
    }
  }

  /**
   * Read auth + terminalPort from the server's /health. We don't fetch this
   * here — sidepanel.js already polls /health for connection state and
   * exposes the relevant fields on window.gstackHealth (set below in init()).
   * If terminalPort is missing, the agent isn't ready yet.
   */
  function getHealth() {
    return window.gstackHealth || {};
  }

  function getServerPort() {
    return window.gstackServerPort || null;
  }

  function getAuthToken() {
    return window.gstackAuthToken || null;
  }

  /**
   * POST /pty-session to mint a fresh terminal session. Returns
   * { terminalPort, ptySessionToken, expiresAt } on success, or
   * { error } on failure. The token rides on the WebSocket
   * Sec-WebSocket-Protocol header, which is the only auth header
   * the browser WebSocket API lets us set. The token is NOT persisted —
   * each sidebar load mints a fresh one and discards it on close.
   */
  async function mintSession() {
    const serverPort = getServerPort();
    const token = getAuthToken();
    if (!serverPort || !token) {
      return { error: 'browse server not ready' };
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${serverPort}/pty-session`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        credentials: 'include',
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { error: `${resp.status} ${body || resp.statusText}` };
      }
      return await resp.json();
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * Commit 3 — re-attach loop. Triggered by an unexpected WS close
   * (anything other than the v1.44 intentional codes) while state was
   * LIVE. Posts /pty-session/reattach with the current sessionId; on
   * success opens a new WS, feeds the {type:"reattach-begin"} +
   * replay-binary handshake from the agent into xterm.
   *
   * Backoff: 1s, 2s, 4s, 8s, then 8s steady. Total wall budget is the
   * server's DETACH_WINDOW_MS (default 60s) — past that point the
   * server has disposed our session and any re-attach attempt will
   * return 410 Gone.
   *
   * Aborts on:
   *   - reattachInFlight transitions to false (user clicked Restart or
   *     navigated away)
   *   - 410 Gone from /pty-session/reattach (lease expired)
   *   - 401 (auth invalid)
   *   - REATTACH_WINDOW_MS elapsed
   */
  function startReattachLoop(prevSessionId) {
    if (!prevSessionId) {
      setState(STATE.ENDED);
      return;
    }
    const serverPort = getServerPort();
    const authToken = getAuthToken();
    if (!serverPort || !authToken) {
      setState(STATE.ENDED);
      return;
    }
    reattachInFlight = true;
    setState(STATE.RECONNECTING);
    const startedAt = Date.now();
    let attempt = 0;

    const tick = async () => {
      if (!reattachInFlight) return;
      if (Date.now() - startedAt > REATTACH_WINDOW_MS) {
        reattachInFlight = false;
        setState(STATE.ENDED);
        return;
      }
      attempt += 1;
      let resp;
      try {
        resp = await fetch(`http://127.0.0.1:${serverPort}/pty-session/reattach`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId: prevSessionId }),
          credentials: 'include',
        });
      } catch (err) {
        scheduleNextAttempt();
        return;
      }
      if (resp.status === 410) {
        // Server disposed the session — lease window closed. No point
        // retrying; fall through so the user clicks Restart for a fresh
        // session.
        reattachInFlight = false;
        setState(STATE.ENDED);
        return;
      }
      if (resp.status === 401) {
        reattachInFlight = false;
        autoConnectAborted = true;
        setState(STATE.IDLE, {
          message: 'Auth invalid — reload the sidebar or restart your gstack session.',
        });
        return;
      }
      if (!resp.ok) {
        scheduleNextAttempt();
        return;
      }
      let body;
      try { body = await resp.json(); } catch { body = null; }
      if (!body || !body.terminalPort || !body.attachToken) {
        scheduleNextAttempt();
        return;
      }
      reattachInFlight = false;
      openReattachWebSocket(body.terminalPort, body.attachToken, body.sessionId || prevSessionId);
    };

    const scheduleNextAttempt = () => {
      const backoffIdx = Math.min(attempt - 1, REATTACH_BACKOFF_MS.length - 1);
      const delay = REATTACH_BACKOFF_MS[backoffIdx] ?? 8000;
      setTimeout(tick, delay);
    };

    tick();
  }

  /**
   * Open the post-reattach WebSocket. Mostly a clone of connect()'s
   * attach wiring but with the {type:"reattach-begin"} → RIS → binary
   * replay handshake added. The xterm element is REUSED (not disposed) so
   * the buffer flash is minimal — RIS clears it cleanly just before the
   * replay arrives.
   */
  function openReattachWebSocket(terminalPort, attachToken, sessionId) {
    currentSessionId = sessionId || null;
    try { window.gstackPtySession = currentSessionId; } catch {}
    setState(STATE.LIVE);
    ensureXterm();
    nextBinaryIsReplay = false;
    ws = new WebSocket(`ws://127.0.0.1:${terminalPort}/ws`, [`gstack-pty.${attachToken}`]);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {}
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: 'keepalive' })); } catch {}
      }, KEEPALIVE_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'reattach-begin') {
            // Clear xterm before the replay binary arrives — RIS (\x1bc)
            // is a full hardware reset that flushes the buffer and
            // resets all attributes. The server's replay starts with
            // DECSTR + optional alt-screen re-enter for safety.
            try { term.write('\x1bc'); } catch {}
            nextBinaryIsReplay = true;
            return;
          }
          if (msg.type === 'error' && msg.code === 'CLAUDE_NOT_FOUND') {
            setState(STATE.NO_CLAUDE);
            try { ws.close(); } catch {}
            return;
          }
          if (msg.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong', ts: msg.ts })); } catch {}
            return;
          }
        } catch {}
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      // First binary frame after reattach-begin is the replay payload;
      // write it through unchanged (server already prefixed soft-reset).
      // Subsequent binary frames are live PTY output.
      term.write(buf);
      if (nextBinaryIsReplay) nextBinaryIsReplay = false;
    });

    ws.addEventListener('close', (ev) => {
      ws = null;
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      // If THIS reattach WS also closes uncleanly, recurse into another
      // re-attach loop with the SAME sessionId — the server may still
      // be inside the detach window. The state check + sessionId guard
      // prevent runaway recursion (ENDED short-circuits the next loop).
      if (state !== STATE.LIVE) return;
      const code = (ev && (ev.code ?? 1006)) || 1006;
      const intentional = code === 1000 || code === 4001 || code === 4404;
      if (intentional || !currentSessionId) {
        setState(intentional ? STATE.ENDED : STATE.ENDED);
        return;
      }
      startReattachLoop(currentSessionId);
    });
    ws.addEventListener('error', (err) => {
      console.error('[gstack terminal] reattach ws error', err);
    });
  }

  async function checkClaudeAvailable(terminalPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${terminalPort}/claude-available`, {
        credentials: 'include',
      });
      if (!resp.ok) return { available: false };
      return await resp.json();
    } catch {
      return { available: false };
    }
  }

  function ensureXterm() {
    if (term) return;
    term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, "Noto Sans Mono CJK KR", "Malgun Gothic", monospace',
      fontSize: 13,
      theme: { background: '#0a0a0a', foreground: '#e5e5e5' },
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: false,
      convertEol: false,
    });
    if (FitAddonModule && FitAddonModule.FitAddon) {
      fitAddon = new FitAddonModule.FitAddon();
      term.loadAddon(fitAddon);
    }
    // CRITICAL: caller must make els.mount visible BEFORE invoking
    // ensureXterm. xterm.js measures the container synchronously inside
    // term.open() — if the mount is display:none, xterm caches a 0-size
    // viewport and never auto-grows even after the container goes
    // visible. The visible-first pattern is enforced by connect()
    // calling setState(STATE.LIVE) before us.
    term.open(els.mount);
    // First fit waits for the next paint frame so the browser has
    // applied the .active class transition. Otherwise term.cols/rows
    // can come back as the minimum (2x2) when the mount's clientHeight
    // is still being computed.
    requestAnimationFrame(() => {
      try {
        fitAddon && fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });

    const ro = new ResizeObserver(() => {
      try {
        fitAddon && fitAddon.fit();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    ro.observe(els.mount);

    // IME composition handling for Korean/CJK input (issue #1272).
    // Suppress partial jamo during composition; only send the final
    // composed string on compositionend. Without this, Korean IME
    // sends fragmented input or doubles characters.
    let composing = false;
    const ta = term.textarea;
    if (ta) {
      ta.addEventListener('compositionstart', () => { composing = true; });
      ta.addEventListener('compositionend', (e) => {
        composing = false;
        if (e.data && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new TextEncoder().encode(e.data));
        }
      });
    }


    term.onData((data) => {
      if (composing) return;  // suppress partial input events during IME composition
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });
  }

  /**
   * Inject a string into the live PTY (the same way a real keystroke would).
   * Used by the toolbar's Cleanup button and the Inspector's "Send to Code"
   * action so the user can drive claude from outside-the-keyboard surfaces.
   * Returns true if the bytes went out, false if no live session.
   *
   * IMPORTANT (D6): this function stays SYNCHRONOUS and SCAN-FREE. Page-
   * derived input MUST be pre-scanned via window.gstackScanForPTYInject()
   * before calling this. The invariant test in
   * test/extension-pty-inject-invariant.test.ts fails the build if any
   * extension/*.js path calls this without the preceding scan.
   *
   * Why not move the scan inside this function: callers already use the
   * sync `const ok = gstackInjectToTerminal?.(text)` pattern. Making the
   * inject async would turn `ok` into a Promise and silently break every
   * existing call site. Pre-scanning at the caller keeps the boundary
   * clean and the invariant testable.
   */
  window.gstackInjectToTerminal = function (text) {
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(new TextEncoder().encode(text));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Scan page-derived text via the browse server's /pty-inject-scan
   * endpoint before injecting it into the PTY. Returns:
   *   { allow: true, verdict: "PASS" }                  → safe to inject
   *   { allow: true, verdict: "WARN", reasons: [...] }  → caller should
   *       prompt the user before injecting
   *   { allow: false, verdict: "BLOCK", reasons: [...]} → drop the text;
   *       caller should surface a banner to the user
   *
   * On any network / endpoint failure: returns
   *   { allow: true, verdict: "WARN", reasons: ["scan-unreachable"] }
   * so the caller falls back to WARN+confirm rather than silent PASS.
   *
   * Closes #1370.
   */
  window.gstackScanForPTYInject = async function (text, origin) {
    if (!text) return { allow: false, verdict: 'BLOCK', reasons: ['empty-text'] };
    try {
      const resp = await fetch('http://127.0.0.1:34567/pty-inject-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getAuthTokenForScan()}`,
        },
        body: JSON.stringify({ text, origin: origin || 'extension' }),
      });
      if (!resp.ok) {
        return { allow: true, verdict: 'WARN', reasons: [`scan-http-${resp.status}`] };
      }
      const body = await resp.json();
      const verdict = body.verdict || 'WARN';
      const allow = verdict !== 'BLOCK';
      return { allow, verdict, reasons: body.reasons || [], l4: body.l4 };
    } catch (err) {
      return {
        allow: true,
        verdict: 'WARN',
        reasons: ['scan-unreachable', err && err.message ? err.message : 'fetch-failed'],
      };
    }
  };

  // The auth token for /pty-inject-scan comes from the same source the
  // sidepanel uses for /pty-session — a runtime fetch from /health (which
  // already returns AUTH_TOKEN in headed mode per CLAUDE.md's v1.1 TODO).
  // We don't echo the token here; this helper is a thin proxy around the
  // existing pattern.
  async function getAuthTokenForScan() {
    if (window.__gstackPtyScanToken) return window.__gstackPtyScanToken;
    try {
      const resp = await fetch('http://127.0.0.1:34567/health');
      const body = await resp.json();
      const token = body.AUTH_TOKEN || body.authToken || '';
      if (token) window.__gstackPtyScanToken = token;
      return token;
    } catch {
      return '';
    }
  }

  async function connect() {
    if (state !== STATE.IDLE) return; // already connecting/live
    setState(STATE.CONNECTING);

    const minted = await mintSession();
    if (minted.error) {
      // 401 = stale auth token; no amount of retrying will fix it. Sticky
      // abort the polling loop so we don't spam the same error every 2s
      // until the user clicks Restart (which clears the flag).
      if (typeof minted.error === 'string' && minted.error.startsWith('401')) {
        autoConnectAborted = true;
        setState(STATE.IDLE, {
          message: 'Auth invalid — reload the sidebar or restart your gstack session.',
        });
        return;
      }
      setState(STATE.IDLE, { message: `Cannot start: ${minted.error}` });
      return;
    }
    // v1.44 4-tuple: { terminalPort, sessionId, attachToken, leaseExpiresAt }
    // Falls back to the legacy `ptySessionToken` field for one minor release
    // (server keeps the alias) so a partially-updated extension still works
    // against a fresh server.
    const { terminalPort, sessionId } = minted;
    const attachToken = minted.attachToken || minted.ptySessionToken;
    if (!attachToken) {
      setState(STATE.IDLE, { message: 'Cannot start: no attach token returned' });
      return;
    }
    currentSessionId = sessionId || null;
    // Expose for sidepanel.js pagehide handler — see Commit 2C wiring.
    try { window.gstackPtySession = currentSessionId; } catch {}

    // Pre-flight: does claude even exist on PATH?
    const claudeStatus = await checkClaudeAvailable(terminalPort);
    if (!claudeStatus.available) {
      setState(STATE.NO_CLAUDE);
      return;
    }

    // setState(LIVE) flips terminal-mount from display:none to display:flex.
    // We MUST do that BEFORE ensureXterm() — xterm.js measures the container
    // synchronously inside term.open() and a hidden container yields a 0x0
    // terminal that never recovers. ensureXterm + the requestAnimationFrame
    // fit() inside it run after the browser has applied the layout.
    setState(STATE.LIVE);
    ensureXterm();

    // Token rides on Sec-WebSocket-Protocol — the only auth header the
    // browser WebSocket API lets us set. Cross-port HttpOnly cookies with
    // SameSite=Strict don't survive the jump from server.ts:34567 to the
    // agent's random port from a chrome-extension origin, so cookies
    // alone weren't reliable.
    ws = new WebSocket(`ws://127.0.0.1:${terminalPort}/ws`, [`gstack-pty.${attachToken}`]);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {}
      // Push a fresh tab snapshot so claude's tabs.json is populated by
      // the time the lazy spawn finishes booting. Background.js exposes
      // the snapshot helper via chrome.runtime; we ask for it here and
      // forward whatever comes back.
      try {
        chrome.runtime.sendMessage({ type: 'getTabState' }, (resp) => {
          if (resp && ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({
                type: 'tabState',
                active: resp.active,
                tabs: resp.tabs,
                reason: 'initial',
              }));
            } catch {}
          }
        });
      } catch {}
      // v1.44 eager spawn: send {type:"start"} so the agent boots claude
      // without requiring the user to type a keystroke. Pre-v1.44 the
      // lazy-binary-spawn pattern made forceRestart look stuck for ~2-3s
      // until the user pressed any key.
      try { ws.send(JSON.stringify({ type: 'start' })); } catch {}
      // v1.44 client-side keepalive. Server pings every 25s; we ALSO send
      // keepalive frames at the same cadence so a paused timer on either
      // side still has the other to lean on. Both are silently dropped
      // by the agent's message handler.
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: 'keepalive' })); } catch {}
      }, KEEPALIVE_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        // Agent control message. Treat as JSON; error frames carry code,
        // ping frames trigger an immediate pong reply.
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'error' && msg.code === 'CLAUDE_NOT_FOUND') {
            setState(STATE.NO_CLAUDE);
            try { ws.close(); } catch {}
            return;
          }
          if (msg.type === 'ping') {
            // Mirror the server's timestamp back. Cheap liveness ACK that
            // lets the agent observe round-trip latency for free.
            try { ws.send(JSON.stringify({ type: 'pong', ts: msg.ts })); } catch {}
            return;
          }
        } catch {}
        return;
      }
      // Binary: feed to xterm.
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      term.write(buf);
    });

    ws.addEventListener('close', (ev) => {
      ws = null;
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      if (state === STATE.NO_CLAUDE) return;
      // v1.44 Commit 3 — re-attach loop on transient close. Clean codes
      // (1000 = pty exited, 4001 = intentional restart, 4404 = no-claude)
      // skip the loop and fall through to ENDED. Any other code
      // (1006 abnormal, 1001 going-away) is a candidate for re-attach
      // within the 60s server-side detach window, provided we still
      // have a sessionId to match against.
      const code = (ev && (ev.code ?? 1006)) || 1006;
      const intentional = code === 1000 || code === 4001 || code === 4404;
      if (state === STATE.LIVE && !intentional && currentSessionId) {
        startReattachLoop(currentSessionId);
        return;
      }
      setState(STATE.ENDED);
    });

    ws.addEventListener('error', (err) => {
      console.error('[gstack terminal] ws error', err);
    });
  }

  function teardown() {
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
    try { ws && ws.close(); } catch {}
    ws = null;
    if (term) {
      try { term.dispose(); } catch {}
      term = null;
      fitAddon = null;
    }
    setState(STATE.IDLE);
  }

  // ─── Wiring ───────────────────────────────────────────────────

  /**
   * Force a fresh session: close any open WS, dispose xterm, return to
   * IDLE, kick off auto-connect. Safe to call from any state.
   */
  /**
   * v1.44 forceRestart: hits the server's /pty-restart one-transaction
   * endpoint with the current sessionId. The server kills the old PtySession
   * scope-to-our-id, mints a fresh sessionId + lease + attachToken, and
   * returns the new 4-tuple in one round trip. Zero race window between
   * kill and mint (codex D8).
   *
   * If we don't have a sessionId (sidebar is in IDLE / ENDED state because
   * the prior session ended cleanly), the route accepts that gracefully —
   * skips the dispose step and just mints fresh. Either way the user sees
   * the same "Restarting..." → fresh prompt UX.
   */
  async function forceRestart() {
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
    // Re-arm the auto-connect loop in case a prior auth failure stuck the
    // sticky flag — explicit user action is the cleared-flag signal.
    autoConnectAborted = false;
    setState(STATE.IDLE, { message: 'Restarting Claude Code...' });

    const serverPort = getServerPort();
    const authToken = getAuthToken();
    const priorSessionId = currentSessionId;

    // Close the local WS BEFORE the server-side kill so the agent's
    // close handler doesn't race with the dispose call.
    try { ws && ws.close(4001, 'intentional-restart'); } catch {}
    ws = null;
    if (term) {
      try { term.dispose(); } catch {}
      term = null;
      fitAddon = null;
    }

    if (!serverPort || !authToken) {
      // Server hasn't been discovered yet — fall back to the patient
      // polling loop. forceRestart's promise of "fresh prompt now" can't
      // be met without a live server; user sees the patient status path.
      tryAutoConnect();
      return;
    }

    let nextTuple = null;
    try {
      const resp = await fetch(`http://127.0.0.1:${serverPort}/pty-restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(priorSessionId ? { sessionId: priorSessionId } : {}),
        credentials: 'include',
      });
      if (resp.ok) {
        nextTuple = await resp.json();
      } else if (resp.status === 401) {
        autoConnectAborted = true;
        setState(STATE.IDLE, {
          message: 'Auth invalid — reload the sidebar or restart your gstack session.',
        });
        return;
      } else if (resp.status === 503) {
        // Agent down — fall through to patient autoconnect which will
        // surface the appropriate "waiting for server" status.
        setState(STATE.IDLE, { message: 'Restart failed: terminal agent not ready. Retrying...' });
      } else {
        const body = await resp.text().catch(() => '');
        setState(STATE.IDLE, { message: `Restart failed: ${resp.status} ${body || resp.statusText}` });
      }
    } catch (err) {
      setState(STATE.IDLE, {
        message: `Restart failed: ${err && err.message ? err.message : String(err)}`,
      });
    }

    if (!nextTuple) {
      // Restart didn't yield a fresh tuple. Fall back to the regular
      // connect path; tryAutoConnect will retry as the server recovers.
      currentSessionId = null;
      try { window.gstackPtySession = null; } catch {}
      tryAutoConnect();
      return;
    }

    // We have a fresh 4-tuple — open the new WS directly without going
    // through mintSession again. This is the explicit "no race window"
    // path the codex D8 redesign was after.
    const { terminalPort, sessionId, attachToken, expiresAt: _expiresAt } = nextTuple;
    const token = attachToken || nextTuple.ptySessionToken;
    if (!terminalPort || !token) {
      currentSessionId = null;
      tryAutoConnect();
      return;
    }
    currentSessionId = sessionId || null;
    try { window.gstackPtySession = currentSessionId; } catch {}

    // Pre-flight: claude still on PATH?
    const claudeStatus = await checkClaudeAvailable(terminalPort);
    if (!claudeStatus.available) {
      setState(STATE.NO_CLAUDE);
      return;
    }

    setState(STATE.LIVE);
    ensureXterm();
    ws = new WebSocket(`ws://127.0.0.1:${terminalPort}/ws`, [`gstack-pty.${token}`]);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {}
      try {
        chrome.runtime.sendMessage({ type: 'getTabState' }, (resp) => {
          if (resp && ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({
                type: 'tabState',
                active: resp.active,
                tabs: resp.tabs,
                reason: 'restart',
              }));
            } catch {}
          }
        });
      } catch {}
      // Eager spawn — fresh claude prompt visible without user keystroke.
      try { ws.send(JSON.stringify({ type: 'start' })); } catch {}
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: 'keepalive' })); } catch {}
      }, KEEPALIVE_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'error' && msg.code === 'CLAUDE_NOT_FOUND') {
            setState(STATE.NO_CLAUDE);
            try { ws.close(); } catch {}
            return;
          }
          if (msg.type === 'ping') {
            try { ws.send(JSON.stringify({ type: 'pong', ts: msg.ts })); } catch {}
            return;
          }
        } catch {}
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      term.write(buf);
    });

    ws.addEventListener('close', (ev) => {
      ws = null;
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      if (state === STATE.NO_CLAUDE) return;
      // v1.44 Commit 3 — re-attach loop on transient close. Clean codes
      // (1000 = pty exited, 4001 = intentional restart, 4404 = no-claude)
      // skip the loop and fall through to ENDED. Any other code
      // (1006 abnormal, 1001 going-away) is a candidate for re-attach
      // within the 60s server-side detach window, provided we still
      // have a sessionId to match against.
      const code = (ev && (ev.code ?? 1006)) || 1006;
      const intentional = code === 1000 || code === 4001 || code === 4404;
      if (state === STATE.LIVE && !intentional && currentSessionId) {
        startReattachLoop(currentSessionId);
        return;
      }
      setState(STATE.ENDED);
    });
    ws.addEventListener('error', (err) => {
      console.error('[gstack terminal] ws error', err);
    });
  }

  /**
   * Repaint xterm when the Terminal pane becomes visible. xterm.js has a
   * known issue where its renderer doesn't redraw after a display:none →
   * display:flex flip — the canvas/DOM stays blank until something forces
   * a layout pass. fit() recomputes dimensions, refresh() redraws.
   */
  function repaintIfLive() {
    if (state !== STATE.LIVE || !term) return;
    try { fitAddon && fitAddon.fit(); } catch {}
    try { term.refresh(0, term.rows - 1); } catch {}
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {}
  }

  function init() {
    setState(STATE.IDLE, { message: 'Starting Claude Code...' });

    els.installRetry?.addEventListener('click', () => {
      // Re-probe claude on PATH, then try a connect.
      setState(STATE.IDLE, { message: 'Starting Claude Code...' });
      tryAutoConnect();
    });

    // Two restart buttons:
    //   - els.restart lives inside the ENDED state card (visible only after
    //     a session has ended).
    //   - els.restartNow lives in the always-visible toolbar (lets the user
    //     force a fresh claude mid-session without waiting for it to exit).
    els.restart?.addEventListener('click', forceRestart);
    els.restartNow?.addEventListener('click', forceRestart);


    // Live browser-tab state. background.js → sidepanel.js → us. We
    // forward over the live PTY WebSocket; terminal-agent.ts writes
    // <stateDir>/active-tab.json + <stateDir>/tabs.json so claude can
    // always read the current tab landscape.
    document.addEventListener('gstack:tab-state', (ev) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({
          type: 'tabState',
          active: ev.detail?.active,
          tabs: ev.detail?.tabs,
          reason: ev.detail?.reason,
        }));
      } catch {}
    });

    // Repaint after a debug-tab → primary-pane transition. The debug
    // tabs (Activity / Refs / Inspector) hide the Terminal pane via
    // .tab-content { display: none }; xterm doesn't auto-redraw when its
    // container flips back to visible, so we listen for the close-debug
    // event and force a fit + refresh.
    const observer = new MutationObserver(() => {
      const term = document.getElementById('tab-terminal');
      if (term?.classList.contains('active')) {
        requestAnimationFrame(repaintIfLive);
      }
    });
    const target = document.getElementById('tab-terminal');
    if (target) observer.observe(target, { attributes: true, attributeFilter: ['class'] });

    tryAutoConnect();
  }

  /**
   * Eager-connect when the sidebar opens. Polls for sidepanel.js to populate
   * window.gstackServerPort + window.gstackAuthToken (which it does as soon
   * as /health succeeds), then fires connect() automatically. The user
   * doesn't have to press a key — Terminal is the default tab and "tap to
   * start" was a needless paper cut on every reload.
   *
   * v1.44 patience overhaul: no more 15s give-up. The user already opened
   * the sidebar; giving up tells them "you did something wrong" when the
   * truth is the daemon is slow to boot (or restarting via the upstream
   * supervisor). We poll forever at 2s intervals with ascending status
   * messages so the user knows we're still trying, and ONLY abort on
   * explicit signals: state transition out of IDLE (connect succeeded
   * or user navigated), or an unrecoverable auth/network signal.
   */
  function tryAutoConnect() {
    if (state !== STATE.IDLE) return;
    if (autoConnectAborted) return;
    const startedAt = Date.now();
    const tick = () => {
      // If the user navigated away (Chat tab) or already connected, drop out.
      if (state !== STATE.IDLE) return;
      // If a prior attempt hit an unrecoverable error (401, etc.), stop
      // polling. The user clears the flag by clicking Restart.
      if (autoConnectAborted) return;
      if (getServerPort() && getAuthToken()) {
        connect();
        return;
      }
      // Ascending status messages — the user wants to know the sidebar is
      // still trying. Each threshold is the moment the message would
      // mislead if left silent: at 15s "should have started by now," at
      // 60s "the server might be in trouble," at 5min "stop waiting and
      // check on it manually."
      const elapsed = Date.now() - startedAt;
      if (elapsed > 300_000) {
        setState(STATE.IDLE, {
          message: 'Browse server still not responding after 5 min. Try `$B status` in a terminal.',
        });
      } else if (elapsed > 60_000) {
        setState(STATE.IDLE, {
          message: 'Still waiting — browse server may be slow to start.',
        });
      } else if (elapsed > 15_000) {
        setState(STATE.IDLE, { message: 'Waiting for browse server...' });
      }
      setTimeout(tick, 2000);
    };
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
