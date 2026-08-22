import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { translate } from '../i18n'
import type { PortalWorker } from '../types'
import { constellationLayout, WorkerConstellation } from './WorkerConstellation'

const worker = (agentId: string, nodeType: 'desktop' | 'server', status: PortalWorker['status']): PortalWorker => ({
  ownerUserId: `usr_${agentId.slice(-16)}`,
  agentId,
  displayName: nodeType === 'desktop' ? 'Structure Mac' : 'GPU Server',
  nodeType,
  os: { family: nodeType === 'desktop' ? 'macos' : 'linux', architecture: 'arm64' },
  runtimeIds: ['codex-runtime'], capabilityIds: ['protein.structure'], gpu: [], status,
  lastSeenAt: '2026-08-22T14:00:00.000Z', profileExpiresAt: '2026-08-22T20:00:00.000Z', revision: 1
})

const workers = [worker('agt_aaaaaaaaaaaaaaaa', 'desktop', 'online'), worker('agt_bbbbbbbbbbbbbbbb', 'server', 'busy')]

describe('Worker Constellation', () => {
  it('keeps Desktop and Server nodes in distinct fields with deterministic positions', () => {
    const first = constellationLayout(workers, [])
    expect(first).toEqual(constellationLayout(workers, []))
    expect(first[0]!.x).toBeLessThan(first[1]!.x)
  })

  it('renders keyboard-focusable nodes with textual status and no WebGL canvas', () => {
    const t = (key: Parameters<typeof translate>[1]): string => translate('en', key)
    const markup = renderToStaticMarkup(<WorkerConstellation workers={workers} selectedId={workers[0]!.agentId} capabilityFilter={null} locale="en" t={t} onSelect={() => undefined} />)
    expect(markup).toContain('role="button"')
    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('Online')
    expect(markup).toContain('Busy')
    expect(markup).not.toContain('<canvas')
  })
})
