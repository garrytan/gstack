// Studio — Soft Modern Studio
// Cream + sage + ink. Notion/Things DNA. Generous radii, dot motif, all Inter.
// Low-risk, friendly, slightly less distinctive. The safe ship.
// ─────────────────────────────────────────────────────────────

const S = {
  bg: '#F6F2EA',
  card: '#FFFFFF',
  cardBorder: 'rgba(31,31,30,0.07)',
  ink: '#1F1F1E',
  subtle: '#6E6E6B',
  faint: '#A8A6A1',
  hair: '#EEEAE0',
  sage: '#5C7A4E',
  sageLight: '#DDE5D2',
  sageSoft: '#EEF2E8',
  amber: '#D89B3C',
  amberSoft: '#F8EBD3',
  warm: '#FBF5E9',
  rose: '#C25B5B',
};

const sFont = { fontFamily: "'Inter', system-ui, sans-serif" };

const Pill = ({ color, bg, children, dot, style = {} }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 999, background: bg, color,
    fontSize: 12, fontWeight: 500, letterSpacing: '0.01em',
    ...style
  }}>
    {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />}
    {children}
  </span>
);

const Avatar = ({ name, color = S.sage, size = 28 }) => {
  const initials = name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color, color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 600, letterSpacing: '0.02em',
      boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
    }}>{initials}</div>
  );
};

const SPage = ({ children }) => (
  <div style={{
    width: '100%', height: '100%', background: S.bg, color: S.ink,
    backgroundImage: 'radial-gradient(rgba(31,31,30,0.05) 1.2px, transparent 1.2px)',
    backgroundSize: '20px 20px',
    ...sFont, fontSize: 14, lineHeight: 1.55,
    display: 'flex', flexDirection: 'column',
  }}>{children}</div>
);

