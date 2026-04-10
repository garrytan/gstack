import type {
  PipelineEvent,
  Pipeline,
  PipelineStep,
  AgentCall,
  PipelineError,
  AgentData,
  AgentTypeStat,
  Collaboration,
  Trace,
  Span,
} from './types'

import { AGENT_DEPT_MAP } from './agents-config'

// Department mapping — derived from single source + non-org agents
export const DEPT_MAP: Record<string, string> = {
  ...AGENT_DEPT_MAP,
  // Non-org agents (Claude Code built-in agent types)
  'general-purpose': 'engineering-frontend',
  'Explore': 'engineering-frontend',
  'Plan': 'planning',
}

/**
 * Parse NDJSON string into structured pipeline data
 */
export function parseEvents(content: string): Pipeline {
  const lines = content.trim().split('\n').filter(Boolean)
  const events: PipelineEvent[] = []

  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]))
    } catch {
      // Skip malformed lines
    }
  }

  return buildPipeline(events)
}

/**
 * Parse agent events into agent-centric data
 */
export function parseAgentEvents(content: string): AgentData {
  const lines = content.trim().split('\n').filter(Boolean)
  const events: PipelineEvent[] = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch { /* skip */ }
  }
  return buildAgentData(events)
}

/**
 * Build agent-centric data from raw events
 */
function buildAgentData(events: PipelineEvent[]): AgentData {
  const agentMap = new Map<string, AgentCall>()

  for (const ev of events) {
    if (ev.type === 'agent_start') {
      const e = ev as PipelineEvent & {
        call_id: string; agent_type: string; model?: string;
        description?: string; prompt_summary?: string; background?: boolean;
        pipeline_slug?: string; trace_id?: string; input?: string;
        department?: string; skill_name?: string; parent_span_id?: string | null;
      }
      agentMap.set(e.call_id, {
        callId: e.call_id,
        agentType: e.agent_type || 'unknown',
        model: e.model || '',
        description: e.description || '',
        promptSummary: e.prompt_summary || '',
        background: e.background || false,
        pipelineSlug: e.pipeline_slug || null,
        parallelGroup: null,
        startedAt: e.ts,
        endedAt: null,
        durationMs: null,
        isError: false,
        errorMessage: '',
        resultSummary: '',
        // Enhanced tracing fields
        traceId: e.trace_id,
        input: e.input,
        department: e.department,
        skillName: e.skill_name,
        parentSpanId: e.parent_span_id ?? null,
      })
    } else if (ev.type === 'agent_end') {
      const e = ev as PipelineEvent & {
        call_id: string; agent_type?: string; is_error?: boolean;
        error_message?: string; result_summary?: string; duration_ms?: number;
        output?: string; token_usage?: { input: number; output: number };
      }
      const agent = agentMap.get(e.call_id)
      if (agent) {
        agent.endedAt = e.ts
        agent.isError = e.is_error || false
        agent.errorMessage = e.error_message || ''
        agent.resultSummary = e.result_summary || ''
        agent.output = e.output
        agent.tokenUsage = e.token_usage
        agent.durationMs = e.duration_ms ??
          (agent.startedAt ? new Date(e.ts).getTime() - new Date(agent.startedAt).getTime() : null)
      } else {
        // Orphaned end event -- still record it
        agentMap.set(e.call_id, {
          callId: e.call_id,
          agentType: (e.agent_type as string) || 'unknown',
          model: '',
          description: '',
          promptSummary: '',
          background: false,
          pipelineSlug: (e.pipeline_slug as string) || null,
          parallelGroup: null,
          startedAt: null,
          endedAt: e.ts,
          durationMs: e.duration_ms ?? null,
          isError: e.is_error || false,
          errorMessage: e.error_message || '',
          resultSummary: e.result_summary || '',
          output: e.output,
          tokenUsage: e.token_usage,
        })
      }
    }
  }

  const allCalls = Array.from(agentMap.values())
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))

  // Compute per-agent-type stats
  const statsByType: Record<string, AgentTypeStat> = {}
  for (const call of allCalls) {
    const t = call.agentType
    if (!statsByType[t]) {
      statsByType[t] = {
        agentType: t,
        dept: DEPT_MAP[t] || 'unknown',
        callCount: 0,
        errorCount: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
        errorRate: 0,
        models: {},
      }
    }
    const s = statsByType[t]
    s.callCount++
    if (call.isError) s.errorCount++
    if (call.durationMs != null) {
      if (!call.isError) {
        s.totalDurationMs += call.durationMs
      }
      s.minDurationMs = Math.min(s.minDurationMs, call.durationMs)
      s.maxDurationMs = Math.max(s.maxDurationMs, call.durationMs)
    }
    if (call.model) {
      s.models[call.model] = (s.models[call.model] || 0) + 1
    }
  }
  // Finalize averages
  for (const s of Object.values(statsByType)) {
    const completed = s.callCount - s.errorCount
    s.avgDurationMs = completed > 0 ? Math.round(s.totalDurationMs / completed) : 0
    if (s.minDurationMs === Infinity) s.minDurationMs = 0
    s.errorRate = s.callCount > 0 ? Math.round((s.errorCount / s.callCount) * 100) : 0
  }

  // Detect collaboration (agents called within 5s of each other in same pipeline)
  const collaborations = detectCollaborations(allCalls)

  return {
    calls: allCalls,
    stats: Object.values(statsByType).sort((a, b) => b.callCount - a.callCount),
    collaborations,
    totalCalls: allCalls.length,
    totalErrors: allCalls.filter(c => c.isError).length,
    runningCount: allCalls.filter(c => c.startedAt && !c.endedAt).length,
  }
}

