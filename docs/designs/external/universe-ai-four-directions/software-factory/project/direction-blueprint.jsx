// Workshop Blueprint — drafting table, not factory floor
// Drafting cream + blueprint blue + technical pen black
// Construction marks, dimension lines, revision stamps, title blocks
// ─────────────────────────────────────────────────────────────

const B = {
  cream: '#EDE6D3',
  paper: '#FAF6EB',
  ink: '#16161A',
  subtle: '#5A5A5E',
  faint: '#8F8C82',
  grid: 'rgba(11,61,145,0.07)',
  hair: '#C9C2AD',
  blue: '#0B3D91',
  blueLight: '#1F5BC9',
  blueWash: '#D9E2F4',
  stamp: '#B72424',
  approve: '#1F6F3F',
};

const bFont = {
  ui: { fontFamily: "'Inter', system-ui, sans-serif" },
  mono: { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
  display: { fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 700, letterSpacing: '-0.02em' },
};

const bCaps = {
  ...bFont.mono,
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  fontWeight: 500,
};

// Corner crosshair brackets (drafting marks)
const Brackets = ({ size = 12, color = B.ink, thickness = 1.5 }) => (
  <>
    {[
      { top: -1, left: -1, borderTop: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` },
      { top: -1, right: -1, borderTop: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` },
      { bottom: -1, left: -1, borderBottom: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` },
      { bottom: -1, right: -1, borderBottom: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` },
    ].map((s, i) => <div key={i} style={{ position: 'absolute', width: size, height: size, ...s, pointerEvents: 'none' }} />)}
  </>
);

// Title block — drafting sheet corner
const TitleBlock = ({ sheet, rev, title, scale, status, statusColor = B.blue, date = '22 MAY 26' }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', border: `1px solid ${B.ink}`, background: B.paper, ...bFont.mono }}>
    {[
      ['SHEET', sheet],
      ['REV', rev],
      ['TITLE', title],
      ['SCALE', scale],
      ['DATE', date],
      ['STATUS', status, statusColor],
    ].map(([k, v, color], i) => (
      <React.Fragment key={k}>
        <div style={{ padding: '6px 10px', fontSize: 9, color: B.faint, letterSpacing: '0.16em', borderRight: `1px solid ${B.hair}`, borderBottom: i < 4 ? `1px solid ${B.hair}` : 'none', minWidth: 70 }}>{k}</div>
        <div style={{ padding: '6px 12px', fontSize: 11, color: color || B.ink, borderBottom: i < 4 ? `1px solid ${B.hair}` : 'none', minWidth: 160, fontWeight: 500 }}>{v}</div>
      </React.Fragment>
    ))}
  </div>
);

// Rotated stamp
const Stamp = ({ label, color = B.stamp, angle = -8, sub }) => (
  <div style={{
    transform: `rotate(${angle}deg)`,
    border: `2.5px solid ${color}`,
    padding: '8px 14px',
    color, ...bFont.mono, fontSize: 12, letterSpacing: '0.22em', fontWeight: 700, textTransform: 'uppercase',
    display: 'inline-block', textAlign: 'center',
    boxShadow: `1px 1px 0 ${color}25`,
  }}>
    {label}
    {sub && <div style={{ fontSize: 8, letterSpacing: '0.18em', marginTop: 4, fontWeight: 500 }}>{sub}</div>}
  </div>
);

// Dimension line — horizontal label with arrow caps
const DimLine = ({ children, color = B.blue }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
    <span style={{ color }}>‹</span>
    <div style={{ flex: 1, height: 1, background: color }} />
    <span style={{ ...bCaps, color, fontSize: 9, whiteSpace: 'nowrap' }}>{children}</span>
    <div style={{ flex: 1, height: 1, background: color }} />
    <span style={{ color }}>›</span>
  </div>
);

const BPage = ({ children }) => (
  <div style={{
    width: '100%', height: '100%', background: B.cream, color: B.ink,
    backgroundImage: `linear-gradient(to right, ${B.grid} 1px, transparent 1px), linear-gradient(to bottom, ${B.grid} 1px, transparent 1px)`,
    backgroundSize: '24px 24px',
    ...bFont.ui, fontSize: 13, lineHeight: 1.5,
    display: 'flex', flexDirection: 'column', position: 'relative',
  }}>{children}</div>
);

// Border frame around the whole sheet (like a drafting border)
const SheetFrame = ({ children }) => (
  <div style={{ position: 'absolute', inset: 18, border: `1px solid ${B.ink}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
    {/* Inner second-line border */}
    <div style={{ position: 'absolute', inset: 6, border: `1px solid ${B.ink}`, opacity: 0.4, pointerEvents: 'none' }} />
    {children}
  </div>
);

// ── Screen 1: Mode picker ────────────────────────────────────
function BlueprintMode() {
  const ModePanel = ({ letter, kind, title, body, bullets, drawing, primary }) => (
    <div style={{ flex: 1, background: B.paper, border: `1.5px solid ${B.ink}`, padding: '24px 26px 26px', display: 'flex', flexDirection: 'column', gap: 16, position: 'relative' }}>
      <Brackets color={primary ? B.blue : B.ink} thickness={2} size={16} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: '50%',
            border: `1.5px solid ${primary ? B.blue : B.ink}`,
            color: primary ? B.blue : B.ink,
            ...bFont.mono, fontSize: 12, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>{letter}</div>
          <span style={{ ...bCaps, color: primary ? B.blue : B.subtle }}>{kind}</span>
        </div>
        <span style={{ ...bCaps, color: B.faint }}>Detail · {letter}.1</span>
      </div>

      {/* Drawing */}
      <div style={{
        background: primary ? B.blueWash : B.cream,
        border: `1px dashed ${primary ? B.blue : B.ink}`,
        height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center',
        position: 'relative'
      }}>
        {drawing}
        <div style={{ position: 'absolute', bottom: 6, left: 8, ...bCaps, fontSize: 8, color: primary ? B.blue : B.faint }}>Fig. {letter}.1 — {kind}</div>
      </div>

      <div style={{ ...bFont.display, fontSize: 52, lineHeight: 1, color: B.ink, marginTop: 2 }}>{title}</div>

      <p style={{ fontSize: 14, color: B.subtle, margin: 0, lineHeight: 1.55, maxWidth: 380 }}>{body}</p>

      <div style={{ borderTop: `1px solid ${B.hair}`, borderBottom: `1px solid ${B.hair}`, padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <span style={{ ...bCaps, color: B.blue, minWidth: 28, fontSize: 9, marginTop: 2 }}>{letter}.{i + 1}</span>
            <span style={{ fontSize: 13.5, color: B.ink, lineHeight: 1.55 }}>{b}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <button style={{
        padding: '12px 16px', background: primary ? B.blue : 'transparent', color: primary ? B.paper : B.ink,
        border: `1.5px solid ${primary ? B.blue : B.ink}`, ...bCaps, fontSize: 11, cursor: 'pointer', textAlign: 'left'
      }}>
        → SELECT MODE {letter}
      </button>
    </div>
  );

  return (
    <BPage>
      <SheetFrame>
        {/* Header strip */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...bCaps, color: B.blue }}>Universe AI · Software Factory</span>
            <div style={{ ...bFont.display, fontSize: 44, lineHeight: 1, color: B.ink, marginTop: 4 }}>
              ASTRA — Operating Mode Selection
            </div>
            <span style={{ ...bFont.mono, fontSize: 12, color: B.subtle, marginTop: 2 }}>
              Billing portal for solar installers · two ways to drive · switch any time
            </span>
          </div>
          <TitleBlock sheet="M.01 / 03" rev="01" title="MODE PICKER" scale="1 : 1" status="AWAITING SELECTION" statusColor={B.blue} />
        </div>

        {/* Stamp floating */}
        <div style={{ position: 'absolute', top: 70, right: 380, zIndex: 5 }}>
          <Stamp label="AWAITING" sub="USER SELECTION" color={B.blue} angle={-7} />
        </div>

        {/* Top-of-sheet dimension line */}
        <DimLine color={B.blue}>SHEET MEASURED · 1380 × 900 · GRID 24 PX</DimLine>

        <div style={{ flex: 1, display: 'flex', gap: 18 }}>
          <ModePanel
            letter="A"
            kind="CONCIERGE · UNATTENDED OPERATION"
            title="Easy"
            body="The factory runs in the background. Universe makes defaults explicit, makes them, and explains them. You're paged only for human-only decisions."
            bullets={[
              'Universe drives the bays; you approve ~3 gates per project.',
              'A plain-English project radio shows you what just happened.',
              'Drop into the cockpit at any moment if you want detail.',
            ]}
            drawing={
              <svg width="200" height="100" viewBox="0 0 200 100">
                <rect x="20" y="20" width="160" height="60" fill="none" stroke={B.ink} strokeWidth="1.4" />
                <line x1="20" y1="34" x2="180" y2="34" stroke={B.ink} strokeWidth="1" />
                <circle cx="40" cy="55" r="8" fill="none" stroke={B.ink} strokeWidth="1.4" />
                <circle cx="40" cy="55" r="2.5" fill={B.ink} />
                <line x1="60" y1="50" x2="160" y2="50" stroke={B.ink} strokeWidth="1" />
                <line x1="60" y1="58" x2="140" y2="58" stroke={B.ink} strokeWidth="1" />
                <line x1="60" y1="66" x2="150" y2="66" stroke={B.ink} strokeWidth="1" />
                <text x="100" y="14" fontFamily="JetBrains Mono" fontSize="7" fill={B.faint} textAnchor="middle" letterSpacing="1">PROJECT RADIO</text>
              </svg>
            }
            primary
          />
          <ModePanel
            letter="B"
            kind="COCKPIT · OPERATOR ATTENDED"
            title="Hands-on"
            body="The whole factory floor exposed. Three bays, every persona, every gate, every artifact. You approve at every transition and can interrupt mid-step."
            bullets={[
              'All bays open: Shape it · Build it · Ship it.',
              'Sign-off required at every phase boundary.',
              'Full audit trail, persona attribution, diff and QA evidence.',
            ]}
            drawing={
              <svg width="220" height="100" viewBox="0 0 220 100">
                <g fill="none" stroke={B.ink} strokeWidth="1.4">
                  <rect x="12" y="22" width="60" height="56" />
                  <rect x="80" y="22" width="60" height="56" />
                  <rect x="148" y="22" width="60" height="56" />
                  <line x1="12" y1="34" x2="72" y2="34" />
                  <line x1="80" y1="34" x2="140" y2="34" />
                  <line x1="148" y1="34" x2="208" y2="34" />
                </g>
                <text x="42" y="32" fontFamily="JetBrains Mono" fontSize="7" fill={B.ink} textAnchor="middle" letterSpacing="1">SHAPE</text>
                <text x="110" y="32" fontFamily="JetBrains Mono" fontSize="7" fill={B.ink} textAnchor="middle" letterSpacing="1">BUILD</text>
                <text x="178" y="32" fontFamily="JetBrains Mono" fontSize="7" fill={B.ink} textAnchor="middle" letterSpacing="1">SHIP</text>
                <line x1="72" y1="50" x2="80" y2="50" stroke={B.ink} strokeWidth="1.4" markerEnd="url(#arr)" />
                <line x1="140" y1="50" x2="148" y2="50" stroke={B.ink} strokeWidth="1.4" markerEnd="url(#arr)" />
                <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill={B.ink} /></marker></defs>
                {[42, 110, 178].map((x, i) => (
                  <g key={i}>
                    <circle cx={x - 12} cy="58" r="2.5" fill={B.ink} />
                    <circle cx={x} cy="58" r="2.5" fill={B.ink} />
                    <circle cx={x + 12} cy="58" r="2.5" fill={B.ink} />
                  </g>
                ))}
                <text x="110" y="14" fontFamily="JetBrains Mono" fontSize="7" fill={B.faint} textAnchor="middle" letterSpacing="1">FACTORY · 3 BAYS</text>
              </svg>
            }
          />
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${B.hair}`, paddingTop: 10, ...bFont.mono, fontSize: 11, color: B.subtle }}>
          <span>NOTE — Most non-technical founders start in Mode A and stay there.</span>
          <span>UNIVERSE · ASTRA · M.01 OF 03</span>
        </div>
      </SheetFrame>
    </BPage>
  );
}

// ── Screen 2: Easy in-flight ─────────────────────────────────
function BlueprintEasy() {
  const Rev = ({ id, tag, text, persona }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '52px 70px 1fr 90px', gap: 0, padding: '10px 0', borderBottom: `1px solid ${B.hair}`, alignItems: 'baseline' }}>
      <span style={{ ...bCaps, color: B.blue, fontSize: 9 }}>REV {id}</span>
      <span style={{ ...bCaps, color: B.subtle, fontSize: 9 }}>{tag}</span>
      <span style={{ fontSize: 13.5, color: B.ink, lineHeight: 1.5 }}>{text}</span>
      <span style={{ ...bFont.mono, fontSize: 10, color: B.faint, textAlign: 'right' }}>{persona}</span>
    </div>
  );

  return (
    <BPage>
      <SheetFrame>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...bCaps, color: B.blue }}>SHEET A.02 · EASY MODE · IN-FLIGHT</span>
            <div style={{ ...bFont.display, fontSize: 36, lineHeight: 1.05, color: B.ink, marginTop: 2 }}>
              Astra — Build it · day 3 of est. 5
            </div>
            <span style={{ ...bFont.mono, fontSize: 11, color: B.subtle }}>Project radio · last update 4 min ago</span>
          </div>
          <TitleBlock sheet="A.02 / 12" rev="07" title="BUILD · INVOICES" scale="EASY MODE" status="DRAWING IN PROGRESS" statusColor={B.blue} />
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18 }}>
          {/* LEFT — current focus drawing */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: B.paper, border: `1.5px solid ${B.ink}`, padding: '20px 22px', position: 'relative', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Brackets color={B.ink} size={14} thickness={2} />

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ ...bCaps, color: B.subtle }}>Detail A · current focus</span>
                <span style={{ ...bCaps, color: B.blue }}>● BUILDING · 4 min</span>
              </div>

              <div style={{ ...bFont.display, fontSize: 30, lineHeight: 1.15, color: B.ink }}>
                Wiring the invoice line-item table — panel, inverter, labor hours.
              </div>

              {/* Drafted sketch of the artifact */}
              <div style={{ background: B.cream, border: `1px dashed ${B.blue}`, padding: '18px 18px', position: 'relative' }}>
                <div style={{ position: 'absolute', top: -10, left: 18, background: B.paper, padding: '2px 8px', ...bCaps, fontSize: 9, color: B.blue }}>FIG. A.1 — INVOICE.PDF · WIP</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 70px 80px 80px', borderBottom: `1.5px solid ${B.ink}`, padding: '8px 0', ...bCaps, fontSize: 9, color: B.subtle }}>
                  <span>ITEM</span><span style={{ textAlign: 'right' }}>QTY</span><span style={{ textAlign: 'right' }}>UNIT</span><span style={{ textAlign: 'right' }}>EXTENDED</span>
                </div>
                {[
                  ['410W Bifacial Panel', '24', '$ 285.00', '$ 6,840.00'],
                  ['7.6kW Inverter', '1', '$ 1,420.00', '$ 1,420.00'],
                  ['Labor — install (hrs)', '18', '$ 95.00', '$ 1,710.00'],
                  ['Permit + inspection', '1', '$ 380.00', '$ 380.00'],
                ].map(([a, b, c, d], i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.5fr 70px 80px 80px', padding: '6px 0', borderBottom: `1px dashed ${B.hair}`, fontSize: 12, color: B.ink }}>
                    <span>{a}</span><span style={{ textAlign: 'right', ...bFont.mono }}>{b}</span><span style={{ textAlign: 'right', ...bFont.mono }}>{c}</span><span style={{ textAlign: 'right', ...bFont.mono }}>{d}</span>
                  </div>
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 70px 80px 80px', padding: '8px 0 0', borderTop: `1.5px solid ${B.ink}`, marginTop: 4, ...bFont.mono, fontSize: 12, color: B.ink, fontWeight: 600 }}>
                  <span style={{ ...bCaps, fontSize: 10 }}>SUBTOTAL</span>
                  <span></span><span></span><span style={{ textAlign: 'right' }}>$ 10,350.00</span>
                </div>
              </div>

              {/* Progress dimension line */}
              <div>
                <DimLine color={B.blue}>STEP PROGRESS · 62 %</DimLine>
                <div style={{ marginTop: 8, height: 6, background: B.cream, border: `1px solid ${B.ink}`, position: 'relative' }}>
                  <div style={{ position: 'absolute', inset: 0, width: '62%', background: B.blue }} />
                </div>
              </div>
            </div>

            {/* Decision */}
            <div style={{ background: B.blueWash, border: `1.5px solid ${B.blue}`, padding: '18px 20px', position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Brackets color={B.blue} size={14} thickness={2} />
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...bCaps, color: B.blue }}>● Decision required · payment processing</span>
                <span style={{ ...bCaps, color: B.subtle }}>Gate G-04</span>
              </div>
              <div style={{ ...bFont.display, fontSize: 22, lineHeight: 1.25, color: B.ink }}>
                Stripe Invoicing, or build the invoice generator in-house?
              </div>
              <p style={{ fontSize: 13, color: B.subtle, margin: 0, lineHeight: 1.55 }}>
                Recommendation: Stripe Invoicing. Ship in 1 day vs ~3 days; trade-off is 0.5% + $0.30 per invoice and a third-party dependency on the tax line.
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button style={{ padding: '10px 14px', background: B.blue, color: B.paper, border: 'none', ...bCaps, fontSize: 10, cursor: 'pointer' }}>↳ APPROVE STRIPE</button>
                <button style={{ padding: '10px 14px', background: 'transparent', color: B.ink, border: `1.5px solid ${B.ink}`, ...bCaps, fontSize: 10, cursor: 'pointer' }}>BUILD IN-HOUSE</button>
                <button style={{ padding: '10px 14px', background: 'transparent', color: B.subtle, border: `1px solid ${B.hair}`, ...bCaps, fontSize: 10, cursor: 'pointer' }}>DEFER 1H</button>
              </div>
            </div>
          </div>

          {/* RIGHT — revision history */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: B.paper, border: `1.5px solid ${B.ink}`, padding: '18px 20px', position: 'relative', flex: 1, display: 'flex', flexDirection: 'column' }}>
              <Brackets color={B.ink} size={14} thickness={2} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ ...bCaps, color: B.subtle }}>Revision history · last 30 min</span>
                <span style={{ ...bCaps, color: B.faint }}>{6} entries</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '52px 70px 1fr 90px', gap: 0, padding: '8px 0', borderBottom: `2px solid ${B.ink}`, ...bCaps, color: B.faint, fontSize: 9 }}>
                <span>REV #</span><span>TAG</span><span>NOTE</span><span style={{ textAlign: 'right' }}>BY</span>
              </div>
              <Rev id="07" tag="BUILD" text="Scaffolded /invoices route + InvoiceTable component." persona="BUILDER" />
              <Rev id="06" tag="TEST" text="6 line-item math tests · all passing in 24ms." persona="INSPECTOR" />
              <Rev id="05" tag="SHAPE" text="Data model locked — Invoice → LineItem → Adjustment." persona="ARCHITECT" />
              <Rev id="04" tag="GATE" text="Data model approved by user · signed off." persona="YOU" />
              <Rev id="03" tag="BUILD" text="Migration 0013 · billing_accounts table." persona="BUILDER" />
              <Rev id="02" tag="TEST" text="Lint + typecheck clean across 14 files." persona="INSPECTOR" />

              <div style={{ flex: 1 }} />

              <div style={{ borderTop: `1px solid ${B.hair}`, paddingTop: 12, ...bFont.mono, fontSize: 11, color: B.subtle }}>
                NOTE — Universe writes one revision per atomic step. Click any row to see diff + reasoning.
              </div>
            </div>

            {/* Up next mini block */}
            <div style={{ background: B.cream, border: `1px solid ${B.ink}`, padding: '14px 16px' }}>
              <div style={{ ...bCaps, color: B.subtle, marginBottom: 8 }}>Queued · up next</div>
              <div style={{ ...bFont.mono, fontSize: 12, color: B.faint, padding: '5px 0', borderTop: `1px dashed ${B.hair}`, display: 'flex', justifyContent: 'space-between' }}>
                <span>email_receipt + tax_line</span><span>BUILD</span>
              </div>
              <div style={{ ...bFont.mono, fontSize: 12, color: B.faint, padding: '5px 0', borderTop: `1px dashed ${B.hair}`, display: 'flex', justifyContent: 'space-between' }}>
                <span>browser_qa /invoices</span><span>TEST</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${B.hair}`, paddingTop: 8, ...bFont.mono, fontSize: 11, color: B.subtle }}>
          <span>NOTE — All artifacts drawn to scale. Decisions stamp on G-XX gate sheets.</span>
          <span>SHT A.02 · REV 07 · ASTRA</span>
        </div>
      </SheetFrame>
    </BPage>
  );
}

// ── Screen 3: Factory three-bay floor plan ───────────────────
function BlueprintFactory() {
  const Bay = ({ id, name, status, statusColor, focus, crew, doorState, children, dim, primary }) => (
    <div style={{
      flex: primary ? 1.4 : 1,
      background: primary ? B.blueWash : B.paper,
      border: `${primary ? 2 : 1.5}px solid ${primary ? B.blue : B.ink}`,
      padding: '20px 22px 22px', display: 'flex', flexDirection: 'column', gap: 12,
      opacity: dim ? 0.55 : 1, position: 'relative'
    }}>
      <Brackets color={primary ? B.blue : B.ink} size={16} thickness={2} />

      {/* Door symbol at top — arc */}
      <div style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ background: B.cream, padding: '0 14px' }}>
          <svg width="44" height="22" viewBox="0 0 44 22">
            <path d={doorState === 'open' ? 'M 4 22 L 4 4 Q 22 4 40 22' : 'M 4 22 L 40 22'} fill="none" stroke={primary ? B.blue : B.ink} strokeWidth="1.5" strokeDasharray={doorState === 'locked' ? '3,3' : 'none'} />
            <circle cx="4" cy="22" r="2" fill={primary ? B.blue : B.ink} />
            <circle cx="40" cy="22" r="2" fill={primary ? B.blue : B.ink} />
          </svg>
        </div>
        <span style={{ ...bCaps, fontSize: 8, color: primary ? B.blue : B.faint, background: primary ? B.blueWash : B.paper, padding: '0 8px', marginTop: -4 }}>{doorState.toUpperCase()}</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 18 }}>
        <span style={{ ...bCaps, color: B.subtle }}>Bay {id}</span>
        <span style={{ ...bCaps, color: statusColor, fontWeight: 700 }}>{status}</span>
      </div>

      <div style={{ ...bFont.display, fontSize: primary ? 40 : 30, lineHeight: 1, color: B.ink }}>{name}</div>

      <div style={{ fontSize: 13, color: B.subtle, lineHeight: 1.55, minHeight: 52 }}>{focus}</div>

      {/* Crew as named figures */}
      <div>
        <div style={{ ...bCaps, color: B.faint, marginBottom: 6 }}>Crew on shift</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {crew.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px dashed ${B.hair}` }}>
              <svg width="14" height="14" viewBox="0 0 14 14">
                <circle cx="7" cy="4.5" r="2.5" fill="none" stroke={B.ink} strokeWidth="1.2" />
                <path d="M 2 13 Q 2 7.5 7 7.5 Q 12 7.5 12 13" fill="none" stroke={B.ink} strokeWidth="1.2" />
              </svg>
              <span style={{ ...bFont.mono, fontSize: 11, color: B.ink, flex: 1 }}>{c.name}</span>
              <span style={{ ...bCaps, color: c.state === 'busy' ? B.blue : c.state === 'idle' ? B.faint : B.stamp, fontSize: 8 }}>{c.state}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />
      {children}
    </div>
  );

  return (
    <BPage>
      <SheetFrame>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...bCaps, color: B.blue }}>SHEET F.01 · FACTORY FLOOR PLAN</span>
            <div style={{ ...bFont.display, fontSize: 38, lineHeight: 1, color: B.ink, marginTop: 4 }}>
              Astra — Three-bay workshop, viewed from above
            </div>
            <span style={{ ...bFont.mono, fontSize: 11, color: B.subtle }}>Hands-on mode · day 3 of est. 5 · all crews on shift in Bay B</span>
          </div>
          <TitleBlock sheet="F.01 / 12" rev="01" title="FLOOR PLAN" scale="1 : 250" status="BUILD IN PROGRESS" statusColor={B.blue} />
        </div>

        {/* Flow arrows above bays */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px' }}>
          <span style={{ ...bCaps, color: B.faint }}>FLOW →</span>
          <DimLine color={B.blue}>SHAPE IT → BUILD IT → SHIP IT</DimLine>
        </div>

        <div style={{ flex: 1, display: 'flex', gap: 24, padding: '14px 0 0' }}>
          <Bay id="A" name="Shape it" status="✓ COMPLETE" statusColor={B.approve} doorState="open"
            focus="Idea brief signed off. Data model & scope locked. Crew released to standby."
            crew={[
              { name: 'architect.v3', state: 'idle' },
              { name: 'brief_writer.v1', state: 'idle' },
              { name: 'researcher.v2', state: 'idle' },
            ]}>
            <div style={{ borderTop: `1px solid ${B.hair}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ ...bCaps, color: B.faint }}>Sheets produced</div>
              <div style={{ ...bFont.mono, fontSize: 11, color: B.ink }}>S.01 · idea_brief.md  REV 03</div>
              <div style={{ ...bFont.mono, fontSize: 11, color: B.ink }}>S.02 · data_model.dbml</div>
              <div style={{ ...bFont.mono, fontSize: 11, color: B.ink }}>S.03 · scope_decisions (4)</div>
            </div>
          </Bay>

          <Bay id="B" name="Build it" status="● ACTIVE" statusColor={B.blue} doorState="open" primary
            focus="Wiring invoice line-item table. 4 of 7 components done. invoice.pdf renders; math passes."
            crew={[
              { name: 'architect.v3', state: 'idle' },
              { name: 'builder.v3', state: 'busy' },
              { name: 'inspector.v2', state: 'busy' },
              { name: 'documentarian.v1', state: 'busy' },
            ]}>
            {/* Pipeline */}
            <div>
              <div style={{ ...bCaps, color: B.faint, marginBottom: 6 }}>Pipeline · 5 stations</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {[
                  { k: 'Scaffold', s: 'done' },
                  { k: 'Wire data', s: 'done' },
                  { k: 'Components', s: 'active' },
                  { k: 'Integrate', s: 'next' },
                  { k: 'QA pass', s: 'next' },
                ].map(p => (
                  <div key={p.k} style={{
                    flex: 1, padding: '6px 4px', textAlign: 'center',
                    ...bCaps, fontSize: 8,
                    border: `1.5px solid ${p.s === 'active' ? B.blue : p.s === 'done' ? B.approve : B.hair}`,
                    background: p.s === 'done' ? B.paper : p.s === 'active' ? B.blue : 'transparent',
                    color: p.s === 'done' ? B.approve : p.s === 'active' ? B.paper : B.subtle,
                  }}>{p.k}</div>
                ))}
              </div>
            </div>

            {/* Decision callout */}
            <div style={{ background: B.paper, border: `1.5px solid ${B.blue}`, padding: '12px 14px' }}>
              <div style={{ ...bCaps, color: B.blue, marginBottom: 6 }}>● Gate G-04 · awaiting user</div>
              <div style={{ fontSize: 14, color: B.ink, lineHeight: 1.3, fontWeight: 500 }}>Stripe Invoicing, or build the generator in-house?</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button style={{ padding: '7px 12px', background: B.blue, color: B.paper, border: 'none', ...bCaps, fontSize: 9, cursor: 'pointer' }}>↳ DECIDE</button>
                <button style={{ padding: '7px 12px', background: 'transparent', color: B.subtle, border: `1px solid ${B.hair}`, ...bCaps, fontSize: 9, cursor: 'pointer' }}>DEFER</button>
              </div>
            </div>
          </Bay>

          <Bay id="C" name="Ship it" status="⌂ LOCKED" statusColor={B.faint} doorState="locked" dim
            focus="Door stays closed until Bay B passes QA gate and user signs the readiness checklist."
            crew={[
              { name: 'packager.v2', state: 'idle' },
              { name: 'release_writer.v1', state: 'idle' },
              { name: 'watchman.v3', state: 'idle' },
            ]}>
            <div style={{ borderTop: `1px solid ${B.hair}`, paddingTop: 10 }}>
              <div style={{ ...bCaps, color: B.faint, marginBottom: 6 }}>Unlocks when</div>
              <div style={{ ...bFont.mono, fontSize: 11, color: B.subtle, lineHeight: 1.7 }}>
                <div>☐ Bay B closes G-05 (QA pass)</div>
                <div>☐ Readiness checklist signed</div>
                <div>☐ Handoff bundle requested</div>
              </div>
            </div>
          </Bay>
        </div>

        {/* Floating stamp on Bay B */}
        <div style={{ position: 'absolute', top: 300, left: '46%', zIndex: 5, pointerEvents: 'none' }}>
          <Stamp label="BUILD IN PROGRESS" color={B.blue} angle={-6} sub="ASTRA · 22 MAY" />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${B.hair}`, paddingTop: 8, ...bFont.mono, fontSize: 11, color: B.subtle }}>
          <span>LEGEND — open door = bay active · dashed = locked · ✓ = sign-off received</span>
          <span>SHT F.01 · REV 01 · 22 MAY 26</span>
        </div>
      </SheetFrame>
    </BPage>
  );
}

Object.assign(window, { BlueprintMode, BlueprintEasy, BlueprintFactory });
