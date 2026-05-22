// ============================================================
// Mode toggle — Easy vs Hands-on
// Sits ABOVE the Factory abstraction; chosen once at project start,
// toggleable from a persistent top-bar control.
// ============================================================
//
// EASY MODE
//   - Universe picks defaults; user sees only must-decide moments
//     (anything irreversible, anything risky, anything taste-driven)
//   - All factory phases / personas / artifacts collapsed
//   - Surface: one big calm card. Headline + tiny "while you wait" feed.
//
// HANDS-ON MODE
//   - Full Factory + Simplified overview + Cockpit stack
//   - User opts in or out per-decision
//
// Mode is per-project, persistent. Flipping mid-project is supported
// (Easy → Hands-on always; Hands-on → Easy with a confirmation).

// ============================================================
// Shared mini-bits
// ============================================================

// Subtle mode-toggle pill — lives in top bar across all modes
const ModePill = ({ mode = 'easy', big = false }) => (
  <div className="row" style={{
    border: '2px solid var(--ink)',
    borderRadius: 999,
    background: 'white',
    padding: 3,
    fontFamily: 'var(--ui)',
    fontSize: big ? 13 : 11.5,
    fontWeight: 600,
    overflow: 'hidden',
    cursor: 'pointer',
  }}>
    <div style={{
      padding: big ? '7px 14px' : '4px 11px',
      borderRadius: 999,
      background: mode === 'easy' ? 'var(--ink)' : 'transparent',
      color: mode === 'easy' ? 'var(--paper)' : 'var(--ink-soft)',
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      <span>✦</span> Easy
    </div>
    <div style={{
      padding: big ? '7px 14px' : '4px 11px',
      borderRadius: 999,
      background: mode === 'hands' ? 'var(--ink)' : 'transparent',
      color: mode === 'hands' ? 'var(--paper)' : 'var(--ink-soft)',
      display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>
      <span>🔧</span> Hands-on
    </div>
  </div>
);

// "Universe handled it for you" line — used in Easy Mode feed
const HandledLine = ({ what, choice, alt }) => (
  <div className="row gap-2 items-start" style={{
    padding: '8px 0', borderBottom: '1px dashed var(--line-soft)',
  }}>
    <span style={{ marginTop: 3, color: 'var(--good)', fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 12 }}>✓</span>
    <div className="col" style={{ flex: 1, lineHeight: 1.3 }}>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5 }}>
        {what} → <strong>{choice}</strong>
      </span>
      {alt && (
        <span className="hand" style={{ fontSize: 14, color: 'var(--ink-mute)', marginTop: 1 }}>
          {alt}
        </span>
      )}
    </div>
    <span className="btn ghost sm" style={{ fontSize: 10, padding: '3px 7px' }}>change</span>
  </div>
);

// ============================================================
// ModeA — The Mode Picker (shown once, at project start)
// ============================================================
const ModeA = () => (
  <div className="wf paper" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
    <div className="row between items-center" style={{ padding: '14px 24px', borderBottom: '1.5px solid var(--line-soft)', background: 'white' }}>
      <div className="row gap-2 items-center">
        <span style={{
          width: 26, height: 26, borderRadius: 7, background: 'var(--ink)', color: 'var(--paper)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 18,
        }}>✦</span>
        <span style={{ fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 14 }}>Universe AI</span>
      </div>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>
        New project · last step before we start
      </span>
    </div>

    <div className="col" style={{ flex: 1, padding: '40px 64px 32px', overflow: 'hidden' }}>
      <div className="col gap-2" style={{ marginBottom: 28 }}>
        <span className="wf-label">Tutor Match · your idea is captured</span>
        <h1 className="hand" style={{ margin: 0, fontSize: 44, lineHeight: 1 }}>
          How <span className="sketch-underline">hands-on</span> do you want to be?
        </h1>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 14, color: 'var(--ink-soft)', marginTop: 4 }}>
          You can change this any time. It only affects how much I check in.
        </span>
      </div>

      <div className="row gap-5" style={{ flex: 1, alignItems: 'stretch', minHeight: 0 }}>
        {/* TRACK 1 — Easy Mode */}
        <div className="sketch-box" style={{
          flex: 1, padding: 0, position: 'relative', background: 'white',
          borderColor: 'var(--ink)', borderWidth: 3,
          display: 'flex', flexDirection: 'column',
          boxShadow: '6px 6px 0 var(--ink)',
        }}>
          <div style={{
            position: 'absolute', top: -14, left: 24,
            background: 'var(--marker)', border: '2px solid var(--ink)',
            padding: '3px 10px', borderRadius: 6,
            fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 16,
            transform: 'rotate(-2deg)',
          }}>recommended for most people</div>

          <div className="col" style={{ padding: '32px 28px 18px' }}>
            <div className="row gap-3 items-center">
              <span style={{ fontFamily: 'var(--hand)', fontSize: 64, lineHeight: 0.9 }}>✦</span>
              <div className="col" style={{ lineHeight: 1 }}>
                <h2 className="hand" style={{ margin: 0, fontSize: 42 }}>Easy Mode</h2>
                <span className="hand" style={{ fontSize: 18, color: 'var(--accent)' }}>I drive · you sign off</span>
              </div>
            </div>
          </div>

          <div className="col gap-3" style={{ padding: '0 28px', flex: 1 }}>
            <p style={{
              margin: 0, fontFamily: 'var(--ui)', fontSize: 14, lineHeight: 1.55,
            }}>
              I'll make the small calls — picking libraries, naming files, layout details, copy tone — and only knock on your door when something <strong>only you can decide</strong>.
            </p>

            <div className="col gap-2" style={{ marginTop: 8 }}>
              <span className="wf-label">When I'll knock</span>
              <KnockRow text="Money: pricing, paid plans, payment provider" />
              <KnockRow text="Brand: name, voice, screenshots of your taste" />
              <KnockRow text="Anything that touches users (privacy, accounts)" />
              <KnockRow text="When I'm not sure I'm building the right thing" />
            </div>

            <div className="col gap-2" style={{ marginTop: 8 }}>
              <span className="wf-label">When I won't</span>
              <KnockRow text="Engineering choices · framework · file layout" off />
              <KnockRow text="Default copy, spacing, color details" off />
              <KnockRow text="Anything I can reverse without you noticing" off />
            </div>
          </div>

          <div className="row gap-3 items-center" style={{
            padding: '16px 28px', borderTop: '1.5px dashed var(--line-soft)', background: 'var(--paper)',
          }}>
            <div className="col" style={{ flex: 1, lineHeight: 1.15 }}>
              <span className="hand" style={{ fontSize: 18, color: 'var(--ink-soft)' }}>
                Expect ~3–5 check-ins total
              </span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>
                vs ~20 in Hands-on
              </span>
            </div>
            <button className="btn primary" style={{ fontSize: 14, padding: '10px 18px' }}>
              Start in Easy Mode →
            </button>
          </div>
        </div>

        {/* TRACK 2 — Hands-on Mode */}
        <div className="sketch-box thin" style={{
          flex: 1, padding: 0, background: 'var(--paper-2)',
          borderColor: 'var(--line-soft)', borderStyle: 'dashed', borderWidth: 2,
          display: 'flex', flexDirection: 'column',
        }}>
          <div className="col" style={{ padding: '32px 28px 18px' }}>
            <div className="row gap-3 items-center">
              <span style={{ fontFamily: 'var(--ui)', fontSize: 48, lineHeight: 0.9 }}>🔧</span>
              <div className="col" style={{ lineHeight: 1 }}>
                <h2 className="hand" style={{ margin: 0, fontSize: 42, color: 'var(--ink-soft)' }}>Hands-on Mode</h2>
                <span className="hand" style={{ fontSize: 18, color: 'var(--ink-mute)' }}>you drive · I assist</span>
              </div>
            </div>
          </div>

          <div className="col gap-3" style={{ padding: '0 28px', flex: 1 }}>
            <p style={{
              margin: 0, fontFamily: 'var(--ui)', fontSize: 14, lineHeight: 1.55, color: 'var(--ink-soft)',
            }}>
              You see every room — Drawing Room, Workshop, Showroom — and review what each crew member produces. Approve, push back, redirect at every step.
            </p>

            <div className="col gap-2" style={{ marginTop: 8 }}>
              <span className="wf-label">You'll see</span>
              <KnockRow text="Every phase opening & closing" tone="ink" />
              <KnockRow text="Every persona's draft before it ships" tone="ink" />
              <KnockRow text="Every artifact (plan, design, build, QA, fix)" tone="ink" />
              <KnockRow text="The raw conversation behind each decision" tone="ink" />
            </div>

            <div className="col gap-2" style={{ marginTop: 8 }}>
              <span className="wf-label">Good for</span>
              <KnockRow text="Engineers wanting to understand what I built" tone="ink" />
              <KnockRow text="Anyone learning how this works" tone="ink" />
              <KnockRow text="High-stakes / brand-critical projects" tone="ink" />
            </div>
          </div>

          <div className="row gap-3 items-center" style={{
            padding: '16px 28px', borderTop: '1.5px dashed var(--line-soft)', background: 'white',
          }}>
            <div className="col" style={{ flex: 1, lineHeight: 1.15 }}>
              <span className="hand" style={{ fontSize: 18, color: 'var(--ink-soft)' }}>
                Expect ~20 check-ins
              </span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>
                you'll learn a lot
              </span>
            </div>
            <button className="btn" style={{ fontSize: 14, padding: '10px 18px' }}>
              Use Hands-on →
            </button>
          </div>
        </div>
      </div>

      <div className="row gap-2 items-center" style={{ marginTop: 22, paddingTop: 14, borderTop: '1.5px dashed var(--line-soft)' }}>
        <span className="hand" style={{ fontSize: 16, color: 'var(--ink-soft)' }}>
          Not sure? Easy is the safer bet — you can switch to Hands-on the moment you want to look under the hood.
        </span>
      </div>
    </div>

    <Note x={420} y={186} w={210} rotate={-2} kind="warn">
      ★ this whole screen<br />only appears ONCE,<br />right after idea capture
    </Note>
  </div>
);

