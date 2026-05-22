// Dashboard + Idea Wizard wireframes

// ============================================================
// Workspace Dashboard — Take A: "Decisions-first" (safe baseline)
// ============================================================
const DashA = () => (
  <div className="wf paper col" style={{ width: 1180, height: 760 }}>
    <WinChrome url="universe.ai / app" right={<Chip kind="mute" style={{ marginLeft: 'auto' }}>Workspace: Maya's Studio</Chip>} />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="home" />
      <div className="col grow" style={{ padding: 24, gap: 18, overflow: 'hidden' }}>
        {/* Header */}
        <div className="row between items-center">
          <div className="col gap-2">
            <h1 className="wf-title" style={{ fontSize: 32 }}>Good morning, Maya</h1>
            <span className="scribble" style={{ fontSize: 16 }}>3 projects in flight · 2 need your attention</span>
          </div>
          <button className="btn primary" style={{ fontSize: 13, padding: '10px 16px' }}>+ New project</button>
        </div>

        {/* Decisions-needed banner */}
        <div className="sketch-box pad-4" style={{
          background: '#fff8e0', borderColor: 'var(--warn)', borderWidth: 2,
          borderRadius: '14px 12px 16px 13px / 14px 16px 12px 15px',
        }}>
          <div className="row between items-center" style={{ marginBottom: 10 }}>
            <div className="row gap-2 items-center">
              <span style={{ fontFamily: 'var(--hand)', fontSize: 22, color: '#6a4a08' }}>Decisions waiting on you</span>
              <Chip kind="warn">2</Chip>
            </div>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)', textDecoration: 'underline' }}>See all</span>
          </div>
          <div className="row gap-3">
            <DecisionMini
              project="Tutor Match"
              phase="Planning"
              label="Approve MVP scope"
              persona={{ initials: 'PC', kind: 'coach' }}
              recommend="Approve" />
            <DecisionMini
              project="Bakery POS"
              phase="QA fix loop"
              label="Allow safe local fixes"
              persona={{ initials: 'IM', kind: 'builder' }}
              recommend="Approve · scoped"
              safety="non-destructive write"/>
          </div>
        </div>

        {/* Projects */}
        <div className="col gap-3" style={{ flex: 1, minHeight: 0 }}>
          <div className="row between items-center">
            <SketchH size={20}>Your projects</SketchH>
            <div className="row gap-2">
              <Chip kind="mute">All</Chip>
              <Chip>Needs decision · 2</Chip>
              <Chip kind="mute">In progress · 1</Chip>
              <Chip kind="mute">Complete</Chip>
            </div>
          </div>
          <div className="row gap-3" style={{ flexWrap: 'wrap' }}>
            <ProjectCard
              name="Tutor Match"
              phase="Planning"
              phaseNum={2}
              persona={{ initials: 'PC', kind: 'coach', name: 'Product Coach', sub: 'shaping MVP scope' }}
              nextAction="Approve MVP scope"
              updated="3 min ago"
              decisionPending
              safety="Read-only audit"
            />
            <ProjectCard
              name="Bakery POS"
              phase="Fix loop"
              phaseNum={7}
              persona={{ initials: 'IM', kind: 'builder', name: 'Implementation', sub: 'awaiting write approval' }}
              nextAction="Approve safe local fixes"
              updated="just now"
              decisionPending
              safety="Safe local fixes pending"
              safetyKind="warn"
            />
            <ProjectCard
              name="HOA Portal"
              phase="Browser QA"
              phaseNum={6}
              persona={{ initials: 'QA', kind: 'qa', name: 'QA Lead', sub: 'running 7 scenarios' }}
              nextAction="QA in progress"
              updated="running…"
              safety="Browser audit"
              running
            />
            <ProjectCard
              name="Wedding Site"
              phase="Ready for handoff"
              phaseNum={9}
              persona={{ initials: 'RC', kind: 'release', name: 'Release Coord.', sub: 'checklist complete' }}
              nextAction="Export handoff bundle"
              updated="yesterday"
              safety="Release locked"
              complete
            />
          </div>
        </div>
      </div>
    </div>
  </div>
);

const DecisionMini = ({ project, phase, label, persona, recommend, safety }) => (
  <div className="sketch-box thin pad-3" style={{
    background: 'white', flex: 1, borderRadius: 8,
    borderColor: 'var(--warn)', borderWidth: 1.5,
  }}>
    <div className="row between items-center" style={{ marginBottom: 8 }}>
      <div className="col" style={{ lineHeight: 1.1 }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>{project} · {phase}</span>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600 }}>{label}</span>
      </div>
      <Persona {...persona} />
    </div>
    <div className="row between items-center">
      <div className="col" style={{ lineHeight: 1.1 }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>Recommended</span>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--good)' }}>{recommend}</span>
      </div>
      {safety && <Chip kind="warn" dot>{safety}</Chip>}
      <button className="btn sm primary">Review →</button>
    </div>
  </div>
);

const ProjectCard = ({ name, phase, phaseNum, persona, nextAction, updated, decisionPending, safety, safetyKind, running, complete }) => (
  <div className="sketch-box" style={{ width: 240, padding: 14, background: 'white' }}>
    <div className="row between items-center" style={{ marginBottom: 8 }}>
      <span style={{ fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 14 }}>{name}</span>
      {complete && <Chip kind="good">Ready</Chip>}
      {decisionPending && <Chip kind="warn">!</Chip>}
      {running && <Chip kind="accent">●</Chip>}
    </div>
    {/* mini phase rail */}
    <div className="row gap-1" style={{ marginBottom: 10 }}>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} style={{
          flex: 1, height: 6, borderRadius: 2,
          background:
            i + 1 < phaseNum ? 'var(--good)' :
            i + 1 === phaseNum ? 'var(--ink)' :
            'var(--paper-2)',
          border: '1px solid var(--ink)',
        }} />
      ))}
    </div>
    <div className="col gap-2" style={{ marginBottom: 10 }}>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)' }}>Phase {phaseNum} of 9 · {phase}</span>
      <Persona {...persona} />
    </div>
    <div className="row between items-center" style={{ marginTop: 6 }}>
      <span style={{
        fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600,
        color: decisionPending ? 'var(--warn)' : 'var(--ink-soft)',
      }}>
        {decisionPending && '↳ '}{nextAction}
      </span>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 10, color: 'var(--ink-mute)' }}>{updated}</span>
    </div>
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--line-soft)' }}>
      <Chip kind={safetyKind || 'mute'} dot>{safety}</Chip>
    </div>
  </div>
);

// ============================================================
// Workspace Dashboard — Take B: "Resume cards / production-floor view"
// ============================================================
const DashB = () => (
  <div className="wf paper col" style={{ width: 1180, height: 760 }}>
    <WinChrome url="universe.ai / app" />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="home" />
      <div className="col grow" style={{ padding: 24, gap: 16, overflow: 'hidden' }}>
        <div className="row between items-center">
          <div className="col">
            <span className="wf-label">Workspace</span>
            <h1 className="wf-h1" style={{ fontSize: 22 }}>Production floor</h1>
          </div>
          <div className="row gap-2">
            <input
              readOnly
              placeholder="Search projects, artifacts, decisions…"
              style={{
                width: 320, padding: '8px 12px', border: '1.5px solid var(--line-soft)',
                borderRadius: 8, fontFamily: 'var(--ui)', fontSize: 12,
              }}
            />
            <button className="btn primary">+ New project</button>
          </div>
        </div>

        {/* Resume hero card */}
        <div className="sketch-box pad-4" style={{
          background: 'white',
          borderColor: 'var(--accent)', borderWidth: 2,
          display: 'flex', gap: 24,
        }}>
          <div className="col gap-2" style={{ flex: 1.5 }}>
            <span className="wf-label" style={{ color: 'var(--accent)' }}>↳ Pick up where you left off</span>
            <h2 className="wf-h1" style={{ fontSize: 24 }}>Tutor Match</h2>
            <span className="scribble" style={{ fontSize: 16 }}>
              Yesterday, 5:14 PM — Product Coach finished drafting MVP scope.
            </span>
            <div className="row gap-2 items-center" style={{ marginTop: 4 }}>
              <Persona initials="PC" kind="coach" name="Product Coach" sub="ready for your review" />
              <span style={{ color: 'var(--ink-mute)' }}>→</span>
              <Chip kind="warn">Decision needed</Chip>
            </div>
            <p style={{ margin: '8px 0 0', fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
              <strong>What's happening:</strong> Universe has condensed your idea into 4 MVP slices and 2 non-goals.
              <strong> What's needed:</strong> approve, edit, or ask for alternatives.
              <strong> What happens next:</strong> Designer persona maps screens from the approved scope.
            </p>
          </div>
          <div className="col gap-2" style={{ width: 260 }}>
            <span className="wf-label">Latest artifact</span>
            <div className="artifact-card">
              <div className="row between">
                <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, fontSize: 13 }}>MVP Scope v2</span>
                <Chip kind="warn">Needs review</Chip>
              </div>
              <Lines widths={['100%', '90%', '70%']} />
              <Lines widths={['80%', '50%']} ink />
            </div>
            <button className="btn primary" style={{ justifyContent: 'center', marginTop: 4 }}>Open cockpit →</button>
          </div>
        </div>

        {/* The grid */}
        <div className="col gap-3" style={{ flex: 1, minHeight: 0 }}>
          <div className="row between items-center">
            <SketchH size={20}>Other projects</SketchH>
            <div className="row gap-2 items-center">
              <span className="wf-label">View</span>
              <Chip>Floor</Chip>
              <Chip kind="mute">List</Chip>
              <Chip kind="mute">Activity</Chip>
            </div>
          </div>
          {/* Production floor view — each row is one project, horizontal phase rail */}
          <div className="col gap-2">
            <FloorRow name="Bakery POS" current={7} pending="Approve safe local fixes" persona={{ initials: 'IM', kind: 'builder' }} updated="just now" warn />
            <FloorRow name="HOA Portal" current={6} pending="QA running · 4/7 done" persona={{ initials: 'QA', kind: 'qa' }} updated="running" accent />
            <FloorRow name="Wedding Site" current={9} pending="Export handoff" persona={{ initials: 'RC', kind: 'release' }} updated="yesterday" good />
            <FloorRow name="Spark (draft)" current={1} pending="Continue intake" persona={{ initials: 'PC', kind: 'coach' }} updated="3 days ago" />
          </div>
        </div>
      </div>
    </div>
    <Note x={620} y={290} w={170} rotate={-3} kind="">
      ✎ Resume hero answers the 4 invariants in one card.
    </Note>
  </div>
);

