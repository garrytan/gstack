'use client';

import { useRef, useState, useTransition } from 'react';
import { AlertTriangle, Loader2, Send } from 'lucide-react';
import { track } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Turn {
  readonly role: 'user' | 'copilot';
  readonly text: string;
  readonly grounded?: boolean;
  readonly unsupportedClaims?: readonly string[];
  readonly notConfigured?: boolean;
}

const SUGGESTIONS = [
  'Why did this get that verdict?',
  'Is it worth the asking price?',
  'What are the biggest risks here?',
  'What should I ask the builder?',
] as const;

export const CopilotChat = ({
  propertyId,
  propertyTitle,
}: {
  propertyId: string;
  propertyTitle: string;
}) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [pending, startTransition] = useTransition();
  const logRef = useRef<HTMLDivElement>(null);

  const ask = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 3 || pending) return;

    setTurns((t) => [...t, { role: 'user', text: trimmed }]);
    setQuestion('');
    track('copilot_used', { propertyId, length: trimmed.length });

    startTransition(async () => {
      try {
        const response = await fetch('/api/copilot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ propertyId, question: trimmed }),
        });
        const body = await response.json();

        if (!response.ok) {
          setTurns((t) => [
            ...t,
            {
              role: 'copilot',
              text: body.error ?? 'The Copilot could not answer that.',
              notConfigured: body.code === 'AI_NOT_CONFIGURED',
            },
          ]);
          return;
        }

        setTurns((t) => [
          ...t,
          {
            role: 'copilot',
            text: body.text,
            grounded: body.grounded,
            unsupportedClaims: body.unsupportedClaims ?? [],
          },
        ]);
      } catch {
        setTurns((t) => [
          ...t,
          {
            role: 'copilot',
            text: 'Could not reach the Copilot. Nothing was guessed in its place.',
          },
        ]);
      } finally {
        requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
      }
    });
  };

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)]">
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label="Copilot conversation"
        className="max-h-[28rem] space-y-4 overflow-y-auto p-4"
      >
        {turns.length === 0 && (
          <div>
            <p className="text-sm text-[var(--text-secondary)]">
              Ask about <strong>{propertyTitle}</strong>. The Copilot answers from this
              property&rsquo;s evidence and the figures PropIQ already computed. It will not tell
              you anything the evidence does not support.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => ask(s)}
                  className="rounded-full border border-[var(--border-strong)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <div key={i} className={turn.role === 'user' ? 'text-right' : ''}>
            <div
              className={
                turn.role === 'user'
                  ? 'inline-block max-w-[85%] rounded-lg bg-accent-600/20 px-3 py-2 text-left text-sm'
                  : 'max-w-full text-sm'
              }
            >
              {turn.role === 'copilot' && turn.notConfigured && (
                <Badge tone="warn" className="mb-2">
                  <AlertTriangle aria-hidden className="size-3" /> No AI provider configured
                </Badge>
              )}
              {turn.role === 'copilot' && turn.grounded === false && (
                <Badge tone="avoid" className="mb-2">
                  <AlertTriangle aria-hidden className="size-3" /> Unverified figures
                </Badge>
              )}
              <p className="whitespace-pre-wrap leading-relaxed">{turn.text}</p>

              {turn.role === 'copilot' && turn.grounded === false && (
                <p className="mt-2 text-[11px] text-[var(--color-avoid)]">
                  This answer contains {turn.unsupportedClaims?.length} figure
                  {turn.unsupportedClaims?.length === 1 ? '' : 's'} that we could not trace back to
                  the evidence on this property ({turn.unsupportedClaims?.join(', ')}). Treat them
                  as unverified and check the evidence panel.
                </p>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 aria-hidden className="size-3 animate-spin" /> Reading the evidence…
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        className="flex gap-2 border-t border-[var(--border-subtle)] p-3"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={800}
          aria-label="Ask PropIQ about this property"
          placeholder="Ask about the verdict, the price, the risks…"
          className="h-10 flex-1 rounded-md border border-[var(--border-strong)] bg-[var(--surface-0)] px-3 text-sm placeholder:text-[var(--text-muted)]"
        />
        <Button type="submit" disabled={pending || question.trim().length < 3}>
          <Send aria-hidden />
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </div>
  );
};