const KnockRow = ({ text, off = false, tone }) => (
  <div className="row gap-2 items-start" style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.35 }}>
    <span style={{
      width: 16, height: 16, borderRadius: '50%',
      border: '1.5px solid var(--ink)',
      background: off ? 'transparent' : tone === 'ink' ? 'var(--ink)' : 'var(--good-soft)',
      color: off ? 'var(--ink-mute)' : tone === 'ink' ? 'var(--paper)' : 'var(--good)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 1,
    }}>{off ? '–' : '✓'}</span>
    <span style={{ color: off ? 'var(--ink-mute)' : 'var(--ink)' }}>{text}</span>
  </div>
);

// ============================================================
// ModeB — Easy Mode in-flight (what day-to-day looks like)
// ============================================================
const ModeB = () => (
  <div className="wf paper" style={{ width: '100%', height: '100%', display: 'flex' }}>
    <SideNav active="cockpit" />
    <div className="col grow" style={{ minWidth: 0 }}>
      <SafetyStrip mode="Read-only audit" subtle />

      {/* Top bar with mode toggle prominent */}
      <div className="row between items-center" style={{
        padding: '14px 28px', borderBottom: '1.5px solid var(--line-soft)', background: 'white',
      }}>
        <div className="row gap-3 items-center">
          <div className="col" style={{ lineHeight: 1.15 }}>
            <span className="wf-label">Tutor Match</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 700 }}>
              Building <span style={{ background: 'var(--marker)', padding: '0 4px' }}>without you</span>
            </span>
          </div>
        </div>
        <div className="row gap-3 items-center">
          <ModePill mode="easy" big />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>
            ↑ flip to see the rooms
          </span>
        </div>
      </div>

      <div className="col" style={{ flex: 1, padding: '40px 80px 24px', gap: 26, overflow: 'hidden' }}>
        {/* THE BIG CALM HERO — basically the whole screen */}
        <div className="sketch-box" style={{
          padding: '36px 40px', background: 'white', borderWidth: 2,
          display: 'flex', flexDirection: 'column', gap: 18,
        }}>
          <div className="row gap-4 items-center">
            <UniverseOrb size={92} busy />
            <div className="col" style={{ flex: 1, lineHeight: 1.2 }}>
              <span className="wf-label">Right now</span>
              <h1 style={{
                margin: 0, fontFamily: 'var(--ui)', fontSize: 30, fontWeight: 600, lineHeight: 1.15,
              }}>
                I'm <span style={{ background: 'var(--marker)', padding: '0 6px' }}>building your app</span>.
              </h1>
              <span className="hand" style={{ fontSize: 24, color: 'var(--ink-soft)', marginTop: 6 }}>
                Step away. I'll text when I need you.
              </span>
            </div>
            <div className="col items-center gap-1" style={{ alignSelf: 'flex-start' }}>
              <span className="hand" style={{ fontSize: 42, color: 'var(--accent)', lineHeight: 1 }}>~4h</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)', textAlign: 'center' }}>
                est. to first<br />preview
              </span>
            </div>
          </div>

          <SimpleProgress done={4} total={9} />

          <div className="row gap-3 items-center" style={{
            padding: '12px 16px', background: 'var(--good-soft)',
            border: '1.5px solid var(--good)', borderRadius: 10,
          }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 22 }}>✓</span>
            <div className="col" style={{ flex: 1, lineHeight: 1.25 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 700 }}>
                Nothing needs you right now.
              </span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: '#1c4e30' }}>
                Last decision asked of you: 38 minutes ago.
              </span>
            </div>
            <span className="btn ghost sm">Notify me by email</span>
          </div>
        </div>

        {/* "While you were away" — quiet feed of things Universe handled */}
        <div className="sketch-box thin" style={{ padding: '20px 24px', background: 'var(--paper)' }}>
          <div className="row between items-center" style={{ marginBottom: 8 }}>
            <span className="wf-label">While you were away · I handled</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>last 2h</span>
          </div>
          <HandledLine
            what="Picked a UI framework"
            choice="Tailwind + Radix"
            alt="standard, gets out of your way"
          />
          <HandledLine
            what="Named the search component"
            choice="TutorFinder"
            alt="clear from URL & code"
          />
          <HandledLine
            what="Chose how tutors load"
            choice="20 at a time, scroll for more"
            alt="cheaper than infinite scroll for now"
          />
          <HandledLine
            what="Wrote the empty-state copy"
            choice='"No tutors yet — try widening your search."'
          />
        </div>
      </div>

      <Note x={460} y={170} w={210} kind="warn" rotate={-2}>
        ★ ONE message, big.<br />no panels, no rails.
      </Note>
      <Note x={870} y={75} w={210} rotate={2}>
        toggle ALWAYS lives<br />in the top bar
      </Note>
      <Note x={120} y={490} w={210} rotate={-1.5}>
        every "handled" item is<br />undoable — keeps trust
      </Note>
    </div>
  </div>
);

