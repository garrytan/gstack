'use client';

import { useState, useTransition } from 'react';
import { Loader2 } from 'lucide-react';
import type { BuyerProfile } from '@/domain/buyer/types';
import { BUYER_PERSONAS, DEFAULT_PRIORITIES } from '@/domain/buyer/types';
import type { Locality } from '@/domain/locality/types';
import { saveBuyerProfile } from '@/server/actions';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { formatINR } from '@/lib/utils';

const PERSONA_COPY: Record<(typeof BUYER_PERSONAS)[number], string> = {
  homebuyer: 'You are buying somewhere to live. Legal certainty and commute weigh heaviest.',
  investor: 'You are buying an asset. Yield, appreciation and liquidity weigh heaviest.',
  nri: 'You are buying from abroad and cannot inspect in person. Legal and developer record weigh heaviest.',
};

export const PreferencesForm = ({
  profile,
  localities,
}: {
  profile: BuyerProfile | undefined;
  localities: readonly Locality[];
}) => {
  const [persona, setPersona] = useState(profile?.persona ?? 'homebuyer');
  const [budgetMin, setBudgetMin] = useState(String(profile?.budgetMin ?? 8_000_000));
  const [budgetMax, setBudgetMax] = useState(String(profile?.budgetMax ?? 18_000_000));
  const [bedroomsMin, setBedroomsMin] = useState(String(profile?.bedroomsMin ?? 2));
  const [bedroomsMax, setBedroomsMax] = useState(String(profile?.bedroomsMax ?? 4));
  const [workplaceLabel, setWorkplaceLabel] = useState(profile?.workplace?.label ?? '');
  const [maxCommute, setMaxCommute] = useState(
    String(profile?.workplace?.maxPeakCommuteMinutes ?? 45),
  );
  const [needsReadyToMove, setNeedsReadyToMove] = useState(profile?.needsReadyToMove ?? false);
  const [minEfficiency, setMinEfficiency] = useState(String(profile?.minCarpetEfficiency ?? 0.65));
  const [targetYield, setTargetYield] = useState(String(profile?.targetGrossYieldPercent ?? 3.5));
  const [selected, setSelected] = useState<string[]>([...(profile?.preferredLocalities ?? [])]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const [pending, startTransition] = useTransition();

  const toggleLocality = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(undefined);
    startTransition(async () => {
      const result = await saveBuyerProfile({
        persona,
        budgetMin,
        budgetMax,
        bedroomsMin,
        bedroomsMax,
        workplaceLabel: workplaceLabel || undefined,
        maxPeakCommuteMinutes: workplaceLabel ? maxCommute : undefined,
        needsReadyToMove,
        minCarpetEfficiency: minEfficiency,
        targetGrossYieldPercent: persona === 'investor' ? targetYield : undefined,
        preferredLocalities: selected,
      });
      setMessage({ ok: result.ok, text: result.message ?? '' });
    });
  };

  const weights = DEFAULT_PRIORITIES[persona];

  return (
    <form onSubmit={submit} className="space-y-8">
      <Fieldset
        legend="How you are buying"
        hint="This changes the pillar weights behind every score you see. It does not change the underlying evidence."
      >
        <div className="space-y-1">
          <Label htmlFor="persona">Buyer type</Label>
          <Select
            id="persona"
            value={persona}
            onChange={(e) => setPersona(e.target.value as typeof persona)}
          >
            {BUYER_PERSONAS.map((p) => (
              <option key={p} value={p}>
                {p === 'nri' ? 'NRI buyer' : p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </Select>
          <p className="text-[11px] text-[var(--text-muted)]">{PERSONA_COPY[persona]}</p>
        </div>

        <dl className="grid grid-cols-2 gap-2 rounded-md propiq-card p-3 sm:grid-cols-4">
          {(['legalCertainty', 'commute', 'appreciation', 'rentalIncome'] as const).map((k) => (
            <div key={k}>
              <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                {k === 'legalCertainty'
                  ? 'Legal certainty'
                  : k === 'rentalIncome'
                    ? 'Rental income'
                    : k.charAt(0).toUpperCase() + k.slice(1)}
              </dt>
              <dd data-figure className="text-sm font-semibold">
                {Math.round(weights[k] * 100)}%
              </dd>
            </div>
          ))}
        </dl>
      </Fieldset>

      <Fieldset
        legend="Budget"
        hint="Properties above your ceiling still appear, scored down rather than hidden."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="budgetMin">Minimum</Label>
            <Input
              id="budgetMin"
              type="number"
              min={0}
              step={100000}
              value={budgetMin}
              onChange={(e) => setBudgetMin(e.target.value)}
            />
            <p data-figure className="text-[11px] text-[var(--text-muted)]">
              {formatINR(Number(budgetMin) || 0)}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="budgetMax">Maximum</Label>
            <Input
              id="budgetMax"
              type="number"
              min={0}
              step={100000}
              value={budgetMax}
              onChange={(e) => setBudgetMax(e.target.value)}
            />
            <p data-figure className="text-[11px] text-[var(--text-muted)]">
              {formatINR(Number(budgetMax) || 0)}
            </p>
          </div>
        </div>
      </Fieldset>

      <Fieldset legend="The home" hint="Used for buyer-fit scoring, not as a hard filter.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="bedroomsMin">Bedrooms, minimum</Label>
            <Input
              id="bedroomsMin"
              type="number"
              min={0}
              max={10}
              value={bedroomsMin}
              onChange={(e) => setBedroomsMin(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bedroomsMax">Bedrooms, maximum</Label>
            <Input
              id="bedroomsMax"
              type="number"
              min={0}
              max={10}
              value={bedroomsMax}
              onChange={(e) => setBedroomsMax(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="minEfficiency">Minimum carpet efficiency</Label>
          <Input
            id="minEfficiency"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={minEfficiency}
            onChange={(e) => setMinEfficiency(e.target.value)}
          />
          <p className="text-[11px] text-[var(--text-muted)]">
            The share of the quoted area that is actually usable floor. Below about 0.62 is poor
            value in most metros.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={needsReadyToMove}
            onChange={(e) => setNeedsReadyToMove(e.target.checked)}
            className="size-4"
          />
          I need somewhere ready to move into
        </label>
      </Fieldset>

      <Fieldset
        legend="Commute"
        hint="Leave the workplace blank if commute is not a factor for you."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="workplaceLabel">Where you work</Label>
            <Input
              id="workplaceLabel"
              value={workplaceLabel}
              placeholder="e.g. Outer Ring Road"
              onChange={(e) => setWorkplaceLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="maxCommute">Longest peak commute you would accept (minutes)</Label>
            <Input
              id="maxCommute"
              type="number"
              min={5}
              max={240}
              value={maxCommute}
              disabled={!workplaceLabel}
              onChange={(e) => setMaxCommute(e.target.value)}
            />
          </div>
        </div>
      </Fieldset>

      {persona === 'investor' && (
        <Fieldset
          legend="Investment"
          hint="The gross yield below which a deal is not interesting to you."
        >
          <div className="space-y-1">
            <Label htmlFor="targetYield">Target gross yield (%)</Label>
            <Input
              id="targetYield"
              type="number"
              min={0}
              max={30}
              step={0.1}
              value={targetYield}
              onChange={(e) => setTargetYield(e.target.value)}
            />
          </div>
        </Fieldset>
      )}

      <Fieldset
        legend="Preferred localities"
        hint="Optional. Leave all unselected to consider the whole covered market."
      >
        <div className="flex flex-wrap gap-2">
          {localities.map((l) => {
            const on = selected.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => toggleLocality(l.id)}
                aria-pressed={on}
                className={
                  on
                    ? 'rounded-full border border-accent-500 bg-accent-500/15 px-3 py-1 text-xs font-medium text-[var(--text-accent)]'
                    : 'rounded-full border border-[var(--border-strong)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                }
              >
                {l.name}
              </button>
            );
          })}
        </div>
      </Fieldset>

      <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] pt-5">
        <Button type="submit" size="lg" disabled={pending}>
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          Save preferences
        </Button>
        {message && (
          <p
            role="status"
            className="text-xs"
            style={{ color: message.ok ? 'var(--color-buy)' : 'var(--color-avoid)' }}
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
};

const Fieldset = ({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint?: string;
  children: React.ReactNode;
}) => (
  <fieldset className="space-y-4">
    <legend className="text-sm font-semibold">{legend}</legend>
    {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
    {children}
  </fieldset>
);
