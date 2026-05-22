// Atelier — ink on warm paper, terracotta accent
// Instrument Serif moments · Inter UI · JetBrains Mono small-caps labels
// Calm everyday surface; gets serious at gates via hairline rules + accent
// ─────────────────────────────────────────────────────────────

const A = {
  paper: '#EEE7D7',
  card: '#F7F1E2',
  cardEdge: '#1A1714',
  ink: '#1A1714',
  subtle: '#6B6356',
  faint: '#B5AB97',
  hair: '#D9CFB8',
  terra: '#B43F26',
  terraDim: '#E4D2C8',
  ochre: '#B5870F',
  sage: '#5C7A4E',
};

const aFont = {
  voice: { fontFamily: "'Instrument Serif', Georgia, serif", fontWeight: 400 },
  display: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 500, letterSpacing: '-0.02em' },
  ui: { fontFamily: "'Inter', system-ui, sans-serif" },
  mono: { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};

const aSmallCaps = {
  ...aFont.mono,
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

// ── Atomic primitives ────────────────────────────────────────
const AHair = ({ vertical, color = A.cardEdge, opacity = 1, style = {} }) => (
  <div style={{ background: color, opacity, ...(vertical ? { width: 1, alignSelf: 'stretch' } : { height: 1, width: '100%' }), ...style }} />
);

const APage = ({ children, style = {} }) => (
  <div style={{
    width: '100%', height: '100%', background: A.paper, color: A.ink,
    backgroundImage: 'radial-gradient(rgba(26,23,20,0.035) 1px, transparent 1.6px)',
    backgroundSize: '18px 18px',
    ...aFont.ui, fontSize: 14, lineHeight: 1.5,
    display: 'flex', flexDirection: 'column',
    ...style
  }}>{children}</div>
);

const ATopBar = ({ project, mode }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '20px 36px 18px', borderBottom: `1px solid ${A.cardEdge}` }}>
    <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
      <span style={{ ...aSmallCaps, color: A.subtle }}>Universe</span>
      <span style={{ ...aSmallCaps, color: A.faint }}>/</span>
      <span style={{ ...aSmallCaps, color: A.ink }}>{project}</span>
    </div>
    {mode && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ ...aSmallCaps, color: A.subtle }}>Mode</span>
        <div style={{ display: 'flex', border: `1px solid ${A.cardEdge}`, borderRadius: 999, overflow: 'hidden' }}>
          <span style={{ ...aSmallCaps, padding: '6px 14px', background: mode === 'easy' ? A.ink : 'transparent', color: mode === 'easy' ? A.paper : A.ink }}>Easy</span>
          <span style={{ ...aSmallCaps, padding: '6px 14px', background: mode === 'hands' ? A.ink : 'transparent', color: mode === 'hands' ? A.paper : A.ink }}>Hands-on</span>
        </div>
      </div>
    )}
  </div>
);

