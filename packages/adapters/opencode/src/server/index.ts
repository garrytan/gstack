export { execute } from './execute.js';
export { testEnvironment } from './test.js';
export { parseOpenCodeOutput, isOpenCodeUnknownSessionError } from './parse.js';

// Session codec - required for session persistence
// Since we're not managing OpenCode sessions in the adapter (relying on OpenCode's internal session mgmt),
// we return null for session params and display ID.
// In a more advanced implementation, we could integrate with OpenCode's session system.
export const sessionCodec = {
  deserialize(_raw): null {
    return null;
  },
  serialize(_params): null {
    return null;
  },
  getDisplayId(_params): null {
    return null;
  },
};