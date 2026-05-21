// Supporting screens: Gate modal, QA evidence, Ship readiness, Mobile sketches

// ============================================================
// GATE MODAL — Take A: Centered modal (canonical pattern)
// ============================================================
const GateA = () => (
  <div className="wf col" style={{ width: 1180, height: 760, background: 'var(--paper-2)' }}>
    {/* Dimmed cockpit behind */}
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(20,20,20,0.45)',
      backdropFilter: 'blur(2px)', zIndex: 1, pointerEvents: 'none',
    }} />
    {/* Sketchy faded backdrop hint of cockpit */}
    <div style={{ position: 'absolute', inset: 0, opacity: 0.35, filter: 'blur(0.5px)' }}>
      <WinChrome url="universe.ai / tutor-match" />
      <SafetyStrip mode="Safe local fixes" subtle />
      <div className="row" style={{ flex: 1, height: 'calc(100% - 78px)' }}>
        <SideNav active="cockpit" />
        <TimelineRail current={7} />
        <div className="col grow" style={{ padding: 24 }}>
          <Lines widths={['80%', '70%', '60%', '85%', '50%']} thick />
        </div>
      </div>
    </div>

    {/* Modal */}
    <div style={{
      position: 'absolute', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%)', zIndex: 10,
      width: 580,
    }}>
      <div className="sketch-box" style={{
        background: 'white', padding: '24px 28px',
        borderColor: 'var(--ink)', borderWidth: 2.5,
        boxShadow: '8px 10px 0 rgba(0,0,0,0.12)',
      }}>
        <div className="row between items-center" style={{ marginBottom: 12 }}>
          <Chip kind="warn">Decision · gate 7.1</Chip>
          <button className="btn ghost sm">✕</button>
        </div>
        <h2 className="hand" style={{ fontSize: 32, margin: '0 0 6px', lineHeight: 1.1 }}>
          Allow safe local fixes for this loop?
        </h2>
        <p style={{
          margin: '0 0 14px', fontFamily: 'var(--ui)', fontSize: 13.5,
          lineHeight: 1.55, color: 'var(--ink-soft)',
        }}>
          Universe will edit project files locally to fix the 3 issues QA found. <strong>Nothing is pushed, deployed, or published.</strong> You'll see a Fix Summary you can review before continuing.
        </p>

        <div className="col gap-2" style={{ marginBottom: 14 }}>
          <span className="wf-label">Safety impact</span>
          <div className="row gap-2" style={{ flexWrap: 'wrap' }}>
            <Chip kind="warn" dot>Safe local writes ON</Chip>
            <Chip kind="mute">No deploy / push</Chip>
            <Chip kind="mute">No secrets read</Chip>
            <Chip kind="mute">No force-reset</Chip>
          </div>
        </div>

        <div style={{
          padding: 12, background: 'var(--paper-2)', borderRadius: 6, marginBottom: 14,
        }}>
          <span className="wf-label">Supporting evidence</span>
          <div className="col gap-1" style={{ marginTop: 6 }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--accent)', textDecoration: 'underline' }}>
              📄 QA Report #4 — 3 must-fix
            </span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--accent)', textDecoration: 'underline' }}>
              🖼 Browser screenshots (3)
            </span>
          </div>
        </div>

        <div className="col gap-2" style={{ marginBottom: 14 }}>
          <span className="wf-label">Reason (optional)</span>
          <div className="tidy-soft" style={{
            minHeight: 50, background: 'var(--paper)', fontFamily: 'var(--ui)',
            fontSize: 12, color: 'var(--ink-mute)',
          }}>
            e.g. "Approving — let's land these before review"
          </div>
        </div>

        <details style={{ marginBottom: 16 }}>
          <summary style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>
            Technical detail (capability scope)
          </summary>
        </details>

        <div className="row between items-center">
          <button className="btn ghost">Request changes</button>
          <div className="row gap-2">
            <button className="btn ghost">Reject</button>
            <button className="btn accent">Approve · apply fixes</button>
          </div>
        </div>
      </div>
    </div>

    <Note x={120} y={120} w={180} kind="" rotate={-3}>
      ✎ Modal: high-friction by design. Risky writes deserve focus.
    </Note>
  </div>
);