const STopBar = ({ project, mode, dot }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 28px', background: S.bg }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, background: S.ink, color: S.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, letterSpacing: '-0.02em'
      }}>u</div>
      <span style={{ fontWeight: 600, color: S.ink }}>Universe</span>
      <span style={{ color: S.faint }}>/</span>
      <span style={{ fontWeight: 500, color: S.subtle }}>{project}</span>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: S.sage, marginLeft: 6 }} />}
    </div>
    {mode && (
      <div style={{ display: 'flex', gap: 4, padding: 4, background: S.card, border: `1px solid ${S.cardBorder}`, borderRadius: 999, boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
        {['easy', 'hands'].map(k => (
          <span key={k} style={{
            padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 500,
            background: mode === k ? S.ink : 'transparent', color: mode === k ? S.bg : S.subtle,
            cursor: 'pointer'
          }}>{k === 'easy' ? 'Easy' : 'Hands-on'}</span>
        ))}
      </div>
    )}
  </div>
);

// ── Screen 1: Mode picker ────────────────────────────────────
function StudioMode() {
  const Card = ({ kind, accent, accentSoft, title, tag, body, bullets, primary, motif }) => (
    <div style={{
      flex: 1, background: S.card, border: `1px solid ${S.cardBorder}`,
      borderRadius: 24, padding: '32px 32px 28px',
      boxShadow: primary ? '0 4px 14px rgba(31,31,30,0.06), 0 24px 48px rgba(92,122,78,0.10)' : '0 2px 8px rgba(31,31,30,0.04)',
      display: 'flex', flexDirection: 'column', gap: 22,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Motif blob */}
      <div style={{ position: 'absolute', top: -40, right: -40, width: 180, height: 180, borderRadius: '50%', background: accentSoft, opacity: 0.7 }} />

      <Pill color={accent} bg={accentSoft} dot style={{ alignSelf: 'flex-start', position: 'relative' }}>{kind}</Pill>

      {/* Motif drawing */}
      <div style={{ height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        {motif}
      </div>

      <div style={{ position: 'relative' }}>
        <h2 style={{ fontSize: 56, fontWeight: 700, letterSpacing: '-0.035em', lineHeight: 1, margin: 0, color: S.ink }}>{title}</h2>
        <p style={{ fontSize: 16, color: S.subtle, margin: '8px 0 0', maxWidth: 400, lineHeight: 1.45 }}>{tag}</p>
      </div>

      <p style={{ fontSize: 14.5, color: S.ink, margin: 0, lineHeight: 1.6, maxWidth: 400 }}>{body}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ width: 18, height: 18, borderRadius: '50%', background: accentSoft, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5 L4.5 7.5 L8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <span style={{ fontSize: 14, color: S.ink, lineHeight: 1.5 }}>{b}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <button style={{
        padding: '14px 18px', borderRadius: 14,
        background: primary ? accent : 'transparent',
        color: primary ? '#fff' : S.ink,
        border: primary ? 'none' : `1.5px solid ${S.ink}`,
        fontSize: 14, fontWeight: 600, cursor: 'pointer',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        boxShadow: primary ? '0 4px 14px rgba(92,122,78,0.30)' : 'none',
      }}>
        <span>{primary ? 'Start in Easy Mode' : 'Open the cockpit'}</span>
        <span style={{ fontSize: 16 }}>→</span>
      </button>
    </div>
  );

  return (
    <SPage>
      <STopBar project="Astra — Billing portal for solar installers" />

      <div style={{ flex: 1, padding: '32px 60px 56px', display: 'flex', flexDirection: 'column', gap: 36 }}>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <Pill color={S.sage} bg={S.sageSoft} style={{ fontSize: 11 }}>New project · one-time choice</Pill>
          <h1 style={{ fontSize: 60, fontWeight: 700, letterSpacing: '-0.035em', lineHeight: 1.05, margin: '6px 0 0', maxWidth: 760, color: S.ink }}>
            How would you like to drive Astra?
          </h1>
          <p style={{ fontSize: 17, color: S.subtle, margin: 0, maxWidth: 600, lineHeight: 1.45 }}>
            Two ways to build, same destination — a billing portal you trust. You can switch tracks any time from the top bar.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 24, flex: 1 }}>
          <Card
            kind="Concierge"
            accent={S.sage}
            accentSoft={S.sageSoft}
            title="Easy"
            tag="Universe drives. You sign off on the few things only you can decide."
            body="The factory runs in the background. You'll see what's happening, but Universe won't pull you in unless something genuinely needs a human call."
            bullets={[
              'Universe picks defaults and explains them in plain English.',
              'You answer roughly 3 questions across the whole project.',
              'A friendly feed shows what just shipped, what\'s next.',
            ]}
            motif={
              <svg width="200" height="100" viewBox="0 0 200 100">
                <circle cx="100" cy="50" r="38" fill={S.sageSoft} stroke={S.sage} strokeWidth="1.5" />
                <circle cx="100" cy="50" r="22" fill="#fff" stroke={S.sage} strokeWidth="1.5" />
                <circle cx="100" cy="50" r="8" fill={S.sage} />
                <circle cx="68" cy="50" r="3" fill={S.sage} />
                <circle cx="132" cy="50" r="3" fill={S.sage} />
                <circle cx="100" cy="20" r="3" fill={S.sage} />
                <circle cx="100" cy="80" r="3" fill={S.sage} />
              </svg>
            }
            primary
          />
          <Card
            kind="Cockpit"
            accent={S.ink}
            accentSoft={S.hair}
            title="Hands-on"
            tag="Open the whole factory. Three bays, every crew, every gate."
            body="You enter the cockpit. Phases, personas, artifacts, logs, diffs — all exposed. You approve at every transition; you can interrupt the crew."
            bullets={[
              'Three bays open: Shape it, Build it, Ship it.',
              'You sign off at every phase before the next begins.',
              'Full audit trail, persona attribution, browser QA evidence.',
            ]}
            motif={
              <svg width="220" height="100" viewBox="0 0 220 100">
                {[20, 80, 140].map((x, i) => (
                  <g key={i}>
                    <rect x={x} y="22" width="60" height="56" rx="10" fill={i === 1 ? S.sageSoft : '#fff'} stroke={S.ink} strokeWidth="1.4" />
                    <circle cx={x + 30} cy="42" r="6" fill={i === 1 ? S.sage : S.faint} />
                    <line x1={x + 14} y1="58" x2={x + 46} y2="58" stroke={S.ink} strokeWidth="1.2" opacity="0.4" />
                    <line x1={x + 14} y1="64" x2={x + 40} y2="64" stroke={S.ink} strokeWidth="1.2" opacity="0.4" />
                  </g>
                ))}
              </svg>
            }
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, color: S.subtle, fontSize: 13 }}>
          <span>💡</span>
          <span>Most non-technical founders start in Easy and stay there. Switch any time.</span>
        </div>
      </div>
    </SPage>
  );
}

