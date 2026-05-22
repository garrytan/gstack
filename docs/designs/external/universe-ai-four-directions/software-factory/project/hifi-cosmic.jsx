// Direction A — COSMIC ARCADE
// Dark mode, neon glow, gaming + space vibes. Lots of motion, big type, glow halos.

const CosmicEasy = () => (
  <div style={{
    width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
    background: '#0A0418',
    fontFamily: '"Space Grotesk", "Inter", system-ui, sans-serif',
    color: '#F0E9FF',
  }}>
    {/* Nebula backdrop */}
    <div style={{
      position: 'absolute', inset: 0,
      background:
        'radial-gradient(60% 50% at 10% 10%, rgba(255, 60, 200, 0.22) 0%, transparent 60%),' +
        'radial-gradient(70% 50% at 95% 5%, rgba(80, 220, 255, 0.18) 0%, transparent 55%),' +
        'radial-gradient(80% 60% at 50% 110%, rgba(140, 80, 255, 0.30) 0%, transparent 60%)',
    }} />
    <CosmicStars density={120} />

    {/* Top bar */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '18px 32px', borderBottom: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <CosmicLogo />
        <span style={{ fontFamily: '"Space Grotesk", sans-serif', fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>
          UNIVERSE
        </span>
        <span style={{
          marginLeft: 12, fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
          fontSize: 11, color: 'rgba(255,255,255,0.4)',
        }}>
          ◍ tutor-match · 04 / 09
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <CosmicModeToggle mode="easy" />
        <button style={cosmicBtn('ghost')}>
          <span style={{ fontSize: 10 }}>⏸</span> PAUSE
        </button>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'linear-gradient(135deg, #FF3CC8, #8C50FF)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 11, color: '#fff',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 0 18px rgba(140,80,255,0.5)',
        }}>MV</div>
      </div>
    </div>

    {/* HERO */}
    <div style={{
      position: 'relative', zIndex: 2,
      padding: '40px 56px',
      display: 'flex', flexDirection: 'column', gap: 28,
    }}>
      {/* Headline + planet */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
        {/* Big animated planet */}
        <CosmicPlanet size={180} />

        <div style={{ flex: 1, lineHeight: 1.0 }}>
          <div style={{
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            fontSize: 11, letterSpacing: '0.18em', color: '#FF3CC8',
            textTransform: 'uppercase', marginBottom: 14,
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', borderRadius: 999,
            background: 'rgba(255,60,200,0.10)',
            border: '1px solid rgba(255,60,200,0.30)',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#FF3CC8',
              boxShadow: '0 0 8px #FF3CC8',
              animation: 'cosmicPulse 1.4s ease-in-out infinite',
            }} />
            now playing
          </div>
          <h1 style={{
            fontFamily: '"Space Grotesk", sans-serif',
            fontSize: 88, fontWeight: 500, margin: 0,
            letterSpacing: '-0.04em', lineHeight: 0.92,
          }}>
            I'm building<br/>your<br/>
            <span style={{
              fontStyle: 'italic',
              background: 'linear-gradient(110deg, #50DCFF 0%, #FF3CC8 50%, #FFC83C 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>tutor app.</span>
          </h1>
          <div style={{
            marginTop: 16,
            fontFamily: '"Space Grotesk", sans-serif',
            fontSize: 18, color: 'rgba(240,233,255,0.55)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <span>step away · I'll text in</span>
            <span style={{
              fontSize: 22, fontWeight: 700, color: '#50DCFF',
              fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            }}>~25:00</span>
          </div>
        </div>
      </div>

      {/* Progress as power bar */}
      <div style={{
        position: 'relative',
        padding: '20px 28px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 18,
        backdropFilter: 'blur(20px)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
        }}>
          <span style={{
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            fontSize: 11, letterSpacing: '0.15em', color: 'rgba(240,233,255,0.5)',
            textTransform: 'uppercase',
          }}>level 04 · build</span>
          <span style={{
            fontSize: 12, color: 'rgba(240,233,255,0.6)',
          }}>4 / 9 stages cleared</span>
        </div>
        <div style={{ display: 'flex', gap: 6, height: 14 }}>
          {Array.from({ length: 9 }, (_, i) => {
            const done = i < 4;
            const active = i === 4;
            return (
              <div key={i} style={{
                flex: 1, borderRadius: 4, position: 'relative', overflow: 'hidden',
                background: done
                  ? 'linear-gradient(180deg, #50DCFF, #2A8CFF)'
                  : active
                    ? 'linear-gradient(180deg, #FF3CC8, #8C50FF)'
                    : 'rgba(255,255,255,0.06)',
                boxShadow: active ? '0 0 16px #FF3CC8, 0 0 32px rgba(255,60,200,0.6)' : 'none',
              }}>
                {active && (
                  <div style={{
                    position: 'absolute', inset: 0,
                    background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
                    animation: 'cosmicShimmer 1.8s linear infinite',
                  }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Two-column lower */}
      <div style={{ display: 'flex', gap: 20 }}>
        {/* All clear */}
        <div style={{
          flex: 1, padding: '20px 22px',
          background: 'linear-gradient(135deg, rgba(80,220,255,0.10), rgba(80,220,255,0.02))',
          border: '1px solid rgba(80,220,255,0.30)',
          borderRadius: 18,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'linear-gradient(135deg, #50DCFF, #2A8CFF)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            color: '#0A0418', fontSize: 22, fontWeight: 900,
            boxShadow: '0 0 24px rgba(80,220,255,0.6)',
          }}>✓</div>
          <div style={{ lineHeight: 1.25 }}>
            <div style={{
              fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
              fontSize: 10, letterSpacing: '0.16em', color: '#50DCFF',
              textTransform: 'uppercase',
            }}>all clear</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>Nothing needs you.</div>
            <div style={{ fontSize: 12, color: 'rgba(240,233,255,0.5)', marginTop: 2 }}>
              last knock: 38m ago · pricing decision
            </div>
          </div>
        </div>

        {/* Side-quests / handled */}
        <div style={{
          flex: 1.4, padding: '18px 22px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 18,
          backdropFilter: 'blur(16px)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12,
          }}>
            <span style={{
              fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
              fontSize: 10.5, letterSpacing: '0.16em', color: 'rgba(240,233,255,0.55)',
              textTransform: 'uppercase',
            }}>side quests · auto-cleared</span>
            <span style={{ fontSize: 11, color: 'rgba(240,233,255,0.4)' }}>last 2h</span>
          </div>
          {[
            ['UI framework', 'Tailwind + Radix'],
            ['Search component name', 'TutorFinder'],
            ['Tutor loading', 'pages of 20'],
          ].map(([k, v], i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '8px 0',
              borderBottom: i < 2 ? '1px dashed rgba(255,255,255,0.08)' : 'none',
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%',
                background: 'rgba(80,220,255,0.16)', color: '#50DCFF',
                fontSize: 11, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>✓</span>
              <span style={{ flex: 1, fontSize: 13, color: 'rgba(240,233,255,0.85)' }}>
                {k} → <span style={{ color: '#fff', fontWeight: 600 }}>{v}</span>
              </span>
              <span style={{
                fontSize: 10.5, color: 'rgba(240,233,255,0.4)',
                fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
                textTransform: 'uppercase', letterSpacing: '0.08em',
              }}>undo</span>
            </div>
          ))}
        </div>
      </div>
    </div>

    <style>{`
      @keyframes cosmicPulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.4); } }
      @keyframes cosmicShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
      @keyframes cosmicSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes cosmicFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
    `}</style>
  </div>
);

// ===== Cosmic primitives =====
const cosmicBtn = (variant = 'primary') => {
  if (variant === 'ghost') {
    return {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '7px 14px', borderRadius: 999,
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.16)',
      color: '#F0E9FF',
      fontFamily: '"Space Grotesk", sans-serif',
      fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
      textTransform: 'uppercase', cursor: 'pointer',
    };
  }
  return {};
};

const CosmicLogo = () => (
  <div style={{
    width: 30, height: 30, borderRadius: '50%',
    background: 'radial-gradient(circle at 30% 30%, #FFE3FF 0%, #FF3CC8 40%, #8C50FF 80%, #2A0E5E 100%)',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.15), 0 0 18px rgba(255,60,200,0.50)',
    position: 'relative',
  }}>
    <div style={{
      position: 'absolute', inset: -3,
      borderRadius: '50%',
      border: '1px solid rgba(140,80,255,0.4)',
      transform: 'rotate(20deg) scaleY(0.5)',
    }} />
  </div>
);

const CosmicStars = ({ density = 80 }) => {
  const stars = React.useMemo(() => Array.from({ length: density }, (_, i) => ({
    x: Math.random() * 100, y: Math.random() * 100,
    s: 0.5 + Math.random() * 1.8, o: 0.2 + Math.random() * 0.7,
    delay: Math.random() * 4, i,
  })), [density]);
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} viewBox="0 0 100 100" preserveAspectRatio="none">
      {stars.map(s => (
        <circle key={s.i} cx={s.x} cy={s.y} r={s.s * 0.12} fill="#fff" opacity={s.o}>
          <animate attributeName="opacity" values={`${s.o};${s.o * 0.3};${s.o}`} dur="3s" begin={`${s.delay}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </svg>
  );
};

const CosmicPlanet = ({ size = 160 }) => (
  <div style={{ position: 'relative', width: size, height: size, flexShrink: 0, animation: 'cosmicFloat 5s ease-in-out infinite' }}>
    {/* glow halo */}
    <div style={{
      position: 'absolute', inset: -size * 0.20,
      borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(255,60,200,0.45) 0%, transparent 60%)',
      filter: 'blur(8px)',
      animation: 'cosmicPulse 3s ease-in-out infinite',
    }} />
    <svg viewBox="0 0 200 200" width={size} height={size} style={{ position: 'relative' }}>
      <defs>
        <radialGradient id="planet-grad" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#FFE3FF" />
          <stop offset="25%" stopColor="#FF8FE3" />
          <stop offset="55%" stopColor="#FF3CC8" />
          <stop offset="85%" stopColor="#8C50FF" />
          <stop offset="100%" stopColor="#2A0E5E" />
        </radialGradient>
        <radialGradient id="planet-shine" cx="30%" cy="25%" r="22%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#50DCFF" stopOpacity="0" />
          <stop offset="50%" stopColor="#50DCFF" />
          <stop offset="100%" stopColor="#50DCFF" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Planet ring */}
      <ellipse cx="100" cy="100" rx="92" ry="20" fill="none" stroke="url(#ring-grad)" strokeWidth="3" transform="rotate(-18 100 100)" />
      <ellipse cx="100" cy="100" rx="92" ry="20" fill="none" stroke="#50DCFF" strokeOpacity="0.3" strokeWidth="1" transform="rotate(-18 100 100)" />
      {/* Planet body */}
      <circle cx="100" cy="100" r="65" fill="url(#planet-grad)" />
      <circle cx="100" cy="100" r="65" fill="url(#planet-shine)" />
      {/* surface bands */}
      <path d="M 40 95 Q 100 88 160 100" fill="none" stroke="#FFFFFF" strokeOpacity="0.18" strokeWidth="2" />
      <path d="M 45 115 Q 100 108 155 118" fill="none" stroke="#FFFFFF" strokeOpacity="0.12" strokeWidth="1.5" />
      {/* sparkle */}
      <path d="M138 50 L141 56 L147 58 L141 60 L138 66 L135 60 L129 58 L135 56 Z" fill="#FFFFFF" opacity="0.95" />
    </svg>
  </div>
);

const CosmicModeToggle = ({ mode }) => (
  <div style={{
    display: 'inline-flex', height: 32, padding: 3,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 999,
    fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
    fontSize: 10.5, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase',
  }}>
    {[['easy', 'easy', '#FF3CC8'], ['hands', 'hands-on', '#50DCFF']].map(([k, label, color]) => (
      <div key={k} style={{
        padding: '0 12px', height: 26, display: 'inline-flex', alignItems: 'center', gap: 6,
        borderRadius: 999,
        background: mode === k ? `linear-gradient(135deg, ${color}80, ${color}30)` : 'transparent',
        color: mode === k ? '#fff' : 'rgba(240,233,255,0.45)',
        boxShadow: mode === k ? `inset 0 0 0 1px ${color}80, 0 0 14px ${color}50` : 'none',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: mode === k ? color : 'rgba(240,233,255,0.3)', boxShadow: mode === k ? `0 0 8px ${color}` : 'none' }} />
        {label}
      </div>
    ))}
  </div>
);

Object.assign(window, { CosmicEasy });