// ============================================================
// GATE MODAL — Take B: Inline split (in-context, no modal)
// ============================================================
const GateB = () => (
  <div className="wf col" style={{ width: 1180, height: 760, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / tutor-match" />
    <SafetyStrip mode="Safe local fixes" />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="cockpit" />
      <div className="row grow" style={{ minHeight: 0 }}>
        {/* Left: context (the cockpit shrunk) */}
        <div className="col grow" style={{ padding: 18, gap: 12, overflow: 'hidden' }}>
          <span className="wf-label">Phase 7 · Fix loop · in progress</span>
          <div className="row gap-1 items-center">
            {[1,2,3,4,5,6,7,8,9].map(n => (
              <div key={n} style={{
                width: 28, height: 8, borderRadius: 2,
                background: n < 7 ? 'var(--good)' : n === 7 ? 'var(--warn)' : 'var(--paper-2)',
                border: '1px solid var(--ink)',
              }} />
            ))}
          </div>
          <div className="col gap-3" style={{ marginTop: 6 }}>
            <ConvoBubble persona={{ initials: 'QA', kind: 'qa', name: 'QA Lead', sub: 'finished audit' }}>
              Found 3 must-fix issues. No code changed. Posting QA Report #4.
            </ConvoBubble>
            <ConvoBubble action>Implementation Agent drafted 3 non-destructive fixes…</ConvoBubble>
            <ConvoBubble persona={{ initials: 'IM', kind: 'builder', name: 'Implementation', sub: 'awaiting approval' }}>
              Ready to apply when you approve. Each fix is scoped to one file.
            </ConvoBubble>
          </div>
          <div style={{ marginTop: 'auto', opacity: 0.5 }}>
            <span className="scribble" style={{ fontSize: 14 }}>↑ Conversation continues after approval.</span>
          </div>
        </div>

        {/* Right: decision panel (sibling, not overlay) */}
        <div className="col" style={{
          width: 440, padding: 22, borderLeft: '2.5px solid var(--ink)',
          background: 'white', gap: 14,
        }}>
          <Chip kind="warn">Decision · blocking next step</Chip>
          <h2 className="hand" style={{ fontSize: 30, margin: 0, lineHeight: 1.05 }}>
            Allow safe local fixes for this loop?
          </h2>
          <p style={{ margin: 0, fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55 }}>
            Universe will edit 3 project files locally. Nothing is pushed, deployed, or published.
          </p>

          <div className="col gap-2">
            <span className="wf-label">Safety scope</span>
            <div className="row gap-2 between" style={{ flexWrap: 'wrap' }}>
              <SafetyRow label="Edit project files" allowed />
              <SafetyRow label="Re-run safe QA checks" allowed />
              <SafetyRow label="Push or deploy" />
              <SafetyRow label="Force reset / clean" />
              <SafetyRow label="Read secrets / env" />
            </div>
          </div>

          <div className="col gap-2">
            <span className="wf-label">Evidence</span>
            <div className="sketch-box thin pad-3" style={{ background: 'var(--paper-2)' }}>
              <div className="row between items-center">
                <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600 }}>QA Report #4</span>
                <Chip kind="warn">3 must-fix</Chip>
              </div>
              <Lines widths={['90%', '70%']} ink />
            </div>
          </div>

          <div className="col gap-1" style={{ marginTop: 'auto' }}>
            <span className="wf-label">Reason (optional)</span>
            <div className="tidy-soft" style={{
              minHeight: 50, background: 'var(--paper)', fontFamily: 'var(--ui)',
              fontSize: 12, color: 'var(--ink-mute)',
            }}>e.g. why you're approving / declining</div>
          </div>

          <div className="row gap-2" style={{ marginTop: 8 }}>
            <button className="btn ghost">Reject</button>
            <button className="btn ghost">Request changes</button>
            <span style={{ flex: 1 }} />
            <button className="btn accent">Approve fixes →</button>
          </div>
        </div>
      </div>
    </div>
    <Note x={420} y={150} w={180} kind="" rotate={-2}>
      ✎ Split view: context stays visible while you decide.
    </Note>
  </div>
);

