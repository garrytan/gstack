# Sign-in button focus appearance

## Problem and user outcome
The existing Sign in button already has `focus-visible:outline`. Give that
keyboard-focused state a deliberate visual treatment that remains clearly
visible against the button and the surrounding sign-in form.

## Proposed visual change
Refine the focus indicator on the existing button. Its color, thickness and
spacing are design choices for the review. Preserve the button's label, size,
position and activation behavior, and avoid clipping or layout shifts in the
current narrow form. Keep keyboard focus available throughout the change.

## Existing boundary
`src/main.tsx` owns the form and its Tailwind classes; `src/styles.css` contains
the existing Tailwind layers. This proposal adds no controls, interaction state
or password-field behavior. Authentication and login errors are unchanged.
The improvement is not implemented. Its implementation and verification proposal
is `.claude/plans/autoplan-focus-appearance.md` and remains open to review.
