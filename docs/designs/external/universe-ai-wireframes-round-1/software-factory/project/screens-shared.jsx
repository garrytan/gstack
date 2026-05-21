// Shared wireframe primitives — used across screens
// Exports to window so other Babel scripts can use them.

const Chip = ({ children, kind = '', dot = false, style }) => (
  <span className={`chip ${kind} ${dot ? 'dot' : ''}`} style={style}>{children}</span>
);

const PhasePill = ({ children, state = '' }) => (
  <span className={`phase-pill ${state}`}>{children}</span>
);

const Persona = ({ initials, kind, name, sub, size = 28 }) => (
  <div className="row gap-2 items-center">
    <span className={`persona-icon ${kind || ''}`} style={{ width: size, height: size, fontSize: size * 0.45 }}>{initials}</span>
    {(name || sub) && (
      <div className="col" style={{ lineHeight: 1.1 }}>
        {name && <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, fontSize: 12 }}>{name}</span>}
        {sub && <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-mute)' }}>{sub}</span>}
      </div>
    )}
  </div>
);

const Lines = ({ widths = ['90%', '70%', '60%'], thick = false, ink = false }) => (
  <div className="col gap-2">
    {widths.map((w, i) => (
      <span key={i} className={`line ${thick ? 'thick' : ''} ${ink ? 'ink' : ''}`} style={{ width: w }} />
    ))}
  </div>
);

const Note = ({ children, x, y, w, kind = '', rotate = 0, arrow }) => (
  <div className={`note ${kind}`} style={{
    left: x, top: y,
    width: w,
    transform: `rotate(${rotate}deg)`,
  }}>
    {arrow && <span style={{ marginRight: 4 }}>{arrow}</span>}
    {children}
  </div>
);

// SVG curly arrow used for annotations
const SketchArrow = ({ x1, y1, x2, y2, curve = 30, color = '#0d7a8f', label, head = 'end' }) => {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 + curve;
  return (
    <svg className="svg-overlay" style={{ overflow: 'visible' }}>
      <path
        d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
        stroke={color} strokeWidth="1.8" fill="none"
        strokeLinecap="round"
        markerEnd={head === 'end' ? 'url(#arrowhead)' : undefined}
      />
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill={color} />
        </marker>
      </defs>
    </svg>
  );
};

// Sketch underline header (h2-ish)
const SketchH = ({ children, size = 22 }) => (
  <h2 className="hand" style={{ margin: 0, fontSize: size, lineHeight: 1 }}>
    <span className="sketch-underline">{children}</span>
  </h2>
);

// Generic window chrome (top bar with dots)
const WinChrome = ({ url, right }) => (
  <div className="win-chrome">
    <span className="win-dot" />
    <span className="win-dot" />
    <span className="win-dot" />
    {url && (
      <div style={{
        flex: 1, textAlign: 'center', fontFamily: 'var(--ui)',
        fontSize: 11, color: 'var(--ink-mute)',
      }}>{url}</div>
    )}
    {right}
  </div>
);

// Safety strip — visible at top of cockpit
const SafetyStrip = ({ mode = 'Read-only audit', subtle }) => {
  const map = {
    'Read-only audit': { kind: '', text: 'Read-only audit — Universe can inspect & produce artifacts. Cannot edit files.' },
    'Browser audit': { kind: '', text: 'Browser QA audit running — no code changes.' },
    'Safe local fixes': { kind: 'warn', text: 'Safe local fixes ON — Universe can edit project files. Cannot push, deploy, or read secrets.' },
    'Release locked': { kind: '', text: 'Release & deploy actions are LOCKED.' },
  };
  const m = map[mode] || map['Read-only audit'];
  return (
    <div className={`safety-strip ${m.kind === 'warn' ? 'warn' : ''}`}
      style={m.kind === 'warn' ? { background: 'var(--warn-soft)', color: '#6a4a08', borderColor: 'var(--warn)' } : {}}>
      <span style={{
        width: 18, height: 18, borderRadius: '50%', border: '1.5px solid currentColor',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
      }}>{m.kind === 'warn' ? '!' : '✓'}</span>
      <span>{mode}</span>
      <span style={{ opacity: 0.75 }}>· {m.text.split(' — ')[1] || m.text}</span>
      {!subtle && (
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--ui)', fontSize: 10.5, opacity: 0.8, cursor: 'pointer', textDecoration: 'underline' }}>
          What can Universe touch?
        </span>
      )}
    </div>
  );
};