const SafetyRow = ({ label, allowed }) => (
  <div className="row gap-2 items-center" style={{ width: '100%' }}>
    <span style={{
      width: 20, height: 20, borderRadius: 4,
      border: '1.5px solid var(--ink)',
      background: allowed ? 'var(--good-soft)' : 'var(--danger-soft)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 12,
      color: allowed ? 'var(--good)' : 'var(--danger)',
    }}>{allowed ? '✓' : '✕'}</span>
    <span style={{
      fontFamily: 'var(--ui)', fontSize: 12.5,
      textDecoration: allowed ? 'none' : 'line-through',
      color: allowed ? 'var(--ink)' : 'var(--ink-mute)',
    }}>{label}</span>
  </div>
);

// ============================================================
// QA EVIDENCE — Take A: Scenario grid + screenshots
// ============================================================
const QAa = () => (
  <div className="wf col" style={{ width: 1180, height: 760, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / tutor-match / qa" />
    <SafetyStrip mode="Browser audit" />

    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="qa" />
      <div className="col grow" style={{ padding: 22, gap: 16, overflow: 'hidden' }}>
        <div className="row between items-center">
          <div className="col" style={{ lineHeight: 1.2 }}>
            <span className="wf-label">QA Evidence · Run #4</span>
            <h1 className="hand" style={{ fontSize: 32, margin: 0 }}>Browser audit · no code changes</h1>
            <span className="scribble" style={{ fontSize: 16, marginTop: 2 }}>
              QA Lead clicked through 7 scenarios on tutor-match-preview.app
            </span>
          </div>
          <div className="row gap-2 items-center">
            <Chip kind="accent" dot>Preview environment</Chip>
            <Chip kind="good">4 passed</Chip>
            <Chip kind="danger">3 failed</Chip>
            <button className="btn ghost sm">↻ Re-run</button>
          </div>
        </div>

        {/* Target card */}
        <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
          <div className="row gap-3 items-center">
            <span className="wf-label">Target</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>https://tutor-match-preview.app</span>
            <Chip kind="accent">Preview</Chip>
            <Chip kind="mute">Auth: test parent account</Chip>
            <span style={{ flex: 1 }} />
            <span className="scribble" style={{ fontSize: 14 }}>
              ✎ Browser QA may create test data. Real users will not see it.
            </span>
          </div>
        </div>

        <div className="row gap-3" style={{ flex: 1, minHeight: 0 }}>
          {/* Scenario matrix */}
          <div className="sketch-box pad-3" style={{ flex: 1.2, background: 'white', overflow: 'auto' }}>
            <SketchH size={18}>Scenario matrix</SketchH>
            <table style={{ width: '100%', marginTop: 12, fontFamily: 'var(--ui)', fontSize: 12.5, borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th style={{ padding: '6px 0', borderBottom: '1.5px solid var(--ink)' }}>Scenario</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1.5px solid var(--ink)', width: 80 }}>Result</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1.5px solid var(--ink)', width: 90 }}>Severity</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1.5px solid var(--ink)', width: 80 }}>Evidence</th>
                </tr>
              </thead>
              <tbody>
                <ScenRow name="Parent signs up via email link" result="pass" />
                <ScenRow name="Parent browses tutors on mobile" result="pass" />
                <ScenRow name="Parent books a 60-min slot" result="fail" sev="must-fix" />
                <ScenRow name="Tutor card layout on iOS Safari" result="fail" sev="must-fix" />
                <ScenRow name="Confirmation email arrives" result="fail" sev="must-fix" />
                <ScenRow name="Parent reschedules a lesson" result="pass" />
                <ScenRow name="Tutor sees new booking on home" result="pass" />
              </tbody>
            </table>

            <div className="sketch-box thin pad-3" style={{ background: 'var(--paper-2)', marginTop: 14 }}>
              <span className="wf-label" style={{ color: 'var(--warn)' }}>Recommended next step</span>
              <div className="row gap-2 items-center" style={{ marginTop: 6 }}>
                <span style={{ fontFamily: 'var(--ui)', fontSize: 13, flex: 1 }}>
                  Start Fix loop for 3 must-fix issues. <strong>Code changes will require a separate approval.</strong>
                </span>
                <button className="btn primary">Open fix loop →</button>
              </div>
            </div>
          </div>

          {/* Evidence column */}
          <div className="col" style={{ flex: 1, gap: 10, overflow: 'auto' }}>
            <span className="wf-label">Screenshots</span>
            <ScreenshotCard caption="Booking accepts a past date (FAIL)" warn />
            <ScreenshotCard caption="Tutor card collapses on iPhone (FAIL)" warn />
            <ScreenshotCard caption="Confirmation email — broken link" warn />
            <span className="wf-label" style={{ marginTop: 4 }}>Trace summary</span>
            <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
              <ol style={{ margin: 0, padding: '0 0 0 16px', fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.6 }}>
                <li>Loaded /tutors · 1.2s</li>
                <li>Clicked first tutor</li>
                <li>Selected past date 2024-09-01 ← unexpected accept</li>
                <li>Submitted form · 200 OK ← should reject</li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Note x={350} y={170} w={220} kind="warn" rotate={-1}>
      ⚠ Loud separation: <strong>audit ≠ fix</strong>. Two approvals, two phases.
    </Note>
  </div>
);

const ScenRow = ({ name, result, sev }) => (
  <tr>
    <td style={{ padding: '8px 0', borderBottom: '1px dashed var(--line-soft)' }}>{name}</td>
    <td style={{ padding: '8px', borderBottom: '1px dashed var(--line-soft)' }}>
      <Chip kind={result === 'pass' ? 'good' : 'danger'} dot>
        {result.toUpperCase()}
      </Chip>
    </td>
    <td style={{ padding: '8px', borderBottom: '1px dashed var(--line-soft)' }}>
      {sev && <Chip kind="warn">{sev}</Chip>}
    </td>
    <td style={{ padding: '8px', borderBottom: '1px dashed var(--line-soft)' }}>
      <a style={{ color: 'var(--accent)', fontFamily: 'var(--ui)', fontSize: 11.5, textDecoration: 'underline' }}>
        {result === 'pass' ? 'view' : 'screenshot →'}
      </a>
    </td>
  </tr>
);

const ScreenshotCard = ({ caption, warn }) => (
  <div className="sketch-box thin" style={{ background: 'white', padding: 8 }}>
    <div className="ph" style={{ height: 100, borderRadius: 4, borderColor: warn ? 'var(--danger)' : 'var(--line-soft)' }}>
      {warn ? '⌐ screen ⌐' : 'screen'}
    </div>
    <div className="row gap-2 items-start" style={{ marginTop: 6 }}>
      {warn && <span style={{ color: 'var(--danger)', fontSize: 14 }}>✕</span>}
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.35 }}>{caption}</span>
    </div>
  </div>
);

