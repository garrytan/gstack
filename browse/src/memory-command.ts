// `$B memory` — diagnostic snapshot of Bun heap + per-tab JS heap +
// Chromium process tree + bounded buffer sizes. Lives in its own file
// because the meta-commands dispatcher imports it lazily — projects
// that never run the diagnostic don't pay the import-graph cost (CDP
// bridge, memory-snapshot types, buffer accessors).

import type { BrowserManager } from './browser-manager';
import { formatBytes, type MemorySnapshot, type MemoryStructureStats } from './memory-snapshot';
import { getModificationHistoryStats } from './cdp-inspector';
import { getSubscriberCount as getActivitySubscriberCount } from './activity';
import { getInspectorSubscriberCount } from './server';
import { consoleBuffer, networkBuffer, dialogBuffer } from './buffers';
import { getCaptureBuffer } from './network-capture';

/**
 * Assemble the MemoryStructureStats from the modules that own each buffer.
 * Browser-manager doesn't take a hard dep on every buffer-owning module —
 * the snapshot caller passes them in.
 */
function collectStructureStats(): MemoryStructureStats {
  return {
    modificationHistory: getModificationHistoryStats(),
    activitySubscribers: getActivitySubscriberCount(),
    inspectorSubscribers: getInspectorSubscriberCount(),
    consoleBufferLen: consoleBuffer.length,
    networkBufferLen: networkBuffer.length,
    dialogBufferLen: dialogBuffer.length,
    captureBufferBytes: getCaptureBuffer().byteSize,
  };
}

/**
 * Pretty-print the snapshot for terminal output. JSON mode (--json) goes
 * straight through JSON.stringify so the extension footer and any test
 * harness can consume it programmatically.
 */
function formatSnapshotText(s: MemorySnapshot): string {
  const lines: string[] = [];
  lines.push(
    `Bun server:        RSS: ${formatBytes(s.bunServer.rss)}  ` +
    `heap: ${formatBytes(s.bunServer.heapUsed)} / ${formatBytes(s.bunServer.heapTotal)}  ` +
    `external: ${formatBytes(s.bunServer.external)}`,
  );

  if (s.processes && s.processes.length > 0) {
    // Group by type so the user sees "renderer: 12" vs listing 12 separate rows.
    const byType: Record<string, number> = {};
    for (const p of s.processes) byType[p.type] = (byType[p.type] ?? 0) + 1;
    const typeSummary = Object.entries(byType)
      .map(([t, n]) => `${t}=${n}`)
      .join(' ');
    lines.push(`Chromium processes: ${s.processes.length} total  (${typeSummary})`);
  } else if (s.processes === null) {
    lines.push('Chromium processes: (unavailable — see notes)');
  } else {
    lines.push('Chromium processes: 0');
  }

  if (s.tabs.length > 0) {
    // Sort by JS heap descending; show top 10 plus "...N more" tail.
    const sorted = [...s.tabs].sort((a, b) => b.jsHeapUsed - a.jsHeapUsed);
    const shown = sorted.slice(0, 10);
    lines.push(`Renderers:         ${s.tabs.length} tabs (top by JS heap):`);
    for (const t of shown) {
      const urlShort = t.url.length > 80 ? t.url.slice(0, 77) + '...' : t.url;
      lines.push(
        `  [${formatBytes(t.jsHeapUsed).padStart(8)} JS, ` +
        `${String(t.nodes).padStart(6)} nodes, ` +
        `${String(t.listeners).padStart(5)} listeners] ` +
        `tab #${t.id} — ${urlShort}`,
      );
    }
    if (sorted.length > shown.length) {
      lines.push(`  ...and ${sorted.length - shown.length} more`);
    }
  } else {
    lines.push('Renderers:         (no tabs tracked)');
  }

  lines.push('─────────────────────────────────────────────────');
  lines.push('In-memory structures (Bun side):');
  const m = s.structures.modificationHistory;
  lines.push(
    `  modificationHistory:    ${m.current} / ${m.cap} entries` +
    (m.evicted > 0 ? `  (${m.evicted} evicted since reset)` : ''),
  );
  lines.push(`  inspectorSubscribers:   ${s.structures.inspectorSubscribers}`);
  lines.push(`  activitySubscribers:    ${s.structures.activitySubscribers}`);
  lines.push(`  consoleBuffer:          ${s.structures.consoleBufferLen} entries`);
  lines.push(`  networkBuffer:          ${s.structures.networkBufferLen} entries`);
  lines.push(`  dialogBuffer:           ${s.structures.dialogBufferLen} entries`);
  lines.push(`  captureBuffer:          ${formatBytes(s.structures.captureBufferBytes)}`);

  if (s.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const n of s.notes) lines.push(`  - ${n}`);
  }

  return lines.join('\n');
}

export async function handleMemoryCommand(args: string[], bm: BrowserManager): Promise<string> {
  const jsonMode = args.includes('--json');
  const structures = collectStructureStats();
  const snapshot = await bm.getMemorySnapshot(structures);
  if (jsonMode) return JSON.stringify(snapshot);
  return formatSnapshotText(snapshot);
}

/** Entry point used by the /memory HTTP endpoint — same data, always JSON. */
export async function buildMemorySnapshotJson(bm: BrowserManager): Promise<MemorySnapshot> {
  const structures = collectStructureStats();
  return bm.getMemorySnapshot(structures);
}
