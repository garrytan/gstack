// Hi-fi · Mode Picker
// The one-time choice at project start. Easy on the left (recommended), Hands-on on the right.

const HiModePicker = () => (
  <div className="uf u-cosmic-bg" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
    <UStars density={32} />

    {/* Top bar — minimal, no nav (it's the project-start moment) */}
    <div className="u-row u-between u-items-center" style={{ padding: '20px 32px', borderBottom: '1px solid var(--u-line-2)', position: 'relative', zIndex: 2 }}>
      <UWordmark size={16} />
      <div className="u-row u-items-center u-gap-3">
        <span className="u-pill"><UIcon name="check" size={12} color="var(--u-sage)" /> Idea captured</span>
        <span style={{ fontSize: 12.5, color: 'var(--u-ink-3)' }}>Step 3 of 3</span>
      </div>
    </div>

    <div className="u-col u-grow" style={{ padding: '36px 64px 32px', overflow: 'hidden', position: 'relative', zIndex: 1 }}>
      {/* Heading */}
      <div className="u-col u-gap-2" style={{ marginBottom: 28, maxWidth: 880 }}>
        <span className="u-eyebrow">Last setup question · Tutor Match</span>
        <h1 className="u-display" style={{ margin: 0, fontSize: 56 }}>
          How <em>hands-on</em> do you want to be?
        </h1>
        <p className="u-body" style={{ fontSize: 15.5, maxWidth: 620, marginTop: 4 }}>
          You can change this any time from the top bar. It only changes how often I check in with you.
        </p>
      </div>

      <div className="u-row u-gap-5" style={{ flex: 1, alignItems: 'stretch', minHeight: 0 }}>
        {/* ===== EASY MODE — featured ===== */}
        <div className="u-col" style={{ flex: 1.05, position: 'relative' }}>
          <div className="u-card lifted" style={{
            position: 'relative', overflow: 'hidden',
            background: 'var(--u-card)',
            border: '1.5px solid var(--u-ink)',
            boxShadow: '0 24px 60px -16px rgba(75,63,187,0.30), 0 6px 16px rgba(15,22,41,0.08)',
            display: 'flex', flexDirection: 'column', height: '100%',
          }}>
            {/* Cosmic header strip */}
            <div style={{
              position: 'relative',
              padding: '24px 28px 22px',
              background: 'linear-gradient(135deg, #2D2580 0%, #4B3FBB 45%, #7B47C4 100%)',
              color: '#fff',
              overflow: 'hidden',
            }}>
              <UStars density={28} />
              <div className="u-row u-between u-items-start" style={{ position: 'relative', zIndex: 1 }}>
                <div className="u-col u-gap-1">
                  <span style={{ fontFamily: 'var(--u-mono)', fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.78 }}>
                    Recommended
                  </span>
                  <div className="u-row u-items-center u-gap-3">
                    <UOrb size={42} busy={false} />
                    <h2 className="u-display" style={{ margin: 0, fontSize: 44, color: '#fff' }}>Easy Mode</h2>
                  </div>
                  <span style={{ fontFamily: 'var(--u-display)', fontSize: 22, fontStyle: 'italic', color: '#E8E4FB', marginTop: 2 }}>
                    I drive · you sign off
                  </span>
                </div>
                <div className="u-col" style={{ alignItems: 'flex-end', gap: 4 }}>
                  <span className="u-pill" style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff' }}>
                    <UIcon name="sparkle" size={11} color="#fff" /> ~3–5 check-ins
                  </span>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>over ~5 days</span>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="u-col u-grow" style={{ padding: '24px 28px 4px', gap: 18 }}>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--u-ink-2)' }}>
                I'll handle the small calls — picking libraries, naming files, layout details, copy tone — and only knock on your door when <strong style={{ color: 'var(--u-ink)' }}>only you can decide.</strong>
              </p>

              <div className="u-col u-gap-2">
                <span className="u-eyebrow" style={{ color: 'var(--u-brand)' }}>When I'll knock</span>
                <KnockRow icon="check" tone="brand" text="Money — pricing, paid plans, payment provider" />
                <KnockRow icon="check" tone="brand" text="Brand — name, voice, taste references" />
                <KnockRow icon="check" tone="brand" text="Anything that touches users (privacy, accounts)" />
                <KnockRow icon="check" tone="brand" text="When I'm unsure I'm building the right thing" />
              </div>

              <div className="u-col u-gap-2">
                <span className="u-eyebrow">When I won't</span>
                <KnockRow icon="minus" tone="mute" text="Engineering choices · framework · file layout" />
                <KnockRow icon="minus" tone="mute" text="Default copy, spacing, color details" />
                <KnockRow icon="minus" tone="mute" text="Anything I can reverse without you noticing" />
              </div>
            </div>

            {/* CTA bar */}
            <div className="u-row u-items-center u-gap-3" style={{
              padding: '18px 28px', marginTop: 'auto',
              borderTop: '1px solid var(--u-line-2)', background: 'var(--u-paper)',
            }}>
              <div className="u-col u-grow" style={{ lineHeight: 1.25 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--u-ink)' }}>Step away. I'll text when I need you.</span>
                <span style={{ fontSize: 11.5, color: 'var(--u-ink-3)' }}>Every auto-decision is one click to undo.</span>
              </div>
              <button className="u-btn brand lg" style={{ paddingRight: 22 }}>
                Start in Easy Mode
                <UIcon name="arrow-right" size={14} color="#fff" />
              </button>
            </div>
          </div>
        </div>

        {/* ===== HANDS-ON MODE ===== */}
        <div className="u-col" style={{ flex: 0.95, position: 'relative' }}>
          <div className="u-card" style={{
            display: 'flex', flexDirection: 'column', height: '100%',
            background: 'var(--u-paper)',
            borderColor: 'var(--u-line)',
          }}>
            {/* Header (no cosmic gradient — subdued) */}
            <div style={{ padding: '24px 28px 20px' }}>
              <div className="u-row u-between u-items-start">
                <div className="u-col u-gap-1">
                  <span className="u-eyebrow">For power users</span>
                  <div className="u-row u-items-center u-gap-3">
                    <div style={{
                      width: 42, height: 42, borderRadius: 12,
                      background: 'var(--u-card)',
                      border: '1px solid var(--u-line)',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      boxShadow: 'var(--u-shadow-1)',
                    }}>
                      <UIcon name="compass" size={20} color="var(--u-ink)" />
                    </div>
                    <h2 className="u-display" style={{ margin: 0, fontSize: 40, color: 'var(--u-ink)' }}>Hands-on Mode</h2>
                  </div>
                  <span style={{ fontFamily: 'var(--u-display)', fontSize: 20, fontStyle: 'italic', color: 'var(--u-ink-3)', marginTop: 2 }}>
                    you drive · I assist
                  </span>
                </div>
                <div className="u-col" style={{ alignItems: 'flex-end', gap: 4 }}>
                  <span className="u-pill"><UIcon name="bolt" size={11} color="var(--u-ink-3)" /> ~20 check-ins</span>
                  <span style={{ fontSize: 11, color: 'var(--u-ink-3)' }}>over ~7 days</span>
                </div>
              </div>
            </div>

            <div className="u-hr" />

            {/* Body */}
            <div className="u-col u-grow" style={{ padding: '20px 28px', gap: 18 }}>
              <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, color: 'var(--u-ink-2)' }}>
                You see every room — Drawing Room, Workshop, Showroom — and review what each crew member produces. Approve, push back, or redirect at every step.
              </p>

              <div className="u-col u-gap-2">
                <span className="u-eyebrow">You'll see</span>
                <KnockRow icon="check" tone="ink" text="Every phase opening & closing" />
                <KnockRow icon="check" tone="ink" text="Every persona's draft before it ships" />
                <KnockRow icon="check" tone="ink" text="Every artifact (plan, design, build, QA, fix)" />
                <KnockRow icon="check" tone="ink" text="The raw conversation behind each decision" />
              </div>

              <div className="u-col u-gap-2">
                <span className="u-eyebrow">Good for</span>
                <KnockRow icon="minus" tone="mute" text="Engineers wanting to understand what I built" />
                <KnockRow icon="minus" tone="mute" text="Anyone learning how this works" />
                <KnockRow icon="minus" tone="mute" text="High-stakes or brand-critical projects" />
              </div>
            </div>

            {/* CTA bar */}
            <div className="u-row u-items-center u-gap-3" style={{
              padding: '18px 28px', marginTop: 'auto',
              borderTop: '1px solid var(--u-line-2)', background: 'var(--u-paper-2)',
            }}>
              <div className="u-col u-grow" style={{ lineHeight: 1.25 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--u-ink)' }}>The full factory floor.</span>
                <span style={{ fontSize: 11.5, color: 'var(--u-ink-3)' }}>You'll learn how Universe builds things.</span>
              </div>
              <button className="u-btn ghost lg">
                Use Hands-on
                <UIcon name="arrow-right" size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Foot strip */}
      <div className="u-row u-items-center u-gap-2" style={{ marginTop: 20, color: 'var(--u-ink-3)', fontSize: 13 }}>
        <UIcon name="sparkle" size={13} color="var(--u-brand)" />
        <span>Not sure? <strong style={{ color: 'var(--u-ink)' }}>Easy is the safer bet.</strong> You can switch to Hands-on the moment you want to look under the hood.</span>
      </div>
    </div>
  </div>
);

const KnockRow = ({ icon = 'check', tone = 'brand', text }) => {
  const colors = {
    brand: { bg: 'var(--u-brand-soft)', fg: 'var(--u-brand)' },
    ink:   { bg: 'var(--u-paper-2)',    fg: 'var(--u-ink)' },
    mute:  { bg: 'transparent',          fg: 'var(--u-ink-4)' },
  };
  const c = colors[tone];
  return (
    <div className="u-row u-items-center u-gap-3">
      <span style={{
        width: 22, height: 22, borderRadius: '50%',
        background: c.bg, color: c.fg,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        border: tone === 'mute' ? '1px dashed var(--u-line-strong)' : 'none',
      }}>
        <UIcon name={icon} size={11} color={c.fg} stroke={2} />
      </span>
      <span style={{
        fontSize: 13.5,
        color: tone === 'mute' ? 'var(--u-ink-3)' : 'var(--u-ink-2)',
        lineHeight: 1.4,
      }}>{text}</span>
    </div>
  );
};

Object.assign(window, { HiModePicker });
