/**
 * Negotiation state.
 *
 * Derived from the offer sequence rather than stored, so the state can never
 * disagree with the offers it is supposed to summarise.
 *
 * The guidance is deliberately blunt. A buyer mid-negotiation does not need a
 * balanced summary of considerations; they need to be told that the number on
 * the table is past the walk-away figure they set themselves last week.
 */

import { round } from '../shared/types';
import type { INR } from '../shared/types';
import type { Negotiation, NegotiationState, Offer } from './types';

const latestFrom = (offers: readonly Offer[], party: Offer['party']): Offer | undefined =>
  [...offers]
    .filter((o) => o.party === party)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);

const movementPercent = (from: INR, to: INR | undefined): number =>
  to === undefined || from <= 0 ? 0 : round(((from - to) / from) * 100, 2);

export const negotiationState = (negotiation: Negotiation): NegotiationState => {
  const { offers, askingPrice, walkAwayPrice, targetPrice, fairValueMid, status } = negotiation;

  const latestBuyerOffer = latestFrom(offers, 'buyer');
  const latestSellerOffer = latestFrom(offers, 'seller');

  // The seller's current number is their latest counter, or the asking price
  // if they have not moved at all.
  const sellerNumber = latestSellerOffer?.amount ?? askingPrice;
  const gap =
    latestBuyerOffer === undefined ? undefined : round(sellerNumber - latestBuyerOffer.amount, 2);
  const gapPercent =
    gap === undefined || latestBuyerOffer === undefined || latestBuyerOffer.amount <= 0
      ? undefined
      : round((gap / latestBuyerOffer.amount) * 100, 2);

  const aboveWalkAway = sellerNumber > walkAwayPrice;

  const allConcessions = [...new Set(offers.flatMap((o) => o.concessions ?? []))];

  return {
    status,
    latestBuyerOffer,
    latestSellerOffer,
    gap,
    gapPercent,
    sellerMovementPercent: movementPercent(askingPrice, latestSellerOffer?.amount),
    buyerMovementPercent:
      latestBuyerOffer === undefined
        ? 0
        : round(
            ((latestBuyerOffer.amount -
              (offers.find((o) => o.party === 'buyer')?.amount ?? latestBuyerOffer.amount)) /
              Math.max(1, offers.find((o) => o.party === 'buyer')?.amount ?? 1)) *
              100,
            2,
          ),
    aboveWalkAway,
    guidance: guidanceFor({
      status,
      sellerNumber,
      walkAwayPrice,
      targetPrice,
      fairValueMid,
      hasBuyerOffer: latestBuyerOffer !== undefined,
      hasSellerCounter: latestSellerOffer !== undefined,
      gap,
      concessionCount: allConcessions.length,
    }),
    allConcessions,
  };
};

const guidanceFor = (input: {
  status: Negotiation['status'];
  sellerNumber: INR;
  walkAwayPrice: INR;
  targetPrice: INR;
  fairValueMid?: INR;
  hasBuyerOffer: boolean;
  hasSellerCounter: boolean;
  gap: INR | undefined;
  concessionCount: number;
}): string => {
  const {
    status,
    sellerNumber,
    walkAwayPrice,
    targetPrice,
    hasBuyerOffer,
    hasSellerCounter,
    gap,
    concessionCount,
  } = input;

  if (status === 'agreed') {
    return 'Agreed. Get it in writing, with the concessions itemised in the agreement rather than promised verbally.';
  }
  if (status === 'walkedAway') {
    return 'You walked. That is a result, not a failure — the walk-away number existed so you would use it.';
  }
  if (status === 'lost') {
    return 'Sold to someone else. Worth recording what it went for: it is a real comparable for your next valuation.';
  }

  if (!hasBuyerOffer) {
    return `Nothing on the table yet. Your target is ₹${targetPrice.toLocaleString('en-IN')} and your walk-away is ₹${walkAwayPrice.toLocaleString('en-IN')}. Write both down before you open, not after.`;
  }

  if (!hasSellerCounter) {
    return 'Your offer is in and they have not moved. Silence is a negotiating position — set yourself a date to follow up and a date to stop.';
  }

  if (sellerNumber > walkAwayPrice) {
    return `Their number is above the walk-away price you set yourself. Either the walk-away was wrong, or this is done. Do not revise it just because you are already in the room.`;
  }

  if (sellerNumber <= targetPrice) {
    return 'They are at or below your target. Close it, and get the concessions written into the agreement.';
  }

  const gapText = gap !== undefined ? ` The gap is ₹${Math.abs(gap).toLocaleString('en-IN')}.` : '';
  const concessionText =
    concessionCount > 0
      ? ' They have already moved on non-price terms, which usually means the price itself is close to firm.'
      : ' Nothing non-price has been conceded yet — parking, floor rise and fit-out are all cheaper for them to give than price.';

  return `Between your target and your walk-away.${gapText}${concessionText}`;
};

/**
 * Valid status transitions.
 *
 * Enforced so the record cannot claim a sequence that did not happen — an
 * agreed negotiation reverting to preparing, say, which would make the offer
 * history unreadable.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<Negotiation['status'], readonly Negotiation['status'][]>
> = {
  preparing: ['offerMade', 'walkedAway', 'lost'],
  offerMade: ['countered', 'agreed', 'walkedAway', 'lost'],
  countered: ['offerMade', 'agreed', 'walkedAway', 'lost'],
  agreed: [],
  walkedAway: [],
  lost: [],
};

export const canTransition = (from: Negotiation['status'], to: Negotiation['status']): boolean =>
  ALLOWED_TRANSITIONS[from].includes(to);
