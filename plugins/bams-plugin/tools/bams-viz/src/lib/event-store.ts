import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import type { Pipeline, AgentData, Trace, PipelineEvent, WorkUnitEvent, WorkUnit } from './types'
import { parseEvents, parseAgentEvents, buildTraces } from './parser'
import { generateFlowchart, generateGantt } from './mermaid-gen'
import { getGlobalRoot } from './global-root'

const EMPTY_AGENT_DATA: AgentData = {
  calls: [],
  stats: [],
  collaborations: [],
  totalCalls: 0,
  totalErrors: 0,
  runningCount: 0,
}

/** Cache entry with mtime-based invalidation */
interface CacheEntry<T> {
  data: T
  mtimeMs: number
  cachedAt: number
}

/** Multi-file cache entry (for directories) */
interface DirCacheEntry<T> {
  data: T
  filesMtime: Record<string, number>
  cachedAt: number
}

const CACHE_TTL_MS = 2000 // 2 seconds TTL

class EventStore {
  private static instance: EventStore | null = null

  private pipelineDir: string = ''
  private agentsDir: string = ''
  private initialized = false

  private workunitDir: string = ''

  // File-level caches
  private pipelineCache = new Map<string, CacheEntry<Pipeline | null>>()
  private rawEventsCache = new Map<string, CacheEntry<PipelineEvent[]>>()
  private allRawEventsCache: DirCacheEntry<PipelineEvent[]> | null = null
  private agentCache = new Map<string, DirCacheEntry<AgentData>>()
  private pipelinesListCache: DirCacheEntry<Array<{ slug: string; type: string; status: string; startedAt: string | null }>> | null = null
  private tracesCache: DirCacheEntry<Trace[]> | null = null
  private workunitCache = new Map<string, CacheEntry<WorkUnitEvent[]>>()
  private workunitListCache: DirCacheEntry<WorkUnit[]> | null = null

  /**
   * Defensively decode a percent-encoded parameter.
   * Handles double-encoding by decoding up to 2 times until stable.
   * Returns the decoded string, or the original if decoding fails.
   */
  static safeDecodeParam(param: string): string {
    if (!param) return param
    try {
      let decoded = param
      // Decode up to 2 rounds to handle double-encoding (%25xx → %xx → char)
      for (let i = 0; i < 2; i++) {
        const next = decodeURIComponent(decoded)
        if (next === decoded) break // stable — no more encoding
        decoded = next
      }
      return decoded
    } catch {
      return param // malformed URI — return as-is, let validateParam reject it
    }
  }

  /** Validate slug/date to prevent path traversal.
   * Allows all Unicode letters and numbers (including Korean) via \p{L} and \p{N}.
   * Blocks path traversal characters: /, \\, and double-dot (..) sequences.
   * Automatically decodes percent-encoded input before validation.
   */
  private static validateParam(param: string): void {
    const decoded = EventStore.safeDecodeParam(param)
    if (!decoded || !/^[\p{L}\p{N}_\-]{1,256}$/u.test(decoded)) {
      throw new Error(`Invalid parameter: ${param}`)
    }
  }

  static getInstance(): EventStore {
    if (!EventStore.instance) {
      EventStore.instance = new EventStore()
    }
    return EventStore.instance
  }

  initialize(crewRoot: string): void {
    this.pipelineDir = join(crewRoot, 'artifacts', 'pipeline')
    this.agentsDir = join(crewRoot, 'artifacts', 'agents')
    this.workunitDir = join(crewRoot, 'artifacts', 'pipeline')
    mkdirSync(this.pipelineDir, { recursive: true })
    mkdirSync(this.agentsDir, { recursive: true })
    this.initialized = true
  }

