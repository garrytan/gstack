// Mobile sketches + intro/legend artboards

// ============================================================
// Intro / Reasoning artboard — what these wireframes ARE
// ============================================================
const Intro = () => (
  <div className="wf paper col" style={{ width: 800, height: 760, padding: 40, gap: 18 }}>
    <div className="col gap-2">
      <span className="wf-label">Wireframes · round 1 · {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
      <h1 className="hand" style={{ fontSize: 56, lineHeight: 0.95, margin: 0 }}>
        Universe AI Software Factory<br/>
        <span className="sketch-underline">first pass</span>
      </h1>
    </div>
    <p style={{ margin: 0, fontFamily: 'var(--ui)', fontSize: 14, lineHeight: 1.55 }}>
      Mixed-fidelity sketches exploring the product wedge: a <strong>visible factory cockpit</strong> where conversation, personas, artifacts, approvals, and safety are first-class. Not an IDE. Not a black-box prompt builder.
    </p>

    <div className="sketch-box pad-4" style={{ background: 'white' }}>
      <SketchH size={20}>What's on this canvas</SketchH>
      <div className="col gap-2" style={{ marginTop: 10, fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5 }}>
        <Row n="1" name="Dashboard" sub="two takes — decisions-first vs production-floor resume" />
        <Row n="2" name="Idea wizard" sub="two takes — split form vs single-question conversational" />
        <Row n="3" name="★ Easy vs Hands-on" sub="the two tracks — picker, easy in-flight, comparison, toggle behavior" />
        <Row n="4" name="The Factory" sub="3-bay top-level map (Hands-on) — rooms · storybook · conveyor" />
        <Row n="5" name="Simplified overview" sub="day-to-day surface inside a bay" />
        <Row n="6" name="Cockpit (4 variations)" sub="detailed factory floor" />
        <Row n="7" name="Gate decision" sub="centered modal vs in-context split" />
        <Row n="8" name="QA browser evidence" sub="post-run matrix vs live replay" />
        <Row n="9" name="Ship readiness" sub="checklist vs handoff-bundle 'boxing up'" />
        <Row n="10" name="Mobile sketches" sub="cockpit · decision · resume" />
      </div>
    </div>

    <div className="sketch-box pad-4" style={{ background: 'var(--paper-2)' }}>
      <span className="wf-label">UX invariants on every screen</span>
      <div className="col gap-1" style={{ marginTop: 8, fontFamily: 'var(--ui)', fontSize: 12.5 }}>
        <div>1. What's happening now</div>
        <div>2. Who/which persona is working</div>
        <div>3. What that persona is allowed to touch (safety)</div>
        <div>4. What artifact was produced</div>
        <div>5. What decision is needed from you</div>
        <div>6. What happens next</div>
      </div>
    </div>

    <div className="row gap-3" style={{ marginTop: 'auto' }}>
      <div className="col" style={{ flex: 1 }}>
        <span className="wf-label">How to navigate</span>
        <span className="scribble" style={{ fontSize: 15 }}>↔ scroll / pan · ⌘+wheel to zoom · click any artboard ⤢ to focus</span>
      </div>
      <Persona initials="MV" name="for Milton" sub="from your designer" />
    </div>
  </div>
);

const Row = ({ n, name, sub }) => (
  <div className="row gap-3 items-start">
    <span style={{
      width: 22, height: 22, borderRadius: '50%',
      border: '1.5px solid var(--ink)', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 13,
      background: 'var(--marker)',
    }}>{n}</span>
    <div className="col" style={{ lineHeight: 1.25 }}>
      <span style={{ fontWeight: 700 }}>{name}</span>
      <span style={{ color: 'var(--ink-mute)' }}>{sub}</span>
    </div>
  </div>
);

// ============================================================
// Component legend artboard
// ============================================================
const Legend = () => (
  <div className="wf paper col" style={{ width: 800, height: 760, padding: 32, gap: 16 }}>
    <div className="col">
      <span className="wf-label">Component legend</span>
      <h1 className="hand" style={{ fontSize: 36, margin: 0 }}>Building blocks · <span className="sketch-underline">tidy where it counts</span></h1>
      <span className="scribble" style={{ fontSize: 16, marginTop: 4 }}>Hand-drawn for layout & ideas. Tidy for things that ship — chips, buttons, persona icons, status states.</span>
    </div>

    <div className="row gap-3" style={{ alignItems: 'stretch' }}>
      <div className="sketch-box pad-3" style={{ flex: 1, background: 'white' }}>
        <span className="wf-label">Personas (functional, not mascots)</span>
        <div className="col gap-2" style={{ marginTop: 10 }}>
          <Persona initials="PC" kind="coach" name="Product Coach" sub="Idea & MVP shaping" />
          <Persona initials="CR" kind="reviewer" name="CEO/Reviewer" sub="Scope & value challenges" />
          <Persona initials="DS" kind="designer" name="Designer" sub="Screens & flows" />
          <Persona initials="AR" kind="arch" name="Eng. Architect" sub="Build approach" />
          <Persona initials="IM" kind="builder" name="Implementation" sub="Writes (approved)" />
          <Persona initials="CV" kind="reviewer" name="Code Reviewer" sub="Quality audit" />
          <Persona initials="QA" kind="qa" name="QA Lead" sub="Browser evidence" />
          <Persona initials="RC" kind="release" name="Release Coord." sub="Readiness & handoff" />
        </div>
      </div>

      <div className="col gap-3" style={{ flex: 1 }}>
        <div className="sketch-box pad-3" style={{ background: 'white' }}>
          <span className="wf-label">Phase pills</span>
          <div className="row gap-2 items-center" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <PhasePill state="done">✓ Done</PhasePill>
            <PhasePill state="active">● Active</PhasePill>
            <PhasePill state="upcoming">○ Upcoming</PhasePill>
            <PhasePill state="blocked">⚠ Blocked</PhasePill>
          </div>
        </div>

        <div className="sketch-box pad-3" style={{ background: 'white' }}>
          <span className="wf-label">Safety badges (= command profiles)</span>
          <div className="col gap-1" style={{ marginTop: 8 }}>
            <div className="row gap-2 items-center"><Chip kind="accent" dot>Read-only audit</Chip><span style={{ fontSize: 11 }}>= produce artifacts only</span></div>
            <div className="row gap-2 items-center"><Chip kind="accent" dot>Browser audit</Chip><span style={{ fontSize: 11 }}>= can click UI, can't edit code</span></div>
            <div className="row gap-2 items-center"><Chip kind="warn" dot>Safe local fixes</Chip><span style={{ fontSize: 11 }}>= edit project files only</span></div>
            <div className="row gap-2 items-center"><Chip kind="mute" dot>Network/CI allowed</Chip><span style={{ fontSize: 11 }}>= scoped, off by default</span></div>
            <div className="row gap-2 items-center"><Chip kind="danger" dot>Release locked</Chip><span style={{ fontSize: 11 }}>= no push / publish / deploy</span></div>
          </div>
        </div>

        <div className="sketch-box pad-3" style={{ background: 'white' }}>
          <span className="wf-label">Artifact status</span>
          <div className="row gap-2 items-center" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <Chip kind="mute">Draft</Chip>
            <Chip kind="good">Approved</Chip>
            <Chip kind="warn">Needs review</Chip>
            <Chip kind="mute">Superseded</Chip>
            <Chip kind="accent">Evidence</Chip>
          </div>
        </div>
      </div>
    </div>

    <div className="sketch-box pad-3" style={{ background: 'white' }}>
      <span className="wf-label">Phase color encoding (from brief)</span>
      <div className="row gap-2" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        {[
          ['Idea / Plan', '#d9e4ff', '#3055c4'],
          ['Design', '#ecd9ff', '#7a3fc4'],
          ['Build', '#dcdfff', '#3f4dc4'],
          ['Review', '#f6e6c4', '#a37312'],
          ['QA', '#cfe7ec', '#0d7a8f'],
          ['Ship', '#d2e8d8', '#2f7a4f'],
          ['Safety / blocked', '#f0d2cc', '#b14a3a'],
        ].map(([label, bg, color]) => (
          <span key={label} style={{
            padding: '6px 10px', borderRadius: 6, background: bg, color,
            border: '1.5px solid currentColor',
            fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600,
          }}>{label}</span>
        ))}
      </div>
    </div>
  </div>
);

// ============================================================
// MOBILE — Cockpit / phase room
// ============================================================
const MobileCockpit = () => (
  <div className="mobile-frame">
    <div className="mobile-notch">9:41 · 5G · 87%</div>
    {/* Header */}
    <div style={{ padding: '10px 14px', borderBottom: '1.5px solid var(--line)', background: 'white' }}>
      <div className="row between items-center">
        <button className="btn ghost sm" style={{ padding: '4px 8px' }}>← Tutor Match</button>
        <Chip kind="warn">1 decision</Chip>
      </div>
      <div className="row gap-2 items-center" style={{ marginTop: 10 }}>
        <div className="col" style={{ flex: 1, lineHeight: 1.1 }}>
          <span className="wf-label">Phase 4 of 9</span>
          <span style={{ fontFamily: 'var(--hand)', fontSize: 22, lineHeight: 1 }}>Build</span>
        </div>
        <Persona initials="AR" kind="arch" />
      </div>
      {/* Phase rail collapsed as bars */}
      <div className="row gap-1" style={{ marginTop: 10 }}>
        {[1,2,3,4,5,6,7,8,9].map(n => (
          <div key={n} style={{
            flex: 1, height: 5, borderRadius: 2,
            background: n < 4 ? 'var(--good)' : n === 4 ? 'var(--ink)' : 'var(--paper-2)',
            border: '1px solid var(--ink)',
          }} />
        ))}
      </div>
    </div>

    {/* Safety strip */}
    <div style={{
      padding: '6px 14px', background: 'var(--accent-soft)',
      borderBottom: '1.5px solid var(--accent)', fontFamily: 'var(--ui)',
      fontSize: 10.5, color: '#07505d', display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span>✓</span>
      <span>Read-only · Universe can't edit files yet</span>
    </div>

    {/* Stacked content */}
    <div className="col gap-3" style={{ padding: 14, flex: 1, overflow: 'auto' }}>
      {/* Active card */}
      <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
        <div className="row gap-2 items-center" style={{ marginBottom: 6 }}>
          <Persona initials="AR" kind="arch" size={22} />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 600 }}>Architect</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>· now</span>
        </div>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.45 }}>
          I've drafted 3 build slices. Which option for tutor profiles?
        </span>
        <div className="row gap-1" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <Chip style={{ fontSize: 10 }}>A · stubs</Chip>
          <Chip kind="accent" style={{ fontSize: 10 }}>B · photo+line</Chip>
        </div>
      </div>

      {/* Decision card */}
      <div className="decide-card" style={{ padding: 12 }}>
        <Chip kind="warn">Decision</Chip>
        <h3 className="hand" style={{ fontSize: 19, margin: '6px 0 4px' }}>
          Approve build plan?
        </h3>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 11, lineHeight: 1.4, color: 'var(--ink-soft)' }}>
          Nothing is built yet. Universe drafts a plan you can review.
        </span>
        <div className="row gap-1" style={{ marginTop: 8 }}>
          <Chip kind="accent" dot style={{ fontSize: 9 }}>Read-only</Chip>
        </div>
        <button className="btn primary" style={{ width: '100%', marginTop: 10, justifyContent: 'center' }}>Approve →</button>
      </div>

      {/* Latest artifact */}
      <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
        <div className="row between items-center">
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600 }}>Build Plan (draft)</span>
          <Chip kind="warn" style={{ fontSize: 9 }}>Needs review</Chip>
        </div>
        <Lines widths={['90%', '70%']} />
      </div>
    </div>

    {/* Sticky bottom CTA */}
    <div style={{
      padding: 10, borderTop: '1.5px solid var(--line)', background: 'var(--marker)',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ flex: 1, fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 600 }}>
        ↳ Decide on the build plan
      </span>
      <button className="btn primary sm">Open →</button>
    </div>
  </div>
);

