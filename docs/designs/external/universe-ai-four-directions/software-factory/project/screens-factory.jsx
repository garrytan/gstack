// Three-bay factory map — the new top-level abstraction.
// Sits ABOVE Simplified overview, which sits ABOVE the detailed cockpit.
//
// 9 phases → 3 bays:
//   Drawing Room (Shape)   = Product Coach + CEO Reviewer + Designer
//   Workshop (Build)        = Eng Architect + Implementer + Code Reviewer
//   Showroom (Ship)         = QA + Fix loop + Release Coordinator
//
// Three variations explore how literal the factory metaphor gets.

// ============================================================
// Bay data — single source of truth
// ============================================================
const BAYS = [
  {
    id: 1, name: 'Drawing Room', verb: 'Shape',
    tag: 'figuring out what to build',
    color: '#e8d5ff',       // lilac
    deep: '#7b3fb0',
    state: 'done',
    crew: [
      { initials: 'PC', kind: 'coach',    name: 'Product Coach',  job: 'turns your idea into a brief' },
      { initials: 'CR', kind: 'reviewer', name: 'CEO Reviewer',   job: 'pushes back on scope' },
      { initials: 'DS', kind: 'designer', name: 'Designer',       job: 'sketches screens' },
    ],
    outputs: ['Idea brief', 'Project plan', 'Screen mockups'],
    days: 'Day 1',
  },
  {
    id: 2, name: 'Workshop', verb: 'Build',
    tag: 'making it real',
    color: '#ffe6cc',       // amber-cream
    deep: '#a85a14',
    state: 'active',
    crew: [
      { initials: 'AR', kind: 'arch',     name: 'Eng Architect',  job: 'picks the build approach' },
      { initials: 'IM', kind: 'builder',  name: 'Implementer',    job: 'writes the code' },
      { initials: 'CV', kind: 'reviewer', name: 'Code Reviewer',  job: 'checks the code' },
    ],
    outputs: ['Architecture plan', 'Working build', 'Code review'],
    days: 'Day 2–4 · in progress',
  },
  {
    id: 3, name: 'Showroom', verb: 'Ship',
    tag: 'proving it works · handing it off',
    color: '#d2e8d8',       // sage
    deep: '#1c4e30',
    state: 'locked',
    crew: [
      { initials: 'QA', kind: 'qa',       name: 'QA Tester',      job: 'opens it in a browser' },
      { initials: 'FX', kind: 'builder',  name: 'Fix Loop',       job: 'patches what QA found' },
      { initials: 'RC', kind: 'release',  name: 'Release Coord.', job: 'packs it up for handoff' },
    ],
    outputs: ['QA evidence', 'Fix summary', 'Handoff bundle'],
    days: 'Day 5',
  },
];

