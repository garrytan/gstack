// Four cockpit variations exploring the dimensions:
// A — Classic three-col: left timeline rail, center chat, right persona+artifact
// B — Artifact-first split: top stepper, big artifact stage, chat as slide-up drawer
// C — Conveyor map: horizontal production line with stations + nested QA→fix loop
// D — Decision-stage: approval card IS the screen, chat & timeline are supporting

// ============================================================
// Shared sub-bits for cockpits
// ============================================================
const PhaseHeader = ({ name, num, persona, safety = 'Read-only audit', sub }) => (
  <div className="row between items-center" style={{
    padding: '14px 20px', borderBottom: '1.5px solid var(--line)', background: 'white',
  }}>
    <div className="col" style={{ lineHeight: 1.2 }}>
      <span className="wf-label">Project · Tutor Match</span>
      <h2 className="wf-h1" style={{ fontSize: 18 }}>
        Phase {num}: <span className="hand" style={{ fontSize: 24 }}>{name}</span>
      </h2>
      {sub && <span className="scribble" style={{ fontSize: 15, marginTop: 2 }}>{sub}</span>}
    </div>
    <div className="row gap-3 items-center">
      <Persona {...persona} />
      <Chip kind="accent" dot>{safety}</Chip>
    </div>
  </div>
);

const ArtifactPreview = ({ title, status = 'Draft', kind = 'plan', lines = 5 }) => (
  <div className="artifact-card" style={{ background: 'white' }}>
    <div className="row between items-center">
      <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 700 }}>{title}</span>
      <Chip kind={status === 'Approved' ? 'good' : status === 'Needs review' ? 'warn' : 'mute'}>{status}</Chip>
    </div>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>{kind} · auto-generated</span>
    <Lines widths={Array.from({ length: lines }, (_, i) => `${90 - i * 8}%`)} />
  </div>
);

const DecisionCard = ({ title, why, impact, recommend = 'Approve', primary = 'Approve', subtle }) => (
  <div className="decide-card">
    <div className="row gap-2 items-center" style={{ marginBottom: 6 }}>
      <Chip kind="warn">Decision needed</Chip>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>·  Recommended: {recommend}</span>
    </div>
    <h3 className="hand" style={{ fontSize: 22, margin: '0 0 6px', lineHeight: 1.1 }}>{title}</h3>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink-soft)' }}>{why}</span>
    {impact && (
      <div className="row gap-2 items-center" style={{ marginTop: 8 }}>
        {impact.map((i, idx) => <Chip key={idx} kind={i.kind} dot={i.dot}>{i.label}</Chip>)}
      </div>
    )}
    {!subtle && (
      <div className="row between items-center" style={{ marginTop: 12 }}>
        <button className="btn ghost sm">Request changes</button>
        <div className="row gap-2">
          <button className="btn ghost sm">Reject</button>
          <button className="btn primary">{primary}</button>
        </div>
      </div>
    )}
  </div>
);

