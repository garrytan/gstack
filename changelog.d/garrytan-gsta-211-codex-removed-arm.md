**The rule-removed control for safety-rule evals now really removes the rule on the Codex host (GST-840).** The Codex host installs every gstack skill under `~/.codex/skills` as a link into the checkout. A removed-arm run therefore still had the rule in the installed skill, and in GSTA-211's `safety-pair-agent-block` run the model read it there and passed the control.

### Fixed
- **`test/helpers/codex-host-runner.ts`**: under `GSTACK_SAFETY_ARM=removed`, each installed skill whose markdown carries a registered safety-rule paragraph is swapped from its link to a private copy with that paragraph deleted. Files are replaced, never written in place, so the checkout is never touched. The `rule` arm is unchanged.
- **`test/codex-host-safety-arm.test.ts`** checks both arms on a linked install like the one `./setup --host codex` makes, with no model and no setup run.
