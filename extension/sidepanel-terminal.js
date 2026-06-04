/**
 * Terminal sidebar tab — interactive coding-agent PTY in xterm.js.
 *
 * Lifecycle (per plan + codex review):
 *   1. Sidebar opens. Terminal is the default-active tab.
 *   2. Bootstrap card shows the active agent status. Codex is the default.
 *   3. On first keystroke (lazy spawn — codex finding #8): the extension
 *      a) POSTs /pty-session on the browse server with the AUTH_TOKEN to
 *         mint a short-lived HttpOnly cookie scoped to the terminal-agent.
 *      b) Opens ws://127.0.0.1:<terminalPort>/ws — the cookie travels
 *         automatically. Terminal-agent validates the cookie + the
 *         chrome-extension:// Origin (codex finding #9), then spawns
 *         the selected agent in a PTY.
 *   4. Bytes pump both ways. Resize observer sends {type:"resize"} text
 *      frames; tab-switch hooks send {type:"tabSwitch"} frames.
 *   5. PTY exits or WS closes -> we show "Session ended" with a restart
 *      button. We do NOT auto-reconnect (codex finding #8: auto-reconnect
 *      = burn a fresh agent session every time).
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

  const DEFAULT_AGENT = 'codex';
  const AGENTS = {
    codex: {
      key: 'codex',
      label: 'Codex',
      displayName: 'Codex CLI',
      installTitle: 'Codex CLI not found',
      installUrl: 'https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started',
      installText: 'OpenAI Codex CLI guide',
      hint: 'Real PTY. Real terminal. Codex by default.',
    },
    claude: {
      key: 'claude',
      label: 'Claude',
      displayName: 'Claude Code',
      installTitle: 'Claude Code not found',
      installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
      installText: 'Claude Code docs',
      hint: 'Real PTY. Real terminal. Claude Code.',
    },
  };

  const els = {
    bootstrap: document.getElementById('terminal-bootstrap'),
    bootstrapStatus: document.getElementById('terminal-bootstrap-status'),
    bootstrapHint: document.getElementById('terminal-bootstrap-hint'),
    installCard: document.getElementById('terminal-install-card'),
    installTitle: document.getElementById('terminal-install-title'),
    installLink: document.getElementById('terminal-install-link'),
    installRetry: document.getElementById('terminal-install-retry'),
    mount: document.getElementById('terminal-mount'),
    ended: document.getElementById('terminal-ended'),
    restart: document.getElementById('terminal-restart'),
    restartNow: document.getElementById('terminal-restart-now'),
    agentButtons: Array.from(document.querySelectorAll('[data-terminal-agent]')),
  };

  /** State machine. */
  const STATE = { IDLE: 'idle', CONNECTING: 'connecting', LIVE: 'live', ENDED: 'ended', NO_AGENT: 'no-agent' };
  let state = STATE.IDLE;

  let term = null;
  let fitAddon = null;
  let ws = null;
  let connectSeq = 0;
  let currentAgent = loadAgent();

  function loadAgent() {
    try {
      const saved = localStorage.getItem('gstackTerminalAgent');
      return AGENTS[saved] ? saved : DEFAULT_AGENT;
    } catch {
      return DEFAULT_AGENT;
    }
  }

  function saveAgent(agent) {
    try { localStorage.setItem('gstackTerminalAgent', agent); } catch {}
  }

  function getAgent() {
    return AGENTS[currentAgent] || AGENTS[DEFAULT_AGENT];
  }

  function show(el) { el.style.display = ''; }
  function hide(el) { el.style.display = 'none'; }

  function updateAgentControls() {
    const agent = getAgent();
    for (const btn of els.agentButtons) {
      const active = btn.dataset.terminalAgent === agent.key;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (els.bootstrapHint) els.bootstrapHint.textContent = agent.hint;
    if (els.installTitle) els.installTitle.textContent = agent.installTitle;
    if (els.installLink) {
      els.installLink.href = agent.installUrl;
      els.installLink.textContent = agent.installText;
    }
    if (els.restartNow) els.restartNow.title = `Restart ${agent.displayName} session`;
  }

  function setState(next, opts = {}) {
    updateAgentControls();
    const agent = getAgent();
    state = next;
    switch (next) {
      case STATE.IDLE:
        show(els.bootstrap);
        hide(els.installCard);
        hide(els.mount);
        hide(els.ended);
        els.bootstrapStatus.textContent = opts.message || `Press any key to start ${agent.displayName}.`;
        break;
      case STATE.CONNECTING:
        show(els.bootstrap);
        hide(els.installCard);
        hide(els.mount);
        hide(els.ended);
        els.bootstrapStatus.textContent = `Connecting ${agent.displayName}...`;
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
      case STATE.NO_AGENT:
        show(els.bootstrap);
        show(els.installCard);
        hide(els.mount);
        hide(els.ended);
        els.bootstrapStatus.textContent = '';
        break;
    }
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

  async function checkAgentAvailable(terminalPort, agentKey) {
    try {
      const resp = await fetch(`http://127.0.0.1:${terminalPort}/agent-available?agent=${encodeURIComponent(agentKey)}`, {
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
   * action so the user can drive the selected agent from toolbar surfaces.
   * Returns true if the bytes went out, false if no live session.
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

  async function connect() {
    if (state !== STATE.IDLE) return; // already connecting/live
    const seq = ++connectSeq;
    const agentKey = currentAgent;
    setState(STATE.CONNECTING);

    const minted = await mintSession();
    if (seq !== connectSeq || agentKey !== currentAgent) return;
    if (minted.error) {
      setState(STATE.IDLE, { message: `Cannot start: ${minted.error}` });
      return;
    }
    const { terminalPort, ptySessionToken } = minted;
    if (!ptySessionToken) {
      setState(STATE.IDLE, { message: 'Cannot start: no session token returned' });
      return;
    }

    // Pre-flight: does the selected agent CLI exist on PATH?
    const agentStatus = await checkAgentAvailable(terminalPort, agentKey);
    if (seq !== connectSeq || agentKey !== currentAgent) return;
    if (!agentStatus.available) {
      setState(STATE.NO_AGENT);
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
    const socket = new WebSocket(`ws://127.0.0.1:${terminalPort}/ws?agent=${encodeURIComponent(agentKey)}`, [`gstack-pty.${ptySessionToken}`]);
    ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', () => {
      if (seq !== connectSeq || ws !== socket) return;
      try {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {}
      // Push a fresh tab snapshot so the agent's tabs.json is populated by
      // the time the lazy spawn finishes booting. Background.js exposes
      // the snapshot helper via chrome.runtime; we ask for it here and
      // forward whatever comes back.
      try {
        chrome.runtime.sendMessage({ type: 'getTabState' }, (resp) => {
          if (resp && seq === connectSeq && ws === socket && socket.readyState === WebSocket.OPEN) {
            try {
              socket.send(JSON.stringify({
                type: 'tabState',
                active: resp.active,
                tabs: resp.tabs,
                reason: 'initial',
              }));
            } catch {}
          }
        });
      } catch {}
      // Send a single byte to nudge the agent to spawn (lazy-spawn trigger).
      try { socket.send(new TextEncoder().encode('\n')); } catch {}
    });

    socket.addEventListener('message', (ev) => {
      if (seq !== connectSeq || ws !== socket) return;
      if (typeof ev.data === 'string') {
        // Agent control message (rare). Treat as JSON; error frames carry code.
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'error' && (msg.code === 'CLAUDE_NOT_FOUND' || msg.code === 'CODEX_NOT_FOUND')) {
            setState(STATE.NO_AGENT);
            try { ws.close(); } catch {}
          }
        } catch {}
        return;
      }
      // Binary: feed to xterm.
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      term.write(buf);
    });

    socket.addEventListener('close', () => {
      if (ws === socket) ws = null;
      if (seq !== connectSeq) return;
      if (state !== STATE.NO_AGENT) setState(STATE.ENDED);
    });

    socket.addEventListener('error', (err) => {
      if (seq !== connectSeq || ws !== socket) return;
      console.error('[gstack terminal] ws error', err);
    });
  }

  function teardown() {
    connectSeq += 1;
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
  function forceRestart() {
    const agent = getAgent();
    connectSeq += 1;
    try { ws && ws.close(); } catch {}
    ws = null;
    if (term) {
      try { term.dispose(); } catch {}
      term = null;
      fitAddon = null;
    }
    setState(STATE.IDLE, { message: `Starting ${agent.displayName}...` });
    tryAutoConnect();
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
    updateAgentControls();
    setState(STATE.IDLE, { message: `Starting ${getAgent().displayName}...` });

    for (const btn of els.agentButtons) {
      btn.addEventListener('click', () => {
        const next = btn.dataset.terminalAgent;
        if (!AGENTS[next] || next === currentAgent) return;
        currentAgent = next;
        saveAgent(next);
        forceRestart();
      });
    }

    els.installRetry?.addEventListener('click', () => {
      // Re-probe the selected agent on PATH, then try a connect.
      setState(STATE.IDLE, { message: `Starting ${getAgent().displayName}...` });
      tryAutoConnect();
    });

    // Two restart buttons:
    //   - els.restart lives inside the ENDED state card (visible only after
    //     a session has ended).
    //   - els.restartNow lives in the always-visible toolbar (lets the user
    //     force a fresh agent mid-session without waiting for it to exit).
    els.restart?.addEventListener('click', forceRestart);
    els.restartNow?.addEventListener('click', forceRestart);


    // Live browser-tab state. background.js → sidepanel.js → us. We
    // forward over the live PTY WebSocket; terminal-agent.ts writes
    // <stateDir>/active-tab.json + <stateDir>/tabs.json so the agent can
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
   */
  function tryAutoConnect() {
    if (state !== STATE.IDLE) return;
    let waited = 0;
    const tick = () => {
      // If the user navigated away (Chat tab) or already connected, drop out.
      if (state !== STATE.IDLE) return;
      if (getServerPort() && getAuthToken()) {
        connect();
        return;
      }
      waited += 200;
      if (waited > 15000) {
        setState(STATE.IDLE, { message: 'Browse server not ready. Reload sidebar to retry.' });
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
