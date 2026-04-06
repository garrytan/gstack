'use client'

import { AppHeader } from '@/components/shared/AppHeader'
import { WorkCardGrid } from '@/components/landing/WorkCardGrid'

export default function Home() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      background: 'var(--bg-secondary)',
    }}>
      <AppHeader />
      <main style={{
        padding: '24px',
        maxWidth: '1200px',
        margin: '0 auto',
        width: '100%',
      }}>
        <h2 style={{
          fontSize: '16px',
          fontWeight: 700,
          color: 'var(--text-primary)',
          marginBottom: '16px',
        }}>
          Work Units
        </h2>
        <WorkCardGrid />
      </main>
    </div>
  )
}
