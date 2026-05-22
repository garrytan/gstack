// Hi-fi · Easy Mode in-flight
// The day-to-day surface for someone using Easy Mode. One giant calm hero +
// quiet "while you were away" feed. Toggle persists in top bar.

const HiEasy = () => (
  <div className="uf" style={{ width: '100%', height: '100%', display: 'flex', background: 'var(--u-paper)' }}>
    <USideNav active="cockpit" project={{ name: 'Tutor Match', phase: 'Building · day 2 of 5', state: 'amber' }} />

    <div className="u-col u-grow" style={{ minWidth: 0 }}>
      {/* Top bar */}
      <div className="u-topbar">
        <div className="u-row u-items-center u-gap-3">
          <span className="u-eyebrow">Project</span>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--u-ink)' }}>Tutor Match</span>
          <span className="u-pill sage dot">All clear</span>
        </div>
        <div className="u-row u-items-center u-gap-3">
          <UModeToggle mode="easy" size="md" />
          <button className="u-btn ghost sm"><UIcon name="pause" size={12} /> Pause</button>
          <span className="u-avatar" style={{ width: 30, height: 30, fontSize: 11 }}>MV</span>
        </div>
      </div>

      <div className="u-col u-grow" style={{ padding: '32px 56px 28px', gap: 24, overflow: 'auto' }}>
        {/* HERO — the one calm message */}
        <div className="u-card lifted" style={{
          padding: 0, overflow: 'hidden', position: 'relative',
          background: 'var(--u-card)',
        }}>
          {/* cosmic backdrop strip */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 6,
            background: 'linear-gradient(90deg, #4B3FBB 0%, #7B47C4 50%, #F0A03C 100%)',
          }} />

          <div className="u-row u-items-center u-gap-5" style={{ padding: '38px 44px 30px' }}>
            <UOrb size={104} busy />
            <div className="u-col u-grow" style={{ lineHeight: 1.2 }}>
              <span className="u-eyebrow">Right now</span>
              <h1 className="u-display" style={{ margin: '8px 0 0', fontSize: 44 }}>
                I'm <em>building the tutor search</em>.
              </h1>
              <p style={{ margin: '12px 0 0', fontFamily: 'var(--u-display)', fontSize: 20, fontStyle: 'italic', color: 'var(--u-ink-3)' }}>
                Step away. I'll text when I need you.
              </p>
            </div>
            <div className="u-col u-items-center" style={{ gap: 2, paddingTop: 8 }}>
              <span style={{ fontFamily: 'var(--u-display)', fontSize: 56, lineHeight: 0.9, color: 'var(--u-brand)' }}>~25m</span>
              <span style={{ fontFamily: 'var(--u-mono)', fontSize: 10.5, color: 'var(--u-ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>to next check-in</span>
            </div>
          </div>

          <div style={{ padding: '0 44px 26px' }}>
            <div className="u-row u-between u-items-center" style={{ marginBottom: 10 }}>
              <span className="u-eyebrow">Where we are</span>
              <span style={{ fontSize: 12, color: 'var(--u-ink-3)' }}>4 of 9 steps · on track</span>
            </div>
            <UProgress done={4} active={1} total={9} labels={['Shape', 'Plan', 'Design', 'Build', 'Review', 'Test', 'Fix', 'Ready', 'Hand off']} />
          </div>

          {/* All clear strip */}
          <div className="u-row u-items-center u-gap-3" style={{
            margin: '0 26px 24px', padding: '14px 18px',
            background: 'var(--u-sage-soft)',
            border: '1px solid rgba(63,133,104,0.30)',
            borderRadius: 'var(--u-r-md)',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'var(--u-sage)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}>
              <UIcon name="check" size={14} color="#fff" stroke={2.4} />
            </div>
            <div className="u-col u-grow" style={{ lineHeight: 1.3 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--u-sage-deep)' }}>Nothing needs you right now.</span>
              <span style={{ fontSize: 12, color: 'var(--u-sage-deep)', opacity: 0.85 }}>Last decision asked of you: 38 minutes ago · Pricing.</span>
            </div>
            <button className="u-btn ghost sm" style={{ background: 'var(--u-card)' }}>
              <UIcon name="mail" size={12} /> Notify me by email
            </button>
          </div>
        </div>

        {/* While you were away */}
        <div className="u-card" style={{ padding: '22px 26px' }}>
          <div className="u-row u-between u-items-center" style={{ marginBottom: 14 }}>
            <div className="u-row u-items-center u-gap-2">
              <UIcon name="sparkle" size={14} color="var(--u-brand)" />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--u-ink)' }}>While you were away · I handled</span>
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--u-ink-3)' }}>last 2 hours · 4 decisions</span>
          </div>

          {[
            { what: 'Picked a UI framework', choice: 'Tailwind + Radix', why: 'standard, stays out of your way' },
            { what: 'Named the search component', choice: 'TutorFinder', why: 'clear from URL & code' },
            { what: 'Chose how tutors load', choice: 'Pages of 20', why: 'cheaper than infinite scroll for MVP' },
            { what: 'Wrote the empty-state copy', choice: '"No tutors yet — try widening your search."', why: null },
          ].map((d, i, arr) => (
            <div key={i} className="u-row u-items-start u-gap-3" style={{
              padding: '12px 0',
              borderBottom: i < arr.length - 1 ? '1px solid var(--u-line-2)' : 'none',
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: '50%',
                background: 'var(--u-sage-soft)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                marginTop: 1, flexShrink: 0,
              }}>
                <UIcon name="check" size={11} color="var(--u-sage)" stroke={2.4} />
              </span>
              <div className="u-col u-grow" style={{ lineHeight: 1.4, gap: 3 }}>
                <div style={{ fontSize: 13.5, color: 'var(--u-ink-2)' }}>
                  {d.what} → <strong style={{ color: 'var(--u-ink)' }}>{d.choice}</strong>
                </div>
                {d.why && (
                  <span style={{ fontFamily: 'var(--u-display)', fontStyle: 'italic', fontSize: 14, color: 'var(--u-ink-3)' }}>
                    {d.why}
                  </span>
                )}
              </div>
              <button className="u-btn text sm" style={{ color: 'var(--u-brand)', height: 26 }}>Change</button>
            </div>
          ))}
        </div>

        {/* Foot — hints for power users */}
        <div className="u-row u-items-center u-gap-3" style={{ marginTop: 'auto', color: 'var(--u-ink-3)', fontSize: 12.5 }}>
          <UIcon name="compass" size={14} color="var(--u-ink-3)" />
          <span>Want to look under the hood? Flip the <strong style={{ color: 'var(--u-ink)' }}>Hands-on</strong> toggle above — you'll see all three production rooms and every persona's work.</span>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, { HiEasy });
