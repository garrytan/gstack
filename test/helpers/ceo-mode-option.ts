/** Match CEO mode labels after the PTY capture strips cursor-spacing escapes. */
type CeoMode = 'HOLD SCOPE' | 'SCOPE EXPANSION' | 'SELECTIVE EXPANSION' | 'SCOPE REDUCTION';

export function findCeoModeOption(
  options: ReadonlyArray<{ index: number; label: string }>,
  targetMode: CeoMode,
): number | null {
  const modes = options.map(option => {
    // The CLI renders a description pane beside the options. Its text may
    // mention a different mode, so match only the leading option title.
    const title = option.label.split(/[│┌\r\n]/, 1)[0]!
      .replace(/\s+/g, '').toUpperCase();
    const mode = /^(HOLDSCOPE|SCOPEEXPANSION|SELECTIVEEXPANSION|SCOPEREDUCTION)(?:$|[^A-Z])/.exec(title)?.[1];
    return { index: option.index, mode };
  });
  if (!modes.some(option => option.mode)) return null;

  const target = modes.find(option => option.mode === targetMode.replace(/\s+/g, ''));
  if (!target) {
    throw new Error(
      `Mode AskUserQuestion rendered but target "${targetMode}" not in option labels:\n` +
      options.map(option => `  ${option.index}. ${option.label}`).join('\n'),
    );
  }
  return target.index;
}
