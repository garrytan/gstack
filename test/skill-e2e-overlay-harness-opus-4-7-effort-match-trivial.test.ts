import { describeE2ETier } from './helpers/e2e-gate';
import { registerOverlayCase } from './helpers/overlay-case';

describeE2ETier('periodic')('overlay behavior contract v2 (SDK)', () => {
  registerOverlayCase('opus-4-7-effort-match-trivial');
});
