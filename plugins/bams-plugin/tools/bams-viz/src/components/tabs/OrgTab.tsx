'use client'

import { useEffect, useRef, useCallback } from 'react'
import { usePolling } from '@/hooks/usePolling'
import { EmptyState } from '@/components/ui/EmptyState'

interface OrgResponse {
  mermaid: string
}

export function OrgTab() {
  const { data, error, isLoading } = usePolling<OrgResponse>('/api/org', 3000)
  const containerRef = useRef<HTMLDivElement>(null)
  const mermaidRef = useRef<typeof import('mermaid') | null>(null)
  const prevCodeRef = useRef<string>('')

  const renderMermaid = useCallback(async (code: string) => {
    if (!containerRef.current || code === prevCodeRef.current) return
    prevCodeRef.current = code
    if (!mermaidRef.current) {
      mermaidRef.current = await import('mermaid')
      mermaidRef.current.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict',
        flowchart: {
          useMaxWidth: false,
          nodeSpacing: 80,
          rankSpacing: 100,
          padding: 40,
          htmlLabels: true,
        },
      })
    }
    try {
      const id = `org-${Date.now()}`
      const { svg } = await mermaidRef.current.default.render(id, code)
      containerRef.current.innerHTML = svg
    } catch (err) {
      console.error('Mermaid org render error:', err)
      if (containerRef.current) {
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        containerRef.current.innerHTML = `<pre style="color:var(--status-fail);padding:20px;white-space:pre-wrap">${escaped}</pre>`
      }
    }
  }, [])

  useEffect(() => {
    if (data?.mermaid) {
      renderMermaid(data.mermaid)
    }
  }, [data?.mermaid, renderMermaid])

  if (isLoading) {
    return <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading org chart...</div>
  }
  if (error) {
    return <div style={{ padding: '20px', color: 'var(--status-fail)' }}>Error loading org chart: {error.message}</div>
  }
  if (!data?.mermaid) {
    return <EmptyState icon="🏢" title="No org data" description="Organization chart data is not available yet" />
  }

  return (
    <div style={{ padding: '20px', overflow: 'auto', height: '100%' }}>
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '24px',
        boxShadow: '0 2px 8px var(--shadow)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <span style={{ fontSize: '16px' }}>🏢</span>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>Organization Chart</span>
        </div>
        <div
          ref={containerRef}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            minWidth: '800px',
            minHeight: '1200px',
          }}
        />
      </div>
    </div>
  )
}
