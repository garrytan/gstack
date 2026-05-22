// COSMIC ARCADE — additional screens
// Mode Picker · Factory (three planets) · Mobile companion

// =================================================================
// COSMIC MODE PICKER — the first moment
// =================================================================
const CosmicModePicker = () => (
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
        'radial-gradient(50% 60% at 25% 20%, rgba(255, 60, 200, 0.28) 0%, transparent 60%),' +
        'radial-gradient(45% 50% at 80% 30%, rgba(80, 220, 255, 0.20) 0%, transparent 60%),' +
        'radial-gradient(70% 60% at 50% 110%, rgba(140, 80, 255, 0.32) 0%, transparent 65%)',
    }} />
    <CosmicStars density={140} />

    {/* Top bar */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '18px 32px', borderBottom: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <CosmicLogo />
        <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>UNIVERSE</span>
      </div>
      <div style={{
        fontFamily: 'ui-monospace, monospace', fontSize: 11,
        letterSpacing: '0.16em', textTransform: 'uppercase',
        color: 'rgba(240,233,255,0.55)',
      }}>
        ◍ setup · 03 / 03 · pick your difficulty
      </div>
    </div>

    {/* Big heading */}
    <div style={{ position: 'relative', zIndex: 2, padding: '36px 56px 14px' }}>
      <div style={{
        fontFamily: 'ui-monospace, monospace', fontSize: 11,
        letterSpacing: '0.18em', textTransform: 'uppercase',
        color: '#50DCFF', marginBottom: 8,
      }}>tutor-match · ready to launch</div>
      <h1 style={{
        margin: 0, fontFamily: '"Space Grotesk", sans-serif',
        fontSize: 64, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 0.95,
      }}>
        choose your <span style={{
          fontStyle: 'italic',
          background: 'linear-gradient(110deg, #50DCFF 0%, #FF3CC8 60%, #FFC83C 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>difficulty.</span>
      </h1>
      <p style={{
        margin: '10px 0 0', fontSize: 16, color: 'rgba(240,233,255,0.5)',
      }}>
        switch any time. it just changes how often I ping you.
      </p>
    </div>

    {/* Two cards */}
    <div style={{
      position: 'relative', zIndex: 2,
      padding: '20px 56px 40px',
      display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 22,
      minHeight: 540,
    }}>
      {/* EASY — featured */}
      <div style={{
        position: 'relative',
        background: 'linear-gradient(155deg, rgba(255,60,200,0.18) 0%, rgba(140,80,255,0.20) 60%, rgba(80,220,255,0.10) 100%)',
        border: '1px solid rgba(255,60,200,0.35)',
        borderRadius: 24,
        padding: '32px 32px 24px',
        display: 'flex', flexDirection: 'column',
        backdropFilter: 'blur(20px)',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.04), 0 20px 50px rgba(255,60,200,0.20)',
      }}>
        {/* Featured stamp */}
        <div style={{
          position: 'absolute', top: -14, left: 28,
          padding: '6px 14px', borderRadius: 999,
          background: 'linear-gradient(135deg, #FF3CC8, #8C50FF)',
          fontFamily: 'ui-monospace, monospace', fontSize: 10.5,
          letterSpacing: '0.18em', textTransform: 'uppercase',
          color: '#fff', fontWeight: 700,
          boxShadow: '0 0 20px rgba(255,60,200,0.6)',
        }}>★ recommended</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 18 }}>
          <CosmicPlanet size={88} />
          <div>
            <div style={{
              fontFamily: 'ui-monospace, monospace', fontSize: 11,
              letterSpacing: '0.18em', textTransform: 'uppercase',
              color: '#FF3CC8',
            }}>mode · easy</div>
            <h2 style={{
              margin: '4px 0 0', fontFamily: '"Space Grotesk", sans-serif',
              fontSize: 48, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1,
            }}>
              <span style={{ fontStyle: 'italic' }}>I drive,</span><br/>
              you sign off
            </h2>
          </div>
        </div>

        <p style={{
          fontSize: 15, lineHeight: 1.55, color: 'rgba(240,233,255,0.78)', margin: '0 0 18px',
        }}>
          I'll handle the small calls — libraries, file names, copy tone — and only ping you
          when <span style={{ color: '#fff', fontWeight: 600 }}>only you can decide.</span>
        </p>

        <CosmicKnockList
          title="when I'll knock"
          tone="brand"
          items={[
            'money — pricing, paid plans, payment provider',
            'brand — name, voice, taste references',
            'anything that touches users (privacy, accounts)',
            'when I\'m unsure I\'m building the right thing',
          ]}
        />
        <CosmicKnockList
          title="when I won't"
          tone="mute"
          items={[
            'engineering choices · framework · file layout',
            'default copy, spacing, color details',
            'anything I can reverse without you noticing',
          ]}
        />

        <div style={{ flex: 1 }} />

        <div style={{
          marginTop: 18, padding: '14px 16px',
          background: 'rgba(0,0,0,0.30)', borderRadius: 14,
          display: 'flex', alignItems: 'center', gap: 14,
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>~3-5 check-ins total</div>
            <div style={{ fontSize: 11.5, color: 'rgba(240,233,255,0.5)' }}>
              every auto-decision is one tap to undo
            </div>
          </div>
          <button style={{
            padding: '11px 22px', borderRadius: 999,
            background: 'linear-gradient(135deg, #FF3CC8, #8C50FF)',
            color: '#fff', border: 'none',
            fontFamily: '"Space Grotesk", sans-serif',
            fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
            cursor: 'pointer',
            boxShadow: '0 6px 24px rgba(255,60,200,0.50), 0 0 0 1px rgba(255,255,255,0.12) inset',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            START EASY <span style={{ fontSize: 14 }}>→</span>
          </button>
        </div>
      </div>

      {/* HANDS-ON — console-y, secondary */}
      <div style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 24,
        padding: '32px 28px 22px',
        display: 'flex', flexDirection: 'column',
        backdropFilter: 'blur(16px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
          <div style={{
            width: 76, height: 76, borderRadius: 16,
            background: 'rgba(80,220,255,0.10)',
            border: '1px solid rgba(80,220,255,0.30)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 36,
            boxShadow: 'inset 0 0 24px rgba(80,220,255,0.20)',
          }}>🛠</div>
          <div>
            <div style={{
              fontFamily: 'ui-monospace, monospace', fontSize: 11,
              letterSpacing: '0.18em', textTransform: 'uppercase',
              color: '#50DCFF',
            }}>mode · hands-on</div>
            <h2 style={{
              margin: '4px 0 0', fontFamily: '"Space Grotesk", sans-serif',
              fontSize: 42, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1,
              color: 'rgba(240,233,255,0.92)',
            }}>
              <span style={{ fontStyle: 'italic' }}>you drive,</span><br/>
              I assist
            </h2>
          </div>
        </div>

        <p style={{
          fontSize: 14.5, lineHeight: 1.55, color: 'rgba(240,233,255,0.62)', margin: '0 0 18px',
        }}>
          see every room — Drawing Room, Workshop, Showroom — and review what each crew member
          produces. approve, push back, or redirect at every step.
        </p>

        <CosmicKnockList
          title="you'll see"
          tone="cyan"
          items={[
            'every phase opening & closing',
            'every persona\'s draft before it ships',
            'every artifact (plan, design, build, QA, fix)',
            'the raw conversation behind every decision',
          ]}
        />
        <CosmicKnockList
          title="good for"
          tone="mute"
          items={[
            'engineers wanting to understand what I built',
            'anyone learning how this works',
            'high-stakes or brand-critical projects',
          ]}
        />

        <div style={{ flex: 1 }} />

        <div style={{
          marginTop: 18, padding: '14px 16px',
          background: 'rgba(0,0,0,0.30)', borderRadius: 14,
          display: 'flex', alignItems: 'center', gap: 14,
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>~20 check-ins</div>
            <div style={{ fontSize: 11.5, color: 'rgba(240,233,255,0.5)' }}>
              you'll learn how I build things
            </div>
          </div>
          <button style={{
            padding: '11px 20px', borderRadius: 999,
            background: 'transparent',
            color: '#50DCFF', border: '1px solid rgba(80,220,255,0.6)',
            fontFamily: '"Space Grotesk", sans-serif',
            fontSize: 12.5, fontWeight: 700, letterSpacing: '0.04em',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            USE HANDS-ON →
          </button>
        </div>
      </div>
    </div>

    <style>{`
      @keyframes cosmicPulse2 { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    `}</style>
  </div>
);

const CosmicKnockList = ({ title, items, tone = 'brand' }) => {
  const colors = {
    brand: { dot: '#FF3CC8', label: '#FF3CC8' },
    cyan:  { dot: '#50DCFF', label: '#50DCFF' },
    mute:  { dot: 'rgba(240,233,255,0.25)', label: 'rgba(240,233,255,0.4)' },
  }[tone];
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontFamily: 'ui-monospace, monospace', fontSize: 10,
        letterSpacing: '0.16em', textTransform: 'uppercase',
        color: colors.label, marginBottom: 8,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((t, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: colors.dot, flexShrink: 0, marginTop: 7,
              boxShadow: tone !== 'mute' ? `0 0 8px ${colors.dot}` : 'none',
            }} />
            <span style={{
              fontSize: 13, lineHeight: 1.45,
              color: tone === 'mute' ? 'rgba(240,233,255,0.45)' : 'rgba(240,233,255,0.85)',
            }}>{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// =================================================================
// COSMIC FACTORY — three planets / stations
// =================================================================
const COSMIC_ROOMS = [
  {
    id: 1, name: 'Drawing Room', verb: 'SHAPE IT',
    state: 'done', tag: 'figure out what to build',
    when: 'PHASE 01 · COMPLETE',
    core: '#7B47C4', glow: '#FF3CC8', accent: '#FFB4E8',
    crew: [['PC', 'Product Coach'], ['CR', 'CEO Reviewer'], ['DS', 'Designer']],
    outputs: ['Idea brief', 'Project plan', 'Screen mockups'],
  },
  {
    id: 2, name: 'Workshop', verb: 'BUILD IT',
    state: 'active', tag: 'making it real',
    when: 'PHASE 02 · ACTIVE',
    core: '#F0A03C', glow: '#FFC83C', accent: '#FFE08A',
    crew: [['AR', 'Architect'], ['IM', 'Implementer'], ['CV', 'Code Reviewer']],
    outputs: ['Architecture', 'Working build', 'Code review'],
  },
  {
    id: 3, name: 'Showroom', verb: 'SHIP IT',
    state: 'locked', tag: 'prove + hand off',
    when: 'PHASE 03 · LOCKED',
    core: '#3F8568', glow: '#50DCFF', accent: '#A8E5F5',
    crew: [['QA', 'QA Tester'], ['FX', 'Fix Loop'], ['RC', 'Release Coord.']],
    outputs: ['QA evidence', 'Fix summary', 'Handoff'],
  },
];

const CosmicFactory = () => (
  <div style={{
    width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
    background: '#0A0418',
    fontFamily: '"Space Grotesk", "Inter", system-ui, sans-serif',
    color: '#F0E9FF',
  }}>
    <div style={{
      position: 'absolute', inset: 0,
      background:
        'radial-gradient(50% 40% at 18% 30%, rgba(140,80,255,0.30) 0%, transparent 60%),' +
        'radial-gradient(40% 35% at 52% 35%, rgba(255,200,60,0.20) 0%, transparent 60%),' +
        'radial-gradient(45% 40% at 85% 30%, rgba(80,220,255,0.18) 0%, transparent 60%)',
    }} />
    <CosmicStars density={180} />

    {/* Top bar */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '18px 32px', borderBottom: '1px solid rgba(255,255,255,0.08)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <CosmicLogo />
        <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>UNIVERSE</span>
        <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
        <span style={{ fontSize: 14, color: 'rgba(240,233,255,0.75)' }}>tutor-match</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <CosmicModeToggle mode="hands" />
        <button style={cosmicBtn('ghost')}>⏸ PAUSE</button>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'linear-gradient(135deg, #FF3CC8, #8C50FF)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 11, color: '#fff',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 0 18px rgba(140,80,255,0.5)',
        }}>MV</div>
      </div>
    </div>

    {/* Title row */}
    <div style={{
      position: 'relative', zIndex: 2, padding: '32px 56px 16px',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
    }}>
      <div>
        <div style={{
          fontFamily: 'ui-monospace, monospace', fontSize: 11,
          letterSpacing: '0.18em', textTransform: 'uppercase',
          color: '#50DCFF', marginBottom: 6,
        }}>your factory · three zones</div>
        <h1 style={{
          margin: 0, fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 56, fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 0.95,
        }}>
          three zones. <span style={{ fontStyle: 'italic', color: 'rgba(240,233,255,0.55)' }}>traveled in order.</span>
        </h1>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CosmicChip color="#50DCFF" label="1 CLEARED" />
        <CosmicChip color="#FFC83C" label="1 ACTIVE" />
        <CosmicChip color="rgba(255,255,255,0.25)" label="1 LOCKED" muted />
      </div>
    </div>

    {/* Three planets */}
    <div style={{
      position: 'relative', zIndex: 2,
      padding: '24px 56px 28px',
      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 26,
    }}>
      {COSMIC_ROOMS.map(room => <CosmicRoomCard key={room.id} room={room} />)}
    </div>

    {/* Bottom action */}
    <div style={{
      position: 'absolute', left: 56, right: 56, bottom: 28, zIndex: 2,
      padding: '16px 22px',
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,200,60,0.30)',
      borderRadius: 18,
      backdropFilter: 'blur(20px)',
      display: 'flex', alignItems: 'center', gap: 16,
      boxShadow: '0 0 32px rgba(240,160,60,0.15)',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        background: 'radial-gradient(circle at 30% 30%, #FFE08A, #F0A03C, #B96E12)',
        boxShadow: '0 0 24px rgba(255,200,60,0.6)',
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, lineHeight: 1.3 }}>
        <div style={{
          fontFamily: 'ui-monospace, monospace', fontSize: 10,
          letterSpacing: '0.18em', textTransform: 'uppercase',
          color: '#FFC83C',
        }}>now playing · workshop</div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Implementer is wiring tutor profiles to the search.</div>
        <div style={{ fontSize: 12.5, color: 'rgba(240,233,255,0.5)', marginTop: 2, fontStyle: 'italic' }}>
          nothing needs you · ~25 min to next check-in
        </div>
      </div>
      <button style={{
        padding: '11px 22px', borderRadius: 999,
        background: 'linear-gradient(135deg, #FFC83C, #F0A03C)',
        color: '#1A0A00', border: 'none',
        fontFamily: '"Space Grotesk", sans-serif',
        fontSize: 12.5, fontWeight: 800, letterSpacing: '0.04em',
        cursor: 'pointer',
        boxShadow: '0 6px 20px rgba(255,200,60,0.4)',
        display: 'inline-flex', alignItems: 'center', gap: 8,
      }}>ENTER WORKSHOP →</button>
    </div>
  </div>
);

const CosmicChip = ({ color, label, muted }) => (
  <div style={{
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '5px 11px', borderRadius: 999,
    background: muted ? 'rgba(255,255,255,0.04)' : `${color}1A`,
    border: `1px solid ${muted ? 'rgba(255,255,255,0.12)' : color + '55'}`,
    fontFamily: 'ui-monospace, monospace',
    fontSize: 10, letterSpacing: '0.14em', fontWeight: 700,
    color: muted ? 'rgba(240,233,255,0.4)' : color,
  }}>
    <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: muted ? 'none' : `0 0 8px ${color}` }} />
    {label}
  </div>
);

const CosmicRoomCard = ({ room }) => {
  const done = room.state === 'done';
  const active = room.state === 'active';
  const locked = room.state === 'locked';
  return (
    <div style={{
      position: 'relative',
      background: locked ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${active ? room.glow + '60' : locked ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.12)'}`,
      borderRadius: 22,
      padding: '0 0 16px',
      overflow: 'hidden',
      backdropFilter: 'blur(20px)',
      boxShadow: active ? `0 0 40px ${room.glow}30, inset 0 0 0 1px ${room.glow}20` : 'none',
      opacity: locked ? 0.78 : 1,
    }}>
      {/* Planet area */}
      <div style={{
        position: 'relative', height: 180,
        background: locked
          ? 'radial-gradient(60% 100% at 50% 60%, rgba(255,255,255,0.04), transparent)'
          : `radial-gradient(70% 100% at 50% 60%, ${room.core}40 0%, transparent 65%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <CosmicRoomPlanet room={room} />
        {/* Stamp */}
        <div style={{
          position: 'absolute', top: 14, left: 14,
          padding: '4px 10px', borderRadius: 999,
          background: done
            ? 'linear-gradient(135deg, #50DCFF, #2A8CFF)'
            : active
              ? `linear-gradient(135deg, ${room.glow}, ${room.core})`
              : 'rgba(255,255,255,0.06)',
          border: `1px solid ${locked ? 'rgba(255,255,255,0.12)' : 'transparent'}`,
          fontFamily: 'ui-monospace, monospace', fontSize: 9.5,
          letterSpacing: '0.16em', fontWeight: 700,
          color: locked ? 'rgba(240,233,255,0.5)' : '#0A0418',
          textTransform: 'uppercase',
          boxShadow: !locked ? `0 0 16px ${room.glow}60` : 'none',
        }}>
          {done ? '✓ cleared' : active ? '● now playing' : '🔒 locked'}
        </div>
        {/* Number */}
        <div style={{
          position: 'absolute', top: 14, right: 14,
          width: 28, height: 28, borderRadius: '50%',
          background: 'rgba(0,0,0,0.4)',
          border: `1px solid ${locked ? 'rgba(255,255,255,0.16)' : room.glow + '60'}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 14, fontWeight: 600,
          color: locked ? 'rgba(240,233,255,0.5)' : room.glow,
        }}>{room.id}</div>
      </div>

      {/* Body */}
      <div style={{ padding: '14px 22px 0' }}>
        <div style={{
          fontFamily: 'ui-monospace, monospace', fontSize: 9.5,
          letterSpacing: '0.18em', textTransform: 'uppercase',
          color: locked ? 'rgba(240,233,255,0.35)' : room.glow,
          marginBottom: 6,
        }}>{room.when}</div>
        <h2 style={{
          margin: 0, fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 32, fontWeight: 500, letterSpacing: '-0.025em', lineHeight: 1,
          color: locked ? 'rgba(240,233,255,0.55)' : '#F0E9FF',
        }}>
          The {room.name}
        </h2>
        <div style={{
          marginTop: 4, fontSize: 13, fontStyle: 'italic',
          color: locked ? 'rgba(240,233,255,0.3)' : 'rgba(240,233,255,0.55)',
        }}>
          {room.verb.toLowerCase()} — {room.tag}
        </div>

        {/* Crew */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px dashed rgba(255,255,255,0.10)' }}>
          <div style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 9.5,
            letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'rgba(240,233,255,0.4)', marginBottom: 8,
          }}>crew</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: locked ? 0.6 : 1 }}>
            {room.crew.map(([initials, name]) => (
              <div key={initials} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: `linear-gradient(135deg, ${room.glow}40, ${room.core}40)`,
                  border: `1px solid ${room.glow}50`,
                  fontSize: 9.5, fontWeight: 700, color: '#F0E9FF',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>{initials}</span>
                <span style={{ fontSize: 12.5, color: 'rgba(240,233,255,0.82)' }}>{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Outputs */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed rgba(255,255,255,0.10)' }}>
          <div style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 9.5,
            letterSpacing: '0.16em', textTransform: 'uppercase',
            color: 'rgba(240,233,255,0.4)', marginBottom: 8,
          }}>{done ? 'loot' : "you'll get"}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {room.outputs.map(o => (
              <span key={o} style={{
                padding: '3px 9px', borderRadius: 999,
                background: done ? `${room.glow}1A` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${done ? room.glow + '40' : 'rgba(255,255,255,0.10)'}`,
                fontSize: 10.5, fontWeight: 500,
                color: done ? room.glow : 'rgba(240,233,255,0.55)',
              }}>{done && '✓ '}{o}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const CosmicRoomPlanet = ({ room }) => {
  const id = React.useId();
  return (
    <div style={{
      position: 'relative', width: 130, height: 130,
      animation: room.state === 'active' ? 'cosmicFloat 5s ease-in-out infinite' : 'none',
    }}>
      {room.state === 'active' && (
        <div style={{
          position: 'absolute', inset: -28,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${room.glow}55 0%, transparent 60%)`,
          filter: 'blur(8px)',
          animation: 'cosmicPulse2 3s ease-in-out infinite',
        }} />
      )}
      <svg viewBox="0 0 150 150" width={130} height={130} style={{ position: 'relative' }}>
        <defs>
          <radialGradient id={`rp-${id}`} cx="35%" cy="32%" r="70%">
            <stop offset="0%" stopColor={room.accent} />
            <stop offset="40%" stopColor={room.glow} />
            <stop offset="80%" stopColor={room.core} />
            <stop offset="100%" stopColor="#0A0418" />
          </radialGradient>
          <radialGradient id={`rs-${id}`} cx="30%" cy="25%" r="22%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity={room.state === 'locked' ? 0.4 : 0.85} />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Ring */}
        {room.state !== 'locked' && (
          <ellipse cx="75" cy="75" rx="68" ry="14" fill="none" stroke={room.glow} strokeOpacity="0.35" strokeWidth="1.5" transform="rotate(-18 75 75)" />
        )}
        <circle cx="75" cy="75" r="48" fill={`url(#rp-${id})`} opacity={room.state === 'locked' ? 0.6 : 1} />
        <circle cx="75" cy="75" r="48" fill={`url(#rs-${id})`} />
        {room.state === 'active' && (
          <path d="M108 38 L110 43 L115 45 L110 47 L108 52 L106 47 L101 45 L106 43 Z" fill="#FFFFFF" />
        )}
        {room.state === 'locked' && (
          <g>
            <rect x="64" y="68" width="22" height="20" rx="3" fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
            <path d="M68 68 V63 a7 7 0 0 1 14 0 V68" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" />
          </g>
        )}
      </svg>
    </div>
  );
};

Object.assign(window, { CosmicModePicker, CosmicFactory });
