'use client';

import { useMemo, useState, useTransition } from 'react';
import { CheckCircle2, CircleAlert, CircleHelp, Loader2 } from 'lucide-react';
import { CHECKLIST } from '@/domain/visits/checklist';
import { CATEGORY_LABELS, VISIT_CATEGORIES } from '@/domain/visits/types';
import type { Answer, SiteVisit, VisitObservation } from '@/domain/visits/types';
import { completeVisit } from '@/server/actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const ANSWERS: ReadonlyArray<{ value: Answer; label: string; color: string }> = [
  { value: 'good', label: 'Good', color: 'var(--color-buy)' },
  { value: 'acceptable', label: 'OK', color: 'var(--color-watch)' },
  { value: 'concern', label: 'Concern', color: 'var(--color-avoid)' },
  { value: 'unknown', label: "Didn't check", color: 'var(--color-unknown)' },
];

export const VisitChecklist = ({ visit }: { visit: SiteVisit }) => {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(visit.observations.map((o) => [o.itemId, o.answer])),
  );
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(visit.observations.filter((o) => o.note).map((o) => [o.itemId, o.note!])),
  );
  const [overallNote, setOverallNote] = useState(visit.overallNote ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [pending, startTransition] = useTransition();

  const answered = Object.keys(answers).length;
  const concerns = useMemo(() => CHECKLIST.filter((c) => answers[c.id] === 'concern'), [answers]);
  const materialConcerns = concerns.filter((c) => c.material);

  const save = () => {
    const observations: VisitObservation[] = Object.entries(answers).map(([itemId, answer]) => ({
      itemId,
      answer,
      note: notes[itemId]?.trim() || undefined,
    }));
    startTransition(async () => {
      const result = await completeVisit(visit.id, observations, overallNote.trim() || undefined);
      setMessage({ ok: result.ok, text: result.message ?? '' });
    });
  };

  return (
    <div className="space-y-8">
      <div className="sticky top-14 z-30 -mx-4 border-b border-[var(--border-subtle)] bg-[var(--surface-0)]/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">
            {answered} of {CHECKLIST.length} answered
          </Badge>
          {concerns.length > 0 && <Badge tone="avoid">{concerns.length} concerns</Badge>}
          {materialConcerns.length > 0 && (
            <Badge tone="warn">{materialConcerns.length} could change the verdict</Badge>
          )}
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            onClick={save}
            disabled={pending || answered === 0}
          >
            {pending && <Loader2 aria-hidden className="animate-spin" />}
            {visit.status === 'completed' ? 'Update visit' : 'Save visit'}
          </Button>
        </div>
        {message && (
          <p
            role="status"
            className="mt-2 text-xs"
            style={{ color: message.ok ? 'var(--color-buy)' : 'var(--color-avoid)' }}
          >
            {message.text}
          </p>
        )}
      </div>

      {VISIT_CATEGORIES.map((category) => {
        const items = CHECKLIST.filter((c) => c.category === category);
        if (items.length === 0) return null;
        return (
          <section key={category}>
            <h2 className="text-sm font-semibold">{CATEGORY_LABELS[category]}</h2>
            <ul className="mt-3 space-y-3">
              {items.map((item) => {
                const answer = answers[item.id];
                return (
                  <li
                    key={item.id}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4"
                    style={
                      answer === 'concern' && item.material
                        ? { borderLeftWidth: 3, borderLeftColor: 'var(--color-avoid)' }
                        : undefined
                    }
                  >
                    <p className="text-sm font-medium">
                      {item.question}
                      {item.material && (
                        <span className="ml-2 align-middle text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                          can change the verdict
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">{item.why}</p>

                    <fieldset className="mt-3">
                      <legend className="sr-only">{item.question}</legend>
                      <div className="flex flex-wrap gap-2">
                        {ANSWERS.map((a) => {
                          const selected = answer === a.value;
                          return (
                            <button
                              key={a.value}
                              type="button"
                              aria-pressed={selected}
                              onClick={() =>
                                setAnswers((prev) => ({ ...prev, [item.id]: a.value }))
                              }
                              className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                              style={
                                selected
                                  ? {
                                      color: a.color,
                                      borderColor: a.color,
                                      background: `color-mix(in srgb, ${a.color} 7%, transparent)`,
                                    }
                                  : {
                                      borderColor: 'var(--border-strong)',
                                      color: 'var(--text-secondary)',
                                    }
                              }
                            >
                              {a.label}
                            </button>
                          );
                        })}
                      </div>
                    </fieldset>

                    {answer !== undefined && answer !== 'unknown' && (
                      <div className="mt-3">
                        <label htmlFor={`note-${item.id}`} className="sr-only">
                          Note for {item.question}
                        </label>
                        <input
                          id={`note-${item.id}`}
                          value={notes[item.id] ?? ''}
                          maxLength={500}
                          placeholder="What exactly did you see?"
                          onChange={(e) =>
                            setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))
                          }
                          className="h-9 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 text-xs placeholder:text-[var(--text-muted)]"
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section>
        <h2 className="text-sm font-semibold">Anything else</h2>
        <textarea
          value={overallNote}
          maxLength={2000}
          rows={4}
          onChange={(e) => setOverallNote(e.target.value)}
          aria-label="Overall notes from the visit"
          placeholder="What you would tell a friend who asked how it went."
          className="mt-2 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-0)] p-3 text-sm placeholder:text-[var(--text-muted)]"
        />
      </section>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4">
        <p className="flex items-center gap-2 text-xs font-semibold">
          <CheckCircle2 aria-hidden className="size-3.5" style={{ color: 'var(--color-buy)' }} />
          What happens to this
        </p>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          Answers on items that map to a scored field become evidence on this property, marked
          verified and sourced to your visit — it is the only first-party evidence in the product,
          and it is weighted accordingly. Items you mark{' '}
          <span className="font-medium">didn&rsquo;t check</span> are excluded rather than counted
          as fine.
        </p>
        {materialConcerns.length > 0 && (
          <p
            className="mt-2 flex items-start gap-2 text-xs"
            style={{ color: 'var(--color-avoid)' }}
          >
            <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            You have flagged {materialConcerns.length} thing(s) serious enough to change the
            verdict. Save the visit and re-read the property page.
          </p>
        )}
        {answered < CHECKLIST.length && (
          <p className="mt-2 flex items-start gap-2 text-xs text-[var(--text-muted)]">
            <CircleHelp aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {CHECKLIST.length - answered} item(s) unanswered. Save anyway — a partial record beats a
            remembered one.
          </p>
        )}
      </div>
    </div>
  );
};
