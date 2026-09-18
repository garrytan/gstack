import { describeE2ETier } from './helpers/e2e-gate';
import { registerCarveSectionCase } from './helpers/carve-section-case';

describeE2ETier('periodic')('carve section-loading: plan-design-review', () => {
  registerCarveSectionCase('plan-design-review');
});
