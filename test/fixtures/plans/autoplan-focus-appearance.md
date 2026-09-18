# Plan: refine the Sign in button's keyboard-focus appearance

## User goal
Give the existing Sign in button a deliberate, clearly visible keyboard-focus
treatment in the narrow sign-in form.

## Existing behavior
The form and submit button are in `src/main.tsx`. The button already has
`focus-visible:outline`; focus is not absent. Its current classes also define a
rounded blue background, white text and padding. The existing React form,
keyboard navigation and submit behavior remain in place.

## Proposed UI
Improve the existing button's focus appearance so its focused state is clearly
distinguishable against both the button and surrounding form. Choose the visual
treatment during review, including the indicator's color, thickness and spacing.
Keep the button's label, size, position and activation behavior unchanged. Use
the existing styling system without adding a control or interaction state.

## Verification to plan
Use the existing real-browser harness to reach the button by keyboard and check
focus entering and leaving it. Verify the approved project styling is applied,
not merely that the browser supplies a default indicator. Check visibility and
clipping in the existing narrow layout without shifting surrounding content.
Retain the baseline submit payload, Enter-to-submit, navigation and error checks.

## Scope
Product scope is fixed to this button's focus appearance. Keep extra user-visible
behaviors as proposals pending the final user gate; do not auto-accept them.
Existing form state, password-field behavior, authentication and error handling
remain unchanged. This is not a form redesign or a new password visibility control.
Ordinary implementation, visual treatment and verification choices remain open to
/autoplan's normal process. Complete SELECTIVE EXPANSION exploration and all
required phases, outside voices and spec reviews. Address the correctness,
accessibility and security needed for this change. If a necessary remedy would
expand product scope, retain its evidence and unresolved blocker for the final
gate rather than assuming approval.

The focus-appearance improvement is not implemented and remains subject to review.