const FloorRow = ({ name, current, pending, persona, updated, warn, accent, good }) => {
  const phases = ['Idea', 'Plan', 'Design', 'Build', 'Review', 'QA', 'Fix', 'Ship', 'Handoff'];
  return (
    <div className="sketch-box thin" style={{ background: 'white', padding: '12px 14px' }}>
      <div className="row items-center gap-4">
        <div className="col" style={{ width: 140, lineHeight: 1.15 }}>
          <span style={{ fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 13.5 }}>{name}</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-mute)' }}>updated {updated}</span>
        </div>
        {/* horizontal phase rail */}
        <div className="row gap-1 items-center" style={{ flex: 1 }}>
          {phases.map((ph, i) => (
            <div key={i} className="col items-center" style={{ flex: 1, gap: 4 }}>
              <div style={{
                width: '100%', height: 8,
                background:
                  i + 1 < current ? 'var(--good)' :
                  i + 1 === current ? (warn ? 'var(--warn)' : accent ? 'var(--accent)' : 'var(--ink)') :
                  'var(--paper-2)',
                border: '1px solid var(--ink)',
                borderRadius: 2,
              }} />
              <span style={{
                fontFamily: 'var(--ui)', fontSize: 9,
                color: i + 1 === current ? 'var(--ink)' : 'var(--ink-mute)',
                fontWeight: i + 1 === current ? 700 : 400,
              }}>{ph}</span>
            </div>
          ))}
        </div>
        <Persona {...persona} />
        <Chip
          kind={warn ? 'warn' : accent ? 'accent' : good ? 'good' : 'mute'}
          style={{ minWidth: 180, justifyContent: 'flex-start' }}
          dot
        >
          {pending}
        </Chip>
      </div>
    </div>
  );
};