// ============================================================
// MOBILE — Decision
// ============================================================
const MobileDecision = () => (
  <div className="mobile-frame">
    <div className="mobile-notch">9:41 · 5G · 87%</div>
    <div style={{ padding: '10px 14px', borderBottom: '1.5px solid var(--line)' }}>
      <div className="row between items-center">
        <button className="btn ghost sm" style={{ padding: '4px 8px' }}>← Back</button>
        <Chip kind="warn">Gate 7.1</Chip>
      </div>
    </div>

    <div className="col" style={{ padding: 16, flex: 1, gap: 12, overflow: 'auto' }}>
      <Chip kind="warn">Decision needed</Chip>
      <h1 className="hand" style={{ fontSize: 28, margin: 0, lineHeight: 1.05 }}>
        Allow safe local fixes?
      </h1>
      <p style={{ margin: 0, fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-soft)' }}>
        Universe will edit 3 files in your project. Nothing is pushed, deployed, or published.
      </p>

      <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
        <span className="wf-label">What Universe can / cannot do</span>
        <div className="col gap-1" style={{ marginTop: 6 }}>
          <SafetyRow label="Edit project files" allowed />
          <SafetyRow label="Re-run QA checks" allowed />
          <SafetyRow label="Push or deploy" />
          <SafetyRow label="Force-reset, clean" />
          <SafetyRow label="Read secrets" />
        </div>
      </div>

      <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
        <span className="wf-label">Evidence</span>
        <div className="col gap-1" style={{ marginTop: 6 }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--accent)', textDecoration: 'underline' }}>📄 QA Report #4</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--accent)', textDecoration: 'underline' }}>🖼 3 screenshots</span>
        </div>
      </div>

      <div className="col gap-1">
        <span className="wf-label">Reason (optional)</span>
        <div className="tidy-soft" style={{ minHeight: 50, background: 'var(--paper)', fontSize: 11 }} />
      </div>
    </div>

    {/* Sticky action bar */}
    <div style={{
      padding: 10, borderTop: '1.5px solid var(--line)', background: 'white',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <button className="btn accent" style={{ width: '100%', justifyContent: 'center', padding: '10px 14px' }}>Approve · apply fixes</button>
      <div className="row gap-2">
        <button className="btn ghost sm" style={{ flex: 1, justifyContent: 'center' }}>Request changes</button>
        <button className="btn ghost sm" style={{ flex: 1, justifyContent: 'center' }}>Reject</button>
      </div>
    </div>
  </div>
);

// ============================================================
// MOBILE — Resume / dashboard
// ============================================================
const MobileResume = () => (
  <div className="mobile-frame">
    <div className="mobile-notch">9:41 · 5G · 87%</div>
    <div style={{ padding: '14px 16px', borderBottom: '1.5px solid var(--line)' }}>
      <div className="row between items-center">
        <span style={{ fontFamily: 'var(--hand)', fontSize: 22 }}>Universe AI</span>
        <Persona initials="MV" size={26} />
      </div>
      <span className="scribble" style={{ fontSize: 14, marginTop: 4, display: 'block' }}>
        good morning, Maya — 2 decisions waiting
      </span>
    </div>

    <div className="col" style={{ padding: 14, flex: 1, gap: 12, overflow: 'auto' }}>
      {/* Resume hero */}
      <div className="sketch-box pad-3" style={{
        background: 'white', borderColor: 'var(--accent)', borderWidth: 2,
      }}>
        <span className="wf-label" style={{ color: 'var(--accent)' }}>↳ Pick up where you left off</span>
        <h2 className="hand" style={{ fontSize: 22, margin: '4px 0' }}>Tutor Match</h2>
        <div className="row gap-1" style={{ marginTop: 6 }}>
          {[1,2,3,4,5,6,7,8,9].map(n => (
            <div key={n} style={{
              flex: 1, height: 5, borderRadius: 2,
              background: n < 2 ? 'var(--good)' : n === 2 ? 'var(--ink)' : 'var(--paper-2)',
              border: '1px solid var(--ink)',
            }} />
          ))}
        </div>
        <div className="row gap-2 items-center" style={{ marginTop: 8 }}>
          <Persona initials="PC" kind="coach" size={24} />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, flex: 1 }}>Product Coach drafted MVP scope</span>
        </div>
        <Chip kind="warn" style={{ marginTop: 6 }}>Decision · Approve MVP scope</Chip>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>Open cockpit →</button>
      </div>

      <span className="wf-label">Other projects</span>
      <MiniProject name="Bakery POS" phase="Fix loop" persona={{ initials: 'IM', kind: 'builder' }} warn />
      <MiniProject name="HOA Portal" phase="QA running" persona={{ initials: 'QA', kind: 'qa' }} accent />
      <MiniProject name="Wedding Site" phase="Ready for handoff" persona={{ initials: 'RC', kind: 'release' }} good />
    </div>

    <div style={{ padding: 10, borderTop: '1.5px solid var(--line)' }}>
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}>+ New project</button>
    </div>
  </div>
);

const MiniProject = ({ name, phase, persona, warn, accent, good }) => (
  <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
    <div className="row between items-center">
      <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 700 }}>{name}</span>
      <Persona {...persona} size={22} />
    </div>
    <Chip
      kind={warn ? 'warn' : accent ? 'accent' : good ? 'good' : 'mute'}
      dot
      style={{ marginTop: 6, fontSize: 9.5 }}
    >{phase}</Chip>
  </div>
);

Object.assign(window, { Intro, Legend, MobileCockpit, MobileDecision, MobileResume });
