/**
 * Buyer profile and fit.
 *
 * Buyer fit is what turns a generic score into a personal one. The same
 * property is a buy for an end-user with a 45-minute commute tolerance and a
 * pass for an investor who needs 4% gross yield.
 */

import type { INR, LocalityId, Unit01, UserId } from '../shared/types';
import type { Facing, PropertyKind } from '../property/types';

export const BUYER_PERSONAS = ['homebuyer', 'investor', 'nri'] as const;
export type BuyerPersona = (typeof BUYER_PERSONAS)[number];

export interface BuyerProfile {
  readonly userId: UserId;
  readonly persona: BuyerPersona;
  readonly budgetMin: INR;
  readonly budgetMax: INR;
  readonly preferredLocalities: readonly LocalityId[];
  readonly bedroomsMin?: number;
  readonly bedroomsMax?: number;
  readonly kinds?: readonly PropertyKind[];
  readonly preferredFacings?: readonly Facing[];
  /** Workplace anchor used for commute fit. */
  readonly workplace?: { readonly label: string; readonly maxPeakCommuteMinutes: number };
  readonly needsReadyToMove?: boolean;
  readonly minCarpetEfficiency?: number;
  /** Investor-only: the gross yield below which the deal is not interesting. */
  readonly targetGrossYieldPercent?: number;
  /** How much the buyer cares about each thing, 0..1. Drives fit weighting. */
  readonly priorities?: BuyerPriorities;
}

export interface BuyerPriorities {
  readonly price?: Unit01;
  readonly commute?: Unit01;
  readonly schools?: Unit01;
  readonly developerReputation?: Unit01;
  readonly legalCertainty?: Unit01;
  readonly appreciation?: Unit01;
  readonly rentalIncome?: Unit01;
  readonly readiness?: Unit01;
}

export const DEFAULT_PRIORITIES: Readonly<Record<BuyerPersona, Required<BuyerPriorities>>> = {
  homebuyer: {
    price: 0.9,
    commute: 0.8,
    schools: 0.6,
    developerReputation: 0.7,
    legalCertainty: 0.9,
    appreciation: 0.4,
    rentalIncome: 0.1,
    readiness: 0.6,
  },
  investor: {
    price: 0.8,
    commute: 0.3,
    schools: 0.2,
    developerReputation: 0.6,
    legalCertainty: 0.9,
    appreciation: 0.9,
    rentalIncome: 0.9,
    readiness: 0.4,
  },
  nri: {
    price: 0.6,
    commute: 0.2,
    schools: 0.3,
    developerReputation: 0.9,
    legalCertainty: 1.0,
    appreciation: 0.7,
    rentalIncome: 0.7,
    readiness: 0.5,
  },
};

export const prioritiesFor = (profile: BuyerProfile): Required<BuyerPriorities> => ({
  ...DEFAULT_PRIORITIES[profile.persona],
  ...(profile.priorities ?? {}),
});
