// Simplified overview layer — sits ABOVE the technical cockpit.
// For non-technical users who don't want to watch the production line.
// Four variations + one layer-model diagram showing how simple ↔ detailed relate.

// ============================================================
// Mini shared bits
// ============================================================

// "Universe" orb — a single calm orb mark. Anthropomorphic but minimal.
const UniverseOrb = ({ size = 56, busy = false }) => (
  <div style={{
    width: size, height: size, borderRadius: '50%',
    border: '2px solid var(--ink)',
    background: 'radial-gradient(circle at 35% 30%, #fff 0%, var(--paper-2) 60%, var(--accent-soft) 100%)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'var(--hand)', fontWeight: 700, fontSize: size * 0.42,
    color: 'var(--ink)', flexShrink: 0,
    position: 'relative',
  }}>
    ✦
    {busy && (
      <span style={{
        position: 'absolute', bottom: -2, right: -2,
        width: size * 0.28, height: size * 0.28, borderRadius: '50%',
        background: 'var(--good)', border: '2px solid var(--paper)',
        boxShadow: '0 0 0 0 var(--good-soft)',
        animation: 'blink 1.6s ease-in-out infinite',
      }} />
    )}
  </div>
);

const SimpleProgress = ({ done = 4, total = 9, labels }) => (
  <div className="col gap-2" style={{ width: '100%' }}>
    <div className="row" style={{ gap: 4, alignItems: 'stretch', height: 18 }}>
      {Array.from({ length: total }, (_, i) => {
        const s = i < done ? 'done' : i === done ? 'active' : 'upcoming';
        return (
          <div key={i} style={{
            flex: 1,
            border: '1.5px solid var(--ink)',
            background: s === 'done' ? 'var(--good-soft)' : s === 'active' ? 'var(--marker)' : 'white',
            borderRadius: 4,
            position: 'relative',
          }}>
            {s === 'active' && (
              <span style={{
                position: 'absolute', top: -3, left: '50%', transform: 'translateX(-50%)',
                width: 6, height: 6, borderRadius: '50%', background: 'var(--ink)',
              }} />
            )}
          </div>
        );
      })}
    </div>
    {labels && (
      <div className="row between" style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-mute)' }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    )}
  </div>
);

// Soft, "shouldn't I be doing more?" reassurance pill
const CalmPill = ({ icon = '✓', kind = 'good', children }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '5px 11px', borderRadius: 999,
    background: kind === 'good' ? 'var(--good-soft)' : kind === 'warn' ? 'var(--warn-soft)' : 'var(--paper-2)',
    border: `1.5px solid ${kind === 'good' ? 'var(--good)' : kind === 'warn' ? 'var(--warn)' : 'var(--line-soft)'}`,
    fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600,
    color: kind === 'good' ? '#1c4e30' : kind === 'warn' ? '#6a4a08' : 'var(--ink)',
  }}>
    <span>{icon}</span>
    <span>{children}</span>
  </span>
);

// Reveals the "factory floor" — the detail layer below
const DetailsHandle = ({ label = 'Show factory floor', count }) => (
  <div className="row gap-2 items-center" style={{
    padding: '10px 14px',
    border: '1.5px dashed var(--line-soft)',
    borderRadius: 10,
    background: 'var(--paper-2)',
    fontFamily: 'var(--ui)', fontSize: 12,
    cursor: 'pointer',
    color: 'var(--ink-soft)',
  }}>
    <span style={{ fontFamily: 'var(--hand)', fontSize: 17, color: 'var(--accent)' }}>⌄</span>
    <span style={{ fontWeight: 600 }}>{label}</span>
    {count && <Chip kind="mute">{count}</Chip>}
    <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)', fontSize: 11 }}>
      timeline · personas · artifacts · raw output
    </span>
  </div>
);

