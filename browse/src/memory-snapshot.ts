// Shared types for the $B memory diagnostic command and the /memory
// endpoint. Lives in its own module so server.ts, read-commands.ts, and
// the extension footer poll can import without taking a circular dep on
// browser-manager.ts.
//
// Background: the gbrowser-OOM investigation (160 GB Activity Monitor
// reading on a friend's machine) needed a diagnostic that could land
// before the next incident — measurement comes first, fixes come after.
// $B memory is that diagnostic.

/** Counts/bytes for the bounded in-memory structures on the Bun side. */
export interface MemoryStructureStats {
  modificationHistory: { current: number; cap: number; evicted: number };
  activitySubscribers: number;
  inspectorSubscribers: number;
  consoleBufferLen: number;
  networkBufferLen: number;
  dialogBufferLen: number;
  captureBufferBytes: number;
}

/** Per-tab JS heap snapshot (CDP Performance.getMetrics). */
export interface MemoryTabSnapshot {
  id: number;
  url: string;
  title: string;
  jsHeapUsed: number;
  jsHeapTotal: number;
  documents: number;
  nodes: number;
  listeners: number;
}

/** Service worker JS heap snapshot (CDP Runtime.getHeapUsage). */
export interface MemoryWorkerSnapshot {
  targetId: string;
  url: string;
  title: string;
  jsHeapUsed: number;
  jsHeapTotal: number;
}

/** GPU hardware capabilities via CDP SystemInfo.getInfo. */
export interface MemoryGpuInfo {
  devices: Array<{
    vendorId: number;
    deviceId: number;
    vendorString: string;
    deviceString: string;
    driverVendor?: string;
    driverVersion?: string;
  }>;
  modelName?: string;
  modelVersion?: string;
}

/** Native memory sampled allocations via CDP Memory.getSamplingProfile. */
export interface MemoryNativeProfile {
  totalAllocatedBytes: number;
}

/** Chromium process metadata via CDP SystemInfo.getProcessInfo. */
export interface MemoryProcess {
  /** Chromium-internal process id (not OS PID). */
  id: number;
  /** 'browser' | 'renderer' | 'gpu' | 'utility' | 'extension' | ... */
  type: string;
  /** CPU time accumulated since process start (seconds). */
  cpuTime: number;
}

export interface MemorySnapshot {
  bunServer: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  tabs: MemoryTabSnapshot[];
  /** Bakes extension background worker heap profile metrics. */
  serviceWorkers: MemoryWorkerSnapshot[];
  /** Detailed GPU device information if CDP provides it. */
  gpuInfo: MemoryGpuInfo | null;
  /** Sampled native memory footprint. */
  nativeProfile: MemoryNativeProfile | null;
  /**
   * Chromium process tree. `null` when no browser handle is available
   * (server in connection mode, or browser not yet launched).
   */
  processes: MemoryProcess[] | null;
  structures: MemoryStructureStats;
  capturedAt: number;
  notes: string[];
}

/** Format bytes as a short human string ("1.4 GB", "312 MB", "84 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
