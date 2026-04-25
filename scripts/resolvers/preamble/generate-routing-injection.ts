import type { TemplateContext } from '../types';

export function generateRoutingInjection(_ctx: TemplateContext): string {
  // Safety hardening: do not prompt for or inject persistent project-file routing rules.
  // Routing remains a manual, user-controlled configuration choice.
  return '';
}
