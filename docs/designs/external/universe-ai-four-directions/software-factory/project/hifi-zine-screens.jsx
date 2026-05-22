// MAXIMALIST ZINE — additional screens
// Mode Picker · Factory (three rooms as comic panels) · Mobile companion

// =================================================================
// ZINE MODE PICKER — the first moment
// =================================================================
const ZineModePicker = () => (
  <div style={{
    width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
    background: '#FFF8E1',
    fontFamily: '"Space Grotesk", "Inter", system-ui, sans-serif',
    color: '#0D0D0D',
  }}>
    {/* Halftone backdrop */}
    <div style={{
      position: 'absolute', inset: 0, opacity: 0.12, pointerEvents: 'none',
      backgroundImage: 'radial-gradient(#0D0D0D 1px, transparent 1px)',
      backgroundSize: '6px 6px',
    }} />

    {/* Top bar */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 24px', borderBottom: '3px solid #0D0D0D', background: '#FFF',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          padding: '4px 10px', background: '#0D0D0D', color: '#FFE066',
          fontWeight: 900, fontSize: 17, letterSpacing: '-0.02em',
          transform: 'rotate(-2deg)',
        }}>UNIVERSE™</div>
        <span style={{
          fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
          fontSize: 11, fontWeight: 600, padding: '3px 8px',
          background: '#FF3D7F', color: '#FFF',
        }}>SETUP · 03 / 03</span>
      </div>
      <div style={{
        fontFamily: 'ui-monospace, monospace', fontSize: 11,
        letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
        color: 'rgba(13,13,13,0.55)',
      }}>
        pick a track ▸
      </div>
    </div>

    {/* Big headline */}
    <div style={{ position: 'relative', zIndex: 2, padding: '28px 48px 14px' }}>
      <div style={{
        display: 'inline-block',
        padding: '4px 10px', background: '#0D0D0D', color: '#FFE066',
        fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 800,
        letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10,
        transform: 'rotate(-1deg)',
      }}>TUTOR-MATCH ▸ ALMOST READY</div>
      <h1 style={{
        margin: 0, fontFamily: '"Space Grotesk", sans-serif',
        fontSize: 76, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 0.88,
      }}>
        HOW <span style={{
          display: 'inline-block', background: '#FF3D7F', color: '#FFF',
          padding: '0 12px', fontStyle: 'italic', transform: 'rotate(-1.5deg)',
          margin: '0 6px',
        }}>HANDS-ON</span><br/>
        DO YOU WANNA BE?
      </h1>
      <p style={{
        margin: '14px 0 0', fontSize: 16, fontWeight: 500, maxWidth: 700,
        color: 'rgba(13,13,13,0.7)',
      }}>
        flip any time. just changes how often I ping you. <strong style={{ color: '#0D0D0D' }}>not a one-way door.</strong>
      </p>
    </div>

    {/* Two cards */}
    <div style={{
      position: 'relative', zIndex: 2,
      padding: '24px 48px 24px',
      display: 'grid', gridTemplateColumns: '1.05fr 1fr', gap: 28,
    }}>
      {/* EASY — featured sticker */}
      <div style={{
        position: 'relative',
        background: '#FFF',
        border: '3px solid #0D0D0D',
        padding: '24px 26px',
        boxShadow: '10px 10px 0 #0D0D0D',
        transform: 'rotate(-0.6deg)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* TOP STAMP */}
        <div style={{
          position: 'absolute', top: -18, right: -16,
          padding: '8px 14px', background: '#FFE066',
          border: '3px solid #0D0D0D',
          fontFamily: '"Space Grotesk", sans-serif',
          fontWeight: 900, fontSize: 14, letterSpacing: '0.04em',
          transform: 'rotate(8deg)',
          boxShadow: '4px 4px 0 #0D0D0D',
        }}>★ START HERE</div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
          <span style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 12,
            letterSpacing: '0.18em', fontWeight: 800, color: '#FF3D7F',
          }}>MODE · EASY</span>
          <span style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 10.5, fontWeight: 700,
            color: 'rgba(13,13,13,0.5)', letterSpacing: '0.1em',
          }}>~3-5 PINGS · 5 DAYS</span>
        </div>
        <h2 style={{
          margin: '4px 0 18px', fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 56, fontWeight: 700, letterSpacing: '-0.035em', lineHeight: 0.92,
        }}>
          <span style={{
            background: '#0D0D0D', color: '#C2F0D8',
            padding: '0 10px', fontStyle: 'italic',
            display: 'inline-block', transform: 'rotate(-1deg)',
          }}>I DRIVE,</span><br/>
          YOU SIGN OFF.
        </h2>

        <p style={{
          fontSize: 14.5, lineHeight: 1.55, color: 'rgba(13,13,13,0.78)',
          margin: '0 0 16px',
        }}>
          I handle the small stuff — libraries, file names, copy tone — and only knock when{' '}
          <strong style={{ background: '#FFE066', padding: '0 4px' }}>only you can decide.</strong>
        </p>

        <ZineKnockBlock
          title="WHEN I'LL KNOCK"
          bg="#FF3D7F" fg="#FFF"
          items={[
            'MONEY — pricing, plans, payments',
            'BRAND — name, voice, taste',
            'USERS — privacy, accounts',
            'WHEN I\'M UNSURE',
          ]}
        />
        <ZineKnockBlock
          title="WHEN I WON'T"
          bg="#0D0D0D" fg="#FFE066"
          items={[
            'engineering, framework, file layout',
            'default copy, spacing, color',
            'anything I can quietly undo',
          ]}
          muted
        />

        <div style={{ flex: 1 }} />

        {/* CTA */}
        <button style={{
          marginTop: 20, padding: '16px 22px',
          background: '#0D0D0D', color: '#FFE066',
          border: '3px solid #0D0D0D',
          fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 17, fontWeight: 900, letterSpacing: '0.04em',
          cursor: 'pointer',
          boxShadow: '5px 5px 0 #FF3D7F',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>START IN EASY MODE</span>
          <span style={{ fontSize: 22 }}>→</span>
        </button>
      </div>

      {/* HANDS-ON — calmer sticker */}
      <div style={{
        position: 'relative',
        background: '#FFF',
        border: '3px solid #0D0D0D',
        padding: '24px 26px',
        boxShadow: '6px 6px 0 #0D0D0D',
        transform: 'rotate(0.5deg)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Tape strip */}
        <div style={{
          position: 'absolute', top: -10, left: 40,
          padding: '4px 14px', background: 'rgba(80,180,255,0.85)',
          fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 800,
          letterSpacing: '0.16em', color: '#0D0D0D',
          transform: 'rotate(-3deg)',
        }}>FOR POWER USERS</div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
          <span style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 12,
            letterSpacing: '0.18em', fontWeight: 800, color: '#0D0D0D',
          }}>MODE · HANDS-ON</span>
          <span style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 10.5, fontWeight: 700,
            color: 'rgba(13,13,13,0.5)', letterSpacing: '0.1em',
          }}>~20 PINGS · 7 DAYS</span>
        </div>
        <h2 style={{
          margin: '4px 0 18px', fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 50, fontWeight: 700, letterSpacing: '-0.035em', lineHeight: 0.92,
        }}>
          YOU DRIVE,<br/>
          <span style={{
            background: '#FFE066', padding: '0 10px', fontStyle: 'italic',
            display: 'inline-block', transform: 'rotate(0.6deg)',
          }}>I ASSIST.</span>
        </h2>

        <p style={{
          fontSize: 14, lineHeight: 1.55, color: 'rgba(13,13,13,0.72)',
          margin: '0 0 16px',
        }}>
          see every room — Drawing Room, Workshop, Showroom. review what each persona makes.
          approve, push back, redirect at every step.
        </p>

        <ZineKnockBlock
          title="YOU'LL SEE"
          bg="#0D0D0D" fg="#C2F0D8"
          items={[
            'every phase opening & closing',
            'every persona\'s draft',
            'every artifact (plan, design, build, qa, fix)',
            'the raw convo behind each call',
          ]}
        />
        <ZineKnockBlock
          title="GOOD FOR"
          bg="#FFF" fg="#0D0D0D"
          items={[
            'engineers who want to understand',
            'anyone learning how this works',
            'brand-critical projects',
          ]}
          muted bordered
        />

        <div style={{ flex: 1 }} />

        <button style={{
          marginTop: 20, padding: '14px 22px',
          background: '#FFF', color: '#0D0D0D',
          border: '3px solid #0D0D0D',
          fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 15, fontWeight: 900, letterSpacing: '0.04em',
          cursor: 'pointer',
          boxShadow: '4px 4px 0 #0D0D0D',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>USE HANDS-ON</span>
          <span style={{ fontSize: 20 }}>→</span>
        </button>
      </div>
    </div>

    {/* Footnote */}
    <div style={{
      position: 'absolute', bottom: 24, left: 48,
      display: 'flex', alignItems: 'center', gap: 12,
      fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700,
      color: 'rgba(13,13,13,0.55)', letterSpacing: '0.08em',
    }}>
      <span style={{ fontSize: 16 }}>✨</span>
      <span>NOT SURE? <strong style={{ color: '#0D0D0D' }}>EASY IS THE SAFER BET.</strong> FLIP TO HANDS-ON THE MOMENT YOU WANT.</span>
    </div>

    {/* Corner stamp */}
    <div style={{
      position: 'absolute', top: 88, right: 36,
      transform: 'rotate(8deg)',
      padding: '8px 14px',
      border: '3px double #0D0D0D',
      fontFamily: 'ui-monospace, monospace',
      fontSize: 10, fontWeight: 800, letterSpacing: '0.16em',
      color: '#0D0D0D', opacity: 0.45, lineHeight: 1.3, textAlign: 'center',
    }}>
      EST.<br/>2026
    </div>
  </div>
);

const ZineKnockBlock = ({ title, items, bg, fg, muted, bordered }) => (
  <div style={{
    marginBottom: 10,
    padding: '10px 14px',
    background: bordered ? bg : bg,
    border: bordered ? '2px dashed rgba(13,13,13,0.30)' : 'none',
    color: fg,
  }}>
    <div style={{
      fontFamily: 'ui-monospace, monospace', fontSize: 10,
      letterSpacing: '0.18em', fontWeight: 800,
      marginBottom: 6, opacity: muted ? 0.65 : 1,
    }}>▸ {title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {items.map((t, i) => (
        <div key={i} style={{
          fontSize: 12.5, fontWeight: 500, lineHeight: 1.4,
          opacity: muted ? 0.75 : 1,
        }}>
          {muted ? '✕' : '✓'} &nbsp;{t}
        </div>
      ))}
    </div>
  </div>
);

// =================================================================
// ZINE FACTORY — three comic panels
// =================================================================
const ZINE_ROOMS = [
  {
    id: 1, name: 'DRAWING ROOM', verb: 'SHAPE IT',
    state: 'done', tag: 'figure out what to build',
    color: '#E8E4FB', accent: '#7B47C4', stamp: '#C2F0D8',
    crew: [['PC', 'Product Coach'], ['CR', 'CEO Reviewer'], ['DS', 'Designer']],
    outputs: ['Idea brief', 'Project plan', 'Mockups'],
  },
  {
    id: 2, name: 'WORKSHOP', verb: 'BUILD IT',
    state: 'active', tag: 'making it real',
    color: '#FFE066', accent: '#FF3D7F', stamp: '#FF3D7F',
    crew: [['AR', 'Architect'], ['IM', 'Implementer'], ['CV', 'Code Review']],
    outputs: ['Architecture', 'Working build', 'Code review'],
  },
  {
    id: 3, name: 'SHOWROOM', verb: 'SHIP IT',
    state: 'locked', tag: 'prove · hand off',
    color: '#FFF', accent: '#0D0D0D', stamp: '#0D0D0D',
    crew: [['QA', 'QA Tester'], ['FX', 'Fix Loop'], ['RC', 'Release']],
    outputs: ['QA evidence', 'Fix summary', 'Handoff'],
  },
];

const ZineFactory = () => (
  <div style={{
    width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
    background: '#FFF8E1',
    fontFamily: '"Space Grotesk", "Inter", system-ui, sans-serif',
    color: '#0D0D0D',
  }}>
    {/* Halftone backdrop */}
    <div style={{
      position: 'absolute', inset: 0, opacity: 0.12, pointerEvents: 'none',
      backgroundImage: 'radial-gradient(#0D0D0D 1px, transparent 1px)',
      backgroundSize: '6px 6px',
    }} />

    {/* Top bar */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 24px', borderBottom: '3px solid #0D0D0D', background: '#FFF',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          padding: '4px 10px', background: '#0D0D0D', color: '#FFE066',
          fontWeight: 900, fontSize: 17, letterSpacing: '-0.02em',
          transform: 'rotate(-2deg)',
        }}>UNIVERSE™</div>
        <span style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 11, fontWeight: 600, padding: '3px 8px',
          background: '#FF3D7F', color: '#FFF',
        }}>PROJ-001 / TUTOR-MATCH</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ZineToggle mode="hands" />
        <button style={{
          padding: '6px 12px', background: '#FFF', color: '#0D0D0D',
          border: '2.5px solid #0D0D0D',
          fontSize: 11, fontWeight: 900, letterSpacing: '0.04em', cursor: 'pointer',
        }}>PAUSE ⏸</button>
        <div style={{
          width: 34, height: 34, background: '#FFE066', border: '2.5px solid #0D0D0D',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 900, fontSize: 12.5, transform: 'rotate(3deg)',
        }}>MV</div>
      </div>
    </div>

    {/* Title row */}
    <div style={{
      position: 'relative', zIndex: 2, padding: '24px 36px 18px',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
    }}>
      <div>
        <div style={{
          display: 'inline-block',
          padding: '4px 10px', background: '#0D0D0D', color: '#FFE066',
          fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 800,
          letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8,
          transform: 'rotate(-1deg)',
        }}>YOUR FACTORY · 3 ZONES</div>
        <h1 style={{
          margin: 0, fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 60, fontWeight: 700, letterSpacing: '-0.035em', lineHeight: 0.92,
        }}>
          THREE ROOMS.<br/>
          <span style={{
            background: '#FF3D7F', color: '#FFF',
            padding: '0 10px', fontStyle: 'italic',
            display: 'inline-block', transform: 'rotate(-1deg)',
          }}>WALK 'EM IN ORDER.</span>
        </h1>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
        <ZineChip bg="#C2F0D8" label="✓ 1 CLEARED" />
        <ZineChip bg="#FFE066" label="● 1 WORKING" />
        <ZineChip bg="#FFF" label="🔒 1 LOCKED" bordered />
      </div>
    </div>

    {/* Three panels */}
    <div style={{
      position: 'relative', zIndex: 2,
      padding: '0 36px 24px',
      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18,
      alignItems: 'stretch',
    }}>
      {ZINE_ROOMS.map((room, i) => <ZineRoomPanel key={room.id} room={room} index={i} />)}
    </div>

    {/* Bottom strip */}
    <div style={{
      position: 'absolute', left: 36, right: 36, bottom: 22, zIndex: 2,
      background: '#0D0D0D', color: '#FFE066',
      border: '3px solid #0D0D0D',
      padding: '14px 20px',
      display: 'flex', alignItems: 'center', gap: 16,
      transform: 'rotate(-0.3deg)',
      boxShadow: '6px 6px 0 #FF3D7F',
    }}>
      <div style={{
        width: 36, height: 36, background: '#FFE066', color: '#0D0D0D',
        fontWeight: 900, fontSize: 16,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        animation: 'zineBlink 1.4s ease-in-out infinite',
      }}>●</div>
      <div style={{ flex: 1, lineHeight: 1.3 }}>
        <div style={{
          fontFamily: 'ui-monospace, monospace', fontSize: 10,
          letterSpacing: '0.18em', fontWeight: 800, color: '#FF3D7F',
        }}>NOW PLAYING · WORKSHOP</div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>
          Implementer is wiring tutor profiles to the search →
        </div>
      </div>
      <button style={{
        padding: '10px 18px', background: '#FFE066', color: '#0D0D0D',
        border: '2.5px solid #FFE066',
        fontFamily: '"Space Grotesk", sans-serif',
        fontSize: 13, fontWeight: 900, letterSpacing: '0.04em',
        cursor: 'pointer',
      }}>ENTER WORKSHOP →</button>
    </div>

    <style>{`@keyframes zineBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
  </div>
);

const ZineChip = ({ bg, label, bordered }) => (
  <div style={{
    padding: '4px 10px',
    background: bg,
    border: '2px solid #0D0D0D',
    fontFamily: 'ui-monospace, monospace',
    fontSize: 10, fontWeight: 800, letterSpacing: '0.1em',
    color: '#0D0D0D',
  }}>{label}</div>
);

const ZineRoomPanel = ({ room, index }) => {
  const done = room.state === 'done';
  const active = room.state === 'active';
  const locked = room.state === 'locked';
  const tilts = [-0.6, 0.6, -0.4];
  return (
    <div style={{
      position: 'relative',
      background: '#FFF',
      border: '3px solid #0D0D0D',
      transform: `rotate(${tilts[index]}deg)`,
      boxShadow: active ? '8px 8px 0 #FF3D7F' : '6px 6px 0 #0D0D0D',
      display: 'flex', flexDirection: 'column',
      opacity: locked ? 0.92 : 1,
    }}>
      {/* Panel number */}
      <div style={{
        position: 'absolute', top: -16, left: 16,
        padding: '4px 12px', background: '#0D0D0D', color: '#FFE066',
        fontFamily: 'ui-monospace, monospace', fontSize: 10,
        letterSpacing: '0.18em', fontWeight: 800,
      }}>PANEL · 0{room.id}</div>

      {/* Stamp */}
      <div style={{
        position: 'absolute', top: -14, right: -10,
        padding: '4px 10px',
        background: done ? '#C2F0D8' : active ? '#FF3D7F' : '#FFF',
        color: done ? '#0D0D0D' : active ? '#FFF' : 'rgba(13,13,13,0.6)',
        border: '3px solid #0D0D0D',
        fontFamily: '"Space Grotesk", sans-serif',
        fontWeight: 900, fontSize: 11, letterSpacing: '0.06em',
        transform: 'rotate(6deg)',
      }}>
        {done ? '✓ DONE' : active ? '● NOW' : '🔒 NEXT'}
      </div>

      {/* Illustration */}
      <div style={{
        background: room.color, padding: '34px 18px 18px',
        borderBottom: '3px solid #0D0D0D', position: 'relative',
      }}>
        <ZineRoomGlyph room={room} />
      </div>

      {/* Body */}
      <div style={{ padding: '14px 18px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <h2 style={{
          margin: 0, fontFamily: '"Space Grotesk", sans-serif',
          fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 0.95,
        }}>
          {room.name}
        </h2>
        <div style={{
          marginTop: 4, fontSize: 13, color: 'rgba(13,13,13,0.65)',
          fontStyle: 'italic',
        }}>
          {room.tag}
        </div>

        {/* VERB stamp */}
        <div style={{
          marginTop: 12,
          padding: '5px 10px',
          background: active ? '#0D0D0D' : '#FFE066',
          color: active ? '#FFE066' : '#0D0D0D',
          fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 800,
          letterSpacing: '0.18em',
          alignSelf: 'flex-start',
          transform: 'rotate(-1.5deg)',
        }}>▸ {room.verb}</div>

        {/* Crew */}
        <div style={{
          marginTop: 14, paddingTop: 12, borderTop: '2px dashed rgba(13,13,13,0.25)',
        }}>
          <div style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 9.5,
            letterSpacing: '0.16em', fontWeight: 800,
            color: 'rgba(13,13,13,0.65)', marginBottom: 8,
          }}>CREW ✦</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: locked ? 0.55 : 1 }}>
            {room.crew.map(([initials, name]) => (
              <div key={initials} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 22, height: 22, background: '#FFE066',
                  border: '2px solid #0D0D0D',
                  fontSize: 10, fontWeight: 900,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>{initials}</span>
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Outputs */}
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: '2px dashed rgba(13,13,13,0.25)',
        }}>
          <div style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 9.5,
            letterSpacing: '0.16em', fontWeight: 800,
            color: 'rgba(13,13,13,0.65)', marginBottom: 6,
          }}>{done ? 'LOOT' : "YOU'LL GET"}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {room.outputs.map(o => (
              <span key={o} style={{
                padding: '2px 7px',
                background: done ? '#C2F0D8' : '#FFF',
                border: '2px solid #0D0D0D',
                fontSize: 10.5, fontWeight: 700,
              }}>{done && '✓ '}{o}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const ZineRoomGlyph = ({ room }) => {
  const done = room.state === 'done';
  const active = room.state === 'active';
  const locked = room.state === 'locked';
  return (
    <svg viewBox="0 0 220 130" style={{ width: '100%', height: 130, display: 'block' }}>
      {/* big number behind */}
      <text x="110" y="100" textAnchor="middle"
        fontFamily="Space Grotesk, sans-serif"
        fontSize="120" fontWeight="900"
        fill={room.accent} opacity="0.18"
        letterSpacing="-0.04em"
      >0{room.id}</text>

      {/* Building/structure */}
      {locked ? (
        // locked: small lock icon + curtain
        <g>
          <rect x="85" y="50" width="50" height="62" fill="#FFF" stroke="#0D0D0D" strokeWidth="3" />
          <path d="M85 60 L135 60 M85 70 L135 70 M85 80 L135 80 M85 90 L135 90 M85 100 L135 100" stroke="#0D0D0D" strokeWidth="2" opacity="0.4" />
          <rect x="100" y="82" width="20" height="18" fill="#0D0D0D" />
          <path d="M104 82 V76 a6 6 0 0 1 12 0 V82" fill="none" stroke="#0D0D0D" strokeWidth="3" />
        </g>
      ) : (
        <g>
          {/* Big shape */}
          <path d="M50 110 L50 60 L110 30 L170 60 L170 110 Z"
            fill="#FFF" stroke="#0D0D0D" strokeWidth="3" strokeLinejoin="round" />
          {/* Door */}
          <rect x="95" y="78" width="30" height="32" fill={done ? '#C2F0D8' : '#FF3D7F'} stroke="#0D0D0D" strokeWidth="3" />
          <circle cx="118" cy="94" r="1.5" fill="#0D0D0D" />
          {/* Window L */}
          <rect x="62" y="68" width="20" height="20" fill={active ? '#FFE066' : '#FFF'} stroke="#0D0D0D" strokeWidth="2.5" />
          <path d="M72 68 V88 M62 78 H82" stroke="#0D0D0D" strokeWidth="2" />
          {/* Window R */}
          <rect x="138" y="68" width="20" height="20" fill={active ? '#FFE066' : '#FFF'} stroke="#0D0D0D" strokeWidth="2.5" />
          <path d="M148 68 V88 M138 78 H158" stroke="#0D0D0D" strokeWidth="2" />
          {/* Smoke */}
          {active && (
            <g>
              <circle cx="148" cy="40" r="6" fill="#FFF" stroke="#0D0D0D" strokeWidth="2" />
              <circle cx="158" cy="30" r="4" fill="#FFF" stroke="#0D0D0D" strokeWidth="2" />
              <circle cx="166" cy="22" r="3" fill="#FFF" stroke="#0D0D0D" strokeWidth="2" />
            </g>
          )}
          {/* Sun/star */}
          {done && (
            <path d="M180 35 L184 45 L194 49 L184 53 L180 63 L176 53 L166 49 L176 45 Z" fill="#FFE066" stroke="#0D0D0D" strokeWidth="2.5" strokeLinejoin="round" />
          )}
        </g>
      )}
    </svg>
  );
};

Object.assign(window, { ZineModePicker, ZineFactory });