// ============================================================
// ModeC — Two-Track Comparison (same project, two journeys)
// ============================================================
const ModeC = () => (
  <div className="wf paper" style={{
    width: '100%', height: '100%', padding: '28px 36px', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
  }}>
    <div className="row between items-end" style={{ marginBottom: 22 }}>
      <div className="col" style={{ lineHeight: 1.1 }}>
        <span className="wf-label">Two tracks · same destination</span>
        <h1 className="hand" style={{ margin: 0, fontSize: 36 }}>
          One project. Pick how often I bug you.
        </h1>
      </div>
      <ModePill big />
    </div>

    <div className="row" style={{ flex: 1, minHeight: 0, gap: 0, alignItems: 'stretch' }}>
      {/* LEFT — Easy Mode track */}
      <TrackCol
        title="Easy Mode"
        subtitle="✦ I drive · you sign off"
        tone="ink"
        stops={[
          { kind: 'start', label: 'You wrote your idea' },
          { kind: 'auto', label: 'I shaped a plan', detail: 'auto-approved · revertible' },
          { kind: 'auto', label: 'I designed screens', detail: 'auto-approved · revertible' },
          { kind: 'auto', label: 'I picked the stack', detail: 'auto · revertible' },
          { kind: 'auto', label: 'I built it', detail: 'silent' },
          { kind: 'ping', label: 'PRICING — what do you want to charge?', detail: 'I can\'t guess this' },
          { kind: 'auto', label: 'I tested it', detail: 'silent · 7 fixes auto-applied' },
          { kind: 'ping', label: 'PREVIEW — does this look like what you wanted?', detail: 'last check before handoff' },
          { kind: 'end', label: 'Handoff bundle ready' },
        ]}
        meta={['~3–5 check-ins', '~5 days', 'no rooms shown']}
      />

      {/* Toggle column */}
      <div className="col items-center" style={{ width: 90, justifyContent: 'center', position: 'relative', padding: '20px 0' }}>
        <div style={{
          position: 'absolute', top: 24, bottom: 24, left: '50%',
          width: 1.5, background: 'var(--line-soft)', borderLeft: '1.5px dashed var(--line-soft)',
        }} />
        <div style={{
          position: 'relative',
          background: 'var(--marker)', border: '2px solid var(--ink)',
          borderRadius: 999, padding: '8px 14px',
          fontFamily: 'var(--hand)', fontSize: 18, fontWeight: 700,
          writingMode: 'vertical-rl', transform: 'rotate(180deg)',
        }}>flip anytime ⇄</div>
        <div className="hand" style={{
          fontSize: 15, color: 'var(--ink-mute)', textAlign: 'center', marginTop: 16, lineHeight: 1.15,
          position: 'absolute', bottom: 30, transform: 'rotate(-90deg)', transformOrigin: 'center', whiteSpace: 'nowrap',
        }}>same project state</div>
      </div>

      {/* RIGHT — Hands-on Mode track */}
      <TrackCol
        title="Hands-on Mode"
        subtitle="🔧 you drive · I assist"
        tone="line"
        stops={[
          { kind: 'start', label: 'You wrote your idea' },
          { kind: 'ping', label: 'Approve idea brief?', detail: '3 must-haves, 2 maybes' },
          { kind: 'ping', label: 'Approve project plan?' },
          { kind: 'ping', label: 'Approve screen mockups?' },
          { kind: 'ping', label: 'Pick the build approach (architect)' },
          { kind: 'ping', label: 'Pick the stack' },
          { kind: 'ping', label: 'Code review · 4 PRs' },
          { kind: 'ping', label: 'Approve QA test plan' },
          { kind: 'ping', label: 'PRICING decision' },
          { kind: 'ping', label: 'Review each fix loop iteration', detail: '+ ~6 more' },
          { kind: 'ping', label: 'PREVIEW & ship readiness check' },
          { kind: 'end', label: 'Handoff bundle ready' },
        ]}
        meta={['~20 check-ins', '~7 days', 'all 3 rooms visible']}
      />
    </div>

    {/* Bottom: principles bar */}
    <div className="row gap-4" style={{
      marginTop: 20, paddingTop: 14, borderTop: '1.5px dashed var(--line-soft)',
    }}>
      {[
        ['Same destination', 'Both tracks ship the same artifact.'],
        ['One-way? No.', 'Flip Easy → Hands-on anytime. Hands-on → Easy asks once.'],
        ['Promote, don\'t hide', 'Easy still surfaces irreversible / brand / money decisions. Always.'],
        ['Auto = revertible', 'Every Universe-made decision has an "undo" button next to it.'],
      ].map(([t, s]) => (
        <div key={t} className="col gap-1" style={{ flex: 1 }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 700 }}>{t}</span>
          <span className="hand" style={{ fontSize: 15.5, color: 'var(--ink-soft)', lineHeight: 1.2 }}>{s}</span>
        </div>
      ))}
    </div>
  </div>
);