// ============================================================
// Sub-bits
// ============================================================
const BayDoor = ({ open = false, color, deep }) => (
  <svg viewBox="0 0 140 100" style={{ width: '100%', height: '100%', display: 'block' }}>
    <defs>
      <pattern id={`brick-${deep.replace('#','')}`} width="14" height="7" patternUnits="userSpaceOnUse">
        <rect width="14" height="7" fill={color} />
        <path d="M0 0 L14 0 M0 7 L14 7 M7 0 L7 7" stroke={deep} strokeOpacity="0.18" strokeWidth="0.6" />
      </pattern>
    </defs>
    {/* building outline */}
    <path d="M5 95 L5 35 L70 8 L135 35 L135 95 Z" fill={`url(#brick-${deep.replace('#','')})`} stroke={deep} strokeWidth="2" strokeLinejoin="round" />
    {/* roof line accent */}
    <path d="M5 35 L70 8 L135 35" fill="none" stroke={deep} strokeWidth="2.5" strokeLinejoin="round" />
    {/* door */}
    {open ? (
      <>
        <path d="M55 95 L55 55 L85 55 L85 95" fill="#fdfcf8" stroke={deep} strokeWidth="1.8" />
        {/* light spill */}
        <path d="M55 95 L40 95 M85 95 L100 95" stroke="#ffe680" strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
        <circle cx="70" cy="75" r="1.6" fill={deep} />
      </>
    ) : (
      <>
        <path d="M50 95 L50 58 Q50 50 58 50 L82 50 Q90 50 90 58 L90 95 Z" fill={deep} fillOpacity="0.15" stroke={deep} strokeWidth="1.8" />
        {/* curtain */}
        <path d="M52 50 L52 95 M58 50 L58 95 M64 50 L64 95 M70 50 L70 95 M76 50 L76 95 M82 50 L82 95 M88 50 L88 95"
              stroke={deep} strokeOpacity="0.45" strokeWidth="0.8" />
        {/* lock */}
        <rect x="64" y="68" width="12" height="11" rx="1.5" fill="#fdfcf8" stroke={deep} strokeWidth="1.3" />
        <path d="M67 68 L67 65 Q67 61 70 61 Q73 61 73 65 L73 68" fill="none" stroke={deep} strokeWidth="1.3" />
      </>
    )}
    {/* small smoke from chimney for active */}
    {open && (
      <g>
        <rect x="100" y="18" width="6" height="14" fill={deep} />
        <path d="M103 18 q-4 -6 0 -10 q4 -6 0 -12" fill="none" stroke={deep} strokeOpacity="0.45" strokeWidth="1.4" strokeLinecap="round" />
      </g>
    )}
  </svg>
);

const SmallWorker = ({ initials, kind, x = 0, busy = false }) => (
  <div style={{
    position: 'absolute', left: x, bottom: 8,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
  }}>
    {busy && <span className="hand" style={{ fontSize: 11, color: 'var(--accent)' }}>•</span>}
    <Persona initials={initials} kind={kind} size={22} />
  </div>
);

