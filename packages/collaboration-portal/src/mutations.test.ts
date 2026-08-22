import { describe, expect, it, vi } from 'vitest'
import { createPortalClient } from './client'
import { buildCreateProject } from './commands'
import { createPortalMutationRunner } from './mutations'

const budget = { maxTasks: 200, maxTasksPerRound: 16, maxCoordinationRounds: 50, maxTaskRetries: 3 }
const project = {
  schemaVersion: 1,
  type: 'project',
  projectId: 'prj_aaaaaaaaaaaaaaaa',
  ownerUserId: 'usr_aaaaaaaaaaaaaaaa',
  displayName: 'Protein atlas',
  goal: 'Compare structures.',
  memberUserIds: ['usr_aaaaaaaaaaaaaaaa', 'usr_bbbbbbbbbbbbbbbb'],
  coordinatorAgentId: 'agt_aaaaaaaaaaaaaaaa',
  status: 'active',
  budget,
  revision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z'
}

describe('Portal mutation controller', () => {
  it('reuses one idempotency key after a commit with a lost response, producing one server operation', async () => {
    const committed = new Set<string>()
    let commitCount = 0
    let proteinAtlasCommitCount = 0
    const observedKeys: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const key = (init?.headers as Record<string, string>)['idempotency-key']
      if (!key) throw new TypeError('missing idempotency key')
      const body = JSON.parse(String(init?.body)) as { displayName: string }
      observedKeys.push(key)
      if (!committed.has(key)) {
        committed.add(key)
        commitCount += 1
        if (body.displayName === 'Protein atlas') {
          proteinAtlasCommitCount += 1
          throw new TypeError('connection reset after commit')
        }
      }
      return new Response(JSON.stringify(project), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const runner = createPortalMutationRunner(createPortalClient({ fetch, origin: 'https://cloud-test.sciforge.cn' }))
    const input = {
      ownerUserId: 'usr_aaaaaaaaaaaaaaaa',
      displayName: 'Protein atlas',
      goal: 'Compare structures.',
      memberUserIds: ['usr_bbbbbbbbbbbbbbbb'],
      coordinatorAgentId: 'agt_aaaaaaaaaaaaaaaa',
      budget
    }

    await expect(runner.run(buildCreateProject(input, { idFactory: (prefix) => `${prefix}_aaaaaaaaaaaaaaaa` }), 'csrf-session-bound')).rejects.toThrow(/response arrived/u)
    await runner.run(buildCreateProject({ ...input, displayName: 'Genomics atlas' }, { idFactory: (prefix) => `${prefix}_cccccccccccccccc` }), 'csrf-session-bound')
    const result = await runner.run(buildCreateProject(input, { idFactory: (prefix) => `${prefix}_bbbbbbbbbbbbbbbb` }), 'csrf-session-bound')

    expect(result).toMatchObject({ projectId: project.projectId })
    expect(observedKeys).toEqual(['idem_aaaaaaaaaaaaaaaa', 'idem_cccccccccccccccc', 'idem_aaaaaaaaaaaaaaaa'])
    expect(commitCount).toBe(2)
    expect(proteinAtlasCommitCount).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0]).toEqual(bodies[2])
    expect(bodies[0]).not.toHaveProperty('protocolVersion')
    expect(bodies[0]).not.toHaveProperty('requestId')
    expect(bodies[0]).not.toHaveProperty('type')
    expect(bodies[0]).not.toHaveProperty('ownerUserId')
  })

  it('never evicts an unresolved mutation when the ambiguity budget is full', async () => {
    const observedKeys: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const key = (init?.headers as Record<string, string>)['idempotency-key']
      if (!key) throw new TypeError('missing idempotency key')
      observedKeys.push(key)
      throw new TypeError('connection reset after commit')
    })
    const runner = createPortalMutationRunner(createPortalClient({ fetch, origin: 'https://cloud-test.sciforge.cn' }))
    const input = {
      ownerUserId: 'usr_aaaaaaaaaaaaaaaa',
      displayName: 'Project 0',
      goal: 'Compare structures.',
      memberUserIds: ['usr_bbbbbbbbbbbbbbbb'],
      coordinatorAgentId: 'agt_aaaaaaaaaaaaaaaa',
      budget
    }
    for (let index = 0; index < 32; index += 1) {
      const suffix = index.toString(16).padStart(16, '0')
      const command = buildCreateProject({ ...input, displayName: `Project ${index}` }, {
        idFactory: (prefix) => `${prefix}_${suffix}`
      })
      await expect(runner.run(command, 'csrf-session-bound')).rejects.toThrow(/response arrived/u)
    }
    const overflow = buildCreateProject({ ...input, displayName: 'Project overflow' }, {
      idFactory: (prefix) => `${prefix}_ffffffffffffffff`
    })
    await expect(runner.run(overflow, 'csrf-session-bound')).rejects.toThrow(/Too many unresolved/u)
    expect(fetch).toHaveBeenCalledTimes(32)

    const retryFirst = buildCreateProject(input, {
      idFactory: (prefix) => `${prefix}_eeeeeeeeeeeeeeee`
    })
    await expect(runner.run(retryFirst, 'csrf-session-bound')).rejects.toThrow(/response arrived/u)
    expect(observedKeys.at(-1)).toBe('idem_0000000000000000')
    expect(fetch).toHaveBeenCalledTimes(33)
  })
})
