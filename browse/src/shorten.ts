/**
 * Path shortening for human-readable tool call summaries.
 * Strips usernames, conductor workspace paths, and the gstack browse binary path.
 */
export function shortenPath(str: string, browseBin: string): string {
  return str
    .replace(new RegExp(browseBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '$B')
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/conductor\/workspaces\/[^/]+\/[^/]+/g, '')
    .replace(/\.claude\/skills\/gstack\//g, '')
    .replace(/browse\/dist\/browse/g, '$B');
}