// ============================================================
// QA EVIDENCE — Take B: Replay timeline / live trace mode
// ============================================================
const QAb = () => (
  <div className="wf col" style={{ width: 1180, height: 760, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / tutor-match / qa" />
    <SafetyStrip mode="Browser audit" />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="qa" />
      <div className="col grow" style={{ padding: 22, gap: 14, overflow: 'hidden' }}>
        <div className="row between items-center">
          <div className="col">
            <span className="wf-label">Browser audit · live</span>
            <h1 className="hand" style={{ fontSize: 30, margin: 0 }}>QA Lead is testing your app right now</h1>
          </div>
          <div className="row gap-2 items-center">
            <Chip kind="accent" dot>Browsing</Chip>
            <Chip kind="mute">Scenario 5 of 7</Chip>
            <button className="btn ghost sm">Pause</button>
          </div>
        </div>

        <div className="row gap-3" style={{ flex: 1, minHeight: 0 }}>
          {/* Replay viewport */}
          <div className="col" style={{ flex: 1.3, gap: 10 }}>
            <div className="sketch-box" style={{
              background: 'white', padding: 0, overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column',
            }}>
              <div style={{
                padding: '6px 10px', background: 'var(--paper-2)',
                borderBottom: '1.5px solid var(--line-soft)',
                fontFamily: 'var(--mono)', fontSize: 11,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span className="win-dot" /><span className="win-dot" /><span className="win-dot" />
                <span style={{ color: 'var(--ink-mute)' }}>tutor-match-preview.app/book/sara-l</span>
              </div>
              <div className="ph" style={{
                flex: 1, borderRadius: 0, border: 'none', background: 'white',
                fontFamily: 'var(--hand)', fontSize: 22, color: 'var(--ink-mute)',
                position: 'relative',
              }}>
                <div className="col gap-2" style={{ padding: 20, alignSelf: 'flex-start', width: '100%' }}>
                  <Lines widths={['80%', '60%']} thick />
                  <div className="row gap-2"><div className="ph" style={{ width: 80, height: 60 }}>img</div><div className="ph" style={{ width: 80, height: 60 }}>img</div><div className="ph" style={{ width: 80, height: 60 }}>img</div></div>
                  <Lines widths={['90%', '70%', '50%']} />
                </div>
                {/* Cursor blip */}
                <div style={{
                  position: 'absolute', left: 220, top: 180, width: 14, height: 14,
                  borderRadius: '50%', background: 'var(--accent)', opacity: 0.5,
                  border: '2px solid var(--accent)',
                  animation: 'blink 1.2s ease-in-out infinite',
                }} />
              </div>
              <div style={{ padding: '8px 12px', background: 'var(--paper-2)', borderTop: '1.5px solid var(--line-soft)' }}>
                <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5 }}>
                  <strong>QA Lead is doing:</strong> "Selecting a 60-minute slot for next Tuesday at 4pm…"
                </span>
              </div>
            </div>

            {/* Replay timeline */}
            <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
              <div className="row between items-center" style={{ marginBottom: 8 }}>
                <span className="wf-label">Scenario timeline · scrub to replay</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>00:14 / 00:42</span>
              </div>
              <div style={{ position: 'relative', height: 32 }}>
                <div style={{
                  position: 'absolute', left: 0, right: 0, top: '50%',
                  height: 4, background: 'var(--paper-2)', borderRadius: 2, transform: 'translateY(-50%)',
                }} />
                <div style={{
                  position: 'absolute', left: 0, top: '50%',
                  width: '34%', height: 4, background: 'var(--accent)', borderRadius: 2, transform: 'translateY(-50%)',
                }} />
                {[
                  { pct: 5, kind: 'good', label: 'open' },
                  { pct: 12, kind: 'good', label: 'click' },
                  { pct: 22, kind: 'warn', label: 'unexpected' },
                  { pct: 34, kind: 'accent', label: 'now' },
                  { pct: 55, kind: 'mute' },
                  { pct: 72, kind: 'mute' },
                ].map((m, i) => (
                  <div key={i} style={{
                    position: 'absolute', left: `${m.pct}%`, top: '50%',
                    width: m.kind === 'accent' ? 16 : 10, height: m.kind === 'accent' ? 16 : 10,
                    borderRadius: '50%', transform: 'translate(-50%, -50%)',
                    background:
                      m.kind === 'good' ? 'var(--good)' :
                      m.kind === 'warn' ? 'var(--warn)' :
                      m.kind === 'accent' ? 'var(--accent)' :
                      'var(--paper-2)',
                    border: '1.5px solid var(--ink)',
                  }} />
                ))}
              </div>
            </div>
          </div>

          {/* Right: per-step events */}
          <div className="col" style={{ width: 360, gap: 10, overflow: 'auto' }}>
            <div className="sketch-box pad-3" style={{ background: 'white' }}>
              <SketchH size={18}>Live trace</SketchH>
              <div className="col gap-2" style={{ marginTop: 10 }}>
                <TraceStep ts="00:00" kind="good">Loaded /tutors · 1.2s</TraceStep>
                <TraceStep ts="00:04" kind="good">Clicked tutor "Sara L"</TraceStep>
                <TraceStep ts="00:08" kind="good">Booking form shown</TraceStep>
                <TraceStep ts="00:12" kind="warn">Past date 2024-09-01 accepted (expected: blocked)</TraceStep>
                <TraceStep ts="00:14" kind="accent" active>Selecting valid time slot…</TraceStep>
                <TraceStep ts="—" kind="mute">Confirm booking</TraceStep>
                <TraceStep ts="—" kind="mute">Verify email</TraceStep>
              </div>
              <div style={{
                marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--line-soft)',
              }}>
                <Chip kind="accent" dot>Read-only · no code edits</Chip>
              </div>
            </div>

            <div className="sketch-box thin pad-3" style={{ background: 'white' }}>
              <span className="wf-label">When the run finishes…</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, marginTop: 4, display: 'block', lineHeight: 1.5 }}>
                A QA Report appears with all 7 scenarios + screenshots. If anything fails, you'll be asked separately whether to start the fix loop.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Note x={50} y={210} w={210} kind="" rotate={-3}>
      ✎ Live mode: shows Universe <em>doing</em> the QA, with scrubable replay.
    </Note>
  </div>
);

