/**
 * code-intelligence — the OPTIONAL, repo-oriented provider contract.
 * See docs/designs/CODE_INTELLIGENCE_PROVIDER_CONTRACT.md.
 */

export * from "./contract";
export { GbrainProvider, parseGbrainSearch } from "./gbrain-adapter";
export { SourcebotProvider, GraphifyProvider } from "./mcp-adapters";
export {
  recommendCodeProvider,
  resolveCodeProvider,
  RECOMMENDED_ORDER,
  type PickerOptions,
} from "./picker";