// ── Screen 2: Easy in-flight ─────────────────────────────────
function StudioEasy() {
  const Activity = ({ persona, color, action, detail, when }) => (
    <div style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: `1px solid ${S.hair}` }}>
      <Avatar name={persona} color={color} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: 14, color: S.ink, lineHeight: 1.45 }}>
            <strong style={{ fontWeight: 600 }}>{persona}</strong> {action}
          </span>
          <span style={{ fontSize: 12, color: S.faint, whiteSpace: 'nowrap' }}>{when}</span>
        </div>
        {detail && <div style={{ fontSize: 13, color: S.subtle, marginTop: 2 }}>{detail}</div>}
      </div>
    </div>
  );

  return (
    <SPage>
      <STopBar project="Astra — Billing portal" mode="easy" dot />

      <div style={{ flex: 1, padding: '14px 32px 36px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* Hero card */}
        <div style={{
          background: S.card, borderRadius: 24, padding: '32px 36px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.04), 0 16px 40px rgba(0,0,0,0.05)',
          display: 'flex', flexDirection: 'column', gap: 20,
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', top: -60, right: -60, width: 240, height: 240, borderRadius: '50%', background: S.sageSoft, opacity: 0.6 }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
            <Pill color={S.sage} bg={S.sageSoft} dot>Building right now</Pill>
            <span style={{ fontSize: 13, color: S.subtle }}>Started 4 min ago · Build it</span>
          </div>

          <h1 style={{ fontSize: 42, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.15, margin: 0, color: S.ink, maxWidth: 900, position: 'relative' }}>
            Universe is wiring up your <span style={{ background: `linear-gradient(transparent 62%, ${S.sageSoft} 62%)`, padding: '0 4px' }}>invoice line-item table</span> — the part that itemizes each panel, inverter, and labor hour for the homeowner.
          </h1>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, position: 'relative' }}>
            <div style={{ flex: 1, height: 8, background: S.hair, borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ width: '62%', height: '100%', background: `linear-gradient(90deg, ${S.sage}, ${S.sage}cc)`, borderRadius: 99 }} />
            </div>
            <span style={{ fontSize: 13, fontWeight: 600, color: S.sage, fontVariantNumeric: 'tabular-nums' }}>62%</span>
          </div>
        </div>

        {/* Two columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 22, flex: 1 }}>
          {/* Activity */}
          <div style={{ background: S.card, borderRadius: 20, padding: '24px 28px', border: `1px solid ${S.cardBorder}`, boxShadow: '0 1px 2px rgba(0,0,0,0.03)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <h3 style={{ fontSize: 17, fontWeight: 600, margin: 0, color: S.ink }}>Activity</h3>
              <span style={{ fontSize: 12, color: S.faint }}>last 30 minutes</span>
            </div>
            <Activity persona="Builder" color={S.sage} action="scaffolded /invoices route and InvoiceTable component" detail="4 React components, 1 API route, 1 migration" when="4 min ago" />
            <Activity persona="Inspector" color="#9C7CC8" action="wrote 6 tests for line-item math" detail="All passing · 24ms total runtime" when="18 min ago" />
            <Activity persona="Architect" color="#3D7AB0" action="locked the data model" detail="Invoice → LineItem → Adjustment" when="32 min ago" />
            <Activity persona="You" color={S.ink} action="approved the data model" detail="Sign-off on schema before code generation" when="38 min ago" />

            <div style={{ flex: 1 }} />
            <div style={{ borderTop: `1px solid ${S.hair}`, paddingTop: 14, marginTop: 8, display: 'flex', justifyContent: 'space-between' }}>
              <a style={{ fontSize: 13, color: S.sage, fontWeight: 500, cursor: 'pointer' }}>See full timeline →</a>
              <span style={{ fontSize: 12, color: S.faint }}>14 events today</span>
            </div>
          </div>

          {/* Right rail */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Decision */}
            <div style={{ background: S.card, borderRadius: 20, padding: '22px 22px', border: `1.5px solid ${S.amber}`, boxShadow: '0 4px 14px rgba(216,155,60,0.18)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Pill color={S.amber} bg={S.amberSoft} dot>Waiting on you</Pill>
                <span style={{ fontSize: 12, color: S.subtle }}>1 decision</span>
              </div>

              <h4 style={{ fontSize: 19, fontWeight: 600, margin: 0, color: S.ink, letterSpacing: '-0.01em', lineHeight: 1.3 }}>
                Stripe Invoicing, or build the generator in-house?
              </h4>

              <p style={{ fontSize: 13.5, color: S.subtle, margin: 0, lineHeight: 1.55 }}>
                Stripe ships in a day and handles tax + reminders. In-house keeps you off third-party fees (~0.5% + 30¢) and lets you brand the PDFs. We lean Stripe for v1.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <button style={{ padding: '12px 16px', borderRadius: 12, background: S.amber, color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  Use Stripe Invoicing <span>→</span>
                </button>
                <button style={{ padding: '12px 16px', borderRadius: 12, background: 'transparent', color: S.ink, border: `1.5px solid ${S.cardBorder}`, fontSize: 13, fontWeight: 500, cursor: 'pointer', textAlign: 'left' }}>
                  Build in-house
                </button>
              </div>

              <a style={{ fontSize: 12, color: S.subtle, cursor: 'pointer' }}>Read the trade-off note →</a>
            </div>

            {/* Up next */}
            <div style={{ background: S.card, borderRadius: 20, padding: '20px 22px', border: `1px solid ${S.cardBorder}`, boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px', color: S.ink }}>Up next</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: `1px solid ${S.hair}`, opacity: 0.85 }}>
                <span style={{ fontSize: 13.5, color: S.ink }}>Email receipt template + tax line</span>
                <Pill color={S.subtle} bg={S.hair} style={{ fontSize: 10 }}>Build</Pill>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: `1px solid ${S.hair}`, opacity: 0.65 }}>
                <span style={{ fontSize: 13.5, color: S.ink }}>Browser QA pass on /invoices</span>
                <Pill color={S.subtle} bg={S.hair} style={{ fontSize: 10 }}>Test</Pill>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderTop: `1px solid ${S.hair}`, opacity: 0.45 }}>
                <span style={{ fontSize: 13.5, color: S.ink }}>Readiness review</span>
                <Pill color={S.subtle} bg={S.hair} style={{ fontSize: 10 }}>Ship</Pill>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SPage>
  );
}

// ── Screen 3: Factory three-bay ──────────────────────────────
function StudioFactory() {
  const Bay = ({ name, status, statusColor, statusBg, focus, crew, primary, dim, accent, accentSoft, children, emoji }) => (
    <div style={{
      flex: primary ? 1.4 : 1, background: S.card, borderRadius: 24, padding: '26px 28px 26px',
      border: primary ? `1.5px solid ${accent}` : `1px solid ${S.cardBorder}`,
      boxShadow: primary ? `0 4px 14px ${accent}25, 0 24px 48px ${accent}15` : '0 2px 8px rgba(0,0,0,0.04)',
      display: 'flex', flexDirection: 'column', gap: 16, opacity: dim ? 0.55 : 1,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%', background: accentSoft, opacity: 0.5 }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 12, background: accentSoft, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{emoji}</div>
        </div>
        <Pill color={statusColor} bg={statusBg} dot={status === 'Active'}>{status}</Pill>
      </div>

      <div style={{ position: 'relative' }}>
        <h2 style={{ fontSize: primary ? 38 : 30, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.05, margin: 0, color: S.ink }}>{name}</h2>
      </div>

      <p style={{ fontSize: 14, color: S.subtle, margin: 0, lineHeight: 1.55, minHeight: 46, position: 'relative' }}>{focus}</p>

      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: S.subtle, marginBottom: 8 }}>Crew</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {crew.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={c.name} color={c.color} size={26} />
              <span style={{ fontSize: 13, color: S.ink, flex: 1 }}>{c.name}</span>
              <span style={{ fontSize: 11, color: c.state === 'Active' ? S.sage : S.faint, fontWeight: 500 }}>{c.state}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );

  return (
    <SPage>
      <STopBar project="Astra — Billing portal" mode="hands" dot />

      <div style={{ padding: '12px 32px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <Pill color={S.sage} bg={S.sageSoft} dot>Day 3 of 5 · on track</Pill>
          <h1 style={{ fontSize: 44, fontWeight: 700, letterSpacing: '-0.035em', lineHeight: 1.05, margin: '10px 0 0', color: S.ink }}>
            Astra is on the floor in <span style={{ color: S.sage }}>Build it.</span>
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 20, fontSize: 13, color: S.subtle }}>
          <span>Started <strong style={{ color: S.ink, fontWeight: 600 }}>May 19</strong></span>
          <span>ETA <strong style={{ color: S.ink, fontWeight: 600 }}>Fri</strong></span>
          <span>14 decisions · <strong style={{ color: S.sage, fontWeight: 600 }}>13 resolved</strong></span>
        </div>
      </div>

      <div style={{ flex: 1, padding: '14px 32px 36px', display: 'flex', gap: 22 }}>
        <Bay name="Shape it" status="Complete" statusColor={S.sage} statusBg={S.sageSoft}
          focus="Idea brief signed off. Data model and project scope locked in."
          crew={[
            { name: 'Architect', color: '#3D7AB0', state: 'Standby' },
            { name: 'Brief Writer', color: '#C25B5B', state: 'Standby' },
            { name: 'Researcher', color: '#9C7CC8', state: 'Standby' },
          ]}
          accent={S.sage} accentSoft={S.sageSoft} emoji="✓">
          <div style={{ borderTop: `1px solid ${S.hair}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: S.subtle, marginBottom: 2 }}>Artifacts</div>
            <a style={{ fontSize: 13, color: S.ink, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}><span>📄</span> Idea brief · v3</a>
            <a style={{ fontSize: 13, color: S.ink, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}><span>🗂</span> Data model</a>
            <a style={{ fontSize: 13, color: S.ink, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}><span>✦</span> 4 scope decisions</a>
          </div>
        </Bay>

        <Bay name="Build it" status="Active" statusColor={S.sage} statusBg={S.sageSoft} primary
          focus="Wiring up the invoice line-item table. 4 of 7 components done. Math passing, PDF rendering."
          crew={[
            { name: 'Architect', color: '#3D7AB0', state: 'Standby' },
            { name: 'Builder', color: S.sage, state: 'Active' },
            { name: 'Inspector', color: '#9C7CC8', state: 'Active' },
            { name: 'Documentarian', color: '#E0995C', state: 'Active' },
          ]}
          accent={S.sage} accentSoft={S.sageSoft} emoji="🔨">

          <div>
            <div style={{ fontSize: 11, fontWeight: 500, color: S.subtle, marginBottom: 8 }}>Pipeline · 5 steps</div>
            <div style={{ display: 'flex', gap: 5 }}>
              {[
                { k: 'Scaffold', s: 'done' },
                { k: 'Wire data', s: 'done' },
                { k: 'Components', s: 'active' },
                { k: 'Integrate', s: 'next' },
                { k: 'QA pass', s: 'next' },
              ].map(p => (
                <div key={p.k} style={{
                  flex: 1, padding: '7px 6px', textAlign: 'center', borderRadius: 10,
                  fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
                  background: p.s === 'done' ? S.sageSoft : p.s === 'active' ? S.sage : S.hair,
                  color: p.s === 'done' ? S.sage : p.s === 'active' ? '#fff' : S.faint,
                }}>{p.k}</div>
              ))}
            </div>
          </div>

          {/* Decision */}
          <div style={{ background: S.amberSoft, borderRadius: 14, padding: '14px 16px', border: `1.5px solid ${S.amber}55` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <Pill color={S.amber} bg="#fff" dot style={{ fontSize: 10 }}>Waiting on you</Pill>
            </div>
            <div style={{ fontSize: 14.5, color: S.ink, fontWeight: 600, lineHeight: 1.3 }}>Stripe Invoicing, or build the generator in-house?</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button style={{ padding: '8px 14px', borderRadius: 10, background: S.amber, color: '#fff', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Decide →</button>
              <button style={{ padding: '8px 14px', borderRadius: 10, background: 'transparent', color: S.subtle, border: `1px solid ${S.cardBorder}`, fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Defer</button>
            </div>
          </div>
        </Bay>

        <Bay name="Ship it" status="Locked" statusColor={S.faint} statusBg={S.hair} dim
          focus="Will open once Build it passes QA and you sign the readiness checklist."
          crew={[
            { name: 'Packager', color: S.faint, state: 'Sleep' },
            { name: 'Release Writer', color: S.faint, state: 'Sleep' },
            { name: 'Watchman', color: S.faint, state: 'Sleep' },
          ]}
          accent={S.faint} accentSoft={S.hair} emoji="🔒">
          <div style={{ borderTop: `1px solid ${S.hair}`, paddingTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: S.subtle, marginBottom: 8 }}>Unlocks when</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: S.subtle }}>
              <div>○ Build it closes QA gate</div>
              <div>○ Readiness checklist signed</div>
              <div>○ Handoff bundle requested</div>
            </div>
          </div>
        </Bay>
      </div>
    </SPage>
  );
}

Object.assign(window, { StudioMode, StudioEasy, StudioFactory });
