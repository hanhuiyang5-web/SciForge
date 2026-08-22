import { describe, expect, it } from 'vitest'
import { canMutateProject, canOpenCoordinationView } from './permissions'
import type { CoordinationView } from './types'

describe('Portal user permission affordances', () => {
  it('lists member Projects without opening the Owner-only coordination view', () => {
    expect(canOpenCoordinationView({ role: 'owner' })).toBe(true)
    expect(canOpenCoordinationView({ role: 'member' })).toBe(false)
    expect(canOpenCoordinationView({ role: 'observer' })).toBe(false)
  })

  it('shows Project mutations only to the canonical owner', () => {
    const view = { project: { ownerUserId: 'usr_owner00000001' } } as CoordinationView
    expect(canMutateProject(view, 'usr_owner00000001')).toBe(true)
    expect(canMutateProject(view, 'usr_member0000001')).toBe(false)
  })
})