const TrackCol = ({ title, subtitle, stops, meta, tone }) => (
  <div className="col" style={{ flex: 1, padding: '0 18px', minWidth: 0 }}>
    <div className="col gap-1" style={{ marginBottom: 14 }}>
      <h2 className="hand" style={{ margin: 0, fontSize: 28, color: tone === 'ink' ? 'var(--ink)' : 'var(--ink-soft)' }}>
        {title}
      </h2>
      <span className="hand" style={{ fontSize: 17, color: 'var(--accent)' }}>{subtitle}</span>
      <div className="row gap-2" style={{ marginTop: 4, flexWrap: 'wrap' }}>
        {meta.map(m => <Chip key={m} kind="mute">{m}</Chip>)}
      </div>
    </div>

    <div className="col" style={{ flex: 1, position: 'relative', overflow: 'auto', paddingLeft: 6 }}>
      {/* vertical track line */}
      <div style={{
        position: 'absolute', left: 16, top: 8, bottom: 8,
        width: 2, background: tone === 'ink' ? 'var(--ink)' : 'var(--line-soft)',
        borderRadius: 1,
      }} />
      {stops.map((s, i) => <Stop key={i} {...s} index={i} />)}
    </div>
  </div>
);

const Stop = ({ kind, label, detail, index }) => {
  const isPing = kind === 'ping';
  const isAuto = kind === 'auto';
  const isStart = kind === 'start';
  const isEnd = kind === 'end';
  return (
    <div className="row gap-3 items-start" style={{ position: 'relative', paddingLeft: 0, paddingBottom: 12 }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        border: '2px solid var(--ink)',
        background:
          isStart ? 'var(--paper-2)' :
          isEnd ? 'var(--good-soft)' :
          isPing ? 'var(--marker)' :
          'white',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 12,
        flexShrink: 0, zIndex: 1,
      }}>
        {isStart && '◐'}
        {isEnd && '✓'}
        {isAuto && '✦'}
        {isPing && '!'}
      </div>
      <div className="col" style={{ flex: 1, lineHeight: 1.3, paddingTop: 4 }}>
        <span style={{
          fontFamily: 'var(--ui)', fontSize: 12.5,
          fontWeight: isPing ? 700 : isAuto ? 500 : 600,
          color: isAuto ? 'var(--ink-soft)' : 'var(--ink)',
        }}>
          {label}
        </span>
        {detail && (
          <span className="hand" style={{ fontSize: 14, color: isPing ? 'var(--warn)' : 'var(--ink-mute)' }}>
            {detail}
          </span>
        )}
      </div>
    </div>
  );
};

