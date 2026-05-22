// Operator — Bloomberg meets a flight deck
// Graphite ground, paper text, mono primary. Status-light color used surgically.
// For pros who run multiple projects; loud at gates because everywhere else is quiet.
// ─────────────────────────────────────────────────────────────

const O = {
  bg: '#0E0F11',
  panel: '#16181B',
  panelDeep: '#1B1D21',
  border: '#2A2D31',
  hair: '#22252A',
  ink: '#E8E8E6',
  text: '#C8CACC',
  subtle: '#8A8E94',
  faint: '#555960',
  ghost: '#3A3D42',
  green: '#5BE38A',
  amber: '#F5B454',
  red: '#EF5B5B',
  cyan: '#6CDFE6',
  blue: '#7BB7FF',
};

const oFont = {
  mono: { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
  ui: { fontFamily: "'Inter', system-ui, sans-serif" },
};

const oTag = (color, label) => (
  <span style={{ ...oFont.mono, fontSize: 10, letterSpacing: '0.12em', padding: '2px 6px', border: `1px solid ${color}`, color, textTransform: 'uppercase' }}>{label}</span>
);

const oDot = (color, size = 8) => (
  <span style={{ display: 'inline-block', width: size, height: size, borderRadius: 99, background: color, boxShadow: `0 0 0 3px ${color}22` }} />
);

const OPage = ({ children }) => (
  <div style={{
    width: '100%', height: '100%', background: O.bg, color: O.ink,
    ...oFont.ui, fontSize: 13, lineHeight: 1.5,
    display: 'flex', flexDirection: 'column',
  }}>{children}</div>
);

const OTopBar = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px', borderBottom: `1px solid ${O.border}`, background: O.panel }}>
    <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
      <span style={{ ...oFont.mono, fontSize: 11, color: O.cyan, letterSpacing: '0.18em' }}>UNIVERSE//</span>
      <span style={{ ...oFont.mono, fontSize: 11, color: O.subtle }}>session_id 8a2f · uptime 3d 04h · 22 events/min</span>
    </div>
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', ...oFont.mono, fontSize: 11, color: O.subtle }}>
      {children}
    </div>
  </div>
);