// ============================================================
// SimpleA — Calm "Right now" card (single-focus)
// ============================================================
const SimpleA = () => (
  <div className="wf" style={{ width: '100%', height: '100%', display: 'flex' }}>
    <SideNav active="cockpit" />
    <div className="col grow" style={{ minWidth: 0 }}>
      <SafetyStrip mode="Read-only audit" subtle />

      {/* Header */}
      <div className="row between items-center" style={{
        padding: '16px 28px', borderBottom: '1.5px solid var(--line-soft)', background: 'white',
      }}>
        <div className="col" style={{ lineHeight: 1.2 }}>
          <span className="wf-label">Project</span>
          <h1 className="wf-h1" style={{ fontSize: 20 }}>Tutor Match — <span className="hand" style={{ fontSize: 26 }}>your MVP</span></h1>
        </div>
        <div className="row gap-3 items-center">
          <CalmPill kind="good" icon="◐">Day 2 of ~5</CalmPill>
          <span className="btn ghost sm">Pause</span>
          <span className="btn sm">Share</span>
        </div>
      </div>

      {/* Right-now hero */}
      <div className="col" style={{ padding: '32px 64px', gap: 28, flex: 1, background: 'var(--paper)' }}>
        <div className="row gap-5 items-center sketch-box" style={{ padding: '28px 32px', background: 'white' }}>
          <UniverseOrb size={84} busy />
          <div className="col" style={{ flex: 1, lineHeight: 1.25 }}>
            <span className="wf-label">Right now</span>
            <div style={{ fontFamily: 'var(--ui)', fontSize: 26, fontWeight: 600, marginTop: 6 }}>
              Universe is <u style={{ textDecorationColor: 'var(--marker)', textDecorationThickness: 6, textUnderlineOffset: 2 }}>building the tutor search</u>.
            </div>
            <div className="hand" style={{ fontSize: 22, color: 'var(--ink-soft)', marginTop: 8 }}>
              You can step away — I'll text you when I need you.
            </div>
          </div>
          <div className="col items-center gap-2">
            <span className="hand" style={{ fontSize: 36, color: 'var(--accent)' }}>~25m</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>until next check-in</span>
          </div>
        </div>

        {/* Progress strip */}
        <div className="col gap-3">
          <div className="row between items-center">
            <span className="wf-label">Where we are</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-mute)' }}>
              4 of 9 steps done · on track
            </span>
          </div>
          <SimpleProgress done={4} total={9} labels={['Shape', 'Plan', 'Design', 'Build', 'Review', 'Test', 'Fix', 'Ready', 'Hand off']} />
        </div>

        {/* Two-up: just finished / anything for me */}
        <div className="row gap-4">
          <div className="col gap-2 sketch-box thin" style={{ flex: 1, padding: 18, background: 'var(--paper)' }}>
            <div className="row between items-center">
              <span className="wf-label">Just finished</span>
              <Chip kind="good" dot>Approved</Chip>
            </div>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600 }}>Design review · screen mockups</span>
            <span className="hand" style={{ fontSize: 18, color: 'var(--ink-soft)' }}>
              Looks clean. 4 screens, matches your brief.
            </span>
            <span className="btn ghost sm" style={{ alignSelf: 'flex-start', marginTop: 4 }}>See what changed →</span>
          </div>

          <div className="col gap-2 sketch-box thin" style={{ flex: 1, padding: 18, background: 'var(--good-soft)', borderColor: 'var(--good)' }}>
            <div className="row between items-center">
              <span className="wf-label">Anything for me?</span>
              <Chip kind="good">All clear</Chip>
            </div>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600 }}>Nothing needs you right now.</span>
            <span className="hand" style={{ fontSize: 18, color: '#1c4e30' }}>
              Last decision was 38 min ago.
            </span>
            <span className="btn ghost sm" style={{ alignSelf: 'flex-start', marginTop: 4 }}>Past decisions (3) →</span>
          </div>
        </div>

        {/* Reveal */}
        <DetailsHandle label="Show factory floor" count="9 phases · 7 personas" />
      </div>

      <Note x={460} y={196} w={210} kind="" rotate={-2}>
        ★ one sentence answer to<br />"what's happening?"
      </Note>
      <Note x={92} y={398} w={210} kind="warn" rotate={1.5}>
        progress lives here<br />— compressed timeline
      </Note>
      <Note x={920} y={580} w={250} rotate={-1.5}>
        the "factory floor" handle reveals<br />the detailed cockpit underneath
      </Note>
    </div>
  </div>
);

