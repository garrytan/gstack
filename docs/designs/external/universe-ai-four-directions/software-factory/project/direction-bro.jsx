// BUILD IT BRO — dorm-room whiteboard energy
// Notebook paper + sharpie + highlighter yellow + hi-vis green + post-it
// Archivo Black headlines · Caveat handwritten annotations · chunky borders
// "Don't drop out — just build it bro™"
// ─────────────────────────────────────────────────────────────

const Bro = {
  paper: '#F1ECDC',
  white: '#FFFFFF',
  sharpie: '#0F0E0C',
  highlight: '#FCE74C',
  hivis: '#C7F141',
  marker: '#E63946',
  locker: '#2E5BFF',
  faint: '#8F8B7E',
  subtle: '#5F5C52',
  postit: '#FFF494',
  rule: 'rgba(46,91,255,0.18)',
};

const brF = {
  display: { fontFamily: "'Archivo Black', 'Inter', sans-serif", letterSpacing: '-0.02em', textTransform: 'uppercase' },
  ui: { fontFamily: "'Inter', system-ui, sans-serif" },
  scrawl: { fontFamily: "'Caveat', cursive", fontWeight: 600 },
  marker: { fontFamily: "'Permanent Marker', cursive" },
  mono: { fontFamily: "'JetBrains Mono', ui-monospace, monospace" },
};

// Highlighter swipe
const HL = ({ children, color = Bro.highlight }) => (
  <span style={{
    background: `linear-gradient(transparent 58%, ${color} 58%, ${color} 92%, transparent 92%)`,
    padding: '0 4px', display: 'inline',
  }}>{children}</span>
);

// Sticker / chunky black-border block with offset shadow
const Sticker = ({ children, bg = Bro.white, color = Bro.sharpie, rotate = 0, shadow = 5, style = {}, padding = '4px 12px' }) => (
  <div style={{
    display: 'inline-block', background: bg, color, padding,
    border: `3px solid ${Bro.sharpie}`, boxShadow: `${shadow}px ${shadow}px 0 ${Bro.sharpie}`,
    transform: `rotate(${rotate}deg)`,
    ...brF.display, fontSize: 12,
    ...style,
  }}>{children}</div>
);

// Loud chunky button
const BroBtn = ({ children, bg = Bro.hivis, color = Bro.sharpie, style = {} }) => (
  <button style={{
    background: bg, color, border: `3px solid ${Bro.sharpie}`,
    boxShadow: `4px 4px 0 ${Bro.sharpie}`,
    padding: '12px 18px', cursor: 'pointer',
    ...brF.display, fontSize: 13, letterSpacing: '0.02em',
    textTransform: 'uppercase',
    ...style,
  }}>{children}</button>
);

// Hand-drawn arrow svg
const Scrawl = ({ children, color = Bro.marker, size = 22, rotate = -3, style = {} }) => (
  <span style={{ ...brF.scrawl, fontSize: size, color, transform: `rotate(${rotate}deg)`, display: 'inline-block', lineHeight: 1, ...style }}>
    {children}
  </span>
);

const BroPage = ({ children }) => (
  <div style={{
    width: '100%', height: '100%', background: Bro.paper, color: Bro.sharpie,
    backgroundImage: `repeating-linear-gradient(transparent, transparent 27px, ${Bro.rule} 27px, ${Bro.rule} 28px)`,
    ...brF.ui, fontSize: 14, lineHeight: 1.5,
    display: 'flex', flexDirection: 'column',
    position: 'relative', overflow: 'hidden',
  }}>
    {/* Left margin red line — like notebook paper */}
    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 48, width: 1.5, background: Bro.marker, opacity: 0.5 }} />
    {/* Three-hole punch dots */}
    {[120, 480, 840].map((y, i) => (
      <div key={i} style={{ position: 'absolute', left: 18, top: y, width: 14, height: 14, borderRadius: '50%', background: Bro.paper, border: `1.5px solid ${Bro.faint}`, opacity: 0.6 }} />
    ))}
    {children}
  </div>
);

