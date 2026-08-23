import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TEST_IDS,
  chineseProviderLocatorFixture
} from '@sciforge/collaboration-contracts/testing'
import {
  COLLABORATION_CAPABILITY_IDS,
  collaborationConnectionViewSchema,
  collaborationParticipantViewSchema,
  type CollaborationProjectionView,
  type CollaborationStatusSnapshot
} from './contract.js'
import {
  createCollaborationCapabilityFactory,
  type CollaborationCapabilityOptions
} from './main.js'
import type { CollaborationRuntime } from './main/runtime.js'

test('global collaboration mutations satisfy the production broker contract without claiming a resource change', async () => {
  const connection = collaborationConnectionViewSchema.parse({
    configured: true,
    baseUrl: 'https://collaboration.example.test',
    state: 'disconnected',
    lastInboxSequence: 0,
    pendingOutboxCount: 0
  })
  const participant = collaborationParticipantViewSchema.parse({
    userId: TEST_IDS.userId,
    displayName: 'Researcher',
    status: 'active',
    revision: 1,
    complete: false,
    endpoints: [],
    agents: []
  })
  const projection: CollaborationProjectionView = {
    projectionId: TEST_IDS.projectionId,
    ownerUserId: TEST_IDS.userId,
    agentId: TEST_IDS.agentId,
    agentOwnerUserId: TEST_IDS.userId,
    humanEndpointId: TEST_IDS.humanEndpointId,
    runtimeId: 'codex',
    threadId: 'fixed-thread',
    displayName: 'Session',
    status: 'active',
    allowUserIds: [TEST_IDS.userId],
    revision: 1,
    queueDepth: 0
  }
  const status: CollaborationStatusSnapshot = {
    revision: 1,
    connection,
        providerOptions: [],
        managedContainers: [],
    participant,
    projections: [projection],
    projects: [],
    queue: [],
    diagnostics: []
  }
  const project = {
    projectId: 'project-1',
    ownerUserId: TEST_IDS.userId,
    name: 'Research Project',
    goal: 'Complete the delegated task.',
    state: 'active' as const,
    revision: 1,
    coordinatorAgentId: TEST_IDS.agentId,
    memberUserIds: [TEST_IDS.userId],
    tasks: []
  }
  const task = {
    taskId: 'task-1',
    projectId: project.projectId,
    executionId: 'execution-1',
    assigneeAgentId: TEST_IDS.agentId,
    assigneeUserId: TEST_IDS.userId,
    revision: 1,
    title: 'Task',
    objective: 'Return a concise result.',
    completionCriteria: [{ criterionId: 'criterion-1', text: 'Result returned.' }],
    state: 'offered' as const,
    updatedAt: '2026-08-15T09:00:00.000Z'
  }
  const contentSpaceBinding = {
    schemaVersion: 1 as const,
    type: 'project_content_space_binding' as const,
    projectId: 'prj_Project000001',
    rootResourceRefId: 'rrf_ContentRoot01',
    status: 'active' as const,
    revision: 1,
    createdAt: '2026-08-15T09:00:00.000Z',
    updatedAt: '2026-08-15T09:00:00.000Z'
  }
  const runtime = {
    changeConnection: async () => connection,
    startChallenge: async () => ({
      challengeId: TEST_IDS.challengeId,
      pairingCode: `sciforge-pair ${TEST_IDS.challengeId} challenge123`,
      expiresAt: '2026-08-15T09:00:00.000Z',
      instruction: 'Send the command.'
    }),
    registerAgent: async () => ({
      agentId: TEST_IDS.agentId,
      ownerUserId: TEST_IDS.userId,
      displayName: 'Desktop',
      nodeType: 'desktop',
      status: 'offline',
      capabilities: [],
      primary: false
    }),
    selectPrimaryAgent: async () => participant,
    linkProjection: async () => projection,
    updateProjection: async () => projection,
    shareProjection: async () => projection,
    retrySynchronization: async () => undefined,
    createProject: async () => project,
    bindProjectContentSpace: async () => contentSpaceBinding,
    createTask: async () => task,
    manageContainer: async () => ({ managedContainer: null }),
    status: async () => status
  } as unknown as CollaborationRuntime
  const definitions = createCollaborationCapabilityFactory<CollaborationCapabilityOptions>({
    defineCapability: (definition) => definition,
    getRuntime: () => runtime
  }).createDefinitions()
  const inputs: Readonly<Record<string, unknown>> = {
    [COLLABORATION_CAPABILITY_IDS.connectionConnect]: { action: 'connect' },
    [COLLABORATION_CAPABILITY_IDS.endpointChallengeStart]: {
      providerKey: 'zulip',
      requestedDisplayName: 'Researcher',
      locator: { realmId: 'research-lab' }
    },
    [COLLABORATION_CAPABILITY_IDS.agentRegister]: {
      displayName: 'Desktop',
      nodeType: 'desktop',
      capabilities: []
    },
    [COLLABORATION_CAPABILITY_IDS.primaryAgentSelect]: {
      agentId: TEST_IDS.agentId,
      expectedParticipantRevision: 1
    },
    [COLLABORATION_CAPABILITY_IDS.projectionLink]: {
      mode: 'existing',
      agentId: TEST_IDS.agentId,
      humanEndpointId: TEST_IDS.humanEndpointId,
      locator: chineseProviderLocatorFixture,
      runtimeId: 'codex',
      threadId: 'fixed-thread',
      displayName: 'Session'
    },
    [COLLABORATION_CAPABILITY_IDS.projectionUpdate]: {
      action: 'pause',
      projectionId: TEST_IDS.projectionId,
      expectedRevision: 1
    },
    [COLLABORATION_CAPABILITY_IDS.projectionShare]: {
      projectionId: TEST_IDS.projectionId,
      allowUserIds: [TEST_IDS.userId],
      expectedRevision: 1
    },
    [COLLABORATION_CAPABILITY_IDS.synchronizationRetry]: { scope: 'connection' },
    [COLLABORATION_CAPABILITY_IDS.projectCreate]: {
      displayName: project.name,
      goal: project.goal,
      memberUserIds: [TEST_IDS.userId],
      coordinatorAgentId: TEST_IDS.agentId
    },
    [COLLABORATION_CAPABILITY_IDS.projectContentSpaceBind]: {
      projectId: contentSpaceBinding.projectId,
      rootResourceRefId: contentSpaceBinding.rootResourceRefId
    },
    [COLLABORATION_CAPABILITY_IDS.taskCreate]: {
      projectId: project.projectId,
      assigneeAgentId: TEST_IDS.agentId,
      title: task.title,
      objective: task.objective,
      completionCriteria: ['Result returned.']
    },
    [COLLABORATION_CAPABILITY_IDS.managedContainerInspect]: { action: 'refresh-status' },
    [COLLABORATION_CAPABILITY_IDS.managedContainerProvision]: {
      action: 'ensure', humanEndpointId: TEST_IDS.humanEndpointId
    },
    [COLLABORATION_CAPABILITY_IDS.managedContainerArchive]: {
      action: 'archive', managedContainerId: 'mco_123456789012', expectedRevision: 1
    }
  }
  const mutations = definitions.filter((definition) => definition.effect === 'external-write')

  assert.equal(mutations.length, 12)
  for (const definition of mutations) {
    assert.equal(definition.scope, 'global')
    assert.equal(Object.hasOwn(inputs, definition.id), true, `missing input fixture for ${definition.id}`)
    const result = await definition.handler(inputs[definition.id])
    assert.notEqual(result.changed, true, `${definition.id} must not claim an app resource change`)
    assert.equal(
      definition.outputSchema.safeParse(result.output).success,
      true,
      `${definition.id} must still return its valid UI result`
    )
  }
  assert.equal(definitions.find(({ id }) => (
    id === COLLABORATION_CAPABILITY_IDS.managedContainerInspect
  ))?.effect, 'read')
  assert.equal(definitions.find(({ id }) => (
    id === COLLABORATION_CAPABILITY_IDS.managedContainerArchive
  ))?.effect, 'destructive')
})