// ============================================================
// SimpleB — Four big tiles / status dashboard
// ============================================================
const TileFrame = ({ tone = 'white', children, span = 1, accent }) => (
  <div className={`sketch-box ${tone === 'tilt' ? 'tilt' : ''}`} style={{
    padding: 20,
    background: tone === 'mark' ? 'var(--marker)' : tone === 'soft' ? 'var(--paper-2)' : tone === 'good' ? 'var(--good-soft)' : tone === 'warn' ? 'var(--warn-soft)' : 'white',
    borderColor: accent || 'var(--ink)',
    gridColumn: `span ${span}`,
    display: 'flex', flexDirection: 'column', gap: 10,
  }}>
    {children}
  </div>
);

const SimpleB = () => (
  <div className="wf" style={{ width: '100%', height: '100%', display: 'flex' }}>
    <SideNav active="cockpit" />
    <div className="col grow" style={{ minWidth: 0 }}>
      <SafetyStrip mode="Read-only audit" subtle />

      <div className="row between items-center" style={{ padding: '14px 24px', borderBottom: '1.5px solid var(--line-soft)', background: 'white' }}>
        <h1 className="wf-h1" style={{ fontSize: 20 }}>
          Tutor Match <span className="hand" style={{ fontSize: 22, color: 'var(--ink-mute)' }}>· at a glance</span>
        </h1>
        <div className="row gap-2 items-center">
          <Chip kind="mute">Simple view</Chip>
          <span className="btn ghost sm">Detailed view ⇄</span>
        </div>
      </div>

      <div style={{
        flex: 1, padding: 24,
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gridTemplateRows: 'auto auto 1fr',
        gap: 18,
      }}>
        {/* Tile 1 · PROGRESS — big */}
        <TileFrame span={2}>
          <div className="row between items-center">
            <span className="wf-label">Where we are</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>on track</span>
          </div>
          <div className="row items-end gap-3">
            <span className="hand" style={{ fontSize: 64, lineHeight: 0.9 }}>4 / 9</span>
            <div className="col" style={{ paddingBottom: 8 }}>
              <span className="hand" style={{ fontSize: 22, color: 'var(--accent)' }}>building stage</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>started 38m ago</span>
            </div>
          </div>
          <SimpleProgress done={4} total={9} />
          <span className="hand" style={{ fontSize: 17, color: 'var(--ink-soft)' }}>
            Next: code review → then I test it for you.
          </span>
        </TileFrame>

        {/* Tile 2 · NEEDS YOU */}
        <TileFrame tone="warn" accent="var(--warn)">
          <div className="row between items-center">
            <span className="wf-label">Needs you</span>
            <Chip kind="warn">1</Chip>
          </div>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 700, lineHeight: 1.25 }}>
            Pick a payment provider
          </span>
          <span className="hand" style={{ fontSize: 17, color: '#6a4a08' }}>
            Stripe is safe & cheap. ~1 minute to decide.
          </span>
          <span className="btn primary sm" style={{ alignSelf: 'flex-start', marginTop: 'auto' }}>
            Decide now →
          </span>
        </TileFrame>

        {/* Tile 3 · TIME */}
        <TileFrame tone="soft">
          <div className="row between items-center">
            <span className="wf-label">Time & runs</span>
          </div>
          <div className="col gap-2">
            <div className="row between">
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)' }}>Today</span>
              <span style={{ fontFamily: 'var(--hand)', fontSize: 22 }}>3h 12m</span>
            </div>
            <div className="row between">
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)' }}>Est. to MVP</span>
              <span style={{ fontFamily: 'var(--hand)', fontSize: 22, color: 'var(--accent)' }}>~2 days</span>
            </div>
            <div className="row between">
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)' }}>Factory runs</span>
              <span style={{ fontFamily: 'var(--hand)', fontSize: 22 }}>14 / ∞</span>
            </div>
          </div>
        </TileFrame>

        {/* Tile 4 · LATEST artifact */}
        <TileFrame span={2}>
          <div className="row between items-center">
            <span className="wf-label">Latest output</span>
            <Chip kind="good" dot>Saved</Chip>
          </div>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600 }}>Tutor card mockup · 4 screens</span>
          <div className="row gap-2">
            {['Search', 'Tutor', 'Book', 'Pay'].map(l => (
              <div key={l} className="ph" style={{ flex: 1, height: 90, fontSize: 13 }}>{l}</div>
            ))}
          </div>
          <div className="row gap-2">
            <span className="btn ghost sm">Open in detail</span>
            <span className="btn ghost sm">Download PDF</span>
          </div>
        </TileFrame>

        {/* Tile 5 · WHAT UNIVERSE IS DOING NOW */}
        <TileFrame tone="mark">
          <div className="row gap-3 items-center">
            <UniverseOrb size={44} busy />
            <div className="col" style={{ lineHeight: 1.15 }}>
              <span className="wf-label" style={{ color: '#6a4a08' }}>Right now</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 700 }}>Building tutor search</span>
            </div>
          </div>
          <span className="hand" style={{ fontSize: 19, color: '#5a3a02' }}>
            Connecting profiles to the search box. ~25 min.
          </span>
          <span className="btn ghost sm" style={{ alignSelf: 'flex-start' }}>Watch live →</span>
        </TileFrame>

        {/* Tile 6 · WHAT JUST HAPPENED — feed */}
        <TileFrame span={3} tone="white">
          <div className="row between items-center">
            <span className="wf-label">What just happened</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>last 2h</span>
          </div>
          <div className="col gap-2">
            {[
              { t: '11:42', kind: 'done', text: 'Finished the design review — you approved 4 screens.' },
              { t: '11:18', kind: 'plain', text: 'Started on the build stage.' },
              { t: '10:55', kind: 'plain', text: 'Drafted the screen mockups for your review.' },
              { t: '10:32', kind: 'done', text: 'Locked in the project plan — 5 must-haves, 3 maybes.' },
            ].map((e, i) => (
              <div key={i} className="row gap-3 items-start" style={{ paddingBottom: 6, borderBottom: i < 3 ? '1px dashed var(--line-soft)' : 'none' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', width: 38 }}>{e.t}</span>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%', marginTop: 5,
                  background: e.kind === 'done' ? 'var(--good)' : 'var(--paper-2)',
                  border: '1.5px solid var(--ink)',
                }} />
                <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.35, flex: 1 }}>{e.text}</span>
              </div>
            ))}
          </div>
        </TileFrame>
      </div>

      <Note x={510} y={150} w={200} rotate={-2}>
        big numbers, plain<br />english labels
      </Note>
      <Note x={770} y={345} w={210} kind="warn" rotate={2}>
        decisions surface here<br />before the user has to ask
      </Note>
    </div>
  </div>
);

