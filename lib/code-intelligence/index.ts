/**
 * code-intelligence — the OPTIONAL, repo-oriented provider contract.
 * See docs/designs/CODE_INTELLIGENCE_PROVIDER_CONTRACT.md.
 */

export * from "./contract";
export { GbrainProvider, parseGbrainSearch } from "./gbrain-adapter";
export { GraphifyProvider, parseGraphifyQuery, type GraphifyOptions } from "./graphify-adapter";
export { SourcebotProvider, parseSourcebotSearch, type SourcebotOptions } from "./sourcebot-adapter";
export {
  readSelection,
  setProvider,
  setConsent,
  hasConsent,
  setRoot,
  getRoot,
  type Selection,
} from "./selection";
export {
  RECOMMENDED_ORDER,
  providerById,
  resolveSelectedProvider,
  detectAvailable,
  type PickerOptions,
  type Availability,
} from "./picker";
