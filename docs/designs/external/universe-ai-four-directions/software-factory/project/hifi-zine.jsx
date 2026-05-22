// Direction C — MAXIMALIST ZINE
// Brutalist sans, hot color blocks, off-kilter stamps & stickers, "sticker on your laptop" energy.

const ZineEasy = () => (
  <div style={{
    width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
    background: '#FFF8E1',
    fontFamily: '"Space Grotesk", "Inter", system-ui, sans-serif',
    color: '#0D0D0D',
  }}>
    {/* Halftone backdrop */}
    <div style={{
      position: 'absolute', inset: 0, opacity: 0.15, pointerEvents: 'none',
      backgroundImage: 'radial-gradient(#0D0D0D 1px, transparent 1px)',
      backgroundSize: '6px 6px',
    }} />

    {/* Top bar - aggressive */}
    <div style={{
      position: 'relative', zIndex: 2,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 24px',
      borderBottom: '3px solid #0D0D0D',
      background: '#FFF',
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
        }}>
          PROJ-001 / TUTOR-MATCH
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ZineToggle mode="easy" />
        <button style={zBtn('outline')}>PAUSE ⏸</button>
        <div style={{
          width: 34, height: 34, background: '#FFE066', border: '2.5px solid #0D0D0D',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 900, fontSize: 12.5, transform: 'rotate(3deg)',
        }}>MV</div>
      </div>
    </div>

    <div style={{
      position: 'relative', zIndex: 2,
      padding: '32px 48px', display: 'grid',
      gridTemplateColumns: '1.5fr 1fr', gap: 24,
    }}>
      {/* LEFT — giant headline */}
      <div>
        {/* Sticker label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 12px',
            background: '#FF3D7F', color: '#FFF',
            border: '2.5px solid #0D0D0D',
            fontWeight: 900, fontSize: 11, letterSpacing: '0.06em',
            transform: 'rotate(-3deg)',
            boxShadow: '3px 3px 0 #0D0D0D',
          }}>
            ● LIVE · COOKING
          </div>
          <div style={{
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            fontSize: 11, color: 'rgba(13,13,13,0.55)',
          }}>02:47 PM · 16 MAY</div>
        </div>

        <h1 style={{
          margin: 0,
          fontFamily: '"Space Grotesk", sans-serif',
          fontWeight: 700, fontSize: 92, lineHeight: 0.88,
          letterSpacing: '-0.04em',
        }}>
          I'M<br/>
          <span style={{
            display: 'inline-block',
            background: '#0D0D0D', color: '#C2F0D8',
            padding: '0 14px', fontStyle: 'italic',
            transform: 'rotate(-1deg)',
            margin: '4px 0',
          }}>BUILDING</span><br/>
          YOUR<br/>
          <span style={{
            display: 'inline-block',
            background: '#FFE066',
            padding: '0 14px',
            transform: 'rotate(0.6deg)',
            position: 'relative',
          }}>
            TUTOR APP
            <span style={{
              position: 'absolute', top: -10, right: -28,
              fontSize: 38, transform: 'rotate(15deg)',
            }}>!</span>
          </span>
        </h1>

        <div style={{
          marginTop: 22, fontSize: 18, fontWeight: 500, maxWidth: 480,
          color: 'rgba(13,13,13,0.75)',
        }}>
          go do <em style={{ background: '#FFE066', fontStyle: 'normal', padding: '0 6px' }}>literally anything else.</em> i'll text in <strong>~25 min</strong>.
        </div>

        {/* Stamp progress */}
        <div style={{ marginTop: 28 }}>
          <div style={{
            display: 'inline-block', padding: '4px 10px',
            background: '#0D0D0D', color: '#FFF',
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
            marginBottom: 12,
          }}>
            STAGES ▸ 4 / 9
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            {Array.from({ length: 9 }, (_, i) => {
              const done = i < 4, now = i === 4;
              return (
                <div key={i} style={{
                  flex: 1, height: 28,
                  background: done ? '#0D0D0D' : now ? '#FF3D7F' : '#FFF',
                  border: '2.5px solid #0D0D0D',
                  position: 'relative',
                }}>
                  {now && (
                    <div style={{
                      position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%) rotate(-4deg)',
                      background: '#FFE066', border: '2px solid #0D0D0D',
                      padding: '1px 6px', fontSize: 9, fontWeight: 900,
                      whiteSpace: 'nowrap',
                    }}>NOW →</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* RIGHT — sticker stack */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* All clear sticker */}
        <div style={{
          background: '#C2F0D8',
          border: '3px solid #0D0D0D',
          padding: '20px 22px',
          transform: 'rotate(1.4deg)',
          boxShadow: '6px 6px 0 #0D0D0D',
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute', top: -16, right: -10,
            background: '#0D0D0D', color: '#C2F0D8',
            border: '3px solid #0D0D0D',
            padding: '4px 10px', fontWeight: 900, fontSize: 10,
            transform: 'rotate(8deg)',
          }}>NEW ✦</div>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
            ALL CLEAR
          </div>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
            zero things <br/>need you.
          </div>
          <div style={{ fontSize: 12, marginTop: 8, color: 'rgba(13,13,13,0.6)' }}>
            ↳ last decision 38m ago — pricing
          </div>
        </div>

        {/* Handled feed */}
        <div style={{
          background: '#FFF',
          border: '3px solid #0D0D0D',
          padding: '18px 20px',
          transform: 'rotate(-0.8deg)',
          boxShadow: '6px 6px 0 #0D0D0D',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10, paddingBottom: 8, borderBottom: '2px solid #0D0D0D',
          }}>
            <div style={{ fontWeight: 900, fontSize: 13, letterSpacing: '0.04em' }}>
              I HANDLED ✦
            </div>
            <div style={{
              background: '#0D0D0D', color: '#FFE066',
              padding: '2px 8px', fontSize: 10, fontWeight: 900,
            }}>4 / LAST 2H</div>
          </div>
          {[
            ['UI framework', 'TAILWIND + RADIX', '#E8E4FB'],
            ['Search name', 'TUTORFINDER', '#FFD9B0'],
            ['Tutor loading', 'PAGES OF 20', '#C2F0D8'],
            ['Empty state copy', '"NO TUTORS YET..."', '#FFE066'],
          ].map(([k, v, color], i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 0',
              borderBottom: i < 3 ? '1px dashed rgba(13,13,13,0.2)' : 'none',
            }}>
              <span style={{
                fontSize: 14, fontWeight: 900, color: '#0D0D0D',
                width: 16, textAlign: 'center', flexShrink: 0,
              }}>✓</span>
              <span style={{ flex: 1, fontSize: 13, lineHeight: 1.3 }}>
                {k} <span style={{
                  background: color, padding: '0 5px', fontWeight: 800, fontSize: 11.5,
                  display: 'inline-block', marginLeft: 4,
                }}>{v}</span>
              </span>
              <span style={{
                fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
                fontSize: 9.5, fontWeight: 700, color: 'rgba(13,13,13,0.5)',
                letterSpacing: '0.06em',
              }}>UNDO</span>
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Corner stamp */}
    <div style={{
      position: 'absolute', bottom: 24, right: 32,
      transform: 'rotate(-12deg)',
      padding: '10px 18px',
      border: '3px double #0D0D0D',
      color: '#0D0D0D',
      fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
      fontSize: 11, fontWeight: 700, letterSpacing: '0.16em',
      opacity: 0.7,
    }}>
      MADE IN<br/>THE UNIVERSE™
    </div>
  </div>
);

const zBtn = (variant) => ({
  padding: '6px 12px',
  background: variant === 'outline' ? '#FFF' : '#0D0D0D',
  color: variant === 'outline' ? '#0D0D0D' : '#FFF',
  border: '2.5px solid #0D0D0D',
  fontSize: 11, fontWeight: 900, letterSpacing: '0.04em',
  cursor: 'pointer',
});

const ZineToggle = ({ mode }) => (
  <div style={{ display: 'inline-flex', border: '2.5px solid #0D0D0D' }}>
    {[['easy', 'EASY ✦'], ['hands', 'HANDS-ON 🔧']].map(([k, label], i) => (
      <div key={k} style={{
        padding: '6px 12px', fontSize: 11, fontWeight: 900,
        letterSpacing: '0.06em',
        background: mode === k ? '#0D0D0D' : '#FFF',
        color: mode === k ? '#FFE066' : '#0D0D0D',
        borderRight: i === 0 ? '2.5px solid #0D0D0D' : 'none',
      }}>{label}</div>
    ))}
  </div>
);

Object.assign(window, { ZineEasy });
