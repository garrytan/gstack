// Hi-fi · The Factory · three rooms
// Top-level abstraction for Hands-on mode. Stylized illustrations of three "rooms"
// (Drawing Room, Workshop, Showroom), each with their crew and outputs.

// ===== Room illustration — flat 2D, with state =====
const RoomIllustration = ({ state, color, deep, sky, accent }) => {
  // state: done | active | locked
  return (
    <svg viewBox="0 0 200 130" preserveAspectRatio="xMidYMax meet" style={{ width: '100%', height: 130, display: 'block' }}>
      <defs>
        <linearGradient id={`sky-${state}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={sky} />
          <stop offset="100%" stopColor={color} stopOpacity="0.18" />
        </linearGradient>
        <linearGradient id={`wall-${state}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor={deep} stopOpacity="0.85" />
        </linearGradient>
      </defs>

      {/* Sky band */}
      <rect x="0" y="0" width="200" height="80" fill={`url(#sky-${state})`} />

      {/* Stars on locked */}
      {state === 'locked' && (
        <g opacity="0.5">
          {Array.from({ length: 12 }, (_, i) => (
            <circle key={i} cx={10 + i * 16 + (i % 2) * 5} cy={10 + (i % 3) * 14} r="0.6" fill={deep} />
          ))}
        </g>
      )}

      {/* Sun / lamp */}
      {state === 'done' && (
        <circle cx="170" cy="22" r="10" fill={accent} opacity="0.85" />
      )}
      {state === 'active' && (
        <g>
          <circle cx="170" cy="22" r="11" fill={accent} opacity="0.95" />
          <circle cx="170" cy="22" r="16" fill={accent} opacity="0.18" />
        </g>
      )}

      {/* Hills/floor */}
      <path d="M0 92 Q 50 78 100 84 T 200 88 V130 H0 Z" fill={deep} opacity="0.10" />
      <rect x="0" y="100" width="200" height="30" fill={deep} opacity="0.08" />

      {/* The building */}
      <g transform="translate(40, 40)">
        {/* Roof */}
        <path d="M0 28 L60 0 L120 28 L120 32 L0 32 Z" fill={deep} />
        {/* Body */}
        <rect x="6" y="32" width="108" height="58" fill={`url(#wall-${state})`} />
        {/* Window left */}
        <rect x="16" y="44" width="22" height="22" rx="2" fill={state === 'locked' ? deep : '#FFFFFF'} opacity={state === 'locked' ? 0.6 : 0.95} />
        <line x1="27" y1="44" x2="27" y2="66" stroke={deep} strokeWidth="1" opacity="0.4" />
        <line x1="16" y1="55" x2="38" y2="55" stroke={deep} strokeWidth="1" opacity="0.4" />
        {/* Window right */}
        <rect x="80" y="44" width="22" height="22" rx="2" fill={state === 'locked' ? deep : (state === 'active' ? accent : '#FFFFFF')} opacity={state === 'locked' ? 0.6 : state === 'active' ? 0.85 : 0.95} />
        <line x1="91" y1="44" x2="91" y2="66" stroke={deep} strokeWidth="1" opacity="0.4" />
        <line x1="80" y1="55" x2="102" y2="55" stroke={deep} strokeWidth="1" opacity="0.4" />

        {/* Door */}
        {state === 'locked' ? (
          <g>
            <rect x="48" y="58" width="24" height="32" rx="3" fill={deep} opacity="0.85" />
            {/* Curtain stripes */}
            <line x1="52" y1="58" x2="52" y2="90" stroke="#fff" strokeWidth="0.6" opacity="0.3" />
            <line x1="58" y1="58" x2="58" y2="90" stroke="#fff" strokeWidth="0.6" opacity="0.3" />
            <line x1="62" y1="58" x2="62" y2="90" stroke="#fff" strokeWidth="0.6" opacity="0.3" />
            <line x1="68" y1="58" x2="68" y2="90" stroke="#fff" strokeWidth="0.6" opacity="0.3" />
            {/* Lock */}
            <circle cx="60" cy="74" r="5" fill="#FFFFFF" />
            <path d="M57 72 V70 A3 3 0 0 1 63 70 V72 Z" fill={deep} />
          </g>
        ) : (
          <g>
            <rect x="48" y="58" width="24" height="32" rx="3" fill="#FFFFFF" />
            <rect x="51" y="61" width="18" height="26" rx="1" fill={state === 'active' ? accent : color} opacity="0.32" />
            <circle cx="66" cy="76" r="1.5" fill={deep} />
            {/* light spill */}
            {state === 'active' && (
              <path d="M48 90 L40 100 H80 L72 90 Z" fill={accent} opacity="0.30" />
            )}
          </g>
        )}

        {/* Chimney smoke for active */}
        {state === 'active' && (
          <g opacity="0.55">
            <rect x="92" y="6" width="6" height="14" fill={deep} />
            <circle cx="95" cy="0" r="3" fill={deep} opacity="0.5" />
            <circle cx="98" cy="-5" r="2.5" fill={deep} opacity="0.4" />
            <circle cx="93" cy="-9" r="2" fill={deep} opacity="0.3" />
          </g>
        )}

        {/* Sign */}
        <rect x="46" y="46" width="28" height="8" rx="1.5" fill="#FFFFFF" stroke={deep} strokeWidth="0.6" opacity={state === 'locked' ? 0.5 : 1} />
      </g>
    </svg>
  );
};

const ROOMS = [
  {
    id: 1, name: 'Drawing Room', verb: 'Shape it', tag: 'figure out what to build',
    state: 'done',
    color: '#E8E4FB', deep: '#4B3FBB', sky: '#F0EBFF', accent: '#7B47C4',
    crew: [
      { initials: 'PC', kind: 'coach',    name: 'Product Coach' },
      { initials: 'CR', kind: 'reviewer', name: 'CEO Reviewer' },
      { initials: 'DS', kind: 'designer', name: 'Designer' },
    ],
    outputs: ['Idea brief', 'Project plan', 'Screen mockups'],
    when: 'Day 1 · done',
  },
  {
    id: 2, name: 'Workshop', verb: 'Build it', tag: 'making it real',
    state: 'active',
    color: '#FBE9CC', deep: '#B96E12', sky: '#FFF4DF', accent: '#F0A03C',
    crew: [
      { initials: 'AR', kind: 'arch',       name: 'Eng Architect' },
      { initials: 'IM', kind: 'builder',    name: 'Implementer' },
      { initials: 'CV', kind: 'codereview', name: 'Code Reviewer' },
    ],
    outputs: ['Architecture plan', 'Working build', 'Code review'],
    when: 'Day 2–4 · in progress',
  },
  {
    id: 3, name: 'Showroom', verb: 'Ship it', tag: 'prove it works · hand it off',
    state: 'locked',
    color: '#DCEAE0', deep: '#225340', sky: '#EAF3EC', accent: '#3F8568',
    crew: [
      { initials: 'QA', kind: 'qa',      name: 'QA Tester' },
      { initials: 'FX', kind: 'fix',     name: 'Fix Loop' },
      { initials: 'RC', kind: 'release', name: 'Release Coord.' },
    ],
    outputs: ['QA evidence', 'Fix summary', 'Handoff bundle'],
    when: 'Day 5 · unlocks after Workshop',
  },
];

const HiFactory = () => (
  <div className="uf" style={{ width: '100%', height: '100%', display: 'flex', background: 'var(--u-paper)' }}>
    <USideNav active="cockpit" project={{ name: 'Tutor Match', phase: 'Workshop · day 2', state: 'amber' }} />

    <div className="u-col u-grow" style={{ minWidth: 0 }}>
      {/* Top bar */}
      <div className="u-topbar">
        <div className="u-row u-items-center u-gap-3">
          <span className="u-eyebrow">Your factory</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Tutor Match</span>
        </div>
        <div className="u-row u-items-center u-gap-3">
          <UModeToggle mode="hands" size="md" />
          <button className="u-btn ghost sm"><UIcon name="pause" size={12} /> Pause</button>
          <span className="u-avatar" style={{ width: 30, height: 30, fontSize: 11 }}>MV</span>
        </div>
      </div>

      <div className="u-col u-grow" style={{ padding: '32px 44px 28px', gap: 22, overflow: 'auto' }}>
        {/* Section header */}
        <div className="u-row u-between u-items-end">
          <div className="u-col">
            <span className="u-eyebrow">The factory · 3 rooms</span>
            <h1 className="u-display" style={{ margin: '6px 0 0', fontSize: 42 }}>
              Three rooms. We go through them <em>in order</em>.
            </h1>
          </div>
          <div className="u-row u-items-center u-gap-2">
            <span className="u-pill sage dot">1 done</span>
            <span className="u-pill amber dot">1 working</span>
            <span className="u-pill"><UIcon name="lock" size={11} color="var(--u-ink-3)" /> 1 to go</span>
          </div>
        </div>

        {/* The three rooms */}
        <div className="u-row u-gap-4" style={{ alignItems: 'stretch' }}>
          {ROOMS.map((room, i) => (
            <RoomCard key={room.id} room={room} hasArrow={i < ROOMS.length - 1} />
          ))}
        </div>

        {/* Bottom — current action card */}
        <div className="u-card" style={{
          padding: '18px 22px',
          background: 'var(--u-card)',
          borderColor: 'var(--u-ink)',
          borderWidth: 1.5,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <UOrb size={48} busy />
          <div className="u-col u-grow" style={{ lineHeight: 1.25 }}>
            <span className="u-eyebrow" style={{ color: 'var(--u-amber-deep)' }}>Right now · in the Workshop</span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--u-ink)', marginTop: 2 }}>
              The Implementer is wiring tutor profiles to the search.
            </span>
            <span style={{ fontFamily: 'var(--u-display)', fontStyle: 'italic', fontSize: 16, color: 'var(--u-ink-3)', marginTop: 2 }}>
              Nothing needs you. I'll knock when it's your turn.
            </span>
          </div>
          <button className="u-btn primary">
            Step inside the Workshop
            <UIcon name="arrow-right" size={14} color="#fff" />
          </button>
        </div>
      </div>
    </div>
  </div>
);

const RoomCard = ({ room, hasArrow }) => {
  const isLocked = room.state === 'locked';
  const isActive = room.state === 'active';
  const isDone   = room.state === 'done';
  return (
    <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
      <div className="u-card" style={{
        padding: 0, overflow: 'hidden',
        background: 'var(--u-card)',
        borderColor: isActive ? room.deep : 'var(--u-line)',
        borderWidth: isActive ? 1.5 : 1,
        boxShadow: isActive ? '0 16px 40px -8px ' + room.deep + '40, 0 4px 10px rgba(15,22,41,0.06)' : 'var(--u-shadow-1)',
        opacity: isLocked ? 0.95 : 1,
        display: 'flex', flexDirection: 'column', height: '100%',
        transform: isActive ? 'translateY(-4px)' : 'none',
      }}>
        {/* Illustration */}
        <div style={{
          background: room.sky, position: 'relative',
          filter: isLocked ? 'grayscale(0.5) brightness(0.96)' : 'none',
        }}>
          <RoomIllustration state={room.state} color={room.color} deep={room.deep} sky={room.sky} accent={room.accent} />
          {/* Stamp */}
          <div style={{
            position: 'absolute', top: 12, left: 12,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 999,
            background: isDone ? 'var(--u-sage)' : isActive ? room.deep : 'rgba(255,255,255,0.85)',
            color: isDone || isActive ? '#fff' : room.deep,
            fontFamily: 'var(--u-mono)', fontSize: 10.5, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            border: isLocked ? '1px solid ' + room.deep + '30' : 'none',
          }}>
            {isDone && <><UIcon name="check" size={11} color="#fff" stroke={2.4} /> Done</>}
            {isActive && <><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} /> Working</>}
            {isLocked && <><UIcon name="lock" size={11} color={room.deep} /> Locked</>}
          </div>
          {/* Number badge */}
          <div style={{
            position: 'absolute', top: 12, right: 12,
            width: 32, height: 32, borderRadius: '50%',
            background: '#fff', border: `1.5px solid ${room.deep}`,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--u-display)', fontSize: 18, color: room.deep,
            fontWeight: 400,
            boxShadow: '0 2px 6px rgba(15,22,41,0.08)',
          }}>
            {isDone ? <UIcon name="check" size={14} color={room.deep} stroke={2.4} /> : room.id}
          </div>
        </div>

        {/* Header text */}
        <div className="u-col" style={{ padding: '18px 20px 8px' }}>
          <span style={{ fontFamily: 'var(--u-mono)', fontSize: 10, color: room.deep, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {room.when}
          </span>
          <h2 className="u-display" style={{ margin: '4px 0 0', fontSize: 30, color: room.deep, opacity: isLocked ? 0.55 : 1 }}>
            The {room.name}
          </h2>
          <span style={{ fontFamily: 'var(--u-display)', fontStyle: 'italic', fontSize: 16, color: 'var(--u-ink-3)', marginTop: 2 }}>
            {room.verb} — {room.tag}
          </span>
        </div>

        {/* Crew */}
        <div className="u-col u-gap-2" style={{ padding: '12px 20px 4px' }}>
          <span className="u-eyebrow" style={{ fontSize: 9.5 }}>Crew</span>
          <div className="u-col u-gap-2" style={{ filter: isLocked ? 'grayscale(0.6) opacity(0.6)' : 'none' }}>
            {room.crew.map(c => (
              <div key={c.initials} className="u-row u-items-center u-gap-2">
                <span className={`u-avatar ${c.kind}`} style={{ width: 24, height: 24, fontSize: 10 }}>{c.initials}</span>
                <span style={{ fontSize: 12.5, color: 'var(--u-ink)', fontWeight: 500 }}>{c.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Outputs */}
        <div className="u-col u-gap-2" style={{
          padding: '14px 20px 16px', marginTop: 'auto',
          borderTop: '1px solid var(--u-line-2)',
        }}>
          <span className="u-eyebrow" style={{ fontSize: 9.5 }}>
            {isDone ? 'You got' : "You'll get"}
          </span>
          <div className="u-row u-gap-2 u-wrap">
            {room.outputs.map(o => (
              <span key={o} className={`u-pill ${isDone ? 'sage' : ''}`} style={{ fontSize: 10.5 }}>
                {isDone && <UIcon name="check" size={10} color="var(--u-sage)" stroke={2.4} />}
                {o}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Connector arrow between cards */}
      {hasArrow && (
        <div style={{
          position: 'absolute', right: -18, top: 78,
          width: 36, height: 36, borderRadius: '50%',
          background: 'var(--u-paper)',
          border: '1px solid var(--u-line)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 2, boxShadow: 'var(--u-shadow-1)',
        }}>
          <UIcon name="arrow-right" size={14} color="var(--u-ink-3)" />
        </div>
      )}
    </div>
  );
};

Object.assign(window, { HiFactory });
