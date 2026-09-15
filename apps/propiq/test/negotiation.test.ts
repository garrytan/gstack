import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, canTransition, negotiationState } from '@/domain/negotiation/engine';
import { NEGOTIATION_STATUSES } from '@/domain/negotiation/types';
import type { Negotiation, Offer } from '@/domain/negotiation/types';
import { asId } from '@/domain/shared/types';
import type { PropertyId, UserId } from '@/domain/shared/types';
import { NOW } from './support/factories';

const offer = (
  party: Offer['party'],
  amount: number,
  at: string,
  extra: Partial<Offer> = {},
): Offer => ({
  id: `${party}-${amount}`,
  party,
  amount,
  at,
  ...extra,
});

const negotiation = (overrides: Partial<Negotiation> = {}): Negotiation => ({
  id: 'neg-1',
  userId: asId<UserId>('u1'),
  propertyId: asId<PropertyId>('prop-1'),
  askingPrice: 16_000_000,
  fairValueMid: 14_800_000,
  targetPrice: 14_500_000,
  walkAwayPrice: 15_500_000,
  status: 'preparing',
  offers: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('negotiationState', () => {
  it('tells a buyer to write down both numbers before opening', () => {
    const state = negotiationState(negotiation());
    expect(state.guidance).toContain('Nothing on the table');
    expect(state.guidance).toContain('walk-away');
    expect(state.latestBuyerOffer).toBeUndefined();
  });

  it('treats the asking price as the seller position until they counter', () => {
    const state = negotiationState(
      negotiation({
        status: 'offerMade',
        offers: [offer('buyer', 14_000_000, '2026-05-01T00:00:00Z')],
      }),
    );
    // Gap is measured against the asking price, not zero.
    expect(state.gap).toBe(2_000_000);
    expect(state.sellerMovementPercent).toBe(0);
  });

  it('names silence as a negotiating position', () => {
    const state = negotiationState(
      negotiation({
        status: 'offerMade',
        offers: [offer('buyer', 14_000_000, '2026-05-01T00:00:00Z')],
      }),
    );
    expect(state.guidance).toContain('Silence is a negotiating position');
  });

  it('uses the latest offer from each side, not the first', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        offers: [
          offer('buyer', 14_000_000, '2026-05-01T00:00:00Z'),
          offer('seller', 15_600_000, '2026-05-02T00:00:00Z'),
          offer('buyer', 14_600_000, '2026-05-03T00:00:00Z'),
          offer('seller', 15_200_000, '2026-05-04T00:00:00Z'),
        ],
      }),
    );
    expect(state.latestBuyerOffer!.amount).toBe(14_600_000);
    expect(state.latestSellerOffer!.amount).toBe(15_200_000);
    expect(state.gap).toBe(600_000);
  });

  it('measures how far the seller has come from the asking price', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        offers: [
          offer('buyer', 14_000_000, '2026-05-01T00:00:00Z'),
          offer('seller', 15_200_000, '2026-05-02T00:00:00Z'),
        ],
      }),
    );
    expect(state.sellerMovementPercent).toBeCloseTo(5, 1);
  });

  it('calls it when the seller is above the walk-away price', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        walkAwayPrice: 15_000_000,
        offers: [
          offer('buyer', 14_000_000, '2026-05-01T00:00:00Z'),
          offer('seller', 15_600_000, '2026-05-02T00:00:00Z'),
        ],
      }),
    );
    expect(state.aboveWalkAway).toBe(true);
    expect(state.guidance).toContain('above the walk-away price');
    expect(state.guidance).toContain('Do not revise it');
  });

  it('says to close when the seller reaches the target', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        targetPrice: 14_500_000,
        offers: [
          offer('buyer', 14_000_000, '2026-05-01T00:00:00Z'),
          offer('seller', 14_400_000, '2026-05-02T00:00:00Z'),
        ],
      }),
    );
    expect(state.aboveWalkAway).toBe(false);
    expect(state.guidance).toContain('Close it');
  });

  it('points at non-price levers when none have been used', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        offers: [
          offer('buyer', 14_000_000, '2026-05-01T00:00:00Z'),
          offer('seller', 15_000_000, '2026-05-02T00:00:00Z'),
        ],
      }),
    );
    expect(state.guidance).toContain('parking, floor rise and fit-out');
  });

  it('reads concessions as a sign the price is firming', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        offers: [
          offer('buyer', 14_000_000, '2026-05-01T00:00:00Z'),
          offer('seller', 15_000_000, '2026-05-02T00:00:00Z', {
            concessions: ['Free covered parking'],
          }),
        ],
      }),
    );
    expect(state.guidance).toContain('price itself is close to firm');
    expect(state.allConcessions).toContain('Free covered parking');
  });

  it('deduplicates concessions across offers', () => {
    const state = negotiationState(
      negotiation({
        status: 'countered',
        offers: [
          offer('seller', 15_500_000, '2026-05-02T00:00:00Z', {
            concessions: ['Waived floor rise'],
          }),
          offer('seller', 15_200_000, '2026-05-04T00:00:00Z', {
            concessions: ['Waived floor rise', 'Free parking'],
          }),
        ],
      }),
    );
    expect(state.allConcessions).toHaveLength(2);
  });

  it('treats walking away as a result, not a failure', () => {
    expect(negotiationState(negotiation({ status: 'walkedAway' })).guidance).toContain(
      'not a failure',
    );
  });

  it('turns a lost deal into a comparable', () => {
    expect(negotiationState(negotiation({ status: 'lost' })).guidance).toContain('real comparable');
  });

  it('tells an agreed buyer to get the concessions in writing', () => {
    expect(negotiationState(negotiation({ status: 'agreed' })).guidance).toContain('in writing');
  });
});

describe('status transitions', () => {
  it('declares transitions for every status', () => {
    for (const status of NEGOTIATION_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('treats agreed, walked away and lost as terminal', () => {
    for (const terminal of ['agreed', 'walkedAway', 'lost'] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toHaveLength(0);
      expect(canTransition(terminal, 'preparing')).toBe(false);
    }
  });

  it('allows the normal path through a negotiation', () => {
    expect(canTransition('preparing', 'offerMade')).toBe(true);
    expect(canTransition('offerMade', 'countered')).toBe(true);
    expect(canTransition('countered', 'offerMade')).toBe(true);
    expect(canTransition('countered', 'agreed')).toBe(true);
  });

  it('refuses a jump that would make the offer history unreadable', () => {
    expect(canTransition('preparing', 'agreed')).toBe(false);
    expect(canTransition('preparing', 'countered')).toBe(false);
  });

  it('allows walking away or losing from any live state', () => {
    for (const live of ['preparing', 'offerMade', 'countered'] as const) {
      expect(canTransition(live, 'walkedAway')).toBe(true);
      expect(canTransition(live, 'lost')).toBe(true);
    }
  });
});
