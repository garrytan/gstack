// Direction B — SOFT 3D / BUBBLE
// Chunky 3D shadows, frosted glass, mascot-forward. Duolingo-meets-Linear-meets-Vision Pro.

const BubbleEasy = () => (
  <div style={{
    width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
    background: 'linear-gradient(160deg, #FFF1E0 0%, #FFE4F1 35%, #E8E4FF 70%, #DEF3FF 100%)',
    fontFamily: '"Bricolage Grotesque", "Inter", system-ui, sans-serif',
    color: '#1A1330',
  }}>
    {/* Floating blobs */}
    <div style={{
      position: 'absolute', top: -100, right: -80, width: 360, height: 360, borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(255,180,210,0.7), transparent 70%)', filter: 'blur(40px)',
    }} />
    <div style={{
      position: 'absolute', bottom: -120, left: -60, width: 320, height: 320, borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(180,200,255,0.6), transparent 70%)', filter: 'blur(50px)',
    }} />

    {/* Top bar */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px 32px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <BubbleMascot size={40} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em' }}>Universe</div>
          <div style={{ fontSize: 11, color: 'rgba(26,19,48,0.55)' }}>tutor match · day 2</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <BubbleToggle mode="easy" />
        <button style={bubBtn('soft')}>⏸ pause</button>
        <div style={{
          width: 38, height: 38, borderRadius: '50%',
          background: 'linear-gradient(135deg, #FFB4C9, #FF8FB1)',
          boxShadow: '0 4px 0 #E66A8E, 0 8px 20px rgba(230,106,142,0.35)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 800, fontSize: 13,
        }}>MV</div>
      </div>
    </div>

    {/* HERO */}
    <div style={{
      position: 'relative', zIndex: 2,
      padding: '24px 48px 32px', display: 'flex', flexDirection: 'column', gap: 22,
    }}>
      {/* Big bubble card */}
      <div style={{
        background: 'rgba(255,255,255,0.55)',
        backdropFilter: 'blur(24px) saturate(180%)',
        border: '1.5px solid rgba(255,255,255,0.7)',
        borderRadius: 32,
        padding: '36px 40px',
        boxShadow: '0 24px 48px -12px rgba(140,80,160,0.18), 0 2px 0 rgba(255,255,255,0.8) inset',
        position: 'relative',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <BubbleMascot size={120} happy waving />

          <div style={{ flex: 1, lineHeight: 1.05 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 999,
              background: '#FFF',
              boxShadow: '0 2px 0 #FFD9B0, 0 4px 12px rgba(255,180,100,0.30)',
              fontSize: 11, fontWeight: 700, letterSpacing: '0.02em',
              color: '#A86310', marginBottom: 14,
            }}>
              <span style={{ animation: 'bubBounce 1.2s ease-in-out infinite' }}>🛠</span>
              cooking right now
            </div>
            <h1 style={{
              fontFamily: '"Bricolage Grotesque", sans-serif',
              fontSize: 64, fontWeight: 700, margin: 0,
              letterSpacing: '-0.035em', lineHeight: 0.95,
              color: '#1A1330',
            }}>
              I'm building your<br/>
              <span style={{
                background: 'linear-gradient(110deg, #FF6FB5 0%, #8B5CF6 60%, #4FB4FF 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                fontStyle: 'italic',
              }}>tutor app</span> ✨
            </h1>
            <p style={{
              margin: '14px 0 0', fontSize: 17, color: 'rgba(26,19,48,0.62)',
              fontWeight: 500,
            }}>
              you can chill. I'll buzz in about <span style={{ fontWeight: 800, color: '#1A1330' }}>~25 min.</span>
            </p>
          </div>

          {/* Chunky stat */}
          <div style={{
            padding: '22px 24px',
            background: '#1A1330', color: '#FFE4F1',
            borderRadius: 24,
            boxShadow: '0 6px 0 #050010, 0 12px 24px rgba(0,0,0,0.25)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 11, opacity: 0.6, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 }}>
              vibe check
            </div>
            <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>4/9</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 6 }}>steps cleared</div>
          </div>
        </div>

        {/* Chunky progress dots */}
        <div style={{ display: 'flex', gap: 8, marginTop: 28, alignItems: 'center' }}>
          {[
            ['Shape', 'done'], ['Plan', 'done'], ['Design', 'done'], ['Build', 'done'],
            ['Review', 'now'], ['Test', ''], ['Fix', ''], ['Ready', ''], ['Ship', ''],
          ].map(([label, state], i) => (
            <BubbleStep key={i} label={label} state={state} />
          ))}
        </div>
      </div>

      {/* Status row */}
      <div style={{ display: 'flex', gap: 18 }}>
        {/* All clear sticker */}
        <div style={{
          flex: 1,
          background: '#C2F0D8',
          border: '2px solid #1A1330',
          borderRadius: 24,
          padding: '20px 24px',
          boxShadow: '6px 6px 0 #1A1330',
          display: 'flex', alignItems: 'center', gap: 14,
          transform: 'rotate(-0.6deg)',
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: '#1A1330', color: '#C2F0D8',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, fontWeight: 900,
          }}>✓</div>
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.01em' }}>nothing for you!</div>
            <div style={{ fontSize: 13, color: 'rgba(26,19,48,0.65)', marginTop: 2 }}>
              last knock 38m ago · go touch grass 🌱
            </div>
          </div>
        </div>

        {/* Mascot speaks */}
        <div style={{
          flex: 1.2,
          background: '#FFF',
          border: '2px solid #1A1330',
          borderRadius: 24,
          padding: '18px 22px',
          boxShadow: '6px 6px 0 #1A1330',
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute', top: -14, left: 24,
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '4px 12px', borderRadius: 999,
            background: '#FFE066', border: '2px solid #1A1330',
            fontSize: 11, fontWeight: 800, letterSpacing: '0.02em',
          }}>
            ✨ I handled · 4 things
          </div>
          <div style={{ marginTop: 6 }}>
            {[
              ['UI framework', 'Tailwind + Radix'],
              ['Search component', 'TutorFinder'],
              ['How tutors load', 'pages of 20'],
            ].map(([k, v], i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0',
                borderBottom: i < 2 ? '1px dashed rgba(26,19,48,0.15)' : 'none',
              }}>
                <span style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: '#C2F0D8', border: '1.5px solid #1A1330',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 900, flexShrink: 0,
                }}>✓</span>
                <span style={{ flex: 1, fontSize: 13.5 }}>
                  {k} → <strong style={{ fontWeight: 800 }}>{v}</strong>
                </span>
                <button style={bubBtn('mini')}>undo</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>

    <style>{`
      @keyframes bubBounce { 0%, 100% { transform: translateY(0) rotate(0); } 50% { transform: translateY(-3px) rotate(8deg); } }
      @keyframes bubWave { 0%, 100% { transform: rotate(-8deg); } 50% { transform: rotate(18deg); } }
      @keyframes bubFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
    `}</style>
  </div>
);

// Bubble primitives
const bubBtn = (variant) => {
  if (variant === 'mini') {
    return {
      padding: '4px 10px', borderRadius: 999,
      background: '#1A1330', color: '#fff',
      border: 'none', fontSize: 10.5, fontWeight: 700,
      letterSpacing: '0.02em', cursor: 'pointer',
    };
  }
  return {
    padding: '8px 16px', borderRadius: 999,
    background: '#FFF', color: '#1A1330',
    border: '2px solid #1A1330',
    boxShadow: '0 3px 0 #1A1330',
    fontSize: 12, fontWeight: 700, letterSpacing: '0.02em',
    cursor: 'pointer',
  };
};

const BubbleMascot = ({ size = 80, happy = false, waving = false }) => (
  <div style={{
    position: 'relative', width: size, height: size, flexShrink: 0,
    animation: 'bubFloat 4s ease-in-out infinite',
  }}>
    <svg viewBox="0 0 100 100" width={size} height={size}>
      <defs>
        <radialGradient id={`bmash-${size}`} cx="40%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#FFE3FF" />
          <stop offset="40%" stopColor="#C5A6FF" />
          <stop offset="100%" stopColor="#7B5CCD" />
        </radialGradient>
      </defs>
      {/* shadow under */}
      <ellipse cx="50" cy="92" rx="28" ry="4" fill="#1A1330" opacity="0.15" />
      {/* body */}
      <circle cx="50" cy="46" r="40" fill={`url(#bmash-${size})`} stroke="#1A1330" strokeWidth="2.5" />
      {/* highlight */}
      <ellipse cx="38" cy="32" rx="10" ry="6" fill="#FFFFFF" opacity="0.6" />
      {/* eyes */}
      <circle cx="38" cy="48" r="4" fill="#1A1330" />
      <circle cx="62" cy="48" r="4" fill="#1A1330" />
      <circle cx="39.5" cy="46.5" r="1.4" fill="#FFFFFF" />
      <circle cx="63.5" cy="46.5" r="1.4" fill="#FFFFFF" />
      {/* mouth */}
      {happy ? (
        <path d="M 40 58 Q 50 68 60 58" fill="none" stroke="#1A1330" strokeWidth="2.5" strokeLinecap="round" />
      ) : (
        <path d="M 44 60 Q 50 64 56 60" fill="none" stroke="#1A1330" strokeWidth="2.5" strokeLinecap="round" />
      )}
      {/* cheeks */}
      <circle cx="32" cy="58" r="3" fill="#FF8FB1" opacity="0.6" />
      <circle cx="68" cy="58" r="3" fill="#FF8FB1" opacity="0.6" />
      {/* arm wave */}
      {waving && (
        <g style={{ transformOrigin: '76px 50px', animation: 'bubWave 1.4s ease-in-out infinite' }}>
          <circle cx="86" cy="38" r="7" fill={`url(#bmash-${size})`} stroke="#1A1330" strokeWidth="2.5" />
        </g>
      )}
      {/* sparkle */}
      <path d="M75 18 L77 24 L83 26 L77 28 L75 34 L73 28 L67 26 L73 24 Z" fill="#FFE066" stroke="#1A1330" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  </div>
);

const BubbleStep = ({ label, state }) => {
  const done = state === 'done', now = state === 'now';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1 }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: done ? '#C2F0D8' : now ? '#FFE066' : '#FFF',
        border: '2px solid #1A1330',
        boxShadow: now ? '0 3px 0 #1A1330, 0 0 0 4px rgba(255,224,102,0.5)' : '0 2px 0 #1A1330',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 800,
        animation: now ? 'bubBounce 1.2s ease-in-out infinite' : 'none',
      }}>
        {done ? '✓' : now ? '•' : ''}
      </div>
      <span style={{
        fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: now ? '#1A1330' : done ? 'rgba(26,19,48,0.55)' : 'rgba(26,19,48,0.30)',
      }}>{label}</span>
    </div>
  );
};

const BubbleToggle = ({ mode }) => (
  <div style={{
    display: 'inline-flex', padding: 4,
    background: '#FFF', border: '2px solid #1A1330',
    borderRadius: 999, boxShadow: '0 3px 0 #1A1330',
  }}>
    {[['easy', '✨ easy'], ['hands', '🔧 hands-on']].map(([k, label]) => (
      <div key={k} style={{
        padding: '5px 14px', borderRadius: 999,
        background: mode === k ? '#1A1330' : 'transparent',
        color: mode === k ? '#FFE066' : 'rgba(26,19,48,0.5)',
        fontSize: 12, fontWeight: 800, letterSpacing: '0.02em',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>{label}</div>
    ))}
  </div>
);

Object.assign(window, { BubbleEasy });