// ============================================================
// COCKPIT A — Classic 3-col (safe baseline)
// ============================================================
const CockpitA = () => (
  <div className="wf col" style={{ width: 1280, height: 800, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / app / projects / tutor-match" />
    <SafetyStrip mode="Read-only audit" />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="cockpit" />
      <TimelineRail current={4} />

      {/* Center: phase room conversation */}
      <div className="col grow" style={{ background: 'var(--paper)' }}>
        <PhaseHeader
          name="Build"
          num={4}
          persona={{ initials: 'AR', kind: 'arch', name: 'Engineering Architect', sub: 'planning build approach' }}
          safety="Read-only audit"
          sub="Choosing how Universe will build, before any file is written"
        />
        <div className="col gap-3" style={{ flex: 1, padding: 18, overflow: 'hidden' }}>
          {/* Phase intro */}
          <div className="sketch-box thin pad-3" style={{ background: 'white', borderColor: 'var(--accent)' }}>
            <div className="row between items-center" style={{ marginBottom: 6 }}>
              <span className="wf-label" style={{ color: 'var(--accent)' }}>Phase room · Build</span>
              <span className="scribble" style={{ fontSize: 14 }}>3 prior phases collapsed ▾</span>
            </div>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5 }}>
              <strong>Goal:</strong> agree on the build plan. <strong>Produces:</strong> Build Plan artifact. <strong>Then:</strong> you approve safe local writes before any code is written.
            </span>
          </div>

          {/* Conversation */}
          <div className="col gap-3" style={{ flex: 1, overflow: 'hidden', padding: '0 4px' }}>
            <ConvoBubble
              persona={{ initials: 'AR', kind: 'arch', name: 'Engineering Architect', sub: 'reviewed your MVP scope' }}
            >
              I've drafted a build plan in 3 slices: booking flow → tutor profiles → mobile polish.
              Each slice ships behind a feature flag so you can preview before opening to parents.
            </ConvoBubble>
            <ConvoBubble action>Drafting <strong>Build Plan</strong> artifact…</ConvoBubble>
            <ConvoBubble from="user">Can we skip profiles for v1?</ConvoBubble>
            <ConvoBubble
              persona={{ initials: 'AR', kind: 'arch', name: 'Engineering Architect', sub: 'thinking…' }}
            >
              Yes — but parents pick by photo + reviews in your scope. Without profiles we'd need a fallback. Two options:
              <div className="row gap-2" style={{ marginTop: 8 }}>
                <Chip>A · Profiles as stubs</Chip>
                <Chip kind="accent">B · Photo + 1 line only</Chip>
              </div>
            </ConvoBubble>
          </div>

          {/* Input */}
          <div className="row gap-2 items-center">
            <input readOnly placeholder="Reply, or pick a suggestion…" style={{
              flex: 1, padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--line-soft)',
              fontFamily: 'var(--ui)', fontSize: 13, background: 'white',
            }} />
            <button className="btn primary">Send</button>
          </div>
        </div>
      </div>

      {/* Right: persona + artifact + decision */}
      <div className="col" style={{
        width: 320, padding: 16, gap: 14, borderLeft: '1.5px solid var(--line)',
        background: 'var(--paper-2)', overflow: 'auto',
      }}>
        <div className="col gap-2">
          <span className="wf-label">Active persona</span>
          <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
            <Persona initials="AR" kind="arch" name="Engineering Architect" sub="explains build approach" size={36} />
            <div className="col gap-1" style={{ marginTop: 8 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>Current task</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12 }}>Comparing build slices vs scope tradeoffs</span>
            </div>
            <div className="row gap-2" style={{ marginTop: 8 }}>
              <Chip kind="accent" dot>Read-only</Chip>
              <Chip kind="mute">No writes</Chip>
            </div>
          </div>
          <span className="wf-label" style={{ marginTop: 4 }}>Handoff baton</span>
          <div className="row gap-2 items-center" style={{ flexWrap: 'wrap' }}>
            <Chip kind="good" dot>PC</Chip><span>→</span>
            <Chip kind="good" dot>CR</Chip><span>→</span>
            <Chip kind="good" dot>DS</Chip><span>→</span>
            <Chip kind="accent" dot>AR</Chip><span>→</span>
            <Chip kind="mute">IM</Chip><span>→</span>
            <Chip kind="mute">QA</Chip>
          </div>
        </div>

        <div className="col gap-2">
          <span className="wf-label">Latest artifacts</span>
          <ArtifactPreview title="MVP Scope v2" status="Approved" kind="plan" lines={3} />
          <ArtifactPreview title="Build Plan (draft)" status="Draft" kind="build-plan" lines={4} />
        </div>

        <div className="col gap-2">
          <DecisionCard
            title="Approve build plan?"
            why="Universe will draft a Build Plan you can review. Nothing is built yet."
            impact={[
              { label: 'Read-only', kind: 'accent', dot: true },
              { label: 'No files edited', kind: 'mute' },
            ]}
            primary="Approve plan"
          />
        </div>
      </div>
    </div>
    {/* Annotations */}
    <Note x={480} y={770} w={220} kind="ink" rotate={0}>
      ✎ Chat is the medium; artifacts & decisions are the units of progress.
    </Note>
  </div>
);