// Sidebar nav — condensed to 4 workspace items + 1 contextual project card.
// Per-phase navigation (Plan/Design/Build/QA/Ship) lives INSIDE the cockpit's
// own timeline rail, not here. Safety moved into Settings. Decisions + Activity
// combined into "Inbox".
const NavIcon = ({ glyph }) => (
  <span style={{
    width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--ui)', fontSize: 13, color: 'currentColor', flexShrink: 0,
  }}>{glyph}</span>
);

const SideNav = ({ active = 'cockpit', project = { name: 'Tutor Match', phase: 'Build · 4/9', state: 'active' } }) => (
  <div className="side-nav">
    <div className="row items-center gap-2" style={{ padding: '0 6px 14px', borderBottom: '1.5px dashed var(--line-soft)', marginBottom: 8 }}>
      <span style={{
        width: 26, height: 26, borderRadius: 7, background: 'var(--ink)', color: 'var(--paper)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 18,
      }}>✦</span>
      <span style={{ fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 14 }}>Universe AI</span>
    </div>

    <div className={`nav-item ${active === 'home' ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <NavIcon glyph="◐" />Home
    </div>
    <div className={`nav-item ${active === 'projects' ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <NavIcon glyph="▤" />Projects
    </div>
    <div className={`nav-item ${active === 'inbox' ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <NavIcon glyph="✉" />Inbox
      <Chip kind="warn" style={{ marginLeft: 'auto', padding: '1px 5px', fontSize: 9 }}>3</Chip>
    </div>
    <div className={`nav-item ${active === 'settings' ? 'active' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <NavIcon glyph="⚙" />Settings
    </div>

    {/* Current project card — contextual, replaces the old "Current project" sub-list */}
    {project && (
      <div className="col gap-2" style={{
        marginTop: 16, padding: 10,
        border: '1.5px solid var(--line)', borderRadius: 10,
        background: active === 'cockpit' || active === 'project' ? 'white' : 'var(--paper)',
      }}>
        <div className="row between items-center">
          <span className="wf-label" style={{ fontSize: 9 }}>In your project</span>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: project.state === 'active' ? 'var(--good)' : 'var(--ink-mute)',
          }} />
        </div>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 700, lineHeight: 1.15 }}>{project.name}</span>
        <span className="hand" style={{ fontSize: 15, color: 'var(--ink-soft)', lineHeight: 1.1 }}>{project.phase}</span>
        <div className={`nav-item ${active === 'cockpit' ? 'active' : ''}`} style={{
          margin: '4px -4px 0', padding: '5px 8px', fontSize: 11.5,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          Open project <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>→</span>
        </div>
      </div>
    )}
  </div>
);

// Vertical timeline rail (left rail for cockpit)
const TimelineRail = ({ current = 4, nested = false }) => {
  const phases = [
    { id: 1, name: 'Idea shaping', persona: 'PC' },
    { id: 2, name: 'Plan & MVP', persona: 'CR' },
    { id: 3, name: 'Design review', persona: 'DS' },
    { id: 4, name: 'Build', persona: 'AR' },
    { id: 5, name: 'Code review', persona: 'CV' },
    { id: 6, name: 'Browser QA', persona: 'QA' },
    { id: 7, name: 'Fix loop', persona: 'IM', nested: true },
    { id: 8, name: 'Ship readiness', persona: 'RC' },
    { id: 9, name: 'Handoff', persona: 'RC' },
  ];
  return (
    <div className="col gap-3" style={{ width: 220, padding: 16, borderRight: '1.5px solid var(--line)', flexShrink: 0 }}>
      <div className="row between items-center">
        <span className="wf-label">Factory Timeline</span>
        <Chip kind="mute">9 phases</Chip>
      </div>
      <div className="col" style={{ gap: 0 }}>
        {phases.map((p, i) => {
          const state =
            i + 1 < current ? 'done' :
            i + 1 === current ? 'active' :
            'upcoming';
          return (
            <div key={p.id} className="row gap-2 items-start" style={{ position: 'relative' }}>
              {/* connector line */}
              {i < phases.length - 1 && (
                <div style={{
                  position: 'absolute',
                  left: 13, top: 24, bottom: -4,
                  width: 2, background: state === 'done' ? 'var(--good)' : 'var(--line-soft)',
                  borderRadius: 1,
                }} />
              )}
              <div style={{
                width: 26, height: 26, borderRadius: '50%',
                border: state === 'active' ? '2.5px solid var(--ink)' : '1.5px solid var(--ink)',
                background:
                  state === 'done' ? 'var(--good-soft)' :
                  state === 'active' ? 'var(--marker)' :
                  state === 'blocked' ? 'var(--danger-soft)' : 'white',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700,
                zIndex: 1, flexShrink: 0,
                color: state === 'upcoming' ? 'var(--ink-mute)' : 'var(--ink)',
              }}>{state === 'done' ? '✓' : p.id}</div>
              <div className="col" style={{ paddingBottom: 14, paddingTop: 3, lineHeight: 1.2 }}>
                <span style={{
                  fontFamily: 'var(--ui)',
                  fontSize: 12.5,
                  fontWeight: state === 'active' ? 700 : 500,
                  color: state === 'upcoming' ? 'var(--ink-mute)' : 'var(--ink)',
                  textIndent: 0,
                  marginLeft: p.nested && nested ? 12 : 0,
                }}>{p.name}</span>
                <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>
                  {state === 'done' ? 'Complete' : state === 'active' ? 'Active · waiting on you' : 'Upcoming'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Conversation bubble — phase room style
const ConvoBubble = ({ from = 'system', persona, children, action }) => {
  if (from === 'user') {
    return (
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <div className="sketch-box" style={{
          maxWidth: '70%', background: 'white',
          padding: '8px 12px', borderRadius: '12px 4px 12px 12px',
          border: '1.5px solid var(--ink)',
        }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5 }}>{children}</span>
        </div>
      </div>
    );
  }
  if (action) {
    return (
      <div className="row gap-2 items-start" style={{ paddingLeft: 36 }}>
        <div className="sketch-box" style={{
          padding: '8px 12px', background: 'var(--paper-2)',
          fontFamily: 'var(--ui)', fontSize: 11.5,
          borderRadius: 8, borderStyle: 'dashed',
          borderColor: 'var(--line-soft)', borderWidth: 1.5,
          display: 'inline-flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{
            width: 14, height: 14, border: '1.5px solid var(--ink)', borderTop: 'none',
            borderRadius: '50%', borderTopColor: 'transparent', display: 'inline-block',
            animation: 'spin 2s linear infinite',
          }} />
          <span>{children}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="row gap-2 items-start">
      {persona && <Persona {...persona} size={28} />}
      <div className="col gap-2" style={{ flex: 1 }}>
        {persona && (
          <div className="row gap-2 items-center">
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 600 }}>{persona.name}</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>{persona.sub}</span>
          </div>
        )}
        <div style={{
          background: 'white', border: '1.5px solid var(--line-soft)',
          padding: '10px 12px', borderRadius: '4px 12px 12px 12px',
          fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.45,
        }}>{children}</div>
      </div>
    </div>
  );
};

Object.assign(window, {
  Chip, PhasePill, Persona, Lines, Note, SketchArrow, SketchH,
  WinChrome, SafetyStrip, SideNav, TimelineRail, ConvoBubble,
});