// ============================================================
// New Project Wizard — Take A: "Idea canvas grows as you answer"
// ============================================================
const WizardA = () => (
  <div className="wf paper col" style={{ width: 1180, height: 760 }}>
    <WinChrome url="universe.ai / app / projects / new" />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      {/* Left: questions */}
      <div className="col" style={{ width: 480, padding: 28, gap: 18, borderRight: '1.5px solid var(--line)', background: 'var(--paper-2)' }}>
        <div className="col gap-1">
          <span className="wf-label">Step 2 of 4 · Idea shaping</span>
          <h1 className="hand" style={{ fontSize: 32, margin: 0, lineHeight: 1 }}>Tell me about your idea</h1>
        </div>
        <Persona initials="PC" kind="coach" name="Product Coach" sub="I'll turn your idea into a brief you can share." size={36} />

        <div className="col gap-3">
          <div className="col gap-2">
            <span className="wf-h2">What problem are you solving?</span>
            <div className="tidy" style={{ minHeight: 60, background: 'white' }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 13 }}>
                Independent tutors waste hours on email + calendar back-and-forth with parents to schedule lessons.
              </span>
            </div>
          </div>
          <div className="col gap-2">
            <span className="wf-h2">Who is the user?</span>
            <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
              <Chip>Independent tutors</Chip>
              <Chip kind="mute">+ Add</Chip>
            </div>
          </div>
          <div className="col gap-2">
            <div className="row between items-center">
              <span className="wf-h2">What's the must-have outcome?</span>
              <span className="scribble" style={{ fontSize: 14 }}>(one sentence)</span>
            </div>
            <div className="tidy dashed" style={{
              borderStyle: 'dashed', background: 'white', minHeight: 40,
              color: 'var(--ink-mute)', fontFamily: 'var(--ui)', fontSize: 12.5,
            }}>
              <span style={{ borderBottom: '1px solid var(--ink)', paddingBottom: 1 }}>Parents can book a lesson in under 60 seconds…</span>
              <span style={{ animation: 'blink 1s steps(2) infinite' }}>|</span>
            </div>
          </div>
          <div className="col gap-2" style={{ opacity: 0.45 }}>
            <span className="wf-h2">What's your timeline?</span>
            <div className="row gap-2">
              <Chip kind="mute">2 weeks</Chip>
              <Chip kind="mute">1 month</Chip>
              <Chip kind="mute">3 months</Chip>
              <Chip kind="mute">No rush</Chip>
            </div>
          </div>
        </div>

        <div className="row between items-center" style={{ marginTop: 'auto', paddingTop: 12 }}>
          <button className="btn ghost">← Back</button>
          <button className="btn primary">Next question</button>
        </div>
      </div>

      {/* Right: live Idea Brief preview */}
      <div className="col grow" style={{ padding: 28, gap: 14 }}>
        <div className="row between items-center">
          <span className="wf-label">Live preview · grows as you answer</span>
          <div className="row gap-2 items-center">
            <Chip kind="mute">Draft</Chip>
            <span className="scribble" style={{ fontSize: 14 }}>auto-saved · 2 min ago</span>
          </div>
        </div>

        {/* Document */}
        <div className="sketch-box" style={{
          background: 'white', flex: 1, padding: '28px 36px', overflow: 'auto',
        }}>
          <div className="col gap-3">
            <span className="wf-label" style={{ color: 'var(--accent)' }}>Idea Brief · v0.3</span>
            <h2 className="hand" style={{ fontSize: 28, margin: 0 }}>Tutor Match</h2>
            <span className="scribble" style={{ fontSize: 16, color: 'var(--ink-soft)' }}>A scheduling tool for independent tutors and parents.</span>

            <div className="col gap-2" style={{ marginTop: 8 }}>
              <span className="wf-h2 sketch-underline">The problem</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.5 }}>
                Tutors lose 3–5 hrs/week to scheduling email threads. Parents drop off when it takes more than two messages to book.
              </span>
            </div>
            <div className="col gap-2">
              <span className="wf-h2 sketch-underline">Who it's for</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 13 }}>Independent tutors (1–20 students) and the parents who book their kids.</span>
            </div>
            <div className="col gap-2" style={{ opacity: 0.55 }}>
              <span className="wf-h2 sketch-underline">Must-have outcome</span>
              <Lines widths={['80%']} />
            </div>
            <div className="col gap-2" style={{ opacity: 0.3 }}>
              <span className="wf-h2 sketch-underline">Constraints</span>
              <Lines widths={['60%', '40%']} />
            </div>
          </div>
        </div>
      </div>
    </div>
    <SketchArrow x1={500} y1={520} x2={620} y2={520} curve={-10} />
    <Note x={500} y={540} w={120} kind="" rotate={-2}>
      ✎ answer →  brief grows
    </Note>
  </div>
);