// ============================================================
// COCKPIT B — Artifact-first split (artifact center, chat as drawer)
// ============================================================
const CockpitB = () => (
  <div className="wf col" style={{ width: 1280, height: 800, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / app / projects / tutor-match" />
    <SafetyStrip mode="Read-only audit" />

    {/* Top phase stepper */}
    <div className="row items-center gap-2" style={{
      padding: '14px 24px', background: 'white', borderBottom: '1.5px solid var(--line)',
    }}>
      <div className="col" style={{ marginRight: 16 }}>
        <span className="wf-label">Tutor Match</span>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 700 }}>Phase 4 · Build</span>
      </div>
      {['Idea', 'Plan', 'Design', 'Build', 'Review', 'QA', 'Fix', 'Ship', 'Handoff'].map((p, i) => {
        const state = i + 1 < 4 ? 'done' : i + 1 === 4 ? 'active' : 'upcoming';
        return (
          <React.Fragment key={p}>
            <PhasePill state={state}>
              {state === 'done' ? '✓' : i + 1}
              <span style={{ marginLeft: 2 }}>{p}</span>
            </PhasePill>
            {i < 8 && <span style={{ color: 'var(--line-soft)', fontSize: 16 }}>—</span>}
          </React.Fragment>
        );
      })}
    </div>

    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      {/* Center stage: the Build Plan artifact */}
      <div className="col grow" style={{ padding: 24, gap: 14, overflow: 'hidden' }}>
        <div className="row between items-center">
          <div className="col">
            <span className="wf-label" style={{ color: 'var(--accent)' }}>↳ Artifact in focus</span>
            <h2 className="hand" style={{ fontSize: 32, margin: 0 }}>Build Plan · draft</h2>
          </div>
          <div className="row gap-2">
            <Chip kind="mute">v0.3</Chip>
            <Chip kind="warn">Needs review</Chip>
            <button className="btn ghost sm">Compare</button>
            <button className="btn ghost sm">Share</button>
          </div>
        </div>

        <div className="sketch-box" style={{
          flex: 1, background: 'white', padding: '24px 32px',
          overflow: 'auto', position: 'relative',
        }}>
          <div className="col gap-3" style={{ maxWidth: 640 }}>
            <span className="wf-label" style={{ color: 'var(--accent)' }}>Build Plan</span>
            <span className="scribble" style={{ fontSize: 16 }}>
              Three slices behind feature flags. You preview each before parents see it.
            </span>

            <div className="col gap-2" style={{ marginTop: 4 }}>
              <h3 className="hand" style={{ fontSize: 22, margin: 0 }}>Slice 1 · <span className="sketch-underline">Booking flow</span></h3>
              <Lines widths={['95%', '85%', '70%']} />
              <div className="row gap-2"><Chip>4 days</Chip><Chip kind="mute">low risk</Chip></div>
            </div>
            <div className="col gap-2">
              <h3 className="hand" style={{ fontSize: 22, margin: 0 }}>Slice 2 · <span className="sketch-underline">Tutor profiles</span></h3>
              <Lines widths={['90%', '80%']} />
              <div className="row gap-2"><Chip>3 days</Chip><Chip kind="warn">tradeoff: see decision</Chip></div>
            </div>
            <div className="col gap-2" style={{ opacity: 0.6 }}>
              <h3 className="hand" style={{ fontSize: 22, margin: 0 }}>Slice 3 · <span className="sketch-underline">Mobile polish</span></h3>
              <Lines widths={['70%', '50%']} />
            </div>
          </div>
        </div>

        {/* Slide-up chat drawer (collapsed) */}
        <div className="sketch-box thin" style={{
          background: 'white',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <Persona initials="AR" kind="arch" />
          <div className="col" style={{ flex: 1, lineHeight: 1.15 }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>
              Architect · 2 min ago
            </span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5 }}>
              "I've outlined 3 slices. Reply if you want to skip Slice 2…"
            </span>
          </div>
          <Chip kind="mute">12 in this phase</Chip>
          <button className="btn ghost sm">Open chat ↑</button>
        </div>
      </div>

      {/* Right: persona panel + decision sticky */}
      <div className="col" style={{
        width: 340, padding: 18, gap: 14,
        borderLeft: '1.5px solid var(--line)', background: 'var(--paper-2)',
      }}>
        <div className="col gap-2">
          <span className="wf-label">Working now</span>
          <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
            <Persona initials="AR" kind="arch" name="Engineering Architect" sub="drafting Slice 2 tradeoff" size={36} />
            <div className="row gap-2" style={{ marginTop: 8 }}>
              <Chip kind="accent" dot>Read-only</Chip>
            </div>
          </div>
          <span className="wf-label" style={{ marginTop: 4 }}>Up next</span>
          <div className="sketch-box thin pad-3" style={{ background: 'white', opacity: 0.65 }}>
            <Persona initials="IM" kind="builder" name="Implementation" sub="will need your write approval" size={32} />
          </div>
        </div>

        <DecisionCard
          title="Slice 2: stub profiles or photo+line only?"
          why="Affects ~3 days of build. Stubs keep scope tight but parents need to pick somehow."
          impact={[
            { label: 'Scope choice', kind: 'mute' },
            { label: 'No code yet', kind: 'accent', dot: true },
          ]}
          recommend="Photo + 1 line"
          primary="Pick option B"
        />

        <div className="col gap-2">
          <span className="wf-label">Other artifacts</span>
          <ArtifactPreview title="MVP Scope" status="Approved" kind="plan" lines={2} />
          <ArtifactPreview title="Screen Map" status="Approved" kind="design-doc" lines={2} />
        </div>
      </div>
    </div>

    <Note x={300} y={310} w={220} kind="" rotate={-2}>
      ✎ Document is the hero. Chat is a peekable drawer.
    </Note>
  </div>
);

// ============================================================
// COCKPIT C — "Conveyor" map (novel; subtle factory metaphor)
// ============================================================
const CockpitC = () => (
  <div className="wf col" style={{ width: 1280, height: 800, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / app / projects / tutor-match" />
    <SafetyStrip mode="Safe local fixes" />

    {/* Production line — phases as stations with conveyor */}
    <div style={{
      background: 'white', padding: '24px 24px 18px',
      borderBottom: '1.5px solid var(--line)', position: 'relative',
    }}>
      <div className="row between items-center" style={{ marginBottom: 14 }}>
        <div className="col">
          <span className="wf-label">Tutor Match · Production line</span>
          <span className="scribble" style={{ fontSize: 16 }}>You are at station 7 — Fix loop (nested under QA)</span>
        </div>
        <div className="row gap-2">
          <Chip kind="good" dot>4 done</Chip>
          <Chip kind="warn" dot>Fix loop active</Chip>
          <Chip kind="mute">3 upcoming</Chip>
        </div>
      </div>
      {/* Conveyor */}
      <div style={{ position: 'relative', paddingTop: 6, paddingBottom: 6 }}>
        {/* Conveyor belt */}
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '50%', height: 4,
          background: 'var(--line)', borderRadius: 2, transform: 'translateY(-50%)',
          backgroundImage: 'repeating-linear-gradient(90deg, var(--ink) 0 12px, transparent 12px 18px)',
        }} />
        <div className="row" style={{ position: 'relative', justifyContent: 'space-between' }}>
          {[
            { id: 1, name: 'Idea', state: 'done' },
            { id: 2, name: 'Plan', state: 'done' },
            { id: 3, name: 'Design', state: 'done' },
            { id: 4, name: 'Build', state: 'done' },
            { id: 5, name: 'Review', state: 'done' },
            { id: 6, name: 'QA', state: 'qa', nest: true },
            { id: 7, name: 'Fix', state: 'active', nest: true },
            { id: 8, name: 'Ship', state: 'upcoming' },
            { id: 9, name: 'Handoff', state: 'upcoming' },
          ].map(p => (
            <Station key={p.id} {...p} />
          ))}
        </div>
        {/* Nested loop bracket above stations 6-7 */}
        <svg className="svg-overlay" style={{ top: -6, height: 60, zIndex: 2 }}>
          <path
            d="M 685 50 Q 685 8 760 8 Q 820 8 820 50"
            stroke="var(--warn)" strokeWidth="2" fill="none" strokeDasharray="5 4" strokeLinecap="round"
          />
          <text x="753" y="2" fontSize="11" fontFamily="var(--hand)" fill="var(--warn)">QA → Fix loop</text>
        </svg>
      </div>
    </div>

    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="cockpit" />

      {/* Center: phase room for Fix loop */}
      <div className="col grow" style={{ background: 'var(--paper)' }}>
        <div className="row between items-center" style={{
          padding: '14px 20px', borderBottom: '1.5px solid var(--line)',
          background: 'white',
        }}>
          <div className="col" style={{ lineHeight: 1.2 }}>
            <span className="wf-label">Station 7 · Inside the QA loop</span>
            <h2 className="wf-h1" style={{ fontSize: 18 }}>
              <span className="hand" style={{ fontSize: 24 }}>Fix loop</span> — proposing fixes for 2 failed scenarios
            </h2>
          </div>
          <div className="row gap-2 items-center">
            <Chip kind="warn" dot>2 must-fix</Chip>
            <Chip kind="mute">1 should-fix</Chip>
            <button className="btn ghost sm">Pause loop</button>
          </div>
        </div>

        <div className="col gap-3" style={{ padding: 18, flex: 1, overflow: 'hidden' }}>
          {/* Action card with live progress */}
          <div className="sketch-box pad-3" style={{
            background: 'white', borderColor: 'var(--warn)', borderWidth: 1.5,
          }}>
            <div className="row between items-center" style={{ marginBottom: 8 }}>
              <div className="row gap-2 items-center">
                <Persona initials="IM" kind="builder" name="Implementation Agent" sub="proposing non-destructive fixes" />
              </div>
              <Chip kind="warn" dot>Awaiting your approval</Chip>
            </div>
            <div className="col gap-2">
              <FixItem name="Booking form accepts past dates" suggested="Add date validation in BookingForm" risk="low" />
              <FixItem name="Tutor card collapses on iOS Safari" suggested="Tighten flex shrink + min-width:0" risk="low" />
              <FixItem name="Confirmation email link uses dev URL" suggested="Read base URL from env" risk="medium" warn />
            </div>
          </div>

          {/* Persona handoff baton */}
          <div className="row gap-2 items-center" style={{ padding: '8px 12px', background: 'var(--paper-2)', border: '1.5px dashed var(--line-soft)', borderRadius: 8 }}>
            <span className="wf-label">Baton</span>
            <Chip kind="good" dot>QA</Chip>
            <span style={{ color: 'var(--ink-mute)' }}>found issues →</span>
            <Chip kind="warn" dot>IM</Chip>
            <span style={{ color: 'var(--ink-mute)' }}>proposing fixes →</span>
            <Chip kind="mute">QA</Chip>
            <span style={{ color: 'var(--ink-mute)' }}>regression check</span>
            <span style={{ flex: 1 }} />
            <Chip kind="mute">Loop iteration 1</Chip>
          </div>

          <div className="col grow" style={{ overflow: 'hidden' }}>
            <ConvoBubble
              persona={{ initials: 'IM', kind: 'builder', name: 'Implementation Agent', sub: 'now' }}
            >
              All three fixes are non-destructive — local file edits only, no push or deploy. Approve and I'll apply them, then hand back to QA for a regression pass.
            </ConvoBubble>
          </div>
        </div>
      </div>

      {/* Right: Decision-first sticky */}
      <div className="col" style={{
        width: 340, padding: 18, gap: 14,
        borderLeft: '1.5px solid var(--line)', background: 'var(--paper-2)',
      }}>
        <DecisionCard
          title="Allow Universe to apply 3 safe local fixes?"
          why="Universe will edit project files only. Cannot push, deploy, force-reset, or read secrets."
          impact={[
            { label: 'Safe local writes', kind: 'warn', dot: true },
            { label: 'No deploy', kind: 'mute' },
            { label: 'No secrets', kind: 'mute' },
          ]}
          recommend="Approve"
          primary="Apply fixes"
        />

        <div className="col gap-2">
          <span className="wf-label">Evidence from QA station</span>
          <ArtifactPreview title="QA Report · run #4" status="Needs review" kind="qa-report" lines={3} />
          <ArtifactPreview title="Screenshot · past-date error" status="Evidence" kind="screenshot" lines={1} />
        </div>

        <div className="col gap-2">
          <span className="wf-label">After this</span>
          <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5 }}>
              QA will re-run failed scenarios. If clean, station 8 (Ship readiness) opens.
            </span>
          </div>
        </div>
      </div>
    </div>

    <Note x={48} y={252} w={180} kind="" rotate={-2}>
      ✎ Stations + conveyor; loops nest above the line.
    </Note>
  </div>
);

