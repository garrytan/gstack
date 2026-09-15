/**
 * Shared primitives for the PropIQ domain layer.
 *
 * Everything in `src/domain` is pure: no I/O, no framework imports, no clock
 * reads except through an injected `now`. That keeps scoring, valuation and
 * decision output reproducible and testable, which matters because PropIQ
 * publishes its methodology and must be able to replay any historical result.
 */

/** Branded ID types so a LocalityId can never be passed where a ProjectId is expected. */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CityId = Brand<string, 'CityId'>;
export type MicroMarketId = Brand<string, 'MicroMarketId'>;
export type LocalityId = Brand<string, 'LocalityId'>;
export type DeveloperId = Brand<string, 'DeveloperId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type PhaseId = Brand<string, 'PhaseId'>;
export type TowerId = Brand<string, 'TowerId'>;
export type UnitTypeId = Brand<string, 'UnitTypeId'>;
export type UnitId = Brand<string, 'UnitId'>;
export type PropertyId = Brand<string, 'PropertyId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type UserId = Brand<string, 'UserId'>;

export const asId = <T extends string>(value: string): T => value as T;

/** Indian Rupees, stored as a whole number of rupees (never paise, never float drift). */
export type INR = number;

/** Square feet. India quotes carpet/built-up/super built-up; we always say which. */
export type SqFt = number;

export type AreaBasis = 'carpet' | 'builtUp' | 'superBuiltUp';

/** A 0..1 normalized value. Produced by the normalization layer, consumed by scoring. */
export type Unit01 = number;

/** ISO-8601 instant. Domain code never calls Date.now(); callers inject the clock. */
export type Instant = string;

export interface Money {
  readonly amount: INR;
  readonly currency: 'INR';
}

export const inr = (amount: INR): Money => ({ amount, currency: 'INR' });

/** Inclusive numeric range with a central estimate. Used for every estimated figure. */
export interface Range {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/** A discriminated result type; the domain never throws for expected failures. */
export type Result<T, E = DomainError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface DomainError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const domainError = (
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): DomainError => (details ? { code, message, details } : { code, message });

/** Clamp to [min, max]. Used everywhere normalization could otherwise run off the rails. */
export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const clamp01 = (value: number): Unit01 => clamp(value, 0, 1);

/** Round to `dp` decimal places without float tail noise (0.1+0.2 style drift). */
export const round = (value: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
};

export const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
