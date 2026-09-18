import { describeE2ETier } from './helpers/e2e-gate';
import { registerCarveSectionCase } from './helpers/carve-section-case';

describeE2ETier('periodic')('carve section-loading: plan-eng-review', () => {
  registerCarveSectionCase('plan-eng-review');
});
