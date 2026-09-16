/**
 * Negotiation.
 *
 * Tracks the sequence of offers rather than a single "target price", because
 * the sequence is what a buyer loses track of: what was asked, what was
 * offered, what came back, what was conceded in place of price, and what the
 * walk-away number was before the room changed their mind about it.
 *
 * Recording the walk-away price up front is the point of the whole model. A
 * number set while calm is worth more than one set across a table.
 */

import type { INR, Instant, PropertyId, UserId } from '../shared/types';

export const NEGOTIATION_STATUSES = [
  'preparing',
  'offerMade',
  'countered',
  'agreed',
  'walkedAway',
  'lost',
] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

export const STATUS_LABELS: Readonly<Record<NegotiationStatus, string>> = {
  preparing: 'Preparing',
  offerMade: 'Offer made',
  countered: 'Countered',
  agreed: 'Agreed',
  walkedAway: 'Walked away',
  lost: 'Lost to another buyer',
};

export type OfferParty = 'buyer' | 'seller';

export interface Offer {
  readonly id: string;
  readonly party: OfferParty;
  readonly amount: INR;
  readonly at: Instant;
  /** Non-price movement: a free parking slot, waived floor rise, a fit-out. */
  readonly concessions?: readonly string[];
  readonly note?: string;
}

export interface Negotiation {
  readonly id: string;
  readonly userId: UserId;
  readonly propertyId: PropertyId;
  readonly askingPrice: INR;
  /** From the valuation, captured at the time so later drift is visible. */
  readonly fairValueMid?: INR;
  readonly targetPrice: INR;
  /** Set before the first offer. The whole point of writing it down. */
  readonly walkAwayPrice: INR;
  readonly status: NegotiationStatus;
  readonly offers: readonly Offer[];
  readonly outcomePrice?: INR;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface NegotiationState {
  readonly status: NegotiationStatus;
  readonly latestBuyerOffer?: Offer;
  readonly latestSellerOffer?: Offer;
  /** Distance between the two sides right now. */
  readonly gap: INR | undefined;
  readonly gapPercent: number | undefined;
  /** How far the seller has come from the asking price, as a percentage. */
  readonly sellerMovementPercent: number;
  readonly buyerMovementPercent: number;
  /** True when the seller's latest number is above the walk-away price. */
  readonly aboveWalkAway: boolean;
  /** Plain-language read of where this stands and what to do next. */
  readonly guidance: string;
  readonly allConcessions: readonly string[];
}