// ── Screen 1: Mode picker ────────────────────────────────────
function OperatorMode() {
  const Col = ({ id, badge, badgeColor, title, sub, body, metrics, bullets, primary }) => (
    <div style={{ flex: 1, background: O.panel, border: `1px solid ${O.border}`, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ ...oFont.mono, fontSize: 11, color: O.subtle, letterSpacing: '0.12em' }}>MODE.{id}</span>
        {oTag(badgeColor, badge)}
      </div>

      <div>
        <div style={{ ...oFont.ui, fontWeight: 800, fontSize: 56, lineHeight: 1, letterSpacing: '-0.025em', color: O.ink }}>{title}</div>
        <div style={{ ...oFont.mono, fontSize: 12, color: O.subtle, marginTop: 8, letterSpacing: '0.04em' }}>{sub}</div>
      </div>

      <div style={{ ...oFont.mono, fontSize: 12.5, color: O.text, lineHeight: 1.65, maxWidth: 440 }}>{body}</div>

      {/* Metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderTop: `1px solid ${O.hair}`, borderBottom: `1px solid ${O.hair}` }}>
        {metrics.map((m, i) => (
          <div key={i} style={{ padding: '14px 0', borderRight: i < 2 ? `1px solid ${O.hair}` : 'none' }}>
            <div style={{ ...oFont.mono, fontSize: 9, color: O.faint, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{m.k}</div>
            <div style={{ ...oFont.mono, fontWeight: 600, fontSize: 22, color: O.ink, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{m.v}</div>
            <div style={{ ...oFont.mono, fontSize: 10, color: m.tone || O.subtle, marginTop: 2 }}>{m.u}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <span style={{ ...oFont.mono, fontSize: 10, color: O.faint }}>{'>>'.padStart(2)}</span>
            <span style={{ fontSize: 13, color: O.text, lineHeight: 1.5 }}>{b}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <button style={{
        padding: '14px 18px', background: primary ? O.cyan : 'transparent',
        color: primary ? O.bg : O.cyan, border: `1px solid ${O.cyan}`,
        ...oFont.mono, fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
        fontWeight: 600, cursor: 'pointer', textAlign: 'left'
      }}>
        [ init {title.toLowerCase()} ] →
      </button>
    </div>
  );

  return (
    <OPage>
      <OTopBar>
        <span>astra.proj <span style={{ color: O.faint }}>·</span> awaiting_mode_select</span>
        {oDot(O.amber)}
      </OTopBar>

      <div style={{ flex: 1, padding: '40px 48px 48px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div>
          <div style={{ ...oFont.mono, fontSize: 11, color: O.cyan, letterSpacing: '0.18em' }}>$ universe init --project=astra</div>
          <h1 style={{ ...oFont.ui, fontWeight: 800, fontSize: 64, margin: '12px 0 8px', letterSpacing: '-0.03em', color: O.ink, lineHeight: 1 }}>
            select an operating mode
          </h1>
          <div style={{ ...oFont.mono, fontSize: 13, color: O.subtle, maxWidth: 720 }}>
            Astra — Billing portal for solar installers. <span style={{ color: O.text }}>One-time decision.</span> Switch any time via top bar. Default kernel: <span style={{ color: O.cyan }}>haiku-4-5</span> · <span style={{ color: O.cyan }}>opus-4-1</span> for gates.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 24, flex: 1 }}>
          <Col id="01" badge="Concierge" badgeColor={O.amber} title="EASY" sub="universe drives · you sign gates only"
            body="// Background crew runs unattended. You're paged only for decisions only a human can make: name, brand voice, billing provider, ship/no-ship."
            metrics={[
              { k: 'Gates / proj', v: '~3', u: 'human decisions' },
              { k: 'Decisions / day', v: '0.4', u: 'avg' },
              { k: 'Cockpit hours', v: '0', u: 'hidden by default', tone: O.green },
            ]}
            bullets={[
              'Project radio feed — what just happened, in plain English.',
              'Universe explains every default before applying it.',
              'You can drop into the cockpit at any moment via ⌘\\.',
            ]}
            primary
          />
          <Col id="02" badge="Cockpit" badgeColor={O.cyan} title="HANDS-ON" sub="full surface · approve every gate"
            body="// Three bays exposed. Phase pipeline, persona attribution, diff view, browser QA evidence. You approve at every transition; you can interrupt mid-step."
            metrics={[
              { k: 'Gates / proj', v: '~14', u: 'human decisions', tone: O.amber },
              { k: 'Decisions / day', v: '3.2', u: 'avg' },
              { k: 'Cockpit hours', v: '6+ /wk', u: 'expected', tone: O.cyan },
            ]}
            bullets={[
              'Bays: shape_it → build_it → ship_it. Sign-off gates between.',
              'Full audit trail. Persona attribution on every artifact.',
              'Diff view, log tail, browser QA timeline scrub.',
            ]}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', ...oFont.mono, fontSize: 11, color: O.subtle, borderTop: `1px solid ${O.hair}`, paddingTop: 12 }}>
          <span>⌘1 / ⌘2 to select · ↵ to confirm · esc to defer</span>
          <span>rev_01 · 22 may 2026</span>
        </div>
      </div>
    </OPage>
  );
}

// ── Screen 2: Easy in-flight ─────────────────────────────────
function OperatorEasy() {
  const logRow = (t, tag, tagColor, msg, persona) => (
    <div style={{ display: 'flex', gap: 14, padding: '10px 0', borderBottom: `1px dashed ${O.hair}`, ...oFont.mono, fontSize: 12 }}>
      <span style={{ color: O.faint, minWidth: 64 }}>{t}</span>
      <span style={{ minWidth: 72 }}>{oTag(tagColor, tag)}</span>
      <span style={{ flex: 1, color: O.text }}>{msg}</span>
      <span style={{ color: O.subtle, minWidth: 110, textAlign: 'right' }}>{persona}</span>
    </div>
  );

  const statusRow = (label, value, tone) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${O.hair}` }}>
      <span style={{ ...oFont.mono, fontSize: 10, color: O.faint, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ ...oFont.mono, fontSize: 12, color: tone || O.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );

  return (
    <OPage>
      <OTopBar>
        <span style={{ color: O.text }}>astra.proj</span>
        <span style={{ color: O.faint }}>·</span>
        {oTag(O.amber, 'EASY MODE')}
        <span style={{ color: O.faint }}>·</span>
        <span>bay_02/build_it</span>
        {oDot(O.green)}
      </OTopBar>

      {/* Status strip */}
      <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${O.border}`, background: O.panelDeep }}>
        {[
          { k: 'STATE', v: 'BUILDING', tone: O.green },
          { k: 'BAY', v: '02 · BUILD IT' },
          { k: 'STEP', v: 'invoice_table.wire' },
          { k: 'PROGRESS', v: '62%', tone: O.cyan },
          { k: 'WAITING_ON_YOU', v: '1 decision', tone: O.amber },
          { k: 'ETA', v: 'fri 14:00' },
          { k: 'BURN', v: '$2.41' },
        ].map((s, i) => (
          <div key={i} style={{ flex: 1, padding: '14px 18px', borderRight: i < 6 ? `1px solid ${O.border}` : 'none' }}>
            <div style={{ ...oFont.mono, fontSize: 9, color: O.faint, letterSpacing: '0.18em' }}>{s.k}</div>
            <div style={{ ...oFont.mono, fontSize: 14, color: s.tone || O.ink, marginTop: 6, fontWeight: 500 }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 360px', gap: 0 }}>
        {/* Log feed */}
        <div style={{ padding: '20px 24px', borderRight: `1px solid ${O.border}`, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
            <span style={{ ...oFont.mono, fontSize: 11, color: O.cyan, letterSpacing: '0.16em' }}>// PROJECT STREAM — last 30 min</span>
            <span style={{ ...oFont.mono, fontSize: 11, color: O.subtle }}>tail -f · paused for review</span>
          </div>

          {/* Active block — what's happening RIGHT NOW */}
          <div style={{ background: O.panel, border: `1px solid ${O.border}`, borderLeft: `3px solid ${O.green}`, padding: '16px 18px', marginBottom: 18 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
              {oDot(O.green)}
              <span style={{ ...oFont.mono, fontSize: 11, color: O.green, letterSpacing: '0.16em' }}>ACTIVE · BUILDER · started 4m12s ago</span>
            </div>
            <div style={{ ...oFont.ui, fontWeight: 600, fontSize: 22, color: O.ink, lineHeight: 1.25, letterSpacing: '-0.01em' }}>
              Wiring the invoice line-item table — panel, inverter, labor hour breakdown.
            </div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.subtle, marginTop: 8 }}>
              touched: <span style={{ color: O.cyan }}>src/Invoice.tsx</span> · <span style={{ color: O.cyan }}>api/invoices.ts</span> · <span style={{ color: O.cyan }}>db/migrations/0014</span>
            </div>
            <div style={{ marginTop: 12, height: 4, background: O.hair, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, width: '62%', background: O.green }} />
            </div>
          </div>

          {logRow('11:42', 'BUILD', O.cyan, 'Scaffolded /invoices route + InvoiceTable.tsx (4 components).', '— builder.v3')}
          {logRow('11:28', 'TEST', O.green, '6 unit tests on line-item math · all passing · 24ms.', '— inspector.v2')}
          {logRow('11:14', 'SHAPE', O.subtle, 'Data model locked · Invoice → LineItem → Adjustment.', '— architect.v3')}
          {logRow('10:52', 'GATE', O.amber, 'Gate cleared · data model approved by user.', '— you')}
          {logRow('10:31', 'BUILD', O.cyan, 'Generated migration 0013 · billing_accounts table.', '— builder.v3')}
          {logRow('10:08', 'TEST', O.green, 'Lint + typecheck clean across 14 files.', '— inspector.v2')}
        </div>

        {/* Right rail */}
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 24, background: O.panelDeep }}>
          {/* Waiting */}
          <div style={{ background: O.bg, border: `1px solid ${O.amber}`, padding: '16px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              {oDot(O.amber)}
              <span style={{ ...oFont.mono, fontSize: 10, color: O.amber, letterSpacing: '0.18em' }}>WAITING_ON_YOU [1]</span>
            </div>
            <div style={{ ...oFont.mono, fontSize: 9, color: O.faint, letterSpacing: '0.16em', marginBottom: 8 }}>DECISION · PAYMENT_PROCESSING</div>
            <div style={{ ...oFont.ui, fontWeight: 600, fontSize: 16, color: O.ink, lineHeight: 1.3 }}>
              Stripe Invoicing, or build the invoice generator in-house?
            </div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.subtle, marginTop: 10, lineHeight: 1.6 }}>
              recommendation: <span style={{ color: O.cyan }}>stripe</span> · faster ship, $0.50+0.5% per inv. in-house: 3+ day build, $0 per inv.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
              <button style={{ padding: '10px 12px', background: O.amber, color: O.bg, border: 'none', ...oFont.mono, fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>[ A ] use stripe invoicing →</button>
              <button style={{ padding: '10px 12px', background: 'transparent', color: O.text, border: `1px solid ${O.border}`, ...oFont.mono, fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', cursor: 'pointer', textAlign: 'left' }}>[ B ] build in-house</button>
              <button style={{ padding: '10px 12px', background: 'transparent', color: O.subtle, border: `1px solid ${O.hair}`, ...oFont.mono, fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', cursor: 'pointer', textAlign: 'left' }}>[ esc ] defer 1h</button>
            </div>
          </div>

          {/* Project status */}
          <div>
            <div style={{ ...oFont.mono, fontSize: 10, color: O.faint, letterSpacing: '0.18em', marginBottom: 8 }}>SESSION TELEMETRY</div>
            {statusRow('tokens_used', '184.2K', O.text)}
            {statusRow('test_pass_rate', '100%', O.green)}
            {statusRow('open_gates', '1', O.amber)}
            {statusRow('blocked', '0', O.green)}
            {statusRow('next_artifact', 'invoice.pdf', O.cyan)}
            {statusRow('crew_active', '3 of 4', O.text)}
          </div>

          {/* Up next */}
          <div>
            <div style={{ ...oFont.mono, fontSize: 10, color: O.faint, letterSpacing: '0.18em', marginBottom: 8 }}>UP_NEXT · QUEUED [2]</div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.subtle, padding: '8px 0', borderBottom: `1px solid ${O.hair}`, display: 'flex', justifyContent: 'space-between' }}>
              <span>email_receipt + tax_line</span>{oTag(O.subtle, 'BUILD')}
            </div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.subtle, padding: '8px 0', display: 'flex', justifyContent: 'space-between' }}>
              <span>browser_qa /invoices</span>{oTag(O.subtle, 'TEST')}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '10px 24px', borderTop: `1px solid ${O.border}`, ...oFont.mono, fontSize: 11, color: O.subtle, display: 'flex', justifyContent: 'space-between' }}>
        <span>⌘K command palette · ⌘\ open cockpit · ⌘. interrupt crew</span>
        <span>universe v3.4.0 · session 8a2f</span>
      </div>
    </OPage>
  );
}

// ── Screen 3: Factory three-bay ──────────────────────────────
function OperatorFactory() {
  const Bay = ({ id, name, status, statusColor, focus, crew, util, children, dim }) => (
    <div style={{ flex: status === 'ACTIVE' ? 1.5 : 1, background: O.panel, border: `1px solid ${status === 'ACTIVE' ? statusColor : O.border}`, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14, opacity: dim ? 0.55 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ ...oFont.mono, fontSize: 11, color: O.subtle, letterSpacing: '0.16em' }}>BAY.{id}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {oDot(statusColor)}
          <span style={{ ...oFont.mono, fontSize: 10, color: statusColor, letterSpacing: '0.18em' }}>{status}</span>
        </div>
      </div>

      <div style={{ ...oFont.ui, fontWeight: 800, fontSize: status === 'ACTIVE' ? 44 : 32, lineHeight: 1, letterSpacing: '-0.03em', color: O.ink }}>{name}</div>

      <div style={{ ...oFont.mono, fontSize: 12, color: O.text, lineHeight: 1.6, minHeight: 56 }}>{focus}</div>

      {/* Utilization */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ ...oFont.mono, fontSize: 9, color: O.faint, letterSpacing: '0.18em' }}>UTILIZATION</span>
          <span style={{ ...oFont.mono, fontSize: 11, color: statusColor, fontVariantNumeric: 'tabular-nums' }}>{util}%</span>
        </div>
        <div style={{ height: 3, background: O.hair }}>
          <div style={{ height: '100%', width: util + '%', background: statusColor }} />
        </div>
      </div>

      <div>
        <div style={{ ...oFont.mono, fontSize: 9, color: O.faint, letterSpacing: '0.18em', marginBottom: 6 }}>CREW · {crew.length}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {crew.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', ...oFont.mono, fontSize: 11, color: O.text, padding: '4px 0', borderBottom: `1px dashed ${O.hair}` }}>
              <span>{c.name}</span>
              <span style={{ color: c.state === 'busy' ? O.green : c.state === 'idle' ? O.faint : O.amber }}>{c.state}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />
      {children}
    </div>
  );

  return (
    <OPage>
      <OTopBar>
        <span style={{ color: O.text }}>astra.proj</span>
        <span style={{ color: O.faint }}>·</span>
        {oTag(O.cyan, 'HANDS-ON')}
        <span style={{ color: O.faint }}>·</span>
        <span>3 bays · 1 active</span>
        {oDot(O.green)}
      </OTopBar>

      <div style={{ padding: '24px 32px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{ ...oFont.mono, fontSize: 11, color: O.cyan, letterSpacing: '0.18em' }}>$ universe factory.show --all</div>
          <h1 style={{ ...oFont.ui, fontWeight: 800, fontSize: 48, margin: '8px 0 0', letterSpacing: '-0.03em', color: O.ink, lineHeight: 1 }}>
            ASTRA — bay_02/build_it active
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 24, ...oFont.mono, fontSize: 11, color: O.subtle }}>
          <span>started <span style={{ color: O.text }}>19 may 09:14</span></span>
          <span>eta <span style={{ color: O.cyan }}>fri 14:00</span></span>
          <span>tokens <span style={{ color: O.text }}>184.2K</span></span>
        </div>
      </div>

      <div style={{ flex: 1, padding: '12px 32px 32px', display: 'flex', gap: 20 }}>
        <Bay id="01" name="SHAPE_IT" status="DONE" statusColor={O.green} util={100}
          focus="// Idea brief signed off. Data model + scope locked. 4 decisions resolved."
          crew={[
            { name: 'architect.v3', state: 'idle' },
            { name: 'brief.v1', state: 'idle' },
            { name: 'researcher.v2', state: 'idle' },
          ]}>
          <div style={{ borderTop: `1px solid ${O.hair}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ ...oFont.mono, fontSize: 10, color: O.subtle }}>artifacts/</div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.cyan }}>├── idea_brief.md  <span style={{ color: O.faint }}>rev_03</span></div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.cyan }}>├── data_model.dbml</div>
            <div style={{ ...oFont.mono, fontSize: 11, color: O.cyan }}>└── scope_decisions/  <span style={{ color: O.faint }}>4 items</span></div>
          </div>
        </Bay>

        <Bay id="02" name="BUILD_IT" status="ACTIVE" statusColor={O.cyan} util={62}
          focus="// Wiring invoice_line_item_table. 4 of 7 components done. invoice.pdf renders, math passes."
          crew={[
            { name: 'architect.v3', state: 'idle' },
            { name: 'builder.v3', state: 'busy' },
            { name: 'inspector.v2', state: 'busy' },
            { name: 'documentarian.v1', state: 'busy' },
          ]}>
          {/* Phase pipeline */}
          <div>
            <div style={{ ...oFont.mono, fontSize: 9, color: O.faint, letterSpacing: '0.18em', marginBottom: 8 }}>PIPELINE</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { k: 'scaffold', s: 'done' },
                { k: 'wire_data', s: 'done' },
                { k: 'components', s: 'active' },
                { k: 'integrate', s: 'next' },
                { k: 'qa_pass', s: 'next' },
              ].map(p => (
                <div key={p.k} style={{
                  flex: 1, padding: '8px 6px', textAlign: 'center',
                  ...oFont.mono, fontSize: 9, letterSpacing: '0.1em',
                  border: `1px solid ${p.s === 'active' ? O.cyan : p.s === 'done' ? O.green : O.hair}`,
                  background: p.s === 'done' ? `${O.green}18` : p.s === 'active' ? `${O.cyan}22` : 'transparent',
                  color: p.s === 'done' ? O.green : p.s === 'active' ? O.cyan : O.subtle,
                  textTransform: 'uppercase',
                }}>{p.k}</div>
              ))}
            </div>
          </div>

          {/* Decision */}
          <div style={{ background: O.bg, border: `1px solid ${O.amber}`, padding: '12px 14px' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              {oDot(O.amber)}
              <span style={{ ...oFont.mono, fontSize: 10, color: O.amber, letterSpacing: '0.18em' }}>GATE · 1 DECISION PENDING</span>
            </div>
            <div style={{ ...oFont.ui, fontWeight: 600, fontSize: 15, color: O.ink, lineHeight: 1.3 }}>Stripe Invoicing, or in-house generator?</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button style={{ padding: '7px 12px', background: O.amber, color: O.bg, border: 'none', ...oFont.mono, fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700, cursor: 'pointer' }}>[ resolve ] →</button>
              <button style={{ padding: '7px 12px', background: 'transparent', color: O.subtle, border: `1px solid ${O.border}`, ...oFont.mono, fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase', cursor: 'pointer' }}>defer</button>
            </div>
          </div>

          {/* Log tail */}
          <div style={{ ...oFont.mono, fontSize: 11, color: O.subtle, lineHeight: 1.7 }}>
            <div><span style={{ color: O.faint }}>11:42</span> <span style={{ color: O.cyan }}>BUILD</span> scaffolded /invoices · InvoiceTable.tsx</div>
            <div><span style={{ color: O.faint }}>11:28</span> <span style={{ color: O.green }}>TEST</span> 6/6 passing · 24ms</div>
            <div><span style={{ color: O.faint }}>11:14</span> <span style={{ color: O.subtle }}>SHAPE</span> data model locked</div>
          </div>
        </Bay>

        <Bay id="03" name="SHIP_IT" status="LOCKED" statusColor={O.faint} util={0} dim
          focus="// Locked. Unlocks when bay_02 closes qa_pass gate + user signs readiness."
          crew={[
            { name: 'packager.v2', state: 'idle' },
            { name: 'release_writer.v1', state: 'idle' },
            { name: 'watchman.v3', state: 'idle' },
          ]}>
          <div style={{ borderTop: `1px solid ${O.hair}`, paddingTop: 10, ...oFont.mono, fontSize: 11, color: O.subtle, lineHeight: 1.7 }}>
            <div><span style={{ color: O.faint }}>preflight:</span></div>
            <div>├── qa_pass <span style={{ color: O.faint }}>[ ]</span></div>
            <div>├── readiness_signoff <span style={{ color: O.faint }}>[ ]</span></div>
            <div>└── handoff_bundle <span style={{ color: O.faint }}>[ ]</span></div>
          </div>
        </Bay>
      </div>

      <div style={{ padding: '10px 32px', borderTop: `1px solid ${O.border}`, ...oFont.mono, fontSize: 11, color: O.subtle, display: 'flex', justifyContent: 'space-between' }}>
        <span>↑↓ select bay · ↵ enter · g gate · i interrupt · ? help</span>
        <span>rev_01 · 22 may 2026 · 11:46:08 PT</span>
      </div>
    </OPage>
  );
}

Object.assign(window, { OperatorMode, OperatorEasy, OperatorFactory });