// ============================================================
// New Project Wizard — Take B: "Conversational chips, less form"
// ============================================================
const WizardB = () => (
  <div className="wf paper col center" style={{ width: 1180, height: 760, padding: 40 }}>
    <WinChrome url="universe.ai / app / projects / new" />
    <div className="col" style={{ flex: 1, width: '100%', padding: '20px 60px', overflow: 'auto' }}>
      <div className="row between items-center" style={{ marginBottom: 18 }}>
        <div className="row gap-3 items-center">
          <Persona initials="PC" kind="coach" name="Product Coach" sub="step 2 of 4" size={36} />
        </div>
        <div className="row gap-1 items-center">
          {[1, 2, 3, 4].map(n => (
            <div key={n} style={{
              width: 30, height: 6, borderRadius: 3,
              background: n <= 2 ? 'var(--ink)' : 'var(--paper-2)',
              border: '1px solid var(--ink)',
            }} />
          ))}
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-mute)', marginLeft: 6 }}>Idea Brief</span>
        </div>
      </div>

      {/* Big single question */}
      <div className="col gap-4" style={{ marginBottom: 28 }}>
        <h1 className="hand" style={{ fontSize: 44, margin: 0, lineHeight: 1.05 }}>
          And what's the <span className="sketch-underline">must-have outcome</span> for v1?
        </h1>
        <span className="scribble" style={{ fontSize: 18 }}>
          One sentence. The thing without which this is a failure.
        </span>
      </div>

      <div className="sketch-box pad-5" style={{ background: 'white', marginBottom: 18 }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 18, lineHeight: 1.5 }}>
          Parents can book a 1-hour lesson with a known tutor in under 60 seconds, on mobile.
        </span>
        <span style={{ animation: 'blink 1s steps(2) infinite', marginLeft: 2 }}>|</span>
      </div>

      <div className="row gap-3 items-center" style={{ marginBottom: 24 }}>
        <span className="wf-label">Suggestions from your earlier answers</span>
        <Chip kind="accent">+ on mobile</Chip>
        <Chip kind="accent">+ without account</Chip>
        <Chip kind="accent">+ free first session</Chip>
      </div>

      {/* Mini side-by-side preview */}
      <div className="row gap-4" style={{ alignItems: 'stretch' }}>
        <div className="sketch-box pad-4" style={{
          flex: 1, background: 'var(--paper-2)', borderStyle: 'dashed',
        }}>
          <div className="row between items-center" style={{ marginBottom: 8 }}>
            <span className="wf-label" style={{ color: 'var(--accent)' }}>Idea Brief preview</span>
            <Chip kind="mute">v0.3</Chip>
          </div>
          <h3 className="hand" style={{ margin: 0, fontSize: 22 }}>Tutor Match</h3>
          <Lines widths={['80%', '90%', '60%']} />
          <div style={{ marginTop: 8, padding: '6px 0', borderTop: '1px dashed var(--line-soft)' }}>
            <span className="wf-label">Outcome →</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, marginLeft: 6, fontWeight: 600 }}>(filling in…)</span>
          </div>
        </div>
        <div className="sketch-box pad-4" style={{ flex: 1, background: 'white' }}>
          <span className="wf-label" style={{ color: 'var(--ink-mute)' }}>What happens next</span>
          <div className="col gap-2" style={{ marginTop: 8 }}>
            <div className="row gap-2 items-center"><span style={{ color: 'var(--accent)' }}>1.</span><span style={{ fontSize: 12.5 }}>Coach drafts your <strong>Idea Brief</strong></span></div>
            <div className="row gap-2 items-center"><span style={{ color: 'var(--accent)' }}>2.</span><span style={{ fontSize: 12.5 }}>You approve or ask for alternatives</span></div>
            <div className="row gap-2 items-center"><span style={{ color: 'var(--accent)' }}>3.</span><span style={{ fontSize: 12.5 }}>CEO/Product Reviewer challenges scope</span></div>
            <div className="row gap-2 items-center"><span style={{ color: 'var(--ink-mute)' }}>4.</span><span style={{ fontSize: 12.5, color: 'var(--ink-mute)' }}>Designer maps screens</span></div>
          </div>
        </div>
      </div>

      <div className="row between items-center" style={{ marginTop: 24 }}>
        <button className="btn ghost">← Previous</button>
        <div className="row gap-2 items-center">
          <span className="scribble" style={{ fontSize: 15, color: 'var(--ink-mute)' }}>1 more question, then I draft your brief</span>
          <button className="btn primary">Continue →</button>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, { DashA, DashB, WizardA, WizardB });
