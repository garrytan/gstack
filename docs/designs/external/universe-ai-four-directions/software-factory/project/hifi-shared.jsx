// Universe AI — hi-fi shared primitives
// Lean, declarative wrappers around the CSS classes in hifi-tokens.css

// ===== Brand mark — animated cosmic orb =====
const UOrb = ({ size = 56, busy = false, halo = true }) => {
  const id = React.useId();
  return (
    <div style={{
      position: 'relative',
      width: size, height: size,
      flexShrink: 0,
    }}>
      {halo && busy && (
        <div style={{
          position: 'absolute', inset: -size * 0.18,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(240,160,60,0.35) 0%, transparent 60%)',
          animation: 'uPulse 2.6s ease-in-out infinite',
        }} />
      )}
      <svg viewBox="0 0 64 64" width={size} height={size} style={{ display: 'block', position: 'relative' }}>
        <defs>
          <radialGradient id={`og-${id}`} cx="35%" cy="32%" r="65%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="35%" stopColor="#C4B6FF" />
            <stop offset="70%" stopColor="#6E60DC" />
            <stop offset="100%" stopColor="#2D2580" />
          </radialGradient>
          <radialGradient id={`hi-${id}`} cx="32%" cy="28%" r="22%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="32" cy="32" r="28" fill={`url(#og-${id})`} />
        <circle cx="32" cy="32" r="28" fill={`url(#hi-${id})`} />
        {/* sparkle */}
        <path d="M44 16 L45.5 19 L48.5 20.5 L45.5 22 L44 25 L42.5 22 L39.5 20.5 L42.5 19 Z"
              fill="#FFFFFF" opacity="0.92" />
      </svg>
      {busy && (
        <span style={{
          position: 'absolute', right: -2, bottom: -2,
          width: size * 0.28, height: size * 0.28, borderRadius: '50%',
          background: 'var(--u-amber)',
          border: '2px solid var(--u-paper)',
          boxShadow: '0 0 0 0 var(--u-amber)',
          animation: 'uPulse 1.8s ease-out infinite',
        }} />
      )}
    </div>
  );
};

// ===== Wordmark =====
const UWordmark = ({ size = 18, mono = false }) => (
  <div className="u-row u-items-center u-gap-2">
    <UOrb size={size + 8} halo={false} />
    <span style={{
      fontFamily: mono ? 'var(--u-mono)' : 'var(--u-display)',
      fontSize: size,
      fontWeight: mono ? 500 : 400,
      letterSpacing: mono ? '0.02em' : '-0.01em',
      color: 'var(--u-ink)',
    }}>
      Universe<span style={{ color: 'var(--u-brand)', fontStyle: 'italic' }}> AI</span>
    </span>
  </div>
);

// ===== Generic top bar =====
const UTopbar = ({ project, mode, action, breadcrumb, glass = false }) => (
  <div className={`u-topbar ${glass ? 'glass' : ''}`}>
    <div className="u-row u-items-center u-gap-4">
      <UWordmark size={15} />
      {breadcrumb && (
        <>
          <span style={{ color: 'var(--u-ink-4)', fontSize: 14 }}>/</span>
          <span style={{ fontSize: 13.5, color: 'var(--u-ink-2)', fontWeight: 500 }}>{breadcrumb}</span>
        </>
      )}
      {project && (
        <>
          <span style={{ color: 'var(--u-ink-4)', fontSize: 14 }}>/</span>
          <span style={{ fontSize: 13.5, color: 'var(--u-ink)', fontWeight: 600 }}>{project}</span>
        </>
      )}
    </div>
    <div className="u-row u-items-center u-gap-3">
      {mode}
      {action}
    </div>
  </div>
);

