import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DomainRendererCapabilityContract,
  DomainRendererCapabilityInvoker
} from '@sciforge/domain-sdk/host'

import {
  COLLABORATION_CAPABILITY_IDS,
  collaborationEndpointChallengePollInputSchema,
  collaborationEndpointChallengePollResultSchema,
  collaborationProjectionShareInputSchema,
  collaborationProjectionShareResultSchema,
  collaborationProjectContentSpaceBindInputSchema,
  collaborationProjectContentSpaceBindResultSchema,
  collaborationStatusReadInputSchema,
  collaborationStatusReadResultSchema
} from '../contract.js'
import {
  collaborationRendererContracts,
  createCollaborationRendererClient
} from './collaboration-capability-client.js'

test('renderer client invokes only typed public collaboration capabilities', async () => {
  const calls: Array<Readonly<{
    actionId: string
    effect: string
    input: unknown
    options: unknown
  }>> = []
  const invoker: DomainRendererCapabilityInvoker = {
    observe: async () => {
      throw new Error('not observed')
    },
    invoke: async <TInput, TOutput>(
      contract: DomainRendererCapabilityContract<TInput, TOutput>,
      input: TInput,
      options?: unknown
    ): Promise<TOutput> => {
      calls.push({
        actionId: contract.actionId,
        effect: contract.effect,
        input,
        options
      })
      if (contract.actionId === COLLABORATION_CAPABILITY_IDS.statusRead) {
        return statusSnapshot() as TOutput
      }
      if (contract.actionId === COLLABORATION_CAPABILITY_IDS.endpointChallengePoll) {
        return {
          status: 'pending',
          expiresAt: '2026-08-15T04:05:00.000Z',
          retryAfterSeconds: 3
        } as TOutput
      }
      if (contract.actionId === COLLABORATION_CAPABILITY_IDS.projectionShare) {
        return { projection: projection() } as TOutput
      }
      if (contract.actionId === COLLABORATION_CAPABILITY_IDS.projectContentSpaceBind) {
        return { binding: contentSpaceBinding() } as TOutput
      }
      throw new Error(`Unexpected capability ${contract.actionId}`)
    }
  }
  const client = createCollaborationRendererClient(invoker)
  const ephemeralPollHandle = `ephemeral-${Date.now()}`

  await client.readStatus()
  await client.pollEndpointChallenge({ challengeId: ephemeralPollHandle })
  await client.shareProjection({
    projectionId: 'projection-1',
    allowUserIds: ['user-2'],
    expectedRevision: 2
  })
  await client.bindProjectContentSpace({
    projectId: 'prj_Project000001',
    rootResourceRefId: 'rrf_Root000000001'
  })

  assert.deepEqual(calls.map((call) => call.actionId === COLLABORATION_CAPABILITY_IDS.endpointChallengePoll
    ? { ...call, input: Object.keys(call.input as object) }
    : call), [
    {
      actionId: COLLABORATION_CAPABILITY_IDS.statusRead,
      effect: 'read',
      input: {},
      options: undefined
    },
    {
      actionId: COLLABORATION_CAPABILITY_IDS.endpointChallengePoll,
      effect: 'read',
      input: ['challengeId'],
      options: undefined
    },
    {
      actionId: COLLABORATION_CAPABILITY_IDS.projectionShare,
      effect: 'external-write',
      input: {
        projectionId: 'projection-1',
        allowUserIds: ['user-2'],
        expectedRevision: 2
      },
      options: { approval: { mode: 'confirmation' } }
    },
    {
      actionId: COLLABORATION_CAPABILITY_IDS.projectContentSpaceBind,
      effect: 'external-write',
      input: {
        projectId: 'prj_Project000001',
        rootResourceRefId: 'rrf_Root000000001'
      },
      options: { approval: { mode: 'confirmation' } }
    }
  ])
})

test('client contracts reuse the domain strict schemas without a renderer transport contract', () => {
  assert.equal(collaborationRendererContracts.statusRead.inputSchema, collaborationStatusReadInputSchema)
  assert.equal(collaborationRendererContracts.statusRead.outputSchema, collaborationStatusReadResultSchema)
  assert.equal(
    collaborationRendererContracts.endpointChallengePoll.inputSchema,
    collaborationEndpointChallengePollInputSchema
  )
  assert.equal(
    collaborationRendererContracts.endpointChallengePoll.outputSchema,
    collaborationEndpointChallengePollResultSchema
  )
  assert.equal(
    collaborationRendererContracts.projectionShare.inputSchema,
    collaborationProjectionShareInputSchema
  )
  assert.equal(
    collaborationRendererContracts.projectionShare.outputSchema,
    collaborationProjectionShareResultSchema
  )
  assert.equal(
    collaborationRendererContracts.projectContentSpaceBind.inputSchema,
    collaborationProjectContentSpaceBindInputSchema
  )
  assert.equal(
    collaborationRendererContracts.projectContentSpaceBind.outputSchema,
    collaborationProjectContentSpaceBindResultSchema
  )
})

function statusSnapshot() {
  return {
    revision: 1,
    connection: {
      configured: false,
      state: 'unconfigured' as const,
      lastInboxSequence: 0,
      pendingOutboxCount: 0
    },
    providerOptions: [],
    projections: [],
    projects: [],
    queue: [],
    diagnostics: []
  }
}

function projection() {
  return {
    projectionId: 'projection-1',
    ownerUserId: 'user-1',
    agentId: 'agent-1',
    agentOwnerUserId: 'user-1',
    humanEndpointId: 'endpoint-1',
    runtimeId: 'codex',
    threadId: 'thread-1',
    displayName: '手机会话',
    status: 'active' as const,
    allowUserIds: ['user-2'],
    revision: 2,
    queueDepth: 0
  }
}

function contentSpaceBinding() {
  return {
    type: 'project_content_space_binding' as const,
    schemaVersion: 1 as const,
    projectId: 'prj_Project000001',
    rootResourceRefId: 'rrf_Root000000001',
    status: 'active' as const,
    revision: 1,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z'
  }
}