const TraceStep = ({ ts, kind, active, children }) => (
  <div className="row gap-2 items-start" style={{ opacity: kind === 'mute' ? 0.4 : 1 }}>
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)',
      width: 38, paddingTop: 3,
    }}>{ts}</span>
    <span style={{
      width: 14, height: 14, borderRadius: '50%',
      border: '1.5px solid var(--ink)', marginTop: 2,
      background:
        kind === 'good' ? 'var(--good-soft)' :
        kind === 'warn' ? 'var(--warn-soft)' :
        kind === 'accent' ? 'var(--accent)' :
        'white',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 9, fontWeight: 700,
      color: kind === 'good' ? 'var(--good)' : kind === 'warn' ? 'var(--warn)' : 'white',
      flexShrink: 0,
      animation: active ? 'blink 1.2s ease-in-out infinite' : 'none',
    }}>
      {kind === 'good' ? '✓' : kind === 'warn' ? '!' : ''}
    </span>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.4, fontWeight: active ? 600 : 400 }}>{children}</span>
  </div>
);

// ============================================================
// SHIP READINESS — Take A: Checklist + "not deploy" banner
// ============================================================
const ShipA = () => (
  <div className="wf col" style={{ width: 1180, height: 760, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / tutor-match / ship-readiness" />
    <SafetyStrip mode="Release locked" />

    {/* The big "not deploy" banner */}
    <div style={{
      background: 'var(--paper-2)',
      borderBottom: '1.5px solid var(--ink)',
      padding: '14px 24px',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
    }}>
      <span style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '2px solid var(--ink)', background: 'var(--marker)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 22,
      }}>!</span>
      <div className="col" style={{ lineHeight: 1.25 }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 700 }}>
          Ship readiness is not deployment.
        </span>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)' }}>
          Nothing is pushed, published, or deployed in this workflow. This page only verifies your app is <em>ready for handoff</em>.
        </span>
      </div>
      <span style={{ flex: 1 }} />
      <Chip kind="mute">Release & deploy actions locked</Chip>
    </div>

    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="ship" />

      <div className="col grow" style={{ padding: 24, gap: 16, overflow: 'auto' }}>
        <div className="row between items-center">
          <div className="col">
            <span className="wf-label">Tutor Match · Phase 8</span>
            <h1 className="hand" style={{ fontSize: 36, margin: 0, lineHeight: 1 }}>Ship readiness</h1>
            <span className="scribble" style={{ fontSize: 16, marginTop: 2 }}>
              5 of 6 sections ready · 1 needs your attention
            </span>
          </div>
          <div className="row gap-2 items-center">
            <Chip kind="warn" dot>1 risk accepted</Chip>
            <button className="btn ghost">Download handoff bundle ⬇</button>
            <button className="btn primary">Approve readiness →</button>
          </div>
        </div>

        <div className="row gap-3" style={{ alignItems: 'stretch' }}>
          <ReadinessBlock title="Product" status="ready" items={[
            'Idea Brief approved',
            'MVP Scope approved',
            'Non-goals documented',
          ]} />
          <ReadinessBlock title="Quality" status="ready" items={[
            'Code review · clean',
            '0 must-fix issues',
            '2 should-fix accepted (with reason)',
          ]} />
          <ReadinessBlock title="QA" status="ready" items={[
            'Browser audit run #5 · all passed',
            '7/7 scenarios green',
            'Trace + screenshots archived',
          ]} />
        </div>
        <div className="row gap-3" style={{ alignItems: 'stretch' }}>
          <ReadinessBlock title="Release" status="warn" items={[
            'Release notes drafted',
            'Changelog reviewed',
            'No staging URL connected ← needs attention',
          ]} />
          <ReadinessBlock title="Handoff" status="ready" items={[
            'Handoff plan written',
            'Recommended next dev step listed',
            'Artifacts bundled for export',
          ]} />
          <ReadinessBlock title="Risks" status="ready" items={[
            '2 accepted risks documented',
            'Audit trail complete',
            'Decision log available',
          ]} />
        </div>

        {/* What happens next */}
        <div className="sketch-box pad-4" style={{ background: 'white' }}>
          <SketchH size={20}>What happens when you approve</SketchH>
          <div className="row gap-4" style={{ marginTop: 12 }}>
            <NextStep n="1" label="Universe marks the project Ready for handoff." />
            <NextStep n="2" label="Handoff bundle (artifacts + decisions + audit) downloads." />
            <NextStep n="3" label="Release Coordinator drafts release notes you can edit." />
            <NextStep n="4" label="When you're ready to actually deploy, that's a separate, new workflow." dim />
          </div>
        </div>
      </div>
    </div>

    <Note x={460} y={130} w={250} kind="warn" rotate={-1}>
      ⚠ Persistent banner: never imply deploy happened.
    </Note>
  </div>
);