// ===== Mode toggle pill =====
const UModeToggle = ({ mode = 'easy', size = 'md' }) => {
  const s = {
    sm: { h: 30, fs: 11.5, p: 11, dot: 6 },
    md: { h: 36, fs: 12.5, p: 13, dot: 7 },
    lg: { h: 44, fs: 14, p: 18, dot: 8 },
  }[size];
  const TabIn = ({ active, children, kind }) => (
    <div style={{
      height: s.h - 6, padding: `0 ${s.p}px`,
      borderRadius: 999,
      background: active ? 'var(--u-ink)' : 'transparent',
      color: active ? 'var(--u-paper)' : 'var(--u-ink-3)',
      fontFamily: 'var(--u-sans)', fontSize: s.fs, fontWeight: 500,
      display: 'inline-flex', alignItems: 'center', gap: 6,
      letterSpacing: '-0.005em',
      transition: 'all 220ms var(--u-ease)',
    }}>
      <span style={{
        width: s.dot, height: s.dot, borderRadius: '50%',
        background: kind === 'easy'
          ? 'linear-gradient(135deg, var(--u-brand-2) 0%, var(--u-brand) 100%)'
          : (active ? 'var(--u-amber)' : 'var(--u-ink-3)'),
        boxShadow: active && kind === 'easy' ? '0 0 0 2px rgba(110,96,220,0.35)' : 'none',
      }} />
      {children}
    </div>
  );
  return (
    <div style={{
      display: 'inline-flex',
      height: s.h, padding: 3,
      background: 'var(--u-paper-2)',
      border: '1px solid var(--u-line)',
      borderRadius: 999,
      gap: 2,
    }}>
      <TabIn active={mode === 'easy'} kind="easy">Easy</TabIn>
      <TabIn active={mode === 'hands'} kind="hands">Hands-on</TabIn>
    </div>
  );
};

// ===== Persona avatar (uses class variants) =====
const UPersona = ({ initials, kind, name, role, size = 32 }) => (
  <div className="u-row u-items-center u-gap-3">
    <span className={`u-avatar ${kind || ''} ${size === 48 ? 'lg' : ''}`} style={{ width: size, height: size, fontSize: size * 0.34 }}>
      {initials}
    </span>
    {(name || role) && (
      <div className="u-col" style={{ lineHeight: 1.2 }}>
        {name && <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--u-ink)' }}>{name}</span>}
        {role && <span style={{ fontSize: 11.5, color: 'var(--u-ink-3)' }}>{role}</span>}
      </div>
    )}
  </div>
);