// ============================================================
// SimpleC — "Project radio" — text-message style updates
// ============================================================
const SimpleC = () => {
  const feed = [
    { t: 'Now', who: 'Universe', kind: 'now', text: 'Building the tutor search. Wiring profiles to the search box.', extra: '~25 min to next check-in' },
    { t: '11:42', who: 'You', kind: 'me', text: 'Approved the design — go.' },
    { t: '11:35', who: 'Universe', kind: 'normal', text: 'Design is done. Take a look when you have a sec.', artifact: 'Tutor mockups · 4 screens' },
    { t: '10:32', who: 'Universe', kind: 'normal', text: 'Locked in the plan. 5 must-haves, 3 maybes.', artifact: 'Project plan v1' },
    { t: '10:10', who: 'You', kind: 'me', text: 'Skip ratings for now. Add it after MVP.' },
    { t: '10:04', who: 'Universe', kind: 'decision', text: 'Should the MVP include ratings, or keep it lean?', resolved: true },
    { t: '09:15', who: 'Universe', kind: 'milestone', text: 'Shaped your idea into a brief.', artifact: 'Idea brief' },
  ];
  return (
    <div className="wf" style={{ width: '100%', height: '100%', display: 'flex' }}>
      <SideNav active="cockpit" />
      <div className="col grow" style={{ minWidth: 0 }}>
        <SafetyStrip mode="Read-only audit" subtle />

        <div className="row between items-center" style={{ padding: '14px 28px', borderBottom: '1.5px solid var(--line-soft)', background: 'white' }}>
          <div className="row gap-3 items-center">
            <UniverseOrb size={40} busy />
            <div className="col" style={{ lineHeight: 1.15 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 700 }}>Tutor Match</span>
              <span className="hand" style={{ fontSize: 17, color: 'var(--accent)' }}>Universe is working · all good</span>
            </div>
          </div>
          <div className="row gap-2 items-center">
            <CalmPill kind="good">4 / 9 steps</CalmPill>
            <span className="btn ghost sm">Pause</span>
            <span className="btn sm">Detailed view ⇄</span>
          </div>
        </div>

        {/* Feed */}
        <div className="row" style={{ flex: 1, minHeight: 0 }}>
          <div className="col grow" style={{ padding: '20px 64px 24px', overflow: 'auto', background: 'var(--paper)' }}>
            <span className="wf-label" style={{ marginBottom: 14 }}>Today · Tuesday</span>

            {feed.map((e, i) => {
              const mine = e.who === 'You';
              return (
                <div key={i} className="row gap-3 items-start" style={{
                  marginBottom: 14,
                  flexDirection: mine ? 'row-reverse' : 'row',
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%',
                    border: '1.5px solid var(--ink)',
                    background: mine ? 'var(--paper-2)' : 'white',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 16,
                    flexShrink: 0,
                  }}>{mine ? 'You' : '✦'}</div>

                  <div className="col gap-1" style={{
                    maxWidth: '70%',
                    alignItems: mine ? 'flex-end' : 'flex-start',
                  }}>
                    <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-mute)' }}>
                      {e.t}{e.kind === 'now' && ' · live'}
                    </span>

                    {e.kind === 'milestone' ? (
                      <div className="row gap-2 items-center sketch-box" style={{
                        padding: '8px 14px', background: 'var(--good-soft)', borderColor: 'var(--good)',
                      }}>
                        <span>✓</span>
                        <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600 }}>{e.text}</span>
                      </div>
                    ) : e.kind === 'decision' ? (
                      <div className="sketch-box" style={{
                        padding: '10px 14px',
                        background: e.resolved ? 'var(--paper-2)' : '#fff8e0',
                        borderColor: e.resolved ? 'var(--line-soft)' : 'var(--warn)',
                        opacity: e.resolved ? 0.7 : 1,
                      }}>
                        <div className="row gap-2 items-center" style={{ marginBottom: 4 }}>
                          <Chip kind={e.resolved ? 'mute' : 'warn'}>{e.resolved ? 'Decided' : 'Need you'}</Chip>
                        </div>
                        <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.4 }}>{e.text}</span>
                      </div>
                    ) : (
                      <div className="sketch-box thin" style={{
                        padding: '8px 12px',
                        background: e.kind === 'now' ? 'var(--marker)' : mine ? 'white' : 'var(--paper)',
                        borderColor: e.kind === 'now' ? 'var(--ink)' : 'var(--line-soft)',
                        borderWidth: e.kind === 'now' ? 2 : 1.5,
                        maxWidth: 420,
                      }}>
                        <span style={{ fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.4 }}>{e.text}</span>
                        {e.extra && (
                          <div className="hand" style={{ fontSize: 16, color: 'var(--ink-soft)', marginTop: 4 }}>{e.extra}</div>
                        )}
                        {e.artifact && (
                          <div className="row gap-2 items-center" style={{
                            marginTop: 8, padding: '6px 10px',
                            border: '1.5px solid var(--line-soft)', borderRadius: 8,
                            background: 'white',
                          }}>
                            <span style={{
                              width: 22, height: 26, border: '1.5px solid var(--ink)', borderRadius: 3,
                              background: 'var(--paper-2)', flexShrink: 0,
                            }} />
                            <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600, flex: 1 }}>{e.artifact}</span>
                            <span className="btn ghost sm">Open</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right: tiny rail */}
          <div className="col gap-3" style={{
            width: 240, padding: 18,
            borderLeft: '1.5px dashed var(--line-soft)', background: 'var(--paper-2)',
          }}>
            <span className="wf-label">Today's progress</span>
            <SimpleProgress done={4} total={9} />
            <div className="col gap-2 sketch-box thin" style={{ padding: 12, background: 'white' }}>
              <span className="wf-label" style={{ fontSize: 10 }}>Anything for me?</span>
              <span className="hand" style={{ fontSize: 19 }}>Nothing right now.</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-mute)' }}>I'll ping you in ~25 min.</span>
            </div>
            <div className="col gap-2 sketch-box thin" style={{ padding: 12, background: 'white' }}>
              <span className="wf-label" style={{ fontSize: 10 }}>Quick actions</span>
              <span className="btn ghost sm" style={{ justifyContent: 'flex-start' }}>Ask Universe a question</span>
              <span className="btn ghost sm" style={{ justifyContent: 'flex-start' }}>Change the plan</span>
              <span className="btn ghost sm" style={{ justifyContent: 'flex-start' }}>Pause for now</span>
            </div>
            <DetailsHandle label="Open factory floor" />
          </div>
        </div>

        <Note x={120} y={300} w={170} rotate={-2}>
          ★ chat-feed format<br />reads like texts<br />from a friend
        </Note>
        <Note x={655} y={185} w={170} kind="warn" rotate={2}>
          live "now" message<br />is highlighted
        </Note>
      </div>
    </div>
  );
};

