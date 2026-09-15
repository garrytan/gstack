# Product spec

## One line

PropIQ measures whether a property is worth buying — and shows its working.

## The problem

Indian residential buying runs on asymmetry. The developer knows the carpet
ratio, the delay record, the unsold inventory and the real clearing price. The
buyer gets a brochure and a Sunday site visit.

Existing portals optimise for listing volume, because listings are what
developers pay for. That makes them inventory directories with a search box.
They will tell you a flat exists. They will not tell you it is priced 14% above
what comparable units actually transacted at, that the phase's RERA
registration expires eight months before the committed possession date, or that
this developer has averaged eleven months of delay across nine projects.

## The product

Not "what is available" but **"should I buy this one, at this price, and what
should I argue about"**.

Journey: **Discover → Verify → Compare → Score → Analyze → Visit → Negotiate →
Buy → Monitor.**

## Users

| User | Needs | Weighting |
|---|---|---|
| **Homebuyer** | Fair value, fit, project quality, legal confidence, locality, risks, negotiation | Legal 13%, value 15%, commute-heavy |
| **Investor** | Yield, cash flow, IRR, appreciation, liquidity, exit | Investment 16%, liquidity 9%, livability 3% |
| **NRI** | Remote decision support, document confidence, assisted transaction | Legal 18%, developer 14% — cannot inspect in person |
| **Advisor** | Lead context, shortlist, risks, visits, negotiation state | Not built |
| **Enterprise** | Data/API, inventory and demand intelligence | Not built |

## The flagship screen

The Property Intelligence Page. Thirteen sections, each of which must improve a
decision or it does not ship:

1. **Header** — verdict, score with band, confidence, freshness, save/compare/ask
2. **Why this verdict** — decisive positives, decisive negatives, and the unknowns
3. **Fair value & negotiation** — band, asking price against it, open/target/walk-away
4. **Score breakdown** — every pillar expands to its signals, raw values and method
5. **Risks** — nine dimensions, each with drivers
6. **Legal & RERA** — registration, validity against possession, portal link
7. **Developer** — delivery volume, delay record, complaints
8. **Locality & infrastructure** — with the funded/announced distinction made explicit
9. **Investment outlook** — yields, EMI, IRR, scenarios, and the assumptions on show
10. **Comparable alternatives** — same bedrooms, ±30% price
11. **Evidence & sources** — every fact, with source, date, confidence, method
12. **Commercial disclosure** — and the statement that it never touches the score
13. **Next action**

No brochure content. If a section cannot change a decision, it is not a section.

## The PropIQ Score

Twelve pillars: value, legal, developer, project, unit, location,
infrastructure, livability, investment, liquidity, risk, buyer fit.

Pipeline: `evidence → normalized signals → pillar scores → persona-weighted composite`.

Never `LLM → number`. The weights are published at `/methodology`, read from the
running code.

Three properties that matter more than the arithmetic:

- **Missing data is not zero.** Absent signals are dropped and weights rescaled.
- **There is a reporting floor.** Below 45% coverage or 35% confidence, no score
  is published at all.
- **Every score has a band.** 95%, widening as evidence thins.

## The verdict

`BUY` · `NEGOTIATE` · `WATCH` · `AVOID` · `INSUFFICIENT EVIDENCE`

Deterministic rules, evaluated top-down: evidence gate → disqualifying risk →
price gate → score bands. Every verdict names the rule that produced it and
lists its positives, negatives and unknowns.

`INSUFFICIENT EVIDENCE` is a first-class outcome, not a failure state. A product
that always has an opinion is not measuring anything.

## The Decision Room

Comparison that does the reader's work:

- **Biggest differences**, ordered by magnitude — not a wall of matching rows.
- **A winner per dimension**, but only when the gap clears a minimum meaningful
  spread. Below that it says "too close to call", because declaring a winner on
  a 0.4-point difference is noise dressed as insight.
- **Trade-off sentences**: *"Project B costs ₹14.0 lakh more than Project A, and
  in exchange it saves roughly 25 minutes of peak commute, and carries
  materially lower delivery and legal risk."*
- Price is judged on distance from fair value, not on the sticker. The cheapest
  property is not the best-priced one if it is still above what it is worth.

## Differentiation

| | Portals | PropIQ |
|---|---|---|
| Unit of value | The listing | The decision |
| Price signal | Asking price | Asking vs. modelled fair value, with a band |
| Scoring | None, or opaque | Twelve pillars, published formula and weights |
| Missing data | Hidden | Named, excluded, reported as coverage |
| Risk | A badge, if any | Nine dimensions with drivers |
| Commercial influence | Undisclosed | Disclosed, and structurally separated from scoring |
| When evidence is thin | Shows something anyway | Publishes no score |

## Non-goals

- Listing volume. Dense coverage of one market beats thin coverage of a hundred.
- Fractional investing. Needs a separate regulatory workstream.
- Replacing a lawyer. Document AI flags what looks wrong; it does not certify.
- Investment advice. This is decision support.
