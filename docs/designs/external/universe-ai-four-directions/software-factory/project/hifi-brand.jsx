// Hi-fi · Brand & system showcase — cover artboard

const HiBrand = () => (
  <div className="uf u-cosmic-bg" style={{ width: '100%', height: '100%', padding: '56px 64px', overflow: 'hidden', position: 'relative' }}>
    <UStars density={50} />

    {/* Top row — wordmark + meta */}
    <div className="u-row u-between u-items-start" style={{ marginBottom: 40 }}>
      <UWordmark size={20} />
      <div className="u-col" style={{ alignItems: 'flex-end' }}>
        <span className="u-eyebrow">Hi-fi · Round 1</span>
        <span style={{ fontSize: 13, color: 'var(--u-ink-3)', marginTop: 4 }}>
          {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
        </span>
      </div>
    </div>

    {/* Hero */}
    <div className="u-col u-gap-4" style={{ maxWidth: 760, position: 'relative', zIndex: 1 }}>
      <span className="u-pill brand"><span className="u-dot brand" /> The Universe AI design language</span>
      <h1 className="u-display" style={{ margin: 0, fontSize: 92, color: 'var(--u-ink)' }}>
        Build <em>anything</em> in<br/> the universe.
      </h1>
      <p className="u-body" style={{ fontSize: 18, maxWidth: 540, color: 'var(--u-ink-2)' }}>
        A consumer-friendly software factory that turns an idea into a working app —
        without showing users the machinery, unless they want to look.
      </p>
    </div>

    {/* System grid */}
    <div style={{
      position: 'absolute', left: 64, right: 64, bottom: 56,
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18,
    }}>
      {/* Palette */}
      <div className="u-card" style={{ padding: 18 }}>
        <span className="u-eyebrow">Palette</span>
        <div className="u-row u-gap-2" style={{ marginTop: 12, marginBottom: 8 }}>
          {[
            ['var(--u-ink)', '#0F1629'],
            ['var(--u-brand)', '#4B3FBB'],
            ['var(--u-amber)', '#F0A03C'],
            ['var(--u-sage)', '#3F8568'],
            ['var(--u-terra)', '#C75B41'],
          ].map(([c, hex]) => (
            <div key={hex} style={{
              width: 36, height: 52, borderRadius: 'var(--u-r-sm)',
              background: c, position: 'relative',
              boxShadow: 'var(--u-shadow-1)',
            }}>
              <span style={{
                position: 'absolute', bottom: -16, left: 0, right: 0,
                fontFamily: 'var(--u-mono)', fontSize: 9, color: 'var(--u-ink-3)',
                textAlign: 'center',
              }}>{hex.slice(1)}</span>
            </div>
          ))}
        </div>
        <div style={{ height: 18 }} />
        <div style={{ fontSize: 12, color: 'var(--u-ink-3)', lineHeight: 1.45, marginTop: 8 }}>
          Warm paper, deep ink, cosmic indigo brand. Amber for activity, sage for safe.
        </div>
      </div>

      {/* Type */}
      <div className="u-card" style={{ padding: 18 }}>
        <span className="u-eyebrow">Typography</span>
        <div className="u-col u-gap-2" style={{ marginTop: 12 }}>
          <div style={{ fontFamily: 'var(--u-display)', fontSize: 30, lineHeight: 0.95 }}>
            Instrument <em style={{ color: 'var(--u-brand)' }}>Serif</em>
          </div>
          <div style={{ fontFamily: 'var(--u-sans)', fontSize: 14, fontWeight: 600 }}>
            Inter — body & UI
          </div>
          <div style={{ fontFamily: 'var(--u-mono)', fontSize: 11, color: 'var(--u-ink-3)' }}>
            JETBRAINS MONO · LABELS
          </div>
        </div>
      </div>

      {/* Components */}
      <div className="u-card" style={{ padding: 18 }}>
        <span className="u-eyebrow">Components</span>
        <div className="u-col u-gap-3" style={{ marginTop: 12 }}>
          <div className="u-row u-gap-2">
            <button className="u-btn brand sm">Start project</button>
            <button className="u-btn ghost sm">Cancel</button>
          </div>
          <div className="u-row u-gap-2">
            <span className="u-pill sage dot">Approved</span>
            <span className="u-pill amber dot">Working</span>
          </div>
          <UModeToggle mode="easy" size="sm" />
        </div>
      </div>

      {/* Mascot */}
      <div className="u-card brand-soft" style={{ padding: 18, position: 'relative', overflow: 'hidden' }}>
        <UStars density={20} />
        <span className="u-eyebrow" style={{ color: 'var(--u-brand-deep)' }}>Mascot</span>
        <div className="u-row u-items-center u-gap-3" style={{ marginTop: 16 }}>
          <UOrb size={56} busy />
          <div className="u-col" style={{ lineHeight: 1.2 }}>
            <span style={{ fontFamily: 'var(--u-display)', fontSize: 24, color: 'var(--u-brand-deep)' }}>
              Universe
            </span>
            <span style={{ fontSize: 11, color: 'var(--u-ink-3)' }}>pulses when working</span>
          </div>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, { HiBrand });