// ── Screen 1: Mode picker ────────────────────────────────────
function AtelierMode() {
  const Card = ({ num, kind, title, tag, body, bullets, accent }) => (
    <div style={{
      flex: 1, background: A.card, border: `1px solid ${A.cardEdge}`,
      padding: '28px 30px 30px', display: 'flex', flexDirection: 'column', gap: 18,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ ...aSmallCaps, color: A.subtle }}>Option {num}</span>
        <span style={{ ...aSmallCaps, color: accent }}>{kind}</span>
      </div>

      {/* Ornament block */}
      <div style={{ height: 88, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: `1px solid ${A.hair}`, borderBottom: `1px solid ${A.hair}`, padding: '0 0' }}>
        {num === '01' ? (
          <svg width="180" height="64" viewBox="0 0 180 64">
            <circle cx="90" cy="32" r="22" fill="none" stroke={A.ink} strokeWidth="1.2" />
            <path d="M 50 32 Q 90 8 130 32" fill="none" stroke={A.terra} strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="90" cy="32" r="2.5" fill={A.terra} />
          </svg>
        ) : (
          <svg width="180" height="64" viewBox="0 0 180 64">
            <g stroke={A.ink} strokeWidth="1.2" fill="none">
              <rect x="60" y="14" width="60" height="36" />
              <line x1="60" y1="22" x2="120" y2="22" />
              <line x1="60" y1="30" x2="120" y2="30" />
              <line x1="60" y1="38" x2="120" y2="38" />
              <line x1="80" y1="14" x2="80" y2="50" />
              <line x1="100" y1="14" x2="100" y2="50" />
            </g>
            <circle cx="100" cy="30" r="3" fill={A.terra} />
          </svg>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 56, lineHeight: 1, color: A.ink }}>{title}</div>
        <div style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 18, color: A.subtle, lineHeight: 1.4 }}>{tag}</div>
      </div>

      <div style={{ fontSize: 14.5, color: A.ink, lineHeight: 1.55, maxWidth: 380 }}>{body}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <span style={{ ...aFont.mono, fontSize: 11, color: A.faint, minWidth: 22 }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{ fontSize: 13.5, color: A.ink, lineHeight: 1.55 }}>{b}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${A.hair}`, paddingTop: 16 }}>
        <span style={{ ...aSmallCaps, color: A.subtle }}>Gate cadence</span>
        <span style={{ ...aFont.mono, fontSize: 12, color: A.ink }}>{num === '01' ? '~3 / project' : '~14 / project'}</span>
      </div>

      <button style={{
        marginTop: 4, padding: '12px 18px', background: num === '01' ? A.ink : 'transparent',
        color: num === '01' ? A.paper : A.ink, border: `1px solid ${A.cardEdge}`,
        ...aSmallCaps, fontSize: 11, cursor: 'pointer'
      }}>
        Drive in {num === '01' ? 'Easy Mode' : 'Hands-on Mode'} →
      </button>
    </div>
  );

  return (
    <APage>
      <ATopBar project="Astra — Billing portal for solar installers" />
      <div style={{ flex: 1, padding: '40px 60px 56px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 }}>
          <span style={{ ...aSmallCaps, color: A.terra }}>Project start · one-time decision</span>
          <h1 style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 64, lineHeight: 1.05, margin: 0, color: A.ink }}>
            How would you like to drive this?
          </h1>
          <p style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 19, color: A.subtle, margin: 0, maxWidth: 640, lineHeight: 1.45 }}>
            Two ways to ship Astra. Both end at the same place — a working billing portal you trust. You can switch tracks any time from the top bar.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 28, flex: 1 }}>
          <Card num="01" kind="Concierge" title="Easy" tag="Universe drives. You sign off on the things only you can decide."
            body="The factory runs in the background. You'll see what's happening, but you won't be pulled in unless something needs a human call — naming, payment provider, brand voice."
            bullets={[
              'Universe picks defaults and explains them in plain English.',
              'You answer ~3 questions across the whole project.',
              'A simple project radio shows you what just happened.',
            ]}
            accent={A.terra}
          />
          <Card num="02" kind="Cockpit" title="Hands-on" tag="The whole factory floor, all three bays, every crew."
            body="You enter the cockpit. Phases, personas, artifacts, logs, diffs — all exposed. You approve at every gate, and you can interrupt the crew at any moment."
            bullets={[
              'Three bays open: Shape it, Build it, Ship it.',
              'You sign off on each phase before the next begins.',
              'Full audit trail, persona attribution, browser QA evidence.',
            ]}
            accent={A.sage}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: `1px solid ${A.hair}`, paddingTop: 14 }}>
          <span style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 16, color: A.subtle }}>
            Not sure? Most non-technical founders start in Easy and stay there.
          </span>
          <span style={{ ...aSmallCaps, color: A.faint }}>Astra · Rev 01</span>
        </div>
      </div>
    </APage>
  );
}

// ── Screen 2: Easy Mode in-flight ────────────────────────────
function AtelierEasy() {
  const Activity = ({ tag, text, when, persona }) => (
    <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', padding: '14px 0', borderTop: `1px solid ${A.hair}` }}>
      <span style={{ ...aFont.mono, fontSize: 10, color: A.faint, minWidth: 64 }}>{when}</span>
      <span style={{ ...aSmallCaps, color: A.subtle, minWidth: 56 }}>{tag}</span>
      <span style={{ fontSize: 14, color: A.ink, lineHeight: 1.5, flex: 1 }}>{text}</span>
      <span style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 13, color: A.subtle }}>{persona}</span>
    </div>
  );

  return (
    <APage>
      <ATopBar project="Astra — Billing portal" mode="easy" />

      <div style={{ flex: 1, padding: '32px 60px 40px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Hero card */}
        <div style={{ background: A.card, border: `1px solid ${A.cardEdge}`, padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ ...aSmallCaps, color: A.terra }}>● Right now — building</span>
            <span style={{ ...aSmallCaps, color: A.subtle }}>Started 4 min ago · Bay 02 · Build it</span>
          </div>
          <div style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 44, lineHeight: 1.1, color: A.ink, maxWidth: 900 }}>
            Universe is wiring up your invoice line-item table — the part that itemizes each panel, inverter and labor hour for the homeowner.
          </div>
          {/* Subtle progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1, height: 1, background: A.hair, position: 'relative' }}>
              <div style={{ position: 'absolute', left: 0, top: -1, height: 3, width: '62%', background: A.ink }} />
            </div>
            <span style={{ ...aFont.mono, fontSize: 11, color: A.subtle }}>62% of this step</span>
          </div>
        </div>

        {/* Two columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, flex: 1 }}>
          {/* Recent */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 12 }}>
              <span style={{ ...aSmallCaps, color: A.ink }}>What just happened</span>
              <span style={{ ...aSmallCaps, color: A.faint }}>last 30 min</span>
            </div>
            <Activity when="11:42" tag="Build" text="Scaffolded /invoices route and the InvoiceTable React component." persona="— Builder" />
            <Activity when="11:28" tag="Test" text="Wrote 6 unit tests for line-item math; all passing." persona="— Inspector" />
            <Activity when="11:14" tag="Shape" text="Locked the data model: Invoice → LineItem → Adjustment." persona="— Architect" />
          </div>

          {/* Waiting */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: 12 }}>
              <span style={{ ...aSmallCaps, color: A.terra }}>● Waiting on you</span>
              <span style={{ ...aFont.mono, fontSize: 11, color: A.subtle }}>1 decision</span>
            </div>

            <div style={{ background: A.card, border: `1px solid ${A.cardEdge}`, borderLeft: `4px solid ${A.terra}`, padding: '22px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <span style={{ ...aSmallCaps, color: A.terra }}>Decision · payment processing</span>
              <div style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 24, lineHeight: 1.2, color: A.ink }}>
                Stripe Invoicing, or build the invoice generator in-house?
              </div>
              <p style={{ fontSize: 13.5, color: A.subtle, margin: 0, lineHeight: 1.55 }}>
                Stripe is faster to ship and handles tax + reminders. In-house keeps you off third-party fees (~0.5% + 30¢) and lets you brand the PDFs. Universe leans Stripe for v1.
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button style={{ flex: 1, padding: '12px 16px', background: A.ink, color: A.paper, border: `1px solid ${A.cardEdge}`, ...aSmallCaps, fontSize: 11, cursor: 'pointer' }}>Use Stripe Invoicing →</button>
                <button style={{ flex: 1, padding: '12px 16px', background: 'transparent', color: A.ink, border: `1px solid ${A.cardEdge}`, ...aSmallCaps, fontSize: 11, cursor: 'pointer' }}>Build in-house</button>
              </div>
              <a style={{ ...aSmallCaps, fontSize: 10, color: A.subtle, marginTop: 4 }}>Read the trade-off note →</a>
            </div>

            <div style={{ marginTop: 18 }}>
              <span style={{ ...aSmallCaps, color: A.subtle, display: 'block', paddingBottom: 10 }}>Up next · queued</span>
              <div style={{ borderTop: `1px solid ${A.hair}`, padding: '12px 0', display: 'flex', justifyContent: 'space-between', opacity: 0.55 }}>
                <span style={{ fontSize: 13.5 }}>Email receipt template + tax line</span>
                <span style={{ ...aFont.mono, fontSize: 11, color: A.faint }}>BUILD</span>
              </div>
              <div style={{ borderTop: `1px solid ${A.hair}`, padding: '12px 0', display: 'flex', justifyContent: 'space-between', opacity: 0.4 }}>
                <span style={{ fontSize: 13.5 }}>Browser QA pass on /invoices</span>
                <span style={{ ...aFont.mono, fontSize: 11, color: A.faint }}>TEST</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </APage>
  );
}

// ── Screen 3: Factory three-bay ──────────────────────────────
function AtelierFactory() {
  const Crew = ({ names }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {names.map((n, i) => (
        <span key={i} style={{ ...aFont.mono, fontSize: 10, padding: '3px 8px', border: `1px solid ${A.hair}`, color: A.subtle, letterSpacing: '0.05em' }}>{n}</span>
      ))}
    </div>
  );

  const Bay = ({ num, name, status, focus, crew, children, accent, dim }) => (
    <div style={{
      flex: status === 'active' ? 1.35 : 1,
      background: A.card, border: `1px solid ${A.cardEdge}`,
      padding: '24px 26px 26px', display: 'flex', flexDirection: 'column', gap: 16,
      opacity: dim ? 0.55 : 1, position: 'relative'
    }}>
      {/* Lintel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
        <div style={{ height: 1, background: A.cardEdge }} />
        <div style={{ height: 1, background: A.cardEdge }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ ...aSmallCaps, color: A.subtle }}>Bay {num}</span>
        <span style={{ ...aSmallCaps, color: accent }}>{status === 'done' ? '✓ Complete' : status === 'active' ? '● Active' : '⌂ Locked'}</span>
      </div>

      <div style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 40, lineHeight: 1, color: A.ink }}>{name}</div>

      <div style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 16, color: A.subtle, lineHeight: 1.4, minHeight: 44 }}>
        {focus}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ ...aSmallCaps, color: A.faint }}>Crew</span>
        <Crew names={crew} />
      </div>

      <div style={{ flex: 1 }} />
      {children}
    </div>
  );

  return (
    <APage>
      <ATopBar project="Astra — Billing portal" mode="hands" />

      <div style={{ padding: '32px 60px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <span style={{ ...aSmallCaps, color: A.terra }}>The factory · all three bays</span>
          <h1 style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 52, margin: '6px 0 0', lineHeight: 1, color: A.ink }}>
            Astra is on the floor in Bay 02.
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
          <span style={{ ...aSmallCaps, color: A.subtle }}>Started 3 days ago</span>
          <span style={{ ...aSmallCaps, color: A.subtle }}>·</span>
          <span style={{ ...aSmallCaps, color: A.subtle }}>ETA ~ Fri</span>
        </div>
      </div>

      <div style={{ flex: 1, padding: '20px 60px 56px', display: 'flex', gap: 24 }}>
        <Bay num="01" name="Shape it" status="done" accent={A.sage}
          focus="Idea brief signed off. Data model and scope locked."
          crew={['Architect', 'Brief writer', 'Researcher']}>
          <div style={{ borderTop: `1px solid ${A.hair}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <a style={{ ...aSmallCaps, fontSize: 10, color: A.ink }}>📄  Idea brief.pdf · Rev 03</a>
            <a style={{ ...aSmallCaps, fontSize: 10, color: A.ink }}>📄  Data model.sketch</a>
            <a style={{ ...aSmallCaps, fontSize: 10, color: A.ink }}>📄  Scope decisions (4)</a>
          </div>
        </Bay>

        <Bay num="02" name="Build it" status="active" accent={A.terra}
          focus="Wiring up the invoice line-item table. 4 of 7 components done."
          crew={['Architect', 'Builder', 'Inspector', 'Documentarian']}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ ...aSmallCaps, color: A.faint }}>Phase progress</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { k: 'Scaffold', s: 'done' },
                { k: 'Wire data', s: 'done' },
                { k: 'Components', s: 'active' },
                { k: 'Integrate', s: 'next' },
                { k: 'QA pass', s: 'next' },
              ].map(p => (
                <div key={p.k} style={{
                  flex: 1, padding: '8px 10px', textAlign: 'center',
                  ...aSmallCaps, fontSize: 9,
                  border: `1px solid ${p.s === 'active' ? A.terra : A.hair}`,
                  background: p.s === 'done' ? A.ink : p.s === 'active' ? A.terraDim : 'transparent',
                  color: p.s === 'done' ? A.paper : p.s === 'active' ? A.terra : A.subtle,
                }}>{p.k}</div>
              ))}
            </div>
          </div>

          <div style={{ background: A.paper, border: `1px solid ${A.terra}`, borderLeft: `4px solid ${A.terra}`, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...aSmallCaps, color: A.terra }}>● 1 decision waiting on you</span>
            <span style={{ ...aFont.voice, fontStyle: 'italic', fontSize: 18, color: A.ink, lineHeight: 1.2 }}>Stripe Invoicing, or build the generator in-house?</span>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button style={{ padding: '8px 14px', background: A.ink, color: A.paper, border: 'none', ...aSmallCaps, fontSize: 10, cursor: 'pointer' }}>Decide →</button>
              <button style={{ padding: '8px 14px', background: 'transparent', color: A.ink, border: `1px solid ${A.cardEdge}`, ...aSmallCaps, fontSize: 10, cursor: 'pointer' }}>Defer 1 hr</button>
            </div>
          </div>
        </Bay>

        <Bay num="03" name="Ship it" status="locked" accent={A.faint} dim
          focus="Curtain stays down until Build it passes browser QA."
          crew={['Packager', 'Release writer', 'Watchman']}>
          <div style={{ borderTop: `1px solid ${A.hair}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: A.subtle, fontStyle: 'italic', ...aFont.voice }}>
            <span>Will unlock when:</span>
            <span>— Bay 02 closes its QA gate</span>
            <span>— You sign off on the readiness checklist</span>
          </div>
        </Bay>
      </div>
    </APage>
  );
}

Object.assign(window, { AtelierMode, AtelierEasy, AtelierFactory });