const Station = ({ id, name, state, nest }) => {
  const isLoop = state === 'qa' || (state === 'active' && nest);
  return (
    <div className="col items-center" style={{ position: 'relative', zIndex: 3 }}>
      <div style={{
        width: 60, height: 60, borderRadius: 12,
        border: state === 'active' ? '2.5px solid var(--warn)' : '1.8px solid var(--ink)',
        background:
          state === 'done' ? 'var(--good-soft)' :
          state === 'active' ? 'var(--marker)' :
          state === 'qa' ? 'var(--accent-soft)' :
          'white',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 24,
        color: state === 'upcoming' ? 'var(--ink-mute)' : 'var(--ink)',
        boxShadow: state === 'active' ? '0 4px 0 var(--ink)' : 'none',
        position: 'relative',
      }}>
        {state === 'done' ? '✓' : id}
      </div>
      <span style={{
        fontFamily: 'var(--ui)', fontSize: 11, marginTop: 6,
        fontWeight: state === 'active' ? 700 : 500,
        color: state === 'upcoming' ? 'var(--ink-mute)' : 'var(--ink)',
      }}>{name}</span>
    </div>
  );
};

const FixItem = ({ name, suggested, risk, warn }) => (
  <div className="row gap-3 items-start" style={{
    padding: 10, background: 'var(--paper-2)', borderRadius: 6,
    border: '1px solid var(--line-soft)',
  }}>
    <input type="checkbox" defaultChecked style={{ marginTop: 2 }} />
    <div className="col grow" style={{ lineHeight: 1.3 }}>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600 }}>{name}</span>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-soft)' }}>↳ {suggested}</span>
    </div>
    <Chip kind={warn ? 'warn' : 'mute'}>{risk} risk</Chip>
  </div>
);