// ============================================================
// FactoryA — Three bays as a town/skyline
// ============================================================
const FactoryA = () => (
  <div className="wf paper" style={{ width: '100%', height: '100%', display: 'flex' }}>
    <SideNav active="cockpit" />
    <div className="col grow" style={{ minWidth: 0, position: 'relative' }}>
      <SafetyStrip mode="Read-only audit" subtle />

      {/* Header */}
      <div className="row between items-center" style={{ padding: '18px 28px', background: 'white', borderBottom: '1.5px solid var(--line-soft)' }}>
        <div className="col" style={{ lineHeight: 1.15 }}>
          <span className="wf-label">Your factory</span>
          <h1 className="hand" style={{ margin: 0, fontSize: 36 }}>
            <span style={{ background: 'var(--marker)', padding: '0 6px' }}>Tutor Match</span>
          </h1>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>
            day 2 of about 5 · everything on track
          </span>
        </div>
        <div className="row gap-2 items-center">
          <CalmPill kind="good">All clear</CalmPill>
          <span className="btn ghost sm">Pause</span>
          <span className="btn sm">Detailed view ⇄</span>
        </div>
      </div>

      {/* The three bays */}
      <div className="col" style={{ flex: 1, padding: '36px 48px 28px', gap: 24, background: 'var(--paper)', overflow: 'hidden' }}>
        <div className="row between items-end">
          <SketchH size={24}>Three rooms. We go through them in order.</SketchH>
          <span className="hand" style={{ fontSize: 18, color: 'var(--ink-soft)' }}>← drag the map to peek inside</span>
        </div>

        <div className="row gap-4" style={{ flex: 1, minHeight: 0 }}>
          {BAYS.map((bay, i) => {
            const isActive = bay.state === 'active';
            const isDone = bay.state === 'done';
            const isLocked = bay.state === 'locked';
            return (
              <div key={bay.id} className="col" style={{
                flex: 1, minHeight: 0,
                position: 'relative',
                opacity: isLocked ? 0.85 : 1,
              }}>
                {/* the building */}
                <div className="sketch-box" style={{
                  flex: 1,
                  background: isLocked ? '#f2efe8' : bay.color,
                  borderColor: isActive ? 'var(--ink)' : bay.deep,
                  borderWidth: isActive ? 3 : 2,
                  padding: 0,
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'flex', flexDirection: 'column',
                }}>
                  {/* corner stamp */}
                  <div style={{
                    position: 'absolute', top: 12, right: 12, zIndex: 2,
                    width: 44, height: 44, borderRadius: '50%',
                    border: `2.5px solid ${bay.deep}`,
                    background: isDone ? 'var(--good-soft)' : isActive ? 'var(--marker)' : '#fdfcf8',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 22,
                    color: bay.deep,
                    transform: 'rotate(-6deg)',
                  }}>
                    {isDone ? '✓' : bay.id}
                  </div>

                  {/* status ribbon */}
                  <div style={{
                    padding: '8px 14px',
                    background: isActive ? bay.deep : isDone ? bay.deep : 'transparent',
                    color: isActive || isDone ? 'white' : bay.deep,
                    fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: 700,
                    letterSpacing: 0.6, textTransform: 'uppercase',
                    borderBottom: isLocked ? `1.5px dashed ${bay.deep}` : 'none',
                  }}>
                    {isDone && `✓ Done · ${bay.days}`}
                    {isActive && `● Working here now · ${bay.days}`}
                    {isLocked && `↳ Unlocks after Workshop`}
                  </div>

                  {/* the door illustration */}
                  <div style={{ height: 130, padding: '6px 16px 0' }}>
                    <BayDoor open={!isLocked} color={bay.color} deep={bay.deep} />
                  </div>

                  {/* bay name */}
                  <div className="col" style={{ padding: '6px 18px 4px', alignItems: 'center' }}>
                    <h2 className="hand" style={{ margin: 0, fontSize: 32, lineHeight: 1, color: bay.deep }}>
                      The {bay.name}
                    </h2>
                    <span className="hand" style={{ fontSize: 16, color: 'var(--ink-soft)' }}>
                      {bay.tag}
                    </span>
                  </div>

                  {/* crew */}
                  <div className="col gap-2" style={{ padding: '12px 18px 16px', flex: 1 }}>
                    <span className="wf-label" style={{ fontSize: 10 }}>Who works here</span>
                    {bay.crew.map((c) => (
                      <div key={c.initials} className="row gap-2 items-center" style={{
                        filter: isLocked ? 'grayscale(0.85) opacity(0.55)' : 'none',
                      }}>
                        <Persona initials={c.initials} kind={c.kind} size={22} />
                        <div className="col" style={{ lineHeight: 1.1 }}>
                          <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600 }}>{c.name}</span>
                          <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>{c.job}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* footer: outputs */}
                  <div className="col gap-1" style={{
                    padding: '10px 18px',
                    borderTop: `1.5px solid ${bay.deep}`,
                    background: isLocked ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.55)',
                  }}>
                    <span className="wf-label" style={{ fontSize: 9 }}>{isDone ? 'You got' : isLocked ? 'You\'ll get' : 'You\'ll get'}</span>
                    <div className="row gap-1" style={{ flexWrap: 'wrap' }}>
                      {bay.outputs.map(o => (
                        <Chip key={o} kind="mute" style={{ fontSize: 9.5, padding: '2px 6px' }}>
                          {isDone && '✓ '}{o}
                        </Chip>
                      ))}
                    </div>
                  </div>

                  {/* lock overlay */}
                  {isLocked && (
                    <div style={{
                      position: 'absolute', inset: 0,
                      pointerEvents: 'none',
                      background: 'repeating-linear-gradient(45deg, transparent 0 10px, rgba(0,0,0,0.025) 10px 20px)',
                    }} />
                  )}
                </div>

                {/* connector between bays */}
                {i < BAYS.length - 1 && (
                  <div style={{
                    position: 'absolute',
                    right: -22, top: '40%',
                    fontFamily: 'var(--hand)', fontSize: 30,
                    color: isDone ? 'var(--good)' : 'var(--ink-mute)',
                    transform: 'translateY(-50%)',
                    zIndex: 3,
                  }}>→</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Bottom — current action card */}
        <div className="row gap-3 items-center sketch-box" style={{
          padding: '14px 20px', background: 'white', borderColor: 'var(--ink)', borderWidth: 2,
        }}>
          <UniverseOrb size={48} busy />
          <div className="col grow" style={{ lineHeight: 1.2 }}>
            <span className="wf-label">Right now · in the Workshop</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 700 }}>
              The Implementer is wiring tutor profiles to the search.
            </span>
            <span className="hand" style={{ fontSize: 16, color: 'var(--ink-soft)' }}>
              Nothing needs you. I'll knock when it's your turn.
            </span>
          </div>
          <DetailsHandle label="Step inside the Workshop" />
        </div>
      </div>

      <Note x={130} y={290} w={170} rotate={-2}>
        ✓ done · stamped<br />and open
      </Note>
      <Note x={430} y={290} w={170} kind="warn" rotate={1.5}>
        ● where Universe<br />is working right now
      </Note>
      <Note x={760} y={290} w={170} rotate={-1.5}>
        🔒 curtain stays down<br />until prev room ships
      </Note>
    </div>
  </div>
);

// ============================================================
// FactoryB — Storybook journey · pages turning
// ============================================================
const FactoryB = () => (
  <div className="wf paper" style={{ width: '100%', height: '100%', display: 'flex' }}>
    <SideNav active="cockpit" />
    <div className="col grow" style={{ minWidth: 0, position: 'relative' }}>
      <SafetyStrip mode="Read-only audit" subtle />

      <div className="row between items-center" style={{ padding: '16px 28px', background: 'white', borderBottom: '1.5px solid var(--line-soft)' }}>
        <h1 className="wf-h1" style={{ fontSize: 19 }}>Tutor Match · <span className="hand" style={{ fontSize: 24 }}>the journey</span></h1>
        <span className="btn sm">Detailed view ⇄</span>
      </div>

      <div className="col" style={{ flex: 1, padding: '28px 56px', gap: 22, overflow: 'hidden' }}>
        {/* Story strip — three pages of a picture book */}
        <div className="row gap-4" style={{ flex: 1, alignItems: 'stretch' }}>
          {BAYS.map((bay, i) => {
            const isActive = bay.state === 'active';
            const isDone = bay.state === 'done';
            const isLocked = bay.state === 'locked';
            return (
              <React.Fragment key={bay.id}>
                <div className="sketch-box" style={{
                  flex: 1,
                  background: isLocked ? '#f4f1ea' : 'white',
                  borderColor: isActive ? bay.deep : 'var(--ink)',
                  borderWidth: isActive ? 3 : 1.8,
                  padding: 0,
                  display: 'flex', flexDirection: 'column',
                  position: 'relative',
                  transform: isActive ? 'translateY(-4px)' : isLocked ? 'translateY(4px) rotate(0.6deg)' : 'none',
                }}>
                  {/* page corner fold for locked */}
                  {isLocked && (
                    <div style={{
                      position: 'absolute', top: 0, right: 0,
                      width: 0, height: 0,
                      borderTop: '40px solid var(--paper-2)',
                      borderLeft: '40px solid transparent',
                    }} />
                  )}

                  {/* big chapter number */}
                  <div className="col" style={{ padding: '20px 24px 6px', alignItems: 'flex-start' }}>
                    <span className="hand" style={{ fontSize: 18, color: bay.deep, opacity: isLocked ? 0.5 : 1 }}>
                      Chapter {bay.id}
                    </span>
                    <h2 className="hand" style={{
                      margin: '2px 0 0', fontSize: 48, lineHeight: 0.95, color: bay.deep,
                      filter: isLocked ? 'opacity(0.55)' : 'none',
                    }}>
                      {bay.verb}<br/>it
                    </h2>
                  </div>

                  {/* illustration */}
                  <div style={{ flex: 1, padding: '4px 20px', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                    <div style={{ width: '100%', maxHeight: 150, opacity: isLocked ? 0.45 : 1 }}>
                      <BayDoor open={!isLocked} color={bay.color} deep={bay.deep} />
                    </div>
                    {isActive && (
                      <div style={{
                        position: 'absolute', bottom: 8, right: 14,
                        fontFamily: 'var(--hand)', fontSize: 24, color: bay.deep,
                        background: 'var(--marker)', padding: '0 10px',
                        borderRadius: 8,
                        transform: 'rotate(-3deg)',
                      }}>← you are here</div>
                    )}
                  </div>

                  {/* the tag */}
                  <div className="col" style={{ padding: '8px 24px 18px', gap: 6 }}>
                    <span style={{
                      fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.35,
                      color: 'var(--ink-soft)',
                      filter: isLocked ? 'opacity(0.5)' : 'none',
                    }}>
                      {isDone && `You and Universe sketched out the idea, weighed scope, and locked the look.`}
                      {isActive && `Universe is building the thing. You'll get pinged when something needs your taste.`}
                      {isLocked && `Universe will open it in a real browser, fix what breaks, and pack it for handoff.`}
                    </span>
                    {/* crew avatars only */}
                    <div className="row gap-1" style={{ marginTop: 4, opacity: isLocked ? 0.5 : 1 }}>
                      {bay.crew.map((c) => (
                        <Persona key={c.initials} initials={c.initials} kind={c.kind} size={24} />
                      ))}
                      <span className="hand" style={{ fontSize: 15, color: 'var(--ink-mute)', marginLeft: 6, alignSelf: 'center' }}>
                        3 hands at work
                      </span>
                    </div>
                  </div>

                  {/* footer status bar */}
                  <div style={{
                    padding: '8px 24px', borderTop: '1.5px dashed var(--line-soft)',
                    fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 600,
                    color: isDone ? 'var(--good)' : isActive ? bay.deep : 'var(--ink-mute)',
                    background: isDone ? 'var(--good-soft)' : isActive ? bay.color : 'var(--paper-2)',
                  }}>
                    {isDone && '✓ Chapter complete'}
                    {isActive && '● In progress · ~25m'}
                    {isLocked && '🔒 Comes next'}
                  </div>
                </div>

                {/* "and then..." between pages */}
                {i < BAYS.length - 1 && (
                  <div className="col items-center" style={{ justifyContent: 'center', width: 24, gap: 4 }}>
                    <span className="hand" style={{ fontSize: 30, color: 'var(--ink-mute)' }}>→</span>
                    <span className="hand" style={{
                      fontSize: 13, color: 'var(--ink-mute)', textAlign: 'center',
                      writingMode: 'vertical-rl', transform: 'rotate(180deg)',
                    }}>and then…</span>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Sticky next-thing strip */}
        <div className="sticky-cta" style={{ alignSelf: 'stretch' }}>
          <UniverseOrb size={36} busy />
          <span className="hand" style={{ fontSize: 22 }}>Chapter 2 · still being written.</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)', marginLeft: 'auto' }}>
            Next page turns in ~25 min · I'll let you know
          </span>
          <span className="btn primary sm">Peek inside</span>
        </div>
      </div>

      <Note x={310} y={520} w={180} rotate={-2}>
        consumer copy:<br/>"Shape it · Build it · Ship it"
      </Note>
    </div>
  </div>
);

// ============================================================
// FactoryC — Conveyor / playful production line (literal)
// ============================================================
const FactoryC = () => (
  <div className="wf" style={{
    width: '100%', height: '100%', display: 'flex',
    background: 'linear-gradient(180deg, #fdfcf8 0%, #f4f1ea 100%)',
  }}>
    <SideNav active="cockpit" />
    <div className="col grow" style={{ minWidth: 0, position: 'relative' }}>
      <SafetyStrip mode="Read-only audit" subtle />

      <div className="row between items-center" style={{ padding: '14px 28px', background: 'white', borderBottom: '1.5px solid var(--line-soft)' }}>
        <div className="row gap-3 items-center">
          <UniverseOrb size={36} busy />
          <div className="col" style={{ lineHeight: 1.15 }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 700 }}>Tutor Match</span>
            <span className="hand" style={{ fontSize: 17, color: 'var(--accent)' }}>Universe is in the Workshop · all good</span>
          </div>
        </div>
        <div className="row gap-2 items-center">
          <Chip kind="mute">Map view</Chip>
          <span className="btn sm">Detailed view ⇄</span>
        </div>
      </div>

      {/* The factory floor — wide horizontal */}
      <div className="col" style={{ flex: 1, padding: '36px 32px', position: 'relative', overflow: 'hidden' }}>
        {/* Title bar */}
        <div className="row between items-end" style={{ marginBottom: 26 }}>
          <div className="col" style={{ lineHeight: 1.05 }}>
            <span className="wf-label">The factory floor</span>
            <h1 className="hand" style={{ fontSize: 38, margin: 0 }}>From idea to shipped, in three stops.</h1>
          </div>
          <div className="row gap-2 items-center">
            <Chip kind="good" dot>1 done</Chip>
            <Chip kind="warn" dot>1 going</Chip>
            <Chip kind="mute" dot>1 to go</Chip>
          </div>
        </div>

        {/* The conveyor */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {/* track */}
          <div style={{
            position: 'absolute', left: 40, right: 40, top: '52%',
            height: 28,
            background: 'repeating-linear-gradient(90deg, var(--ink) 0 14px, var(--ink-soft) 14px 28px)',
            border: '2px solid var(--ink)', borderRadius: 4,
            opacity: 0.85,
          }} />
          {/* track rails */}
          <div style={{
            position: 'absolute', left: 40, right: 40, top: 'calc(52% - 6px)',
            height: 4, background: 'var(--ink)',
          }} />
          <div style={{
            position: 'absolute', left: 40, right: 40, top: 'calc(52% + 28px + 2px)',
            height: 4, background: 'var(--ink)',
          }} />

          {/* The three stations */}
          <div className="row" style={{
            position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
            justifyContent: 'space-between', padding: '0 20px',
          }}>
            {BAYS.map((bay) => {
              const isActive = bay.state === 'active';
              const isDone = bay.state === 'done';
              const isLocked = bay.state === 'locked';
              return (
                <div key={bay.id} className="col items-center" style={{ flex: 1, height: '100%', justifyContent: 'space-between', position: 'relative' }}>
                  {/* Station building above the track */}
                  <div className="sketch-box" style={{
                    width: '88%', maxWidth: 320,
                    padding: 16,
                    background: isLocked ? '#f4f1ea' : bay.color,
                    borderColor: isActive ? 'var(--ink)' : bay.deep,
                    borderWidth: isActive ? 3 : 2,
                    display: 'flex', flexDirection: 'column', gap: 8,
                    transform: isActive ? 'translateY(-6px)' : 'none',
                    opacity: isLocked ? 0.85 : 1,
                  }}>
                    <div className="row between items-center">
                      <div className="row gap-2 items-center">
                        <span style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: isDone ? 'var(--good)' : isActive ? bay.deep : 'white',
                          color: isDone || isActive ? 'white' : bay.deep,
                          border: `2px solid ${bay.deep}`,
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: 'var(--ui)', fontWeight: 800, fontSize: 11,
                        }}>{isDone ? '✓' : bay.id}</span>
                        <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: 700, color: bay.deep, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                          Stop {bay.id}
                        </span>
                      </div>
                      {isLocked && <span style={{ fontFamily: 'var(--ui)', fontSize: 16 }}>🔒</span>}
                    </div>
                    <h2 className="hand" style={{ margin: 0, fontSize: 26, lineHeight: 1, color: bay.deep }}>
                      {bay.verb} it
                    </h2>
                    <span className="hand" style={{ fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.2 }}>
                      {bay.tag}
                    </span>
                    {/* crew bench */}
                    <div className="row gap-1 items-center" style={{ marginTop: 4 }}>
                      {bay.crew.map((c) => (
                        <Persona key={c.initials} initials={c.initials} kind={c.kind} size={20} />
                      ))}
                      <span className="hand" style={{ fontSize: 13, color: 'var(--ink-mute)', marginLeft: 4 }}>{bay.name}</span>
                    </div>
                  </div>

                  {/* The package on the conveyor */}
                  <div style={{ position: 'absolute', top: '46%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    {isActive ? (
                      <>
                        <span className="hand" style={{ fontSize: 16, color: 'var(--ink)', background: 'var(--marker)', padding: '0 6px', borderRadius: 4 }}>
                          your project
                        </span>
                        <span className="hand" style={{ fontSize: 22, color: 'var(--ink)' }}>↓</span>
                        <div style={{
                          width: 56, height: 44, background: 'white',
                          border: '2px solid var(--ink)', borderRadius: 4,
                          position: 'relative',
                          boxShadow: '3px 3px 0 var(--ink)',
                        }}>
                          {/* package detail */}
                          <div style={{ position: 'absolute', inset: '6px 10px', borderTop: '1.5px dashed var(--line-soft)', borderBottom: '1.5px dashed var(--line-soft)' }} />
                          <span style={{
                            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
                            fontFamily: 'var(--hand)', fontSize: 14, fontWeight: 700,
                          }}>π</span>
                        </div>
                      </>
                    ) : isDone ? (
                      <span style={{ fontFamily: 'var(--ui)', fontSize: 16, color: 'var(--good)' }}>✓</span>
                    ) : (
                      <span style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-mute)' }}>waiting…</span>
                    )}
                  </div>

                  {/* Below the track — what comes off */}
                  <div className="col" style={{
                    width: '70%', alignItems: 'center', gap: 4, paddingTop: 8,
                    opacity: isLocked ? 0.5 : 1,
                  }}>
                    <span className="wf-label" style={{ fontSize: 9 }}>{isDone ? 'Made' : 'Will make'}</span>
                    <div className="row gap-1 items-center" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                      {bay.outputs.map(o => (
                        <Chip key={o} kind={isDone ? 'good' : 'mute'} style={{ fontSize: 9.5, padding: '2px 6px' }}>
                          {isDone && '✓ '}{o}
                        </Chip>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Foot tray */}
        <div className="row gap-3 items-center sketch-box" style={{
          padding: '12px 18px', background: 'white', marginTop: 16,
        }}>
          <span className="hand" style={{ fontSize: 20 }}>What's next?</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-soft)', flex: 1 }}>
            Universe will knock on your door when the Workshop has something for you to look at. Estimated: ~25 min.
          </span>
          <DetailsHandle label="Step into the Workshop →" />
        </div>
      </div>

      <Note x={415} y={460} w={170} kind="warn" rotate={-2}>
        the "package" is your<br/>project moving through
      </Note>
      <Note x={815} y={300} w={180} rotate={2}>
        🔒 locked stops show<br/>the curtain · still visible<br/>so the map feels whole
      </Note>
    </div>
  </div>
);

Object.assign(window, { FactoryA, FactoryB, FactoryC, BAYS });