// ============================================================
// ModeD — Mode toggle interaction · where it lives + flipping
// ============================================================
const ModeD = () => (
  <div className="wf paper" style={{
    width: '100%', height: '100%', padding: '28px 36px', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', gap: 22,
  }}>
    <div className="col gap-1">
      <SketchH size={26}>Where the toggle lives · what happens when you flip</SketchH>
      <span className="hand" style={{ fontSize: 18, color: 'var(--ink-soft)' }}>
        Persistent, top-right. One click. State persists per project.
      </span>
    </div>

    {/* The toggle states row */}
    <div className="row gap-5" style={{ alignItems: 'stretch', flex: 1, minHeight: 0 }}>
      {/* State 1: Easy — closed factory */}
      <div className="col gap-2" style={{ flex: 1 }}>
        <div className="row gap-2 items-center">
          <Chip kind="good">Easy mode active</Chip>
          <span className="hand" style={{ fontSize: 15, color: 'var(--ink-mute)' }}>default</span>
        </div>
        <div className="sketch-box" style={{ flex: 1, padding: 0, background: 'white', overflow: 'hidden' }}>
          <MiniBar mode="easy" />
          <div className="col" style={{ padding: '20px 18px', gap: 14 }}>
            <div className="row gap-3 items-center">
              <UniverseOrb size={48} busy />
              <span className="hand" style={{ fontSize: 22 }}>building your app · ~25m</span>
            </div>
            <SimpleProgress done={4} total={9} />
            <div className="row gap-2 items-center" style={{
              padding: '8px 12px', background: 'var(--good-soft)',
              border: '1.5px solid var(--good)', borderRadius: 8,
            }}>
              <span>✓</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600 }}>Nothing for you</span>
            </div>
            <div className="hand" style={{ fontSize: 14, color: 'var(--ink-mute)', marginTop: 4 }}>
              factory rooms not shown ↓
            </div>
          </div>
        </div>
      </div>

      {/* Flip arrow */}
      <div className="col items-center" style={{ justifyContent: 'center', width: 50 }}>
        <span className="hand" style={{ fontSize: 38, color: 'var(--accent)' }}>⇄</span>
        <span className="hand" style={{ fontSize: 14, color: 'var(--ink-mute)', textAlign: 'center', marginTop: 4 }}>
          one click
        </span>
      </div>

      {/* State 2: Hands-on — opened factory */}
      <div className="col gap-2" style={{ flex: 1 }}>
        <div className="row gap-2 items-center">
          <Chip kind="accent">Hands-on mode active</Chip>
          <span className="hand" style={{ fontSize: 15, color: 'var(--ink-mute)' }}>same project state</span>
        </div>
        <div className="sketch-box" style={{ flex: 1, padding: 0, background: 'white', overflow: 'hidden' }}>
          <MiniBar mode="hands" />
          <div className="col" style={{ padding: '16px 14px', gap: 10 }}>
            <div className="row gap-2">
              {['Drawing Room', 'Workshop', 'Showroom'].map((r, i) => (
                <div key={r} className="col gap-1" style={{
                  flex: 1, padding: '8px 10px',
                  border: '1.5px solid var(--ink)', borderRadius: 6,
                  background: i === 0 ? 'var(--good-soft)' : i === 1 ? 'var(--marker)' : 'white',
                  opacity: i === 2 ? 0.55 : 1,
                }}>
                  <span style={{ fontFamily: 'var(--ui)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>
                    {i === 0 ? '✓ done' : i === 1 ? '● now' : '🔒 next'}
                  </span>
                  <span className="hand" style={{ fontSize: 13 }}>{r}</span>
                  <div className="row gap-1" style={{ marginTop: 2 }}>
                    {[1,2,3].map(p => (
                      <span key={p} style={{
                        width: 14, height: 14, borderRadius: '50%',
                        background: 'var(--paper-2)', border: '1px solid var(--ink)',
                      }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="row gap-2 items-center" style={{
              padding: '6px 10px', background: 'var(--warn-soft)',
              border: '1.5px solid var(--warn)', borderRadius: 6,
            }}>
              <span style={{ fontSize: 13 }}>!</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 600 }}>
                3 past Universe decisions queued for review
              </span>
            </div>
            <div className="hand" style={{ fontSize: 14, color: 'var(--accent)' }}>
              all rooms visible · all crew shown · all artifacts open
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* Bottom: flip behavior */}
    <div className="row gap-3" style={{ alignItems: 'stretch' }}>
      <div className="sketch-box thin" style={{ flex: 1, padding: 14, background: 'white' }}>
        <span className="wf-label" style={{ color: 'var(--good)' }}>Easy → Hands-on</span>
        <div className="hand" style={{ fontSize: 17, marginTop: 4 }}>
          Always free. Just opens the rooms. Past auto-decisions appear in your review queue.
        </div>
      </div>
      <div className="sketch-box thin" style={{ flex: 1, padding: 14, background: 'white' }}>
        <span className="wf-label" style={{ color: 'var(--warn)' }}>Hands-on → Easy</span>
        <div className="hand" style={{ fontSize: 17, marginTop: 4 }}>
          Asks once: "Auto-approve from here?" Won't auto-approve a pending decision in front of you.
        </div>
      </div>
      <div className="sketch-box thin" style={{ flex: 1, padding: 14, background: 'white' }}>
        <span className="wf-label">Per-decision override</span>
        <div className="hand" style={{ fontSize: 17, marginTop: 4 }}>
          Any Easy-mode decision can be flagged "ask me on this kind" in Settings.
        </div>
      </div>
    </div>

    <Note x={50} y={290} w={170} rotate={-2}>
      ★ same factory underneath<br />— rooms just hidden
    </Note>
  </div>
);

const MiniBar = ({ mode }) => (
  <div className="row between items-center" style={{
    padding: '8px 12px', borderBottom: '1.5px solid var(--line-soft)', background: 'var(--paper-2)',
  }}>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700 }}>Tutor Match</span>
    <ModePill mode={mode} />
  </div>
);

Object.assign(window, { ModeA, ModeB, ModeC, ModeD, ModePill });