// ============================================================
// COCKPIT D — Decision stage (the approval IS the screen)
// ============================================================
const CockpitD = () => (
  <div className="wf col" style={{ width: 1280, height: 800, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / app / projects / tutor-match" />
    <SafetyStrip mode="Safe local fixes" />

    {/* Slim breadcrumb header */}
    <div className="row between items-center" style={{
      padding: '12px 24px', borderBottom: '1.5px solid var(--line)', background: 'white',
    }}>
      <div className="row gap-2 items-center">
        <span className="wf-label">Tutor Match</span>
        <span style={{ color: 'var(--ink-mute)' }}>›</span>
        <Chip kind="mute" dot>Phase 7</Chip>
        <span className="hand" style={{ fontSize: 22 }}>Fix loop</span>
      </div>
      <div className="row gap-2 items-center">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => (
          <div key={n} title={`Phase ${n}`} style={{
            width: 24, height: 8, borderRadius: 2,
            background: n < 7 ? 'var(--good)' : n === 7 ? 'var(--warn)' : 'var(--paper-2)',
            border: '1px solid var(--ink)',
          }} />
        ))}
        <span className="scribble" style={{ fontSize: 13, marginLeft: 6 }}>7/9</span>
      </div>
    </div>

    {/* Big decision stage */}
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      {/* Persona dock (left) */}
      <div className="col" style={{ width: 100, padding: '20px 12px', borderRight: '1.5px solid var(--line)', background: 'var(--paper-2)', gap: 16 }}>
        <span className="wf-label" style={{ writingMode: 'horizontal-tb', textAlign: 'center' }}>Team</span>
        {[
          { initials: 'PC', kind: 'coach', state: 'done' },
          { initials: 'CR', kind: 'reviewer', state: 'done' },
          { initials: 'DS', kind: 'designer', state: 'done' },
          { initials: 'AR', kind: 'arch', state: 'done' },
          { initials: 'IM', kind: 'builder', state: 'active' },
          { initials: 'CV', kind: 'reviewer', state: 'done' },
          { initials: 'QA', kind: 'qa', state: 'wait' },
          { initials: 'RC', kind: 'release', state: 'upcoming' },
        ].map(p => (
          <div key={p.initials} className="col items-center" style={{ gap: 2 }}>
            <Persona initials={p.initials} kind={p.kind} size={40} />
            <span style={{
              fontFamily: 'var(--ui)', fontSize: 9, fontWeight: 600,
              color: p.state === 'active' ? 'var(--warn)' : p.state === 'done' ? 'var(--good)' : 'var(--ink-mute)',
              textTransform: 'uppercase', letterSpacing: 0.4,
            }}>
              {p.state === 'active' ? '● active' : p.state === 'done' ? '✓ done' : p.state === 'wait' ? 'waiting' : 'upcoming'}
            </span>
          </div>
        ))}
      </div>

      {/* Stage — the decision is the screen */}
      <div className="col grow" style={{ padding: '32px 40px', overflow: 'auto' }}>
        <div className="col gap-2" style={{ marginBottom: 18 }}>
          <Chip kind="warn">Decision needed · blocking fix loop</Chip>
          <h1 className="hand" style={{ fontSize: 48, margin: 0, lineHeight: 1.05, maxWidth: 720 }}>
            Allow Universe to apply <span className="sketch-underline">3 safe local fixes</span>?
          </h1>
          <span className="scribble" style={{ fontSize: 18, marginTop: 4 }}>
            Recommended by Implementation Agent · based on QA Report #4
          </span>
        </div>

        <div className="row gap-4" style={{ alignItems: 'stretch' }}>
          {/* What Universe will do */}
          <div className="sketch-box pad-4" style={{ flex: 1.4, background: 'white' }}>
            <span className="wf-label" style={{ color: 'var(--accent)' }}>What Universe will do</span>
            <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.7 }}>
              <li>Edit <strong>3 files</strong> in your project (local only)</li>
              <li>Re-run failed QA scenarios</li>
              <li>Produce a <strong>Fix Summary</strong> artifact</li>
            </ul>
            <div style={{ marginTop: 14, padding: 10, background: 'var(--paper-2)', borderRadius: 6 }}>
              <span className="wf-label">Cannot</span>
              <div className="row gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                <Chip kind="mute">push / deploy</Chip>
                <Chip kind="mute">force-reset</Chip>
                <Chip kind="mute">read secrets</Chip>
                <Chip kind="mute">publish</Chip>
              </div>
            </div>
          </div>

          {/* Evidence */}
          <div className="sketch-box pad-4" style={{ flex: 1, background: 'white' }}>
            <span className="wf-label">Evidence supporting this</span>
            <div className="col gap-2" style={{ marginTop: 10 }}>
              <EvidenceRow icon="✕" text="Booking accepts past dates" />
              <EvidenceRow icon="✕" text="Tutor card collapses on iOS" />
              <EvidenceRow icon="!" text="Confirmation email uses dev URL" />
            </div>
            <button className="btn ghost sm" style={{ marginTop: 12 }}>View QA Report →</button>
          </div>
        </div>

        {/* Actions */}
        <div className="row gap-3 items-center" style={{ marginTop: 24 }}>
          <button className="btn primary" style={{ fontSize: 14, padding: '12px 22px' }}>✓ Apply 3 fixes</button>
          <button className="btn ghost">Request changes</button>
          <button className="btn ghost">Pause loop</button>
          <span className="scribble" style={{ marginLeft: 'auto', fontSize: 15, color: 'var(--ink-mute)' }}>
            You can undo any fix from Build → History
          </span>
        </div>

        {/* Collapsed chat */}
        <div style={{ marginTop: 28 }}>
          <button className="btn ghost sm" style={{ width: '100%', justifyContent: 'space-between' }}>
            <span>Open phase conversation · 14 messages</span>
            <span>↓</span>
          </button>
        </div>
      </div>
    </div>

    <Note x={400} y={520} w={200} kind="" rotate={-2}>
      ✎ The approval IS the page. No modal. No buried buttons.
    </Note>
  </div>
);

const EvidenceRow = ({ icon, text }) => (
  <div className="row gap-2 items-center">
    <span style={{
      width: 22, height: 22, borderRadius: '50%', background: 'var(--danger-soft)',
      border: '1.5px solid var(--danger)', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 11, color: 'var(--danger)',
    }}>{icon}</span>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5 }}>{text}</span>
  </div>
);

Object.assign(window, { CockpitA, CockpitB, CockpitC, CockpitD });