const BroTopBar = ({ project, mode }) => (
  <div style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 36px 14px 76px', borderBottom: `2px solid ${Bro.sharpie}`,
    background: Bro.paper,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <Sticker bg={Bro.sharpie} color={Bro.hivis} rotate={-2} padding="6px 12px" shadow={3} style={{ fontSize: 14 }}>BUILD IT BRO™</Sticker>
      <span style={{ ...brF.mono, fontSize: 11, color: Bro.subtle, letterSpacing: '0.06em' }}>//</span>
      <span style={{ ...brF.scrawl, fontSize: 22, color: Bro.sharpie }}>{project}</span>
    </div>
    {mode && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Scrawl color={Bro.subtle} size={16} rotate={-1}>mode:</Scrawl>
        <Sticker bg={mode === 'easy' ? Bro.hivis : Bro.postit} color={Bro.sharpie} rotate={mode === 'easy' ? -2 : 2} padding="6px 14px" shadow={3} style={{ fontSize: 13 }}>
          {mode === 'easy' ? 'LET ME COOK' : 'I GOT THIS'}
        </Sticker>
      </div>
    )}
  </div>
);

// ── Screen 1: Mode picker ────────────────────────────────────
function BroMode() {
  const Card = ({ kind, slogan, scrawlNote, scrawlAngle, body, bullets, primary, ribbon, accent, rotate, broCount, btn }) => (
    <div style={{
      flex: 1, background: Bro.white, border: `4px solid ${Bro.sharpie}`,
      boxShadow: `10px 10px 0 ${Bro.sharpie}`,
      padding: '28px 30px 28px', display: 'flex', flexDirection: 'column', gap: 18,
      position: 'relative', transform: `rotate(${rotate}deg)`,
    }}>
      {/* Tape strip top-left */}
      <div style={{
        position: 'absolute', top: -16, left: 28, width: 92, height: 26,
        background: 'rgba(255,236,61,0.55)', border: `1px dashed ${Bro.sharpie}55`,
        transform: 'rotate(-4deg)',
      }} />

      {/* Floating handwritten note */}
      <Scrawl color={Bro.marker} size={26} rotate={scrawlAngle} style={{ position: 'absolute', top: 16, right: 18, maxWidth: 170, textAlign: 'right' }}>
        {scrawlNote}
      </Scrawl>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
        <span style={{ ...brF.mono, fontSize: 11, color: Bro.subtle, letterSpacing: '0.18em', textTransform: 'uppercase' }}>{kind}</span>
        <div style={{ ...brF.display, fontSize: 88, lineHeight: 0.95, color: Bro.sharpie, marginTop: 2 }}>
          {slogan.split(' ').map((w, i) => i === slogan.split(' ').length - 1 ? <HL key={i} color={accent}>{w}</HL> : <span key={i}>{w} </span>)}
        </div>
      </div>

      <p style={{ fontSize: 15, color: Bro.sharpie, margin: 0, lineHeight: 1.55, maxWidth: 420 }}>{body}</p>

      <div style={{ borderTop: `2px solid ${Bro.sharpie}`, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {bullets.map((b, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ ...brF.display, color: accent === Bro.hivis ? Bro.sharpie : Bro.marker, fontSize: 18, lineHeight: 1, marginTop: 2 }}>▸</span>
            <span style={{ fontSize: 15, color: Bro.sharpie, lineHeight: 1.5 }}>{b}</span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Bro count + button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
        <Scrawl color={Bro.subtle} size={18} rotate={1}>{broCount}</Scrawl>
        <Sticker bg={accent} rotate={primary ? -2 : 2} padding="10px 16px" shadow={4} style={{ fontSize: 14, cursor: 'pointer' }}>{btn} →</Sticker>
      </div>
    </div>
  );

  return (
    <BroPage>
      <BroTopBar project="Astra — billing portal for solar installers" />

      <div style={{ flex: 1, padding: '40px 60px 32px 80px', display: 'flex', flexDirection: 'column', gap: 26, position: 'relative' }}>
        {/* Floating sticker */}
        <Sticker bg={Bro.marker} color={Bro.white} rotate={-6} padding="6px 14px" shadow={4} style={{ position: 'absolute', top: 28, right: 60, fontSize: 12 }}>NEW PROJECT</Sticker>

        {/* Title block */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 1000 }}>
          <Scrawl color={Bro.subtle} size={24} rotate={-2} style={{ marginBottom: 4 }}>real quick before we cook —</Scrawl>
          <h1 style={{ ...brF.display, fontSize: 116, lineHeight: 0.92, margin: 0, color: Bro.sharpie }}>
            YO. <HL>HOW WE</HL> BUILDING THIS?
          </h1>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 6 }}>
            <span style={{ fontSize: 16, color: Bro.subtle, maxWidth: 700 }}>
              Two lanes to ship Astra. Same destination — billing portal that works, customers paid, you back to studying. Switch lanes whenever.
            </span>
          </div>
        </div>

        {/* Cards row */}
        <div style={{ display: 'flex', gap: 36, padding: '18px 12px 28px', flex: 1 }}>
          <Card
            kind="OPTION A · CONCIERGE"
            slogan="LET ME COOK"
            scrawlNote="← pick this 99% of the time"
            scrawlAngle={-6}
            accent={Bro.hivis}
            rotate={-1}
            body="Universe drives the build. I tell you what's happening in plain English. You only get pulled in for stuff only YOU can decide — name, brand voice, payment provider."
            bullets={[
              "I pick the defaults · I explain them like you're a freshman",
              "You answer ~3 questions across the whole project",
              "Friendly feed shows what just shipped",
            ]}
            broCount="~3 decisions / project"
            btn="LET ME COOK"
            primary
          />
          <Card
            kind="OPTION B · COCKPIT"
            slogan="I GOT THIS"
            scrawlNote="full keyboard warrior mode"
            scrawlAngle={5}
            accent={Bro.postit}
            rotate={1.2}
            body="The whole lab opens up. Three rooms, every crew member, every step exposed. You sign off on everything. You can yell at the build mid-step (it's allowed)."
            bullets={[
              "All 3 rooms open: shape it · build it · ship it",
              "You sign off at every step before the next one starts",
              "Full audit trail · diffs · QA evidence · the works",
            ]}
            broCount="~14 decisions / project"
            btn="I GOT THIS"
          />
        </div>

        {/* Footer scrawl */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderTop: `2px solid ${Bro.sharpie}`, paddingTop: 14, marginTop: 4 }}>
          <Scrawl size={28} color={Bro.sharpie} rotate={-1.5}>🎓 don't drop out · just build it bro™</Scrawl>
          <span style={{ ...brF.mono, fontSize: 11, color: Bro.subtle, letterSpacing: '0.12em' }}>v0.1 · ASTRA · 22 MAY '26</span>
        </div>
      </div>
    </BroPage>
  );
}