  /**
   * Find global bams root — delegates to global-root.ts (Single Source of Truth).
   * All projects share ~/.bams/ for cross-project visibility.
   */
  static findCrewRoot(): string {
    return getGlobalRoot()
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.initialize(EventStore.findCrewRoot())
    }
  }

  /** Get file mtime, returns 0 if file doesn't exist */
  private getFileMtime(filePath: string): number {
    try { return statSync(filePath).mtimeMs } catch { return 0 }
  }

  /** Check if single-file cache is still valid */
  private isFileCacheValid<T>(cache: CacheEntry<T> | undefined, filePath: string): cache is CacheEntry<T> {
    if (!cache) return false
    if (Date.now() - cache.cachedAt > CACHE_TTL_MS) return false
    return this.getFileMtime(filePath) === cache.mtimeMs
  }

  /** Get directory file mtimes map */
  private getDirMtimes(dirPath: string, filter: (f: string) => boolean): Record<string, number> {
    try {
      const result: Record<string, number> = {}
      for (const f of readdirSync(dirPath).filter(filter)) {
        result[f] = this.getFileMtime(join(dirPath, f))
      }
      return result
    } catch { return {} }
  }

  /** Check if directory cache is still valid */
  private isDirCacheValid<T>(cache: DirCacheEntry<T> | null | undefined, dirPath: string, filter: (f: string) => boolean): cache is DirCacheEntry<T> {
    if (!cache) return false
    if (Date.now() - cache.cachedAt > CACHE_TTL_MS) return false
    const currentMtimes = this.getDirMtimes(dirPath, filter)
    const cachedKeys = Object.keys(cache.filesMtime)
    const currentKeys = Object.keys(currentMtimes)
    if (cachedKeys.length !== currentKeys.length) return false
    for (const k of currentKeys) {
      if (cache.filesMtime[k] !== currentMtimes[k]) return false
    }
    return true
  }

  /**
   * List all pipelines with summary info
   */
  getPipelines(): Array<{ slug: string; type: string; status: string; startedAt: string | null }> {
    this.ensureInitialized()
    const filter = (f: string) => f.endsWith('-events.jsonl')
    if (this.isDirCacheValid(this.pipelinesListCache, this.pipelineDir, filter)) {
      return this.pipelinesListCache.data
    }
    try {
      const filesMtime = this.getDirMtimes(this.pipelineDir, filter)
      const data = Object.keys(filesMtime)
        .map((f: string) => {
          const slug = f.replace('-events.jsonl', '')
          try {
            const content = readFileSync(join(this.pipelineDir, f), 'utf-8')
            const pipeline = parseEvents(content)
            return { slug, type: pipeline.type, status: pipeline.status, startedAt: pipeline.startedAt }
          } catch {
            return { slug, type: 'unknown', status: 'unknown', startedAt: null }
          }
        })
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      this.pipelinesListCache = { data, filesMtime, cachedAt: Date.now() }
      return data
    } catch {
      return []
    }
  }

  /**
   * Get parsed pipeline data for a given slug
   */
  getPipeline(slug: string): Pipeline | null {
    this.ensureInitialized()
    slug = EventStore.safeDecodeParam(slug)
    EventStore.validateParam(slug)
    const file = join(this.pipelineDir, `${slug}-events.jsonl`)
    const cached = this.pipelineCache.get(slug)
    if (this.isFileCacheValid(cached, file)) return cached.data
    if (!existsSync(file)) return null
    try {
      const content = readFileSync(file, 'utf-8')
      const data = parseEvents(content)
      this.pipelineCache.set(slug, { data, mtimeMs: this.getFileMtime(file), cachedAt: Date.now() })
      return data
    } catch {
      return null
    }
  }

  /**
   * Get raw events array for a pipeline slug
   */
  getRawEvents(slug: string): PipelineEvent[] {
    this.ensureInitialized()
    slug = EventStore.safeDecodeParam(slug)
    EventStore.validateParam(slug)
    const file = join(this.pipelineDir, `${slug}-events.jsonl`)
    const cached = this.rawEventsCache.get(slug)
    if (this.isFileCacheValid(cached, file)) return cached.data
    if (!existsSync(file)) return []
    try {
      const content = readFileSync(file, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const events: PipelineEvent[] = []
      for (const line of lines) {
        try { events.push(JSON.parse(line)) } catch { /* skip */ }
      }
      this.rawEventsCache.set(slug, { data: events, mtimeMs: this.getFileMtime(file), cachedAt: Date.now() })
      return events
    } catch {
      return []
    }
  }

  /**
   * Get raw events from ALL pipeline files combined, sorted by timestamp
   */
  getAllRawEvents(): PipelineEvent[] {
    this.ensureInitialized()
    const pipelineFilter = (f: string) => f.endsWith('-events.jsonl')
    const agentFilter = (f: string) => f.endsWith('.jsonl')

    // Check combined cache validity
    if (this.allRawEventsCache) {
      const now = Date.now()
      if (now - this.allRawEventsCache.cachedAt < CACHE_TTL_MS) {
        // Quick mtime check on both directories
        const pMtimes = this.getDirMtimes(this.pipelineDir, pipelineFilter)
        const aMtimes = this.getDirMtimes(this.agentsDir, agentFilter)
        const combined: Record<string, number> = {}
        for (const [k, v] of Object.entries(pMtimes)) combined[`p:${k}`] = v
        for (const [k, v] of Object.entries(aMtimes)) combined[`a:${k}`] = v
        const cachedKeys = Object.keys(this.allRawEventsCache.filesMtime)
        const currentKeys = Object.keys(combined)
        let valid = cachedKeys.length === currentKeys.length
        if (valid) {
          for (const k of currentKeys) {
            if (this.allRawEventsCache.filesMtime[k] !== combined[k]) { valid = false; break }
          }
        }
        if (valid) return this.allRawEventsCache.data
      }
    }

    try {
      const allEvents: PipelineEvent[] = []
      const filesMtime: Record<string, number> = {}
      const files = readdirSync(this.pipelineDir).filter(pipelineFilter)
      for (const f of files) {
        filesMtime[`p:${f}`] = this.getFileMtime(join(this.pipelineDir, f))
        try {
          const content = readFileSync(join(this.pipelineDir, f), 'utf-8')
          for (const line of content.trim().split('\n').filter(Boolean)) {
            try { allEvents.push(JSON.parse(line)) } catch { /* skip */ }
          }
        } catch { /* skip file */ }
      }
      try {
        const agentFiles = readdirSync(this.agentsDir).filter(agentFilter)
        for (const f of agentFiles) {
          filesMtime[`a:${f}`] = this.getFileMtime(join(this.agentsDir, f))
          try {
            const content = readFileSync(join(this.agentsDir, f), 'utf-8')
            for (const line of content.trim().split('\n').filter(Boolean)) {
              try { allEvents.push(JSON.parse(line)) } catch { /* skip */ }
            }
          } catch { /* skip file */ }
        }
      } catch { /* no agents dir */ }
      // Deduplicate agent events that appear in both pipeline and agents files
      const seen = new Set<string>()
      const deduped = allEvents.filter(e => {
        const callId = (e as Record<string, unknown>).call_id as string | undefined
        if (!callId) return true // non-agent events always pass
        const key = `${e.type}:${callId}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const data = deduped.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
      this.allRawEventsCache = { data, filesMtime, cachedAt: Date.now() }
      return data
    } catch {
      return []
    }
  }

  /**
   * Get Mermaid flowchart and gantt chart for a pipeline slug
   */
  getMermaid(slug: string): { flowchart: string; gantt: string } | null {
    const pipeline = this.getPipeline(slug)
    if (!pipeline) return null
    return {
      flowchart: generateFlowchart(pipeline),
      gantt: generateGantt(pipeline),
    }
  }

  /**
   * Get agent data, optionally filtered by date
   */
  getAgents(date?: string): AgentData {
    this.ensureInitialized()
    const cacheKey = date || 'all'
    try {
      if (!date || date === 'all') {
        const filter = (f: string) => f.endsWith('.jsonl')
        const cached = this.agentCache.get(cacheKey)
        if (this.isDirCacheValid(cached, this.agentsDir, filter)) return cached.data

        const files: string[] = readdirSync(this.agentsDir)
          .filter(filter)
          .sort()
          .reverse()
        const filesMtime = this.getDirMtimes(this.agentsDir, filter)
        let content = ''
        for (const f of files.slice(0, 30)) {
          try {
            content += readFileSync(join(this.agentsDir, f), 'utf-8') + '\n'
          } catch { /* skip */ }
        }
        if (!content.trim()) return { ...EMPTY_AGENT_DATA }
        const data = parseAgentEvents(content)
        this.agentCache.set(cacheKey, { data, filesMtime, cachedAt: Date.now() })
        return data
      } else {
        EventStore.validateParam(date)
        const file = join(this.agentsDir, `${date}.jsonl`)
        if (!existsSync(file)) return { ...EMPTY_AGENT_DATA }
        const content = readFileSync(file, 'utf-8')
        return parseAgentEvents(content)
      }
    } catch {
      return { ...EMPTY_AGENT_DATA }
    }
  }

  /**
   * List available agent date files
   */
  getAgentDates(): string[] {
    this.ensureInitialized()
    try {
      return readdirSync(this.agentsDir)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => f.replace('.jsonl', ''))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /**
   * Get events since a given ISO timestamp, optionally filtered by pipeline
   */
  getEventsSince(since: string, pipeline?: string): PipelineEvent[] {
    this.ensureInitialized()
    const sinceTime = new Date(since).getTime()
    if (isNaN(sinceTime)) return []
    const results: PipelineEvent[] = []

    try {
      const files: string[] = readdirSync(this.pipelineDir)
        .filter((f: string) => f.endsWith('-events.jsonl'))
        .filter((f: string) => !pipeline || f === `${pipeline}-events.jsonl`)

      for (const f of files) {
        try {
          const content = readFileSync(join(this.pipelineDir, f), 'utf-8')
          const lines = content.trim().split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const event: PipelineEvent = JSON.parse(line)
              if (event.ts && new Date(event.ts).getTime() > sinceTime) {
                results.push(event)
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* directory not readable */ }

    return results.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
  }

  /**
   * Build Langfuse-style traces from all pipeline events
   */
  getTraces(params?: { pipeline?: string; agent?: string; from?: string; to?: string }): Trace[] {
    this.ensureInitialized()
    const filter = (f: string) => {
      if (!f.endsWith('-events.jsonl')) return false
      if (params?.pipeline) return f === `${params.pipeline}-events.jsonl`
      return true
    }

    // Use cache for unfiltered traces
    if (!params?.pipeline && !params?.agent && !params?.from && !params?.to) {
      if (this.isDirCacheValid(this.tracesCache, this.pipelineDir, (f) => f.endsWith('-events.jsonl'))) {
        return this.tracesCache.data
      }
    }

    const allEvents: PipelineEvent[] = []
    const filesMtime: Record<string, number> = {}

    try {
      const files: string[] = readdirSync(this.pipelineDir).filter(filter)
      for (const f of files) {
        filesMtime[f] = this.getFileMtime(join(this.pipelineDir, f))
        try {
          const content = readFileSync(join(this.pipelineDir, f), 'utf-8')
          const lines = content.trim().split('\n').filter(Boolean)
          for (const line of lines) {
            try { allEvents.push(JSON.parse(line)) } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    } catch {
      return []
    }

    let traces = buildTraces(allEvents)

    // Cache unfiltered result
    if (!params?.pipeline && !params?.agent && !params?.from && !params?.to) {
      this.tracesCache = { data: traces, filesMtime, cachedAt: Date.now() }
    }

    if (params?.agent) {
      traces = traces.filter(t => t.spans.some(s => s.agentType === params.agent))
    }
    if (params?.from) {
      const fromTime = new Date(params.from).getTime()
      traces = traces.filter(t => new Date(t.startedAt).getTime() >= fromTime)
    }
    if (params?.to) {
      const toTime = new Date(params.to).getTime()
      traces = traces.filter(t => new Date(t.startedAt).getTime() <= toTime)
    }

    return traces.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /**
   * Get a single trace by ID (uses cached traces)
   */
  getTrace(traceId: string): Trace | null {
    const traces = this.getTraces()
    return traces.find(t => t.traceId === traceId) ?? null
  }

  /**
   * Get aggregated agent statistics (uses cached agent data)
   */
  getAgentStats(): { byAgentType: Array<{ agentType: string; count: number; avgDurationMs: number; errorRate: number }> } {
    const agentData = this.getAgents('all')
    return {
      byAgentType: agentData.stats.map(s => ({
        agentType: s.agentType,
        count: s.callCount,
        avgDurationMs: s.avgDurationMs,
        errorRate: s.errorRate,
      })),
    }
  }
  // ── Work Unit methods ──────────────────────────────────

  /**
   * List all work unit slugs from *-workunit.jsonl files
   */
  getWorkUnitSlugs(): string[] {
    this.ensureInitialized()
    try {
      return readdirSync(this.workunitDir)
        .filter((f: string) => f.endsWith('-workunit.jsonl'))
        .map((f: string) => f.replace('-workunit.jsonl', ''))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Get raw events for a specific work unit
   */
  getWorkUnitEvents(slug: string): WorkUnitEvent[] {
    this.ensureInitialized()
    slug = EventStore.safeDecodeParam(slug)
    EventStore.validateParam(slug)
    const file = join(this.workunitDir, `${slug}-workunit.jsonl`)
    const cached = this.workunitCache.get(slug)
    if (this.isFileCacheValid(cached, file)) return cached.data
    if (!existsSync(file)) return []
    try {
      const content = readFileSync(file, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const events: WorkUnitEvent[] = []
      for (const line of lines) {
        try { events.push(JSON.parse(line)) } catch { /* skip */ }
      }
      this.workunitCache.set(slug, { data: events, mtimeMs: this.getFileMtime(file), cachedAt: Date.now() })
      return events
    } catch {
      return []
    }
  }

  /**
   * Get all work units parsed into WorkUnit objects
   */
  getWorkUnits(): WorkUnit[] {
    this.ensureInitialized()
    const filter = (f: string) => f.endsWith('-workunit.jsonl')
    if (this.isDirCacheValid(this.workunitListCache, this.workunitDir, filter)) {
      return this.workunitListCache.data
    }
    try {
      const slugs = this.getWorkUnitSlugs()
      const filesMtime = this.getDirMtimes(this.workunitDir, filter)
      const data = slugs.map((slug) => this.buildWorkUnit(slug)).filter((wu): wu is WorkUnit => wu !== null)
      this.workunitListCache = { data, filesMtime, cachedAt: Date.now() }
      return data
    } catch {
      return []
    }
  }

  /**
   * Get the currently active work unit (started but not ended)
   */
  getActiveWorkUnit(): WorkUnit | null {
    const workunits = this.getWorkUnits()
    return workunits.find((wu) => wu.status === 'active') ?? null
  }

  /**
   * Get all currently active work units (started but not ended)
   */
  getActiveWorkUnits(): WorkUnit[] {
    const workunits = this.getWorkUnits()
    return workunits.filter((wu) => wu.status === 'active')
  }

  /**
   * Build a WorkUnit object from its events
   */
  private buildWorkUnit(slug: string): WorkUnit | null {
    const events = this.getWorkUnitEvents(slug)
    if (events.length === 0) return null

    const startEvent = events.find((e) => e.type === 'work_unit_start')
    if (!startEvent) return null

    const endEvent = events.find((e) => e.type === 'work_unit_end')
    const linkedEvents = events.filter((e) => e.type === 'pipeline_linked')

    let status: WorkUnit['status'] = 'active'
    if (endEvent) {
      status = (endEvent.status === 'abandoned') ? 'abandoned' : 'completed'
    }

    // Deduplicate by pipeline slug (Map preserves first occurrence)
    const pipelineMap = new Map<string, { id: string; slug: string; type: string; linkedAt: string; status: string | undefined; durationMs: number | null; totalSteps: number; completedSteps: number; failedSteps: number; command: string | null; arguments: string | null }>()
    for (const e of linkedEvents) {
      const slug = e.pipeline_slug ?? ''
      if (slug && !pipelineMap.has(slug)) {
        pipelineMap.set(slug, {
          id: slug,
          slug,
          type: e.pipeline_type ?? 'unknown',
          linkedAt: e.ts ?? new Date().toISOString(),
          status: undefined,
          durationMs: null,
          totalSteps: 0,
          completedSteps: 0,
          failedSteps: 0,
          command: null,
          arguments: null,
        })
      }
    }
    const pipelines = Array.from(pipelineMap.values())

    // Enrich pipeline status from EventStore pipeline data
    for (const p of pipelines) {
      const pipeline = this.getPipeline(p.slug)
      if (pipeline) {
        p.status = pipeline.status
        p.durationMs = pipeline.durationMs
        p.command = pipeline.command
      }
    }

    return {
      slug,
      name: startEvent.work_unit_name ?? slug,
      status,
      startedAt: startEvent.ts,
      endedAt: endEvent?.ts ?? null,
      pipelines,
    }
  }

  /**
   * Delete a pipeline's event file and invalidate caches
   */
  deletePipeline(slug: string): boolean {
    this.ensureInitialized()
    slug = EventStore.safeDecodeParam(slug)
    EventStore.validateParam(slug)
    const file = join(this.pipelineDir, `${slug}-events.jsonl`)
    if (!existsSync(file)) return false
    try {
      unlinkSync(file)
      // Invalidate caches
      this.pipelineCache.delete(slug)
      this.rawEventsCache.delete(slug)
      this.pipelinesListCache = null
      this.allRawEventsCache = null
      this.tracesCache = null
      return true
    } catch {
      return false
    }
  }

  /**
   * Delete all pipeline event files and invalidate caches
   */
  deleteAllPipelines(): number {
    this.ensureInitialized()
    try {
      const files = readdirSync(this.pipelineDir).filter(f => f.endsWith('-events.jsonl'))
      let count = 0
      for (const f of files) {
        try {
          unlinkSync(join(this.pipelineDir, f))
          count++
        } catch { /* skip */ }
      }
      // Clear all caches
      this.pipelineCache.clear()
      this.rawEventsCache.clear()
      this.pipelinesListCache = null
      this.allRawEventsCache = null
      this.tracesCache = null
      return count
    } catch {
      return 0
    }
  }
}

export { EventStore }
