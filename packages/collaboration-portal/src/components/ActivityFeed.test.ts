import { describe, expect, it } from 'vitest'
import type { CoordinationView } from '../types'
import { activityItems } from './ActivityFeed'

describe('activity projection', () => {
  it('keeps system events chronological and does not synthesize chat messages', () => {
    const view = { tasks: [{ taskId: 'tsk_a', title: 'Task', objective: 'Objective', status: 'running', updatedAt: '2026-08-22T12:00:00Z' }], records: [{ projectRecordId: 'rec_a', kind: 'decision', body: 'Decision', status: 'accepted', updatedAt: '2026-08-22T13:00:00Z' }], humanRequests: [{ humanRequestId: 'hrq_a', requiredAssurance: 'strong', status: 'pending', updatedAt: '2026-08-22T14:00:00Z' }] } as unknown as CoordinationView
    const items = activityItems(view)
    expect(items.map((item) => item.kind)).toEqual(['human', 'record', 'task'])
    expect(items.some((item) => item.kind === ('chat' as never))).toBe(false)
  })

  it('derives an expired HumanNeeded state from the current clock without waiting for a database revision', () => {
    const view = { tasks: [], records: [], humanRequests: [{ humanRequestId: 'hrq_clock', requiredAssurance: 'basic', status: 'pending', expiresAt: '2026-08-23T10:00:00Z', updatedAt: '2026-08-23T09:00:00Z' }] } as unknown as CoordinationView
    expect(activityItems(view, Date.parse('2026-08-23T09:59:59Z'))[0]?.status).toBe('pending')
    expect(activityItems(view, Date.parse('2026-08-23T10:00:00Z'))[0]?.status).toBe('expired')
  })
})