/**
 * Detect agent collaboration patterns
 */
function detectCollaborations(calls: AgentCall[]): Collaboration[] {
  const edges = new Map<string, number>()

  // Group calls by pipeline slug
  const byPipeline = new Map<string, AgentCall[]>()
  for (const c of calls) {
    if (!c.pipelineSlug) continue
    if (!byPipeline.has(c.pipelineSlug)) byPipeline.set(c.pipelineSlug, [])
    byPipeline.get(c.pipelineSlug)!.push(c)
  }

  for (const [, pCalls] of byPipeline) {
    const sorted = pCalls
      .filter(c => c.startedAt)
      .sort((a, b) => new Date(a.startedAt!).getTime() - new Date(b.startedAt!).getTime())

    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i]
      const next = sorted[i + 1]
      if (curr.agentType === next.agentType) continue

      const gap = Math.abs(
        new Date(next.startedAt!).getTime() - new Date(curr.endedAt || curr.startedAt!).getTime()
      )
      if (gap < 5000) {
        const key = `${curr.agentType}\u2192${next.agentType}`
        edges.set(key, (edges.get(key) || 0) + 1)
      }
    }
  }

  return Array.from(edges.entries())
    .map(([edge, count]) => {
      const [from, to] = edge.split('\u2192')
      return { from, to, count }
    })
    .sort((a, b) => b.count - a.count)
}

/**
 * Build structured pipeline from raw events
 */