const ReadinessBlock = ({ title, status, items }) => (
  <div className="sketch-box pad-3" style={{
    flex: 1, background: 'white',
    borderColor: status === 'ready' ? 'var(--good)' : status === 'warn' ? 'var(--warn)' : 'var(--ink)',
    borderWidth: 2,
  }}>
    <div className="row between items-center" style={{ marginBottom: 10 }}>
      <h3 className="hand" style={{ fontSize: 22, margin: 0 }}>{title}</h3>
      <Chip kind={status === 'ready' ? 'good' : 'warn'} dot>
        {status === 'ready' ? 'Ready' : 'Needs attention'}
      </Chip>
    </div>
    <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
      {items.map((it, i) => {
        const isWarn = it.includes('attention');
        return (
          <li key={i} className="row gap-2 items-start" style={{ marginBottom: 6 }}>
            <span style={{
              width: 16, height: 16, borderRadius: 3,
              border: '1.5px solid var(--ink)', marginTop: 2,
              background: isWarn ? 'var(--warn-soft)' : 'var(--good-soft)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700,
              color: isWarn ? 'var(--warn)' : 'var(--good)',
              flexShrink: 0,
            }}>{isWarn ? '!' : '✓'}</span>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.4 }}>{it}</span>
          </li>
        );
      })}
    </ul>
  </div>
);