// ===== Progress bar =====
const UProgress = ({ done = 0, active = 1, total = 9, labels }) => (
  <div className="u-col u-gap-2">
    <div className="u-progress">
      {Array.from({ length: total }, (_, i) => {
        const cls = i < done ? 'done' : i < done + active ? 'active' : '';
        return <div key={i} className={`seg ${cls}`} />;
      })}
    </div>
    {labels && (
      <div className="u-row u-between" style={{ fontFamily: 'var(--u-mono)', fontSize: 10, color: 'var(--u-ink-3)', letterSpacing: '0.04em' }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    )}
  </div>
);

// ===== Cosmic sparkle decoration =====
const UStars = ({ density = 30 }) => {
  const stars = React.useMemo(() => (
    Array.from({ length: density }, (_, i) => ({
      x: Math.random() * 100, y: Math.random() * 100,
      s: 1 + Math.random() * 1.5, o: 0.2 + Math.random() * 0.5,
      i,
    }))
  ), [density]);
  return (
    <svg className="u-stars" viewBox="0 0 100 100" preserveAspectRatio="none">
      {stars.map(s => (
        <circle key={s.i} cx={s.x} cy={s.y} r={s.s * 0.18} fill="#FFFFFF" opacity={s.o} />
      ))}
    </svg>
  );
};

// ===== Icon — outlined, consistent style =====
const UIcon = ({ name, size = 16, color = 'currentColor', stroke = 1.7 }) => {
  const paths = {
    'check':       'M3 8.5 L7 12 L13.5 4.5',
    'arrow-right': 'M3 8 H13 M9 4 L13 8 L9 12',
    'arrow-left':  'M13 8 H3 M7 4 L3 8 L7 12',
    'plus':        'M8 3 V13 M3 8 H13',
    'minus':       'M3 8 H13',
    'sparkle':     'M8 2 L9.2 6.8 L14 8 L9.2 9.2 L8 14 L6.8 9.2 L2 8 L6.8 6.8 Z',
    'shield':      'M8 2 L13 4 V8 C13 11 10.5 13.5 8 14 C5.5 13.5 3 11 3 8 V4 Z',
    'lock':        'M4 8 H12 V13 H4 Z M5.5 8 V5.5 A2.5 2.5 0 0 1 10.5 5.5 V8',
    'mail':        'M2.5 4 H13.5 V12 H2.5 Z M2.5 4 L8 9 L13.5 4',
    'gear':        'M8 5.5 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 0 0 0 -5 Z M8 2 V3.5 M8 12.5 V14 M14 8 H12.5 M3.5 8 H2 M12.24 3.76 L11.18 4.82 M4.82 11.18 L3.76 12.24 M12.24 12.24 L11.18 11.18 M4.82 4.82 L3.76 3.76',
    'eye':         'M2 8 C 4 4.5 6 3 8 3 C 10 3 12 4.5 14 8 C 12 11.5 10 13 8 13 C 6 13 4 11.5 2 8 Z M8 6 A2 2 0 1 1 8 10 A2 2 0 1 1 8 6 Z',
    'play':        'M5 3 L13 8 L5 13 Z',
    'pause':       'M5 3 H7 V13 H5 Z M9 3 H11 V13 H9 Z',
    'menu':        'M3 5 H13 M3 8 H13 M3 11 H13',
    'home':        'M2 8 L8 3 L14 8 V13 H10 V9 H6 V13 H2 Z',
    'folder':      'M2 5 H6.5 L8 6.5 H14 V12.5 H2 Z',
    'inbox':       'M2 4 H14 V12 H2 Z M2 9 H5.5 L6.5 10.5 H9.5 L10.5 9 H14',
    'down':        'M4 6 L8 10 L12 6',
    'up':          'M4 10 L8 6 L12 10',
    'compass':     'M8 1.5 A6.5 6.5 0 1 0 8 14.5 A6.5 6.5 0 1 0 8 1.5 Z M10.5 5.5 L9.2 8.8 L5.5 10.5 L6.8 7.2 Z',
    'bolt':        'M9 1 L3 9 H7.5 L7 15 L13 7 H8.5 Z',
    'wand':        'M3 13 L11 5 L13 7 L5 15 Z M11 2.5 L11.7 4 L13 4.5 L11.7 5 L11 6.5 L10.3 5 L9 4.5 L10.3 4 Z',
  };
  const d = paths[name];
  if (!d) return null;
  // Heuristic — if it's a filled sparkle/play/wand, fill it; else stroke
  const fillNames = ['sparkle', 'play', 'pause', 'wand'];
  const isFill = fillNames.includes(name);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={isFill ? 'none' : color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {d.split(' M ').map((p, i) => (
        <path key={i} d={i === 0 ? p : 'M ' + p} fill={isFill ? color : 'none'} />
      ))}
    </svg>
  );
};

// ===== Sidebar nav — consumer-friendly =====
const USideNav = ({ active = 'home', project }) => (
  <div className="u-sidenav">
    <div style={{ padding: '4px 10px 16px', marginBottom: 6, borderBottom: '1px solid var(--u-line-2)' }}>
      <UWordmark size={15} />
    </div>
    <NavItem icon="home"    label="Home"      active={active === 'home'} />
    <NavItem icon="folder"  label="Projects"  active={active === 'projects'} />
    <NavItem icon="inbox"   label="Inbox"     active={active === 'inbox'} badge="3" />
    <NavItem icon="gear"    label="Settings"  active={active === 'settings'} />

    {project && (
      <div style={{
        marginTop: 18, padding: 12,
        background: 'var(--u-card)', borderRadius: 'var(--u-r-md)',
        border: '1px solid var(--u-line)',
        boxShadow: 'var(--u-shadow-1)',
      }}>
        <div className="u-row u-between u-items-center" style={{ marginBottom: 8 }}>
          <span className="u-eyebrow" style={{ fontSize: 9.5 }}>In your project</span>
          <span className={`u-dot ${project.state || 'amber'} pulse`} />
        </div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--u-ink)', lineHeight: 1.25 }}>
          {project.name}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--u-ink-3)', marginTop: 2 }}>{project.phase}</div>
        <button className="u-btn ghost sm" style={{ marginTop: 10, width: '100%', justifyContent: 'space-between' }}>
          Open <UIcon name="arrow-right" size={12} />
        </button>
      </div>
    )}

    <div style={{ marginTop: 'auto', paddingTop: 14, borderTop: '1px solid var(--u-line-2)' }}>
      <div className="u-row u-items-center u-gap-3" style={{ padding: '4px 10px' }}>
        <span className="u-avatar" style={{ width: 28, height: 28, fontSize: 11 }}>MV</span>
        <div className="u-col" style={{ lineHeight: 1.15 }}>
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>Milton V.</span>
          <span style={{ fontSize: 10.5, color: 'var(--u-ink-3)' }}>Free · 4 projects</span>
        </div>
      </div>
    </div>
  </div>
);

const NavItem = ({ icon, label, active, badge }) => (
  <div className={`item ${active ? 'active' : ''}`}>
    <UIcon name={icon} size={15} color={active ? 'var(--u-ink)' : 'var(--u-ink-3)'} />
    <span>{label}</span>
    {badge && <span className="badge">{badge}</span>}
  </div>
);

Object.assign(window, {
  UOrb, UWordmark, UTopbar, UModeToggle, UPersona, UProgress, UStars, UIcon, USideNav, NavItem,
});
