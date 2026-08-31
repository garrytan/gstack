/**
 * code-intelligence — the OPTIONAL, repo-oriented provider contract.
 *
 * Portions copyright (c) 2026 Sina Matian, time-attack/gstack (GStack 2), MIT.
 *
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
  LARGE_REPO_FILE_THRESHOLD,
  shouldOfferIndexing,
  trackedFileCount,
  type Suggestion,
  type SuggestReason,
} from "./suggest";
export {
  RECOMMENDED_ORDER,
  providerById,
  resolveSelectedProvider,
  detectAvailable,
  type PickerOptions,
  type Availability,
} from "./picker";