function buildPipeline(events: PipelineEvent[]): Pipeline {
  const pipeline: Pipeline & { parallelGroups?: Map<string, string[]> } = {
    slug: '',
    type: '',
    status: 'running',
    command: '',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    steps: [],
    agents: [],
    errors: [],
  }

  const stepMap = new Map<number, PipelineStep>()
  const agentMap = new Map<string, AgentCall>()

  for (const event of events) {
    pipeline.slug = pipeline.slug || event.pipeline_slug || ''

    switch (event.type) {
      case 'pipeline_start': {
        const e = event as PipelineEvent & { pipeline_type: string; command?: string }
        pipeline.type = e.pipeline_type
        pipeline.command = e.command || ''
        pipeline.startedAt = e.ts
        break
      }

      case 'pipeline_end': {
        const e = event as PipelineEvent & { status: string; duration_ms?: number }
        pipeline.status = e.status
        pipeline.endedAt = e.ts
        pipeline.durationMs = e.duration_ms ?? null
        break
      }

      case 'step_start': {
        const e = event as PipelineEvent & { step_number: number; step_name: string; phase: string }
        const step: PipelineStep = {
          number: e.step_number,
          name: e.step_name,
          phase: e.phase,
          status: 'running',
          startedAt: e.ts,
          endedAt: null,
          durationMs: null,
          agentCallIds: [],
        }
        stepMap.set(e.step_number, step)
        break
      }

      case 'step_end': {
        const e = event as PipelineEvent & { step_number: number; status: string; duration_ms?: number }
        const step = stepMap.get(e.step_number)
        if (step) {
          step.status = e.status
          step.endedAt = e.ts
          step.durationMs = e.duration_ms ?? null
        }
        break
      }

      case 'agent_start': {
        const e = event as PipelineEvent & {
          call_id: string; agent_type: string; model?: string;
          step_number?: number; description?: string; prompt_summary?: string;
          parallel_group?: string | null; trace_id?: string; input?: string;
          department?: string; skill_name?: string; parent_span_id?: string | null;
          background?: boolean;
        }
        const agent: AgentCall = {
          callId: e.call_id,
          agentType: e.agent_type,
          model: e.model || '',
          stepNumber: e.step_number,
          description: e.description || '',
          promptSummary: e.prompt_summary || '',
          parallelGroup: e.parallel_group || null,
          startedAt: e.ts,
          endedAt: null,
          durationMs: null,
          isError: false,
          traceId: e.trace_id,
          input: e.input,
          department: e.department,
          skillName: e.skill_name,
          parentSpanId: e.parent_span_id ?? null,
          background: e.background,
          pipelineSlug: e.pipeline_slug || null,
        }
        agentMap.set(e.call_id, agent)

        // Link to step
        if (e.step_number != null) {
          const step = stepMap.get(e.step_number)
          if (step) step.agentCallIds.push(e.call_id)
        }
        break
      }

      case 'agent_end': {
        const e = event as PipelineEvent & {
          call_id: string; is_error?: boolean; duration_ms?: number;
          result_summary?: string; error_message?: string;
          output?: string; token_usage?: { input: number; output: number };
        }
        const agent = agentMap.get(e.call_id)
        if (agent) {
          agent.endedAt = e.ts
          agent.isError = e.is_error || false
          agent.resultSummary = e.result_summary
          agent.errorMessage = e.error_message
          agent.output = e.output
          agent.tokenUsage = e.token_usage
          agent.durationMs = e.duration_ms ||
            (agent.startedAt ? new Date(e.ts).getTime() - new Date(agent.startedAt).getTime() : null)
        }
        break
      }

      case 'error': {
        const e = event as PipelineEvent & {
          message: string; step_number?: number; error_code?: string; call_id?: string | null
        }
        pipeline.errors.push({
          message: e.message,
          stepNumber: e.step_number,
          errorCode: e.error_code,
          callId: e.call_id,
          ts: e.ts,
        })
        break
      }
    }
  }

  pipeline.steps = Array.from(stepMap.values()).sort((a, b) => a.number - b.number)
  pipeline.agents = Array.from(agentMap.values())

  // Identify parallel groups (agents starting within 500ms of each other in same step)
  identifyParallelGroups(pipeline)

  return pipeline
}

/**
 * Group agents that execute in parallel
 */