// ── Screen 2: Easy in-flight ─────────────────────────────────
function BroEasy() {
  const Log = ({ tag, tagBg, who, msg, when }) => (
    <div style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: `2px dashed ${Bro.sharpie}33`, alignItems: 'center' }}>
      <Sticker bg={tagBg} color={Bro.sharpie} padding="3px 8px" rotate={-2} shadow={2} style={{ fontSize: 10, minWidth: 70, textAlign: 'center' }}>{tag}</Sticker>
      <span style={{ fontSize: 14, color: Bro.sharpie, flex: 1 }}>
        <strong style={{ ...brF.display, textTransform: 'uppercase', letterSpacing: '0.02em', fontSize: 12, marginRight: 6 }}>{who}</strong>
        {msg}
      </span>
      <span style={{ ...brF.mono, fontSize: 11, color: Bro.subtle, whiteSpace: 'nowrap' }}>{when}</span>
    </div>
  );

  return (
    <BroPage>
      <BroTopBar project="Astra — billing portal" mode="easy" />

      <div style={{ flex: 1, padding: '24px 50px 36px 80px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        {/* Hero — current activity */}
        <div style={{
          background: Bro.white, border: `4px solid ${Bro.sharpie}`,
          boxShadow: `10px 10px 0 ${Bro.sharpie}`,
          padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 18,
          position: 'relative',
        }}>
          {/* Tape strips */}
          <div style={{ position: 'absolute', top: -14, left: 60, width: 90, height: 22, background: 'rgba(255,236,61,0.6)', border: `1px dashed ${Bro.sharpie}55`, transform: 'rotate(-3deg)' }} />
          <div style={{ position: 'absolute', top: -14, right: 80, width: 90, height: 22, background: 'rgba(255,236,61,0.6)', border: `1px dashed ${Bro.sharpie}55`, transform: 'rotate(4deg)' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Sticker bg={Bro.hivis} rotate={-2} padding="6px 14px" shadow={4} style={{ fontSize: 13 }}>● COOKING 🔥</Sticker>
            <Scrawl color={Bro.subtle} size={18} rotate={2}>started 4 min ago</Scrawl>
          </div>

          <h1 style={{ ...brF.display, fontSize: 64, lineHeight: 0.95, margin: 0, color: Bro.sharpie, maxWidth: 1100 }}>
            WIRING UP YOUR <HL>INVOICE TABLE</HL> — THE THING THAT BREAKS DOWN PANELS, INVERTERS, LABOR HOURS.
          </h1>

          {/* Progress */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4 }}>
            <div style={{ flex: 1, height: 22, background: Bro.white, border: `3px solid ${Bro.sharpie}`, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, width: '62%', background: Bro.hivis, borderRight: `3px solid ${Bro.sharpie}` }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', ...brF.display, fontSize: 12, color: Bro.sharpie }}>62% — WE LOCKED IN</div>
            </div>
            <Scrawl color={Bro.marker} size={26} rotate={-3}>let's gooo →</Scrawl>
          </div>
        </div>

        {/* Two columns */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 24, flex: 1 }}>
          {/* Activity */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h3 style={{ ...brF.display, fontSize: 32, margin: 0, color: Bro.sharpie }}>THE BOYS BEEN BUSY</h3>
              <Scrawl color={Bro.subtle} size={18} rotate={-1}>last 30 min ↓</Scrawl>
            </div>
            <div style={{ background: Bro.white, border: `3px solid ${Bro.sharpie}`, padding: '8px 22px 14px', boxShadow: `6px 6px 0 ${Bro.sharpie}` }}>
              <Log tag="BUILD" tagBg={Bro.hivis} who="builder" msg="scaffolded the /invoices route + 4 react components. clean." when="4 min ago" />
              <Log tag="TEST" tagBg={Bro.postit} who="inspector" msg="wrote 6 tests on the line-item math. 6/6 passing. no cap." when="18 min ago" />
              <Log tag="SHAPE" tagBg="#D4E7FF" who="architect" msg="locked the data model — Invoice → LineItem → Adjustment." when="32 min ago" />
              <Log tag="GATE ✓" tagBg={Bro.hivis} who="you" msg="signed off the data model. W move." when="38 min ago" />
            </div>
          </div>

          {/* Right rail */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Decision — post-it style */}
            <div style={{
              background: Bro.postit, border: `4px solid ${Bro.sharpie}`,
              boxShadow: `8px 8px 0 ${Bro.sharpie}`, padding: '22px 24px',
              transform: 'rotate(-1.5deg)', display: 'flex', flexDirection: 'column', gap: 12,
              position: 'relative',
            }}>
              <Scrawl color={Bro.marker} size={28} rotate={6} style={{ position: 'absolute', top: -22, right: -8 }}>!!</Scrawl>
              <Sticker bg={Bro.sharpie} color={Bro.hivis} rotate={-3} padding="5px 12px" shadow={3} style={{ fontSize: 11, alignSelf: 'flex-start' }}>● YO BRO — QUICK QUESTION</Sticker>
              <h4 style={{ ...brF.display, fontSize: 26, lineHeight: 1.05, margin: 0, color: Bro.sharpie }}>STRIPE INVOICING, OR WE BUILD THE INVOICE THING OURSELVES?</h4>
              <p style={{ fontSize: 13.5, color: Bro.sharpie, margin: 0, lineHeight: 1.55 }}>
                <strong>my take:</strong> ride Stripe. ships in a day, handles tax + reminders. costs 0.5% + $0.30 / invoice. building in-house = ~3 day grind, $0 / invoice, fully your brand on the PDF.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                <BroBtn bg={Bro.hivis}>RIDE WITH STRIPE →</BroBtn>
                <BroBtn bg={Bro.white}>NAH, WE COOK IT</BroBtn>
                <button style={{ background: 'transparent', border: 'none', ...brF.mono, fontSize: 11, color: Bro.subtle, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline' }}>defer 1 hr — lemme think</button>
              </div>
            </div>

            {/* Up next */}
            <div style={{ background: Bro.white, border: `3px solid ${Bro.sharpie}`, padding: '14px 18px 16px', boxShadow: `5px 5px 0 ${Bro.sharpie}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <h4 style={{ ...brF.display, fontSize: 16, margin: 0 }}>UP NEXT · IN THE QUEUE</h4>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: `2px dashed ${Bro.sharpie}33`, fontSize: 13 }}>
                <span>email receipt + tax line</span>
                <Sticker bg={Bro.paper} padding="2px 8px" rotate={0} shadow={0} style={{ fontSize: 10, boxShadow: 'none' }}>BUILD</Sticker>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: `2px dashed ${Bro.sharpie}33`, fontSize: 13, opacity: 0.7 }}>
                <span>browser QA pass on /invoices</span>
                <Sticker bg={Bro.paper} padding="2px 8px" rotate={0} shadow={0} style={{ fontSize: 10, boxShadow: 'none' }}>TEST</Sticker>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BroPage>
  );
}

// ── Screen 3: Factory three-room ─────────────────────────────
function BroFactory() {
  const Room = ({ num, name, status, statusBg, focus, crew, primary, dim, rotate, accent, broLine, children }) => (
    <div style={{
      flex: primary ? 1.4 : 1, background: primary ? Bro.white : Bro.paper,
      border: `${primary ? 5 : 3}px solid ${Bro.sharpie}`,
      boxShadow: `${primary ? 10 : 6}px ${primary ? 10 : 6}px 0 ${Bro.sharpie}`,
      padding: '22px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14,
      position: 'relative', transform: `rotate(${rotate}deg)`,
      opacity: dim ? 0.7 : 1,
    }}>
      {/* Door tag */}
      <div style={{ position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)' }}>
        <Sticker bg={statusBg} rotate={-3} padding="5px 12px" shadow={3} style={{ fontSize: 11 }}>{status}</Sticker>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
        <span style={{ ...brF.mono, fontSize: 11, color: Bro.subtle, letterSpacing: '0.18em' }}>ROOM #{num}</span>
        <Scrawl color={Bro.subtle} size={16} rotate={2}>{broLine}</Scrawl>
      </div>

      <h2 style={{ ...brF.display, fontSize: primary ? 56 : 40, lineHeight: 0.95, margin: 0, color: Bro.sharpie }}>
        {primary ? <HL color={accent}>{name}</HL> : name}
      </h2>

      <p style={{ fontSize: 13.5, color: Bro.sharpie, margin: 0, lineHeight: 1.5, minHeight: 50 }}>{focus}</p>

      <div>
        <div style={{ ...brF.display, fontSize: 11, color: Bro.subtle, marginBottom: 6, letterSpacing: '0.08em' }}>THE CREW</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {crew.map((c, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1.5px dashed ${Bro.sharpie}33`, fontSize: 13 }}>
              <span>{c.name}</span>
              <span style={{ ...brF.mono, fontSize: 10, color: c.state === 'COOKING' ? Bro.sharpie : Bro.faint, letterSpacing: '0.12em' }}>
                {c.state === 'COOKING' && <span style={{ marginRight: 4, color: Bro.marker }}>●</span>}
                {c.state}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1 }} />
      {children}
    </div>
  );

  return (
    <BroPage>
      <BroTopBar project="Astra — billing portal" mode="hands" />

      <div style={{ flex: 1, padding: '24px 50px 30px 80px', display: 'flex', flexDirection: 'column', gap: 18 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Scrawl color={Bro.subtle} size={22} rotate={-2}>welcome to the lab —</Scrawl>
            <h1 style={{ ...brF.display, fontSize: 80, lineHeight: 0.95, margin: '4px 0 0', color: Bro.sharpie }}>
              ALL <HL color={Bro.hivis}>THREE ROOMS</HL> · WE IN ROOM 2.
            </h1>
            <span style={{ fontSize: 14, color: Bro.subtle, marginTop: 6, display: 'inline-block' }}>
              hands-on mode · day 3 of ~5 · the boys still cooking
            </span>
          </div>
          <Sticker bg={Bro.marker} color={Bro.white} rotate={-7} padding="8px 14px" shadow={4} style={{ fontSize: 13 }}>ETA · FRI ⚡</Sticker>
        </div>

        {/* Rooms */}
        <div style={{ flex: 1, display: 'flex', gap: 32, padding: '24px 4px 8px' }}>
          <Room num="01" name="SHAPE IT" status="✓ DONE" statusBg={Bro.hivis}
            focus="Idea brief locked. data model + scope sealed. crew chilling on the bench, ready for the next call."
            crew={[
              { name: 'Architect', state: 'BENCH' },
              { name: 'Brief Writer', state: 'BENCH' },
              { name: 'Researcher', state: 'BENCH' },
            ]}
            rotate={-1.5} accent={Bro.hivis} broLine="we cooked"
          >
            <div style={{ borderTop: `2px solid ${Bro.sharpie}`, paddingTop: 10 }}>
              <div style={{ ...brF.display, fontSize: 11, color: Bro.subtle, marginBottom: 6 }}>STUFF WE MADE</div>
              <div style={{ ...brF.mono, fontSize: 11, color: Bro.sharpie, lineHeight: 1.7 }}>
                <div>📎 idea_brief.md · v3</div>
                <div>📎 data_model.dbml</div>
                <div>📎 scope_decisions (4)</div>
              </div>
            </div>
          </Room>

          <Room num="02" name="BUILD IT" status="🔥 COOKING" statusBg={Bro.hivis}
            focus="Wiring the invoice line-item table. 4 of 7 components ✓. invoice.pdf renders. math passing. clean run."
            crew={[
              { name: 'Architect', state: 'BENCH' },
              { name: 'Builder', state: 'COOKING' },
              { name: 'Inspector', state: 'COOKING' },
              { name: 'Documentarian', state: 'COOKING' },
            ]}
            rotate={0.5} accent={Bro.hivis} primary broLine="↓ where we at"
          >
            {/* Pipeline */}
            <div>
              <div style={{ ...brF.display, fontSize: 11, color: Bro.subtle, marginBottom: 8 }}>PIPELINE · 5 STEPS</div>
              <div style={{ display: 'flex', gap: 5 }}>
                {[
                  { k: 'Scaffold', s: 'done' },
                  { k: 'Wire data', s: 'done' },
                  { k: 'Components', s: 'active' },
                  { k: 'Integrate', s: 'next' },
                  { k: 'QA pass', s: 'next' },
                ].map(p => (
                  <div key={p.k} style={{
                    flex: 1, padding: '6px 4px', textAlign: 'center',
                    ...brF.display, fontSize: 9, letterSpacing: '0.04em',
                    background: p.s === 'done' ? Bro.hivis : p.s === 'active' ? Bro.sharpie : Bro.white,
                    color: p.s === 'active' ? Bro.hivis : Bro.sharpie,
                    border: `2px solid ${Bro.sharpie}`,
                  }}>{p.k}</div>
                ))}
              </div>
            </div>

            {/* Decision callout */}
            <div style={{ background: Bro.postit, border: `3px solid ${Bro.sharpie}`, boxShadow: `5px 5px 0 ${Bro.sharpie}`, padding: '12px 14px', transform: 'rotate(-1deg)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Sticker bg={Bro.sharpie} color={Bro.hivis} rotate={-3} padding="3px 8px" shadow={2} style={{ fontSize: 10 }}>● YO — 1 THING</Sticker>
                <Scrawl color={Bro.marker} size={20} rotate={5}>!!</Scrawl>
              </div>
              <div style={{ ...brF.display, fontSize: 17, color: Bro.sharpie, lineHeight: 1.15 }}>STRIPE OR WE COOK IT?</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <BroBtn bg={Bro.hivis} style={{ padding: '7px 12px', fontSize: 11 }}>DECIDE →</BroBtn>
                <BroBtn bg={Bro.white} style={{ padding: '7px 12px', fontSize: 11 }}>DEFER</BroBtn>
              </div>
            </div>
          </Room>

          <Room num="03" name="SHIP IT" status="🔒 PRE-GAME" statusBg={Bro.paper} dim
            focus="Locked. Unlocks when Room 2 passes QA and you sign the readiness checklist. The boys napping until then."
            crew={[
              { name: 'Packager', state: 'NAPPING' },
              { name: 'Release Writer', state: 'NAPPING' },
              { name: 'Watchman', state: 'NAPPING' },
            ]}
            rotate={1.5} accent={Bro.postit} broLine="not yet, bro"
          >
            <div style={{ borderTop: `2px solid ${Bro.sharpie}`, paddingTop: 10 }}>
              <div style={{ ...brF.display, fontSize: 11, color: Bro.subtle, marginBottom: 6 }}>UNLOCKS WHEN</div>
              <div style={{ fontSize: 13, color: Bro.subtle, lineHeight: 1.7 }}>
                <div>☐ Room 2 closes QA gate</div>
                <div>☐ readiness signed</div>
                <div>☐ handoff bundle requested</div>
              </div>
            </div>
          </Room>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `2px solid ${Bro.sharpie}`, paddingTop: 12 }}>
          <Scrawl size={22} color={Bro.sharpie} rotate={-1}>🎓 don't drop out · just build it bro™</Scrawl>
          <span style={{ ...brF.mono, fontSize: 11, color: Bro.subtle, letterSpacing: '0.12em' }}>ASTRA · ROOM 2 · DAY 3 OF 5</span>
        </div>
      </div>
    </BroPage>
  );
}

Object.assign(window, { BroMode, BroEasy, BroFactory });