// ============================================================
// SimpleD — Layer model — shows how Simple ↔ Detailed relate
// ============================================================
const SimpleD = () => (
  <div className="wf paper" style={{ width: '100%', height: '100%', padding: '32px 40px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
    <div className="col gap-3" style={{ marginBottom: 18 }}>
      <SketchH size={26}>How the two layers fit together</SketchH>
      <span className="hand" style={{ fontSize: 20, color: 'var(--ink-soft)' }}>
        Same project. Same data. Two ways to look at it.
      </span>
    </div>

    <div className="row gap-5" style={{ flex: 1, minHeight: 0 }}>
      {/* LEFT — simple */}
      <div className="col gap-3" style={{ flex: 1 }}>
        <div className="row gap-2 items-center">
          <Chip kind="good" dot>Default</Chip>
          <span className="hand" style={{ fontSize: 22 }}>Simple view</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>— for makers, founders, PMs</span>
        </div>
        <div className="sketch-box" style={{ flex: 1, padding: 20, background: 'white', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="row gap-3 items-center sketch-box thin" style={{ padding: 14, background: 'var(--paper)' }}>
            <UniverseOrb size={44} busy />
            <div className="col" style={{ flex: 1, lineHeight: 1.2 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 700 }}>Universe is building the tutor search.</span>
              <span className="hand" style={{ fontSize: 16, color: 'var(--ink-soft)' }}>~25 min until next check-in</span>
            </div>
          </div>
          <SimpleProgress done={4} total={9} />
          <div className="row gap-2 items-center sketch-box thin" style={{ padding: 12, background: 'var(--good-soft)', borderColor: 'var(--good)' }}>
            <span>✓</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600 }}>Nothing needs you.</span>
          </div>
          <div className="col gap-2" style={{ marginTop: 'auto' }}>
            <span className="wf-label">Hides</span>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              <Chip kind="mute">9 phases</Chip>
              <Chip kind="mute">persona handoffs</Chip>
              <Chip kind="mute">artifact tree</Chip>
              <Chip kind="mute">QA replay</Chip>
              <Chip kind="mute">raw logs</Chip>
            </div>
          </div>
        </div>
      </div>

      {/* Toggle arrow */}
      <div className="col items-center" style={{ justifyContent: 'center', width: 60, position: 'relative' }}>
        <div style={{
          padding: '12px 8px', border: '2px solid var(--ink)', borderRadius: 999,
          background: 'var(--marker)',
          fontFamily: 'var(--hand)', fontSize: 18, fontWeight: 700, textAlign: 'center',
          writingMode: 'vertical-rl',
        }}>
          toggle ⇄
        </div>
        <div className="hand" style={{
          fontSize: 16, color: 'var(--accent)', textAlign: 'center', marginTop: 12, lineHeight: 1.2,
        }}>
          same data<br />two skins
        </div>
      </div>

      {/* RIGHT — detailed */}
      <div className="col gap-3" style={{ flex: 1 }}>
        <div className="row gap-2 items-center">
          <Chip kind="accent" dot>Power</Chip>
          <span className="hand" style={{ fontSize: 22 }}>Factory floor</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>— for technical users / when something breaks</span>
        </div>
        <div className="sketch-box" style={{ flex: 1, padding: 14, background: 'white', display: 'flex', gap: 10, overflow: 'hidden' }}>
          {/* mini timeline */}
          <div className="col gap-1" style={{ width: 80, flexShrink: 0, borderRight: '1.5px solid var(--line-soft)', paddingRight: 8 }}>
            <span className="wf-label" style={{ fontSize: 9 }}>Timeline</span>
            {['Shape', 'Plan', 'Design', 'Build', 'Review', 'Test', 'Fix', 'Ready', 'Hand off'].map((p, i) => (
              <div key={i} className="row gap-2 items-center" style={{ fontFamily: 'var(--ui)', fontSize: 9.5 }}>
                <span style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: '1.2px solid var(--ink)',
                  background: i < 4 ? 'var(--good-soft)' : i === 4 ? 'var(--marker)' : 'white',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 8, fontWeight: 700,
                }}>{i < 4 ? '✓' : i + 1}</span>
                <span style={{ color: i > 4 ? 'var(--ink-mute)' : 'var(--ink)', fontWeight: i === 4 ? 700 : 400 }}>{p}</span>
              </div>
            ))}
          </div>
          {/* convo */}
          <div className="col gap-2" style={{ flex: 1, minWidth: 0 }}>
            <span className="wf-label" style={{ fontSize: 9 }}>Phase room · Build</span>
            <div className="row gap-1 items-start">
              <Persona initials="AR" kind="arch" size={20} />
              <div className="tidy-soft" style={{ fontSize: 10, padding: '5px 7px' }}>Wiring tutor profiles to the search index…</div>
            </div>
            <div className="row gap-1 items-start">
              <Persona initials="QA" kind="qa" size={20} />
              <div className="tidy-soft" style={{ fontSize: 10, padding: '5px 7px' }}>Standing by for browser run.</div>
            </div>
            <div className="row gap-1 items-start">
              <Persona initials="IM" kind="builder" size={20} />
              <div className="tidy-soft" style={{ fontSize: 10, padding: '5px 7px' }}>Watching for failed checks…</div>
            </div>
          </div>
          {/* artifacts */}
          <div className="col gap-1" style={{ width: 110, flexShrink: 0, borderLeft: '1.5px solid var(--line-soft)', paddingLeft: 8 }}>
            <span className="wf-label" style={{ fontSize: 9 }}>Artifacts</span>
            {['Idea brief', 'Plan v1', 'Design v1', 'Build log', 'QA evidence'].map((a, i) => (
              <div key={a} className="row gap-1 items-center" style={{ fontFamily: 'var(--ui)', fontSize: 9.5 }}>
                <span style={{ width: 12, height: 14, border: '1px solid var(--ink)', background: 'var(--paper-2)' }} />
                <span style={{ flex: 1 }}>{a}</span>
                {i < 3 && <Chip kind="good" style={{ fontSize: 7, padding: '0px 4px' }}>✓</Chip>}
              </div>
            ))}
          </div>
        </div>
        <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
          <span className="wf-label">Adds</span>
          <Chip kind="accent">9 phases</Chip>
          <Chip kind="accent">persona handoffs</Chip>
          <Chip kind="accent">artifact tree</Chip>
          <Chip kind="accent">QA replay</Chip>
          <Chip kind="accent">raw logs</Chip>
        </div>
      </div>
    </div>

    {/* Principles strip */}
    <div className="row gap-3" style={{ marginTop: 20, paddingTop: 16, borderTop: '1.5px dashed var(--line-soft)' }}>
      {[
        ['Default = simple', 'Land in the calm view. Earn the detail.'],
        ['One source of truth', 'Both views read the same project state. No "draft modes."'],
        ['Decisions promote up', 'Anything that needs the human shows on both layers.'],
        ['Detail is one click', 'Never hidden by a menu — handle sits at the bottom of Simple.'],
      ].map(([t, s]) => (
        <div key={t} className="col gap-1" style={{ flex: 1 }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 700 }}>{t}</span>
          <span className="hand" style={{ fontSize: 16, color: 'var(--ink-soft)', lineHeight: 1.2 }}>{s}</span>
        </div>
      ))}
    </div>
  </div>
);

Object.assign(window, {
  SimpleA, SimpleB, SimpleC, SimpleD, UniverseOrb, SimpleProgress, CalmPill, DetailsHandle,
});