function identifyParallelGroups(pipeline: Pipeline): void {
  const byStep = new Map<number, AgentCall[]>()
  for (const agent of pipeline.agents) {
    if (agent.stepNumber == null) continue
    if (!byStep.has(agent.stepNumber)) byStep.set(agent.stepNumber, [])
    byStep.get(agent.stepNumber)!.push(agent)
  }

  let groupCounter = 0
  for (const [step, agents] of byStep) {
    if (agents.length < 2) continue

    // Only apply time-based grouping to agents without explicit parallel_group
    const ungrouped = agents.filter(a => !a.parallelGroup)
    if (ungrouped.length < 2) continue

    // Time-based grouping: within 500ms
    const sorted = ungrouped
      .filter(a => a.startedAt)
      .sort((a, b) => new Date(a.startedAt!).getTime() - new Date(b.startedAt!).getTime())

    let group: AgentCall[] = [sorted[0]]

    for (let i = 1; i < sorted.length; i++) {
      const gap = new Date(sorted[i].startedAt!).getTime() - new Date(sorted[i - 1].startedAt!).getTime()
      if (gap <= 500) {
        group.push(sorted[i])
      } else {
        if (group.length > 1) {
          const gid = `pg-${step}-${++groupCounter}`
          group.forEach(a => { a.parallelGroup = gid })
        }
        group = [sorted[i]]
      }
    }
    if (group.length > 1) {
      const gid = `pg-${step}-${++groupCounter}`
      group.forEach(a => { a.parallelGroup = gid })
    }
  }
}

/**
 * Build traces from pipeline events (Langfuse-style)
 */
export function buildTraces(events: PipelineEvent[]): Trace[] {
  const traceMap = new Map<string, Trace>()
  const spanMap = new Map<string, Span>()

  for (const ev of events) {
    if (ev.type === 'agent_start') {
      const e = ev as PipelineEvent & {
        call_id: string; agent_type: string; model?: string;
        trace_id?: string; input?: string; department?: string;
        skill_name?: string; parent_span_id?: string | null;
        description?: string; pipeline_slug?: string;
      }
      const traceId = e.trace_id || e.pipeline_slug || 'default'

      if (!traceMap.has(traceId)) {
        traceMap.set(traceId, {
          traceId,
          pipelineSlug: e.pipeline_slug || '',
          startedAt: e.ts,
          endedAt: null,
          durationMs: null,
          status: 'running',
          spans: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
        })
      }

      const span: Span = {
        spanId: e.call_id,
        traceId,
        parentSpanId: e.parent_span_id ?? null,
        agentType: e.agent_type || 'unknown',
        model: e.model || '',
        department: e.department || DEPT_MAP[e.agent_type] || 'unknown',
        skillName: e.skill_name ?? null,
        input: e.input || '',
        output: '',
        startedAt: e.ts,
        endedAt: null,
        durationMs: null,
        status: 'running',
        tokenUsage: null,
        description: e.description || '',
      }
      spanMap.set(e.call_id, span)
      traceMap.get(traceId)!.spans.push(span)

    } else if (ev.type === 'agent_end') {
      const e = ev as PipelineEvent & {
        call_id: string; output?: string; is_error?: boolean;
        duration_ms?: number; token_usage?: { input: number; output: number };
      }
      const span = spanMap.get(e.call_id)
      if (span) {
        span.endedAt = e.ts
        span.output = e.output || ''
        span.status = e.is_error ? 'error' : 'success'
        span.durationMs = e.duration_ms ||
          (span.startedAt ? new Date(e.ts).getTime() - new Date(span.startedAt).getTime() : null)
        span.tokenUsage = e.token_usage ?? null

        // Update trace token totals
        const trace = traceMap.get(span.traceId)
        if (trace && e.token_usage) {
          trace.totalInputTokens += e.token_usage.input
          trace.totalOutputTokens += e.token_usage.output
        }
      }
    } else if (ev.type === 'pipeline_end') {
      const e = ev as PipelineEvent & { status: string; duration_ms?: number }
      // Finalize all traces for this pipeline
      for (const trace of traceMap.values()) {
        if (trace.pipelineSlug === ev.pipeline_slug) {
          trace.endedAt = e.ts
          trace.durationMs = e.duration_ms ?? null
          trace.status = e.status === 'completed' ? 'completed' : 'error'
        }
      }
    }
  }

  return Array.from(traceMap.values())
}