const NextStep = ({ n, label, dim }) => (
  <div className="row gap-2 items-start" style={{ flex: 1, opacity: dim ? 0.55 : 1 }}>
    <span style={{
      width: 28, height: 28, borderRadius: '50%',
      border: '2px solid var(--ink)',
      background: dim ? 'var(--paper-2)' : 'var(--marker)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--hand)', fontWeight: 700, fontSize: 16,
      flexShrink: 0,
    }}>{n}</span>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5 }}>{label}</span>
  </div>
);

// ============================================================
// SHIP READINESS — Take B: Bundle preview / "boxing up" metaphor
// ============================================================
const ShipB = () => (
  <div className="wf col" style={{ width: 1180, height: 760, background: 'var(--paper-2)' }}>
    <WinChrome url="universe.ai / tutor-match / ship-readiness" />
    <SafetyStrip mode="Release locked" />
    <div className="row" style={{ flex: 1, minHeight: 0 }}>
      <SideNav active="ship" />
      <div className="row grow" style={{ padding: 24, gap: 18, minHeight: 0 }}>
        {/* Left: status & next steps */}
        <div className="col" style={{ flex: 1, gap: 14 }}>
          <span className="wf-label">Phase 8 of 9</span>
          <h1 className="hand" style={{ fontSize: 38, margin: 0, lineHeight: 1 }}>
            Boxing up <span className="sketch-underline">Tutor Match</span>
          </h1>
          <p style={{ margin: 0, fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
            Universe has gathered your artifacts, audit trail, and known risks into a handoff bundle. <strong>This is readiness, not deployment.</strong> Whenever you (or a developer) want to actually publish, that's a separate workflow.
          </p>

          <div className="sketch-box pad-4" style={{ background: 'white' }}>
            <div className="row between items-center" style={{ marginBottom: 12 }}>
              <SketchH size={18}>Readiness signals</SketchH>
              <Chip kind="good" dot>5/6 green</Chip>
            </div>
            <div className="col gap-2">
              <Signal label="Product" dot="ready" />
              <Signal label="Quality" dot="ready" />
              <Signal label="QA evidence" dot="ready" />
              <Signal label="Release notes" dot="warn" note="No staging URL connected" />
              <Signal label="Handoff plan" dot="ready" />
              <Signal label="Accepted risks logged" dot="ready" />
            </div>
          </div>

          <div className="sketch-box pad-3" style={{
            background: 'var(--paper-2)', borderStyle: 'dashed', borderColor: 'var(--line-soft)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <Persona initials="RC" kind="release" name="Release Coordinator" sub="ready to hand off" />
            <span style={{ flex: 1, fontFamily: 'var(--ui)', fontSize: 12 }}>
              "All set. Want me to add a staging URL note to the bundle?"
            </span>
            <button className="btn ghost sm">Reply</button>
          </div>

          <div className="row gap-2" style={{ marginTop: 'auto' }}>
            <button className="btn ghost">Reject readiness</button>
            <button className="btn ghost">Pause</button>
            <span style={{ flex: 1 }} />
            <button className="btn primary">Mark Ready for handoff ✓</button>
          </div>
        </div>

        {/* Right: bundle preview (a literal box of stuff) */}
        <div className="col" style={{ flex: 1, gap: 12 }}>
          <span className="wf-label">Handoff bundle preview</span>
          <div className="sketch-box pad-4" style={{ background: 'white', flex: 1, overflow: 'auto' }}>
            <div className="row gap-2 items-center" style={{ marginBottom: 12 }}>
              <span style={{ fontFamily: 'var(--hand)', fontSize: 26 }}>📦</span>
              <span style={{ fontFamily: 'var(--ui)', fontWeight: 700, fontSize: 14 }}>tutor-match-handoff-v1.zip</span>
              <Chip kind="mute" style={{ marginLeft: 'auto' }}>~2.3 MB</Chip>
            </div>
            <div className="col gap-2">
              <BundleItem icon="📄" name="Idea Brief.md" sub="approved · 1 page" />
              <BundleItem icon="📄" name="MVP Scope.md" sub="approved · v2" />
              <BundleItem icon="🗺" name="Screen Map.pdf" sub="approved · 6 screens" />
              <BundleItem icon="🛠" name="Build Plan.md" sub="approved" />
              <BundleItem icon="✓" name="Quality Review.md" sub="clean · 0 must-fix" />
              <BundleItem icon="🌐" name="QA Report #5.json" sub="all 7 scenarios pass" />
              <BundleItem icon="🖼" name="QA screenshots (7)" sub="evidence pack" />
              <BundleItem icon="📝" name="Release Notes draft.md" sub="editable" />
              <BundleItem icon="⚠" name="Accepted Risks.md" sub="2 entries · with reasons" warn />
              <BundleItem icon="📜" name="Audit trail.json" sub="immutable · decisions + gates" />
              <BundleItem icon="↪" name="Handoff plan.md" sub="next steps for a developer" />
            </div>
          </div>
          <div style={{
            padding: '10px 14px', background: 'white', border: '1.5px dashed var(--line-soft)',
            borderRadius: 8, fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-soft)',
          }}>
            <strong>Not included</strong> — and intentionally so: production secrets, deployment credentials, anything Universe was not allowed to read.
          </div>
        </div>
      </div>
    </div>
    <Note x={70} y={230} w={170} kind="" rotate={-2}>
      ✎ "Boxing up" reads warmer than "ship". Concrete bundle preview.
    </Note>
  </div>
);

const Signal = ({ label, dot, note }) => (
  <div className="row gap-2 items-center">
    <span style={{
      width: 12, height: 12, borderRadius: '50%',
      background: dot === 'ready' ? 'var(--good)' : dot === 'warn' ? 'var(--warn)' : 'var(--paper-2)',
      border: '1.5px solid var(--ink)', flexShrink: 0,
    }} />
    <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600 }}>{label}</span>
    {note && <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--warn)' }}>· {note}</span>}
  </div>
);

const BundleItem = ({ icon, name, sub, warn }) => (
  <div className="row gap-2 items-center" style={{
    padding: '8px 10px', background: 'var(--paper-2)', borderRadius: 6,
    border: warn ? '1.5px solid var(--warn)' : '1px solid var(--line-soft)',
  }}>
    <span style={{ fontFamily: 'var(--hand)', fontSize: 18, width: 22, textAlign: 'center' }}>{icon}</span>
    <div className="col" style={{ flex: 1, lineHeight: 1.2 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{name}</span>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-mute)' }}>{sub}</span>
    </div>
    <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}>view</span>
  </div>
);

Object.assign(window, { GateA, GateB, QAa, QAb, ShipA, ShipB });
