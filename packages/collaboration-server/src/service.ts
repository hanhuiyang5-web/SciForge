import {
  canTransition,
  computeTaskCreateProposalDigest,
  normalizeTaskCreateProposal,
  providerDirectRecipientSchema,
  resourceRefCreateMetadataSchema,
  type ProviderDirectRecipient,
  type ProviderIdentity,
  type ResourceRefCreateMetadata
} from '@sciforge/collaboration-contracts'

import { actorInboxRecipient, authorize, type AgentActor, type AuthContext, type HumanEndpointActor, type UserActor } from './auth.js'
import { digestSecret, issueSecret, newId, safeAuditMetadata, stableDigest } from './crypto.js'
import { CollaborationServiceError, fail, type CollaborationErrorCode } from './errors.js'
import type {
  InboxRecipient,
  ProviderLocatorValue,
  ProjectBudgets,
  ProjectCapabilityDirectoryView,
  ProjectListPageView,
  ProjectRecordKind,
  StoredActionConfirmation,
  StoredAgent,
  StoredAgentCapabilityProfile,
  StoredAuditEvent,
  StoredDevice,
  StoredEndpoint,
  StoredInboxMessage,
  StoredManagedContainer,
  StoredManagedContainerJob,
  StoredParticipant,
  StoredProjection,
  StoredProject,
  StoredProjectContentSpaceBinding,
  StoredProjectEndpointBinding,
  StoredProjectInput,
  StoredProjectMember,
  StoredProjectRecord,
  StoredResourceRef,
  StoredReceipt,
  StoredTask,
  StoredUser,
  StoredHumanRequest,
  StoredHumanAnswer,
  StoredConfirmableAction,
  StoredWorkerRequirement,
  StoredAuthorizationRequirement,
  TaskStatus,
  WorkerDirectoryPageView,
  OwnedAgentListView
} from './model.js'
import type {
  CollaborationReadRepository,
  CollaborationRepository,
  CollaborationTransaction,
  PortalProjectWakeWatermarks,
  ProjectCoordinationMaterializationBytes,
  ProjectCoordinationMaterializationCounts
} from './repository.js'

export type InboxAvailabilityNotifier = {
  notifyInboxAvailable(recipient: InboxRecipient, latestSequence: number): void | Promise<void>
}

export type CollaborationServiceOptions = {
  repository: CollaborationRepository
  notifier?: InboxAvailabilityNotifier
  now?: () => Date
  pairingTtlMs?: number
  inboxRetentionMs?: number
  receiptRetentionMs?: number
  testWorkerDirectoryEnabled?: boolean
}

type CommandResult<T extends Record<string, unknown>> = {
  response: T
  resourceKind?: string
  resourceId?: string
  notifications?: Array<{ recipient: InboxRecipient; sequence: number }>
  receiptResponse?: Record<string, unknown>
  persistReceipt?: boolean
}

type TaskResultInput = {
  summary: string
  criterionEvidence: Array<{
    criterionId: string
    summary: string
    resourceRefIds: string[]
  }>
  resourceRefIds: string[]
  logSummary?: string
}

const DEFAULT_BUDGETS: ProjectBudgets = {
  maxTasks: 100,
  maxTasksPerRound: 20,
  maxTaskRetries: 2,
  maxCoordinationRounds: 20
}

export const MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER = 1_000
export const MAX_PROJECT_RECORDS_PER_PROJECT = 50_000
export const MAX_HUMAN_REQUESTS_PER_PROJECT = 10_000

// The canonical Desktop coordination response intentionally remains a full snapshot.
// Keep its worst-case application-heap footprint small relative to the 768 MiB
// production container: a 4 MiB serialized ceiling plus conservative per-row and
// fixed overhead leaves ample room for PostgreSQL decoding, domain objects, contract
// projection, and concurrent requests. Canonical Desktop reads fail closed above this
// ceiling; User-facing inspection remains available through the independently paged Portal view.
export const MAX_PROJECT_COORDINATION_MATERIALIZED_BYTES = 4 * 1024 * 1024
export const MAX_PROJECT_COORDINATION_MATERIALIZED_ROWS = 8_000
const PROJECT_COORDINATION_MATERIALIZATION_ROW_OVERHEAD_BYTES = 512
const PROJECT_COORDINATION_MATERIALIZATION_FIXED_OVERHEAD_BYTES = 64 * 1024
const MAX_PROJECT_COORDINATION_TASKS = 10_000

// Portal collection pages fetch one extra row to produce independent stable cursors,
// so a 10k-task/50k-record canonical Project is never materialized in the application
// heap. Active membership is protected separately by the canonical 1000-member invariant.
const PORTAL_COORDINATION_LIMITS = Object.freeze({
  activeMembers: 1_000
})
const PORTAL_COORDINATION_PAGE_DEFAULTS = Object.freeze({
  tasks: 50,
  records: 50,
  humanRequests: 25
})
const PORTAL_COORDINATION_PAGE_MAXIMUMS = Object.freeze({
  tasks: 100,
  records: 100,
  humanRequests: 50
})

function portalTaskVersion(watermarks: PortalProjectWakeWatermarks): string {
  return `tasks:${watermarks.taskCount}:${watermarks.taskRevisionSum}`
}

function portalRecordVersion(watermarks: PortalProjectWakeWatermarks): string {
  return `records:${watermarks.recordCount}:${watermarks.recordRevisionSum}`
}

function portalHumanVersion(watermarks: PortalProjectWakeWatermarks): string {
  return `human:${watermarks.humanRequestCount}:${watermarks.humanRequestRevisionSum}`
}

const COORDINATOR_HUMAN_SOURCE_MESSAGE_TYPES = new Set([
  'project.started',
  'project.input.received',
  'task.updated',
  'project_record.submitted',
  'project.endpoint.updated',
  'human.answer.received'
])

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  offered: ['accepted', 'rejected'],
  accepted: ['in_progress', 'rejected'],
  rejected: [],
  in_progress: ['needs_human', 'completed', 'failed'],
  needs_human: ['in_progress', 'failed'],
  completed: [],
  failed: [],
  cancelled: []
}

export class CollaborationService {
  private readonly repository: CollaborationRepository
  private readonly notifier?: InboxAvailabilityNotifier
  private readonly now: () => Date
  private readonly inboxRetentionMs: number
  private readonly receiptRetentionMs: number
  private readonly testWorkerDirectoryEnabled: boolean

  constructor(options: CollaborationServiceOptions) {
    this.repository = options.repository
    this.notifier = options.notifier
    this.now = options.now ?? (() => new Date())
    this.inboxRetentionMs = bounded(options.inboxRetentionMs ?? 30 * 86_400_000, 86_400_000, 90 * 86_400_000)
    this.receiptRetentionMs = bounded(options.receiptRetentionMs ?? 30 * 86_400_000, 86_400_000, 90 * 86_400_000)
    this.testWorkerDirectoryEnabled = options.testWorkerDirectoryEnabled === true
  }

  async beginPairing(input: {
    provider: string
    realmId: string
    requestedDisplayName: string
    idempotencyKey: string
    requestedBy?: UserActor
    expectedProviderUserId?: string
  }): Promise<Record<string, unknown>> {
    void input
    fail('invalid_state_transition',
      'Legacy pairing is disabled; an OIDC User must use the authoritative Zulip binding service.')
  }

  async verifyPairingFromProvider(input: {
    provider: string
    realmId: string
    providerUserId: string
    providerDisplayName?: string
    challengeId?: string
    challengeCode: string
    providerEventId: string
    assurance: 'verified' | 'strong'
  }): Promise<Record<string, unknown>> {
    void input
    fail('permission_denied',
      'Legacy provider pairing verification is disabled; only trusted binding confirmation is accepted.')
  }

  async enqueueProviderCommandResult(input: {
    identity: ProviderIdentity
    providerEventId: string
    result: 'success' | 'invalid_or_expired' | 'identity_conflict'
  }): Promise<Record<string, unknown>> {
    assertText(input.providerEventId, 'providerEventId', 1, 500)
    const recipient = providerDirectRecipientSchema.parse({
      type: 'provider_direct_recipient',
      provider: input.identity.provider,
      realmId: input.identity.realmId,
      providerUserId: input.identity.providerUserId
    })
    const recipientId = providerIdentityInboxId(recipient)
    const actor: AuthContext = {
      kind: 'system',
      actorKey: `provider-command-result:${recipientId}`
    }
    return this.commit(actor, 'provider.command.result',
      `idem_provider_command_${stableDigest(input.providerEventId)}`, {
      recipient,
      result: input.result
    }, async (tx, at) => {
      const message = await this.appendInbox(tx, { kind: 'provider_identity', id: recipientId },
        'provider.command.result.outbound', {
          protocolVersion: '1.0',
          type: 'provider.command.result.outbound',
          recipient,
          result: input.result,
          text: providerCommandResultText(input.result)
        }, at)
      return {
        response: {
          protocolVersion: '1.0',
          type: 'provider.command.result.queued',
          inboxMessageId: message.messageId
        },
        resourceKind: 'provider_identity',
        resourceId: recipientId
      }
    })
  }

  async pullProviderIdentityInbox(input: {
    recipientId: string
    limit: number
  }): Promise<{ messages: StoredInboxMessage[]; ackedSequence: number; nextSequence: number }> {
    assertProviderIdentityInboxId(input.recipientId)
    const recipient: InboxRecipient = { kind: 'provider_identity', id: input.recipientId }
    const limit = integer(input.limit, 'limit', 1, 200)
    const cursor = await this.repository.getInboxCursor(recipient)
    const messages = await this.repository.pullInbox(
      recipient,
      cursor?.ackedSequence ?? 0,
      limit,
      this.timestamp()
    )
    return { messages, ackedSequence: cursor?.ackedSequence ?? 0, nextSequence: cursor?.nextSequence ?? 1 }
  }

  async ackProviderIdentityInboxMessage(input: {
    recipientId: string
    inboxMessageId: string
    sequence: number
  }): Promise<{ ackedSequence: number; nextSequence: number }> {
    assertProviderIdentityInboxId(input.recipientId)
    integer(input.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER)
    const recipient: InboxRecipient = { kind: 'provider_identity', id: input.recipientId }
    const [message] = await this.repository.pullInbox(recipient, input.sequence - 1, 1, this.timestamp())
    if (!message || message.sequence !== input.sequence || message.messageId !== input.inboxMessageId) {
      fail('not_found', 'The provider identity inbox message does not match its recipient and sequence.')
    }
    const actor: AuthContext = { kind: 'system', actorKey: `provider-outbox:${input.recipientId}` }
    const response = await this.commit(actor, 'provider.outbox.ack',
      `ack:${stableDigest(input.inboxMessageId)}`, input, async (tx, at) => {
        const cursor = await tx.ackInbox(recipient, input.sequence, at)
        return {
          response: {
            protocolVersion: '1.0',
            type: 'provider.outbox.acked',
            ackedSequence: cursor.ackedSequence,
            nextSequence: cursor.nextSequence
          },
          resourceKind: 'provider_identity',
          resourceId: input.recipientId
        }
      })
    return { ackedSequence: Number(response.ackedSequence), nextSequence: Number(response.nextSequence) }
  }

  async redeemPairing(input: { pollSecret: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
    void input
    fail('permission_denied', 'Legacy pairing redemption is disabled and cannot issue a User credential.')
  }

  async revokeCurrentCredential(
    actor: AgentActor,
    input: { idempotencyKey: string }
  ): Promise<void> {
    await this.commit(actor, 'credential.revoke_current', input.idempotencyKey, input, async (tx, at) => {
      if (!await tx.revokeCredential(actor.credentialId, at)) {
        fail('credential_revoked', 'The current bearer credential was already revoked.')
      }
      return {
        response: { protocolVersion: '1.0', type: 'credential.revoked' },
        resourceKind: 'credential',
        resourceId: actor.credentialId
      }
    })
  }

  async setUserStatus(actor: AuthContext, input: {
    userId: string
    status: 'active' | 'suspended' | 'revoked'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredUser> {
    if (actor.kind !== 'system' && (actor.kind !== 'user' || actor.userId !== input.userId || actor.assurance !== 'strong')) {
      fail('permission_denied', 'Changing user lifecycle requires system authority or the same strong User actor.')
    }
    return this.commit(actor, 'user.status.set', input.idempotencyKey, input, async (tx, at) => {
      const user = required(await tx.getUserForUpdate(input.userId), 'User')
      expectRevision(user.revision, input.expectedRevision)
      if (!canTransition('user', user.status, input.status)) {
        fail('invalid_state_transition', `User cannot transition from ${user.status} to ${input.status}.`)
      }
      if (input.status !== 'active') await assertNoActiveOwnedAgents(tx, user.userId)
      const updated: StoredUser = { ...user, status: input.status, revision: user.revision + 1, updatedAt: at,
        revokedAt: input.status === 'revoked' ? at : user.revokedAt }
      await tx.updateUser(updated, user.revision)
      if (input.status !== 'active') await tx.revokeCredentials('user', user.userId, at)
      return { response: entityResponse('user.updated', updated), resourceKind: 'user', resourceId: user.userId }
    }).then(responseEntity<StoredUser>)
  }

  async getUser(actor: AuthContext, userId: string): Promise<StoredUser> {
    if (actor.kind === 'system' || actor.userId !== userId) fail('permission_denied', 'A UserPrincipal is private to its user.')
    return required(await this.repository.getUser(userId), 'User')
  }

  async updateUser(actor: UserActor, input: {
    userId: string
    displayName?: string
    status?: 'active' | 'suspended' | 'revoked'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredUser> {
    if (actor.userId !== input.userId) fail('permission_denied', 'A user may only update their own principal.')
    if (input.status && input.status !== 'active' && actor.assurance !== 'strong') {
      fail('assurance_insufficient', 'Suspending or revoking a user requires strong assurance.')
    }
    if (input.displayName) assertText(input.displayName, 'displayName', 1, 200)
    return this.commit(actor, 'user.update', input.idempotencyKey, input, async (tx, at) => {
      const user = required(await (input.status === undefined
        ? tx.getUser(input.userId)
        : tx.getUserForUpdate(input.userId)), 'User')
      expectRevision(user.revision, input.expectedRevision)
      if (user.status === 'revoked') fail('invalid_state_transition', 'A revoked user cannot be updated.')
      if (input.status !== undefined && !canTransition('user', user.status, input.status)) {
        fail('invalid_state_transition', `User cannot transition from ${user.status} to ${input.status}.`)
      }
      const status = input.status ?? user.status
      if (input.status !== undefined && status !== 'active') await assertNoActiveOwnedAgents(tx, user.userId)
      const updated: StoredUser = { ...user, displayName: input.displayName ?? user.displayName, status,
        revokedAt: status === 'revoked' ? at : user.revokedAt, revision: user.revision + 1, updatedAt: at }
      await tx.updateUser(updated, user.revision)
      if (status !== 'active') await tx.revokeCredentials('user', user.userId, at)
      return { response: entityResponse('user.updated', updated), resourceKind: 'user', resourceId: user.userId }
    }).then(responseEntity<StoredUser>)
  }

  async setEndpointStatus(actor: UserActor, input: {
    humanEndpointId: string
    status: 'active' | 'suspended' | 'revoked'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredEndpoint> {
    return this.commit(actor, 'endpoint.status.set', input.idempotencyKey, input, async (tx, at) => {
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Human endpoint')
      if (endpoint.userId !== actor.userId) fail('permission_denied', 'The endpoint belongs to another user.')
      expectRevision(endpoint.revision, input.expectedRevision)
      if (!canTransition('endpoint', endpoint.status, input.status)) {
        fail('invalid_state_transition', `Human endpoint cannot transition from ${endpoint.status} to ${input.status}.`)
      }
      const updated: StoredEndpoint = { ...endpoint, status: input.status, revision: endpoint.revision + 1,
        updatedAt: at, revokedAt: input.status === 'revoked' ? at : endpoint.revokedAt }
      await tx.updateEndpoint(updated, endpoint.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      const participant = await tx.getParticipant(actor.userId)
      if (participant?.primaryHumanEndpointId === endpoint.humanEndpointId && input.status !== 'active') {
        const changed = completeParticipant({ ...participant, primaryHumanEndpointId: undefined,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      if (input.status !== 'active') {
        notifications.push(...await this.pauseEndpointProjections(tx, endpoint, at, 'human_endpoint_inactive'))
        const container = await tx.getManagedContainerForOwner(actor.userId, endpoint.provider, endpoint.realmId)
        if (container?.humanEndpointId === endpoint.humanEndpointId && container.status !== 'archived') {
          await tx.updateManagedContainer({
            ...container,
            status: 'suspended',
            safeErrorCode: 'human_endpoint_inactive',
            revision: container.revision + 1,
            updatedAt: at
          }, container.revision)
        }
      }
      return { response: entityResponse('endpoint.updated', updated), resourceKind: 'human_endpoint',
        resourceId: endpoint.humanEndpointId, notifications }
    }).then(responseEntity<StoredEndpoint>)
  }

  async transferEndpoint(actor: UserActor, input: {
    humanEndpointId: string
    targetUserId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredEndpoint> {
    if (actor.assurance !== 'strong') fail('assurance_insufficient', 'Endpoint transfer requires strong assurance.')
    return this.commit(actor, 'endpoint.transfer', input.idempotencyKey, input, async (tx, at) => {
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Human endpoint')
      if (endpoint.userId !== actor.userId) fail('permission_denied', 'Only the current endpoint owner may transfer it.')
      expectRevision(endpoint.revision, input.expectedRevision)
      const target = required(await tx.getUser(input.targetUserId), 'Target user')
      if (target.status !== 'active') fail('credential_revoked', 'The target user is not active.')
      const updated: StoredEndpoint = { ...endpoint, userId: target.userId, revision: endpoint.revision + 1, updatedAt: at }
      await tx.transferEndpointOwnership({
        humanEndpointId: endpoint.humanEndpointId,
        sourceUserId: endpoint.userId,
        targetUserId: target.userId,
        expectedRevision: endpoint.revision,
        updatedAt: at
      })
      const notifications = await this.pauseEndpointProjections(tx, endpoint, at, 'human_endpoint_transferred')
      const container = await tx.getManagedContainerForOwner(actor.userId, endpoint.provider, endpoint.realmId)
      if (container?.humanEndpointId === endpoint.humanEndpointId) {
        await tx.updateManagedContainer({
          ...container,
          ownerUserId: target.userId,
          revision: container.revision + 1,
          updatedAt: at
        }, container.revision)
      }
      for (const userId of [actor.userId, target.userId]) {
        const participant = await tx.getParticipant(userId)
        if (!participant) continue
        const changed = completeParticipant({ ...participant,
          primaryHumanEndpointId: userId === target.userId
            ? participant.primaryHumanEndpointId ?? endpoint.humanEndpointId
            : participant.primaryHumanEndpointId === endpoint.humanEndpointId ? undefined : participant.primaryHumanEndpointId,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: entityResponse('endpoint.transferred', updated), resourceKind: 'human_endpoint',
        resourceId: endpoint.humanEndpointId, notifications }
    }).then(responseEntity<StoredEndpoint>)
  }

  async registerAgent(actor: UserActor, input: {
    deviceId: string
    displayName: string
    nodeType: string
    capabilities: string[]
    idempotencyKey: string
  }): Promise<{ agent: StoredAgent; deviceCredential?: string; replayed?: boolean }> {
    assertText(input.deviceId, 'deviceId', 8, 300)
    assertText(input.displayName, 'displayName', 1, 200)
    assertText(input.nodeType, 'nodeType', 1, 100)
    const capabilities = uniqueTexts(input.capabilities, 100, 200)
    const deviceCredential = issueSecret('agent')
    return this.commit(actor, 'agent.register', input.idempotencyKey, { ...input, capabilities }, async (tx, at) => {
      const owner = required(await tx.getUserForUpdate(actor.userId), 'User')
      if (owner.status !== 'active') fail('credential_revoked', 'The Agent owner is not active.')
      const device = required(await tx.getDeviceForUpdate(input.deviceId), 'Device')
      if (device.status !== 'active' || device.userId !== actor.userId) {
        fail('permission_denied', 'Agent registration requires an ACTIVE Device owned by the authenticated User.')
      }
      const existing = (await tx.listAgentsForDevice(device.deviceId))
        .find((candidate) => candidate.status === 'active')
      if (existing) {
        if (existing.ownerUserId !== actor.userId || existing.deviceId !== device.deviceId) {
          fail('identity_conflict', 'The Device is associated with another Agent owner.')
        }
        return { response: { protocolVersion: '1.0', type: 'agent.registered', agent: existing, replayed: true },
          resourceKind: 'agent', resourceId: existing.agentId }
      }
      const agent: StoredAgent = {
        agentId: newId('agt'), deviceId: device.deviceId, ownerUserId: actor.userId,
        displayName: input.displayName, nodeType: input.nodeType, capabilities, status: 'active',
        connectionStatus: 'offline', credentialGeneration: 1, revision: 1, updatedAt: at
      }
      await tx.insertAgent(agent)
      await tx.insertCredential({ credentialId: newId('credential'), kind: 'agent_device', subjectUserId: actor.userId,
        subjectAgentId: agent.agentId, tokenDigest: digestSecret(deviceCredential), assurance: 'device', generation: 1, createdAt: at })
      const participant = await tx.getParticipant(actor.userId)
      const changed = completeParticipant({ userId: actor.userId,
        primaryHumanEndpointId: participant?.primaryHumanEndpointId,
        primaryAgentId: participant?.primaryAgentId ?? agent.agentId,
        status: 'incomplete', revision: (participant?.revision ?? 0) + 1, updatedAt: at })
      await tx.upsertParticipant(changed, participant?.revision ?? null)
      return {
        response: { protocolVersion: '1.0', type: 'agent.registered', agent, deviceCredential },
        receiptResponse: { protocolVersion: '1.0', type: 'agent.registered', agent, replayed: true },
        resourceKind: 'agent', resourceId: agent.agentId
      }
    }).then((response) => ({
      agent: response.agent as StoredAgent,
      ...(typeof response.deviceCredential === 'string' ? { deviceCredential: response.deviceCredential } : {}),
      ...(response.replayed === true ? { replayed: true } : {})
    }))
  }

  async heartbeatAgent(actor: AgentActor, input: {
    expectedRevision: number
    connectionStatus?: 'online' | 'offline'
    capabilities?: string[]
    idempotencyKey: string
  }): Promise<StoredAgent> {
    return this.commit(actor, 'agent.heartbeat', input.idempotencyKey, input, async (tx, at) => {
      const initialAgent = required(await tx.getAgent(actor.agentId), 'Agent')
      assertCurrentAgentActor(actor, initialAgent)
      expectRevision(initialAgent.revision, input.expectedRevision)
      const requestedConnectionStatus = input.connectionStatus ?? 'online'
      const lockedProjects = requestedConnectionStatus === 'offline'
        ? await lockProjectsForUpdate(tx, await activeCoordinatorProjectIds(tx, initialAgent.agentId))
        : new Map<string, StoredProject>()
      const agent = required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
      assertCurrentAgentActor(actor, agent)
      expectRevision(agent.revision, input.expectedRevision)
      const activeCoordinatorProjects = requestedConnectionStatus === 'offline'
        ? await tx.listActiveProjectsForCoordinator(agent.agentId)
        : []
      assertProjectLocksCover(lockedProjects, activeCoordinatorProjects.map((project) => project.projectId))
      const capabilities = input.capabilities ? uniqueTexts(input.capabilities, 256, 128) : agent.capabilities
      const updated: StoredAgent = { ...agent, connectionStatus: requestedConnectionStatus, capabilities, lastSeenAt: at,
        revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      if (updated.connectionStatus === 'offline') {
        for (const project of activeCoordinatorProjects) {
          const paused = { ...project, status: 'paused' as const, revision: project.revision + 1, updatedAt: at }
          await tx.updateProject(paused, project.revision)
          const message = await this.appendInbox(tx, { kind: 'user', id: project.ownerUserId },
            'collaboration.important_failure', { protocolVersion: '1.0', type: 'collaboration.important_failure',
              projectId: project.projectId, safeMessage: 'The Coordinator Agent is offline; the Project was paused and requires explicit resume or transfer.' }, at)
          notifications.push({ recipient: message.recipient, sequence: message.sequence })
        }
      }
      return { response: entityResponse('agent.heartbeat.accepted', updated), resourceKind: 'agent',
        resourceId: agent.agentId, notifications }
    }).then(responseEntity<StoredAgent>)
  }

  async rotateAgentCredential(actor: UserActor, input: {
    agentId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<{ agent: StoredAgent; deviceCredential?: string; replayed?: boolean }> {
    const deviceCredential = issueSecret('agent')
    return this.commit(actor, 'agent.credential.rotate', input.idempotencyKey, input, async (tx, at) => {
      const initial = required(await tx.getAgent(input.agentId), 'Agent')
      if (!initial.deviceId) fail('credential_revoked', 'The Agent is not linked to an ACTIVE Device.')
      const device = required(await tx.getDeviceForUpdate(initial.deviceId), 'Device')
      if (device.status !== 'active' || device.userId !== actor.userId) {
        fail('credential_revoked', 'The Agent Device is no longer active.')
      }
      const agent = required(await tx.getAgentForUpdate(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId) fail('permission_denied', 'The Agent belongs to another user.')
      if (agent.deviceId !== device.deviceId) fail('credential_revoked', 'The Agent Device link changed concurrently.')
      expectRevision(agent.revision, input.expectedRevision)
      await tx.revokeCredentials('agent_device', agent.agentId, at)
      const updated: StoredAgent = { ...agent, credentialGeneration: agent.credentialGeneration + 1,
        connectionStatus: 'offline', revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      await tx.insertCredential({ credentialId: newId('credential'), kind: 'agent_device', subjectUserId: actor.userId,
        subjectAgentId: agent.agentId, tokenDigest: digestSecret(deviceCredential), assurance: 'device',
        generation: updated.credentialGeneration, createdAt: at })
      return { response: { protocolVersion: '1.0', type: 'agent.credential_rotated', agent: updated, deviceCredential },
        receiptResponse: { protocolVersion: '1.0', type: 'agent.credential_rotated', agent: updated, replayed: true },
        resourceKind: 'agent', resourceId: agent.agentId }
    }).then((response) => ({ agent: response.agent as StoredAgent,
      ...(typeof response.deviceCredential === 'string' ? { deviceCredential: response.deviceCredential } : {}),
      ...(response.replayed === true ? { replayed: true } : {}) }))
  }

  async revokeAgent(actor: UserActor, input: {
    agentId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredAgent> {
    return this.commit(actor, 'agent.revoke', input.idempotencyKey, input, async (tx, at) => {
      const initialAgent = required(await tx.getAgent(input.agentId), 'Agent')
      if (initialAgent.ownerUserId !== actor.userId) fail('permission_denied', 'The Agent belongs to another user.')
      expectRevision(initialAgent.revision, input.expectedRevision)
      const lockedProjects = await lockProjectsForUpdate(tx, await affectedAgentProjectIds(tx, initialAgent.agentId))
      const agent = required(await tx.getAgentForUpdate(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId) fail('permission_denied', 'The Agent belongs to another user.')
      expectRevision(agent.revision, input.expectedRevision)
      if (!canTransition('agent', agent.status, 'revoked')) {
        fail('invalid_state_transition', `Agent cannot transition from ${agent.status} to revoked.`)
      }
      const [openTasks, activeCoordinatorProjects] = await Promise.all([
        tx.listOpenTasksForAgent(agent.agentId),
        tx.listActiveProjectsForCoordinator(agent.agentId)
      ])
      assertProjectLocksCover(lockedProjects, [
        ...activeCoordinatorProjects.map((project) => project.projectId),
        ...openTasks.map((task) => task.projectId)
      ])
      const updated: StoredAgent = { ...agent, status: 'revoked', connectionStatus: 'offline', revokedAt: at,
        revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      await tx.revokeCredentials('agent_device', agent.agentId, at)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      const ownerMessage = await this.appendInbox(tx, { kind: 'user', id: actor.userId }, 'collaboration.important_failure',
        { protocolVersion: '1.0', type: 'collaboration.important_failure', safeMessage: 'A collaboration Agent was revoked and its pending work requires review.' }, at)
      notifications.push({ recipient: ownerMessage.recipient, sequence: ownerMessage.sequence })
      for (const task of openTasks) {
        const project = required(lockedProjects.get(task.projectId) ?? null, 'Task Project')
        const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated',
          { protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
            revision: task.revision, status: contractTaskStatus(task.status), safeFailureCode: 'assignee_revoked' }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      for (const project of activeCoordinatorProjects) {
        const paused = { ...project, status: 'paused' as const, revision: project.revision + 1, updatedAt: at }
        await tx.updateProject(paused, project.revision)
        const message = await this.appendInbox(tx, { kind: 'user', id: project.ownerUserId },
          'collaboration.important_failure', { protocolVersion: '1.0', type: 'collaboration.important_failure',
            projectId: project.projectId, safeMessage: 'The Coordinator Agent was revoked; the Project was paused and requires explicit transfer.' }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      const participant = await tx.getParticipant(actor.userId)
      if (participant?.primaryAgentId === agent.agentId) {
        const changed = completeParticipant({ ...participant, primaryAgentId: undefined,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: entityResponse('agent.revoked', updated), resourceKind: 'agent', resourceId: agent.agentId, notifications }
    }).then(responseEntity<StoredAgent>)
  }

  async transferAgentOwnership(actor: UserActor, input: {
    agentId: string
    targetUserId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<{ agent: StoredAgent; deviceCredential?: string; replayed?: boolean }> {
    if (actor.assurance !== 'strong') fail('assurance_insufficient', 'Agent ownership transfer requires strong assurance.')
    const deviceCredential = issueSecret('agent')
    return this.commit(actor, 'agent.owner.transfer', input.idempotencyKey, input, async (tx, at) => {
      const initialAgent = required(await tx.getAgent(input.agentId), 'Agent')
      if (initialAgent.ownerUserId !== actor.userId) fail('permission_denied', 'Only the current Agent owner may transfer it.')
      if (initialAgent.deviceId) {
        fail('invalid_state_transition', 'A Device-linked Agent cannot transfer ownership independently of its Device.')
      }
      expectRevision(initialAgent.revision, input.expectedRevision)

      // Every write that can bind this Agent to work follows Project -> User -> Agent -> Task.
      // Lock the currently affected Projects first so a concurrent task assignment
      // cannot pass its membership check while ownership is being transferred.
      const lockedProjects = await lockProjectsForUpdate(tx, await affectedAgentProjectIds(tx, initialAgent.agentId))
      const target = required(await tx.getUserForUpdate(input.targetUserId), 'Target user')
      if (target.status !== 'active') fail('credential_revoked', 'The target user is not active.')
      const agent = required(await tx.getAgentForUpdate(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId) fail('permission_denied', 'Only the current Agent owner may transfer it.')
      expectRevision(agent.revision, input.expectedRevision)

      // Re-query after taking the Agent lock. This closes the window where an
      // assignment committed after the initial Project discovery but before the lock.
      const currentAffectedProjectIds = await affectedAgentProjectIds(tx, agent.agentId)
      assertProjectLocksCover(lockedProjects, currentAffectedProjectIds)
      for (const projectId of currentAffectedProjectIds) {
        const membership = await tx.getProjectMember(projectId, target.userId)
        if (!membership?.active || membership.role === 'observer') {
          fail('permission_denied', 'The target owner must already be an executable member of every active Project assigned to this Agent.')
        }
      }
      await tx.revokeCredentials('agent_device', agent.agentId, at)
      // Capability evidence belongs to the reporting owner. It must not survive
      // an ownership transfer or be re-attributed to the new owner by a FK cascade.
      await tx.deleteAgentCapabilityProfile(agent.agentId)
      const updated: StoredAgent = { ...agent, ownerUserId: target.userId,
        credentialGeneration: agent.credentialGeneration + 1, connectionStatus: 'offline',
        revision: agent.revision + 1, updatedAt: at }
      await tx.updateAgent(updated, agent.revision)
      await tx.insertCredential({ credentialId: newId('credential'), kind: 'agent_device',
        subjectUserId: target.userId, subjectAgentId: agent.agentId, tokenDigest: digestSecret(deviceCredential),
        assurance: 'device', generation: updated.credentialGeneration, createdAt: at })
      for (const userId of [actor.userId, target.userId]) {
        const participant = await tx.getParticipant(userId)
        if (!participant) continue
        const changed = completeParticipant({ ...participant,
          primaryAgentId: userId === target.userId
            ? participant.primaryAgentId ?? agent.agentId
            : participant.primaryAgentId === agent.agentId ? undefined : participant.primaryAgentId,
          revision: participant.revision + 1, updatedAt: at })
        await tx.upsertParticipant(changed, participant.revision)
      }
      return { response: { protocolVersion: '1.0', type: 'agent.owner_transferred', agent: updated, deviceCredential },
        receiptResponse: { protocolVersion: '1.0', type: 'agent.owner_transferred', agent: updated, replayed: true },
        resourceKind: 'agent', resourceId: agent.agentId }
    }).then((response) => ({ agent: response.agent as StoredAgent,
      ...(typeof response.deviceCredential === 'string' ? { deviceCredential: response.deviceCredential } : {}),
      ...(response.replayed === true ? { replayed: true } : {}) }))
  }

  async selectPrimary(actor: UserActor, input: {
    primaryHumanEndpointId?: string | null
    primaryAgentId?: string | null
    expectedRevision: number | null
    idempotencyKey: string
  }): Promise<StoredParticipant> {
    return this.commit(actor, 'participant.primary.select', input.idempotencyKey, input, async (tx, at) => {
      const existing = await tx.getParticipant(actor.userId)
      if ((existing?.revision ?? null) !== input.expectedRevision) {
        fail('revision_conflict', 'The Participant profile revision changed.', { details: { currentRevision: existing?.revision ?? null } })
      }
      const endpointId = input.primaryHumanEndpointId === null ? undefined
        : input.primaryHumanEndpointId ?? existing?.primaryHumanEndpointId
      const agentId = input.primaryAgentId === null ? undefined : input.primaryAgentId ?? existing?.primaryAgentId
      const agentRoute = agentId
        ? await prepareAgentRouteLocks(tx, [{
            agentId,
            label: 'Agent',
            unavailableMessage: 'Primary Agent must have an active owner and linked Device.'
          }])
        : undefined
      if (endpointId) {
        const endpoint = required(await tx.getEndpoint(endpointId), 'Human endpoint')
        if (endpoint.userId !== actor.userId || endpoint.status !== 'active') fail('permission_denied', 'Primary endpoint must be active and owned by the user.')
      }
      if (agentId) {
        const agent = required((await finishAgentRouteLocks(tx, agentRoute!)).get(agentId) ?? null, 'Agent')
        if (agent.ownerUserId !== actor.userId) {
          fail('permission_denied', 'Primary Agent must be active and owned by the user.')
        }
      }
      const participant = completeParticipant({ userId: actor.userId, primaryHumanEndpointId: endpointId,
        primaryAgentId: agentId, status: 'incomplete', revision: (existing?.revision ?? 0) + 1, updatedAt: at })
      await tx.upsertParticipant(participant, existing?.revision ?? null)
      return { response: entityResponse('participant.updated', participant), resourceKind: 'participant', resourceId: actor.userId }
    }).then(responseEntity<StoredParticipant>)
  }

  async getParticipantSnapshot(actor: AuthContext, userId: string): Promise<{
    user: StoredUser
    participant: StoredParticipant
    humanEndpoints: StoredEndpoint[]
    agents: StoredAgent[]
  }> {
    if (actor.kind === 'system' || actor.userId !== userId) fail('permission_denied', 'A Participant snapshot is private to its user.')
    const [user, participant, humanEndpoints, agents] = await Promise.all([
      this.repository.getUser(userId), this.repository.getParticipant(userId),
      this.repository.listEndpointsForUser(userId), this.repository.listAgentsForUser(userId)
    ])
    const resolvedUser = required(user, 'User')
    const projectedAgents = await Promise.all(agents.map(async (agent) => {
      if (await isUsableAgent(this.repository, agent, resolvedUser)) return agent
      return { ...agent, connectionStatus: 'offline' as const }
    }))
    return { user: resolvedUser, participant: required(participant, 'Participant'), humanEndpoints, agents: projectedAgents }
  }

  async createProjection(actor: UserActor, input: {
    agentId: string
    humanEndpointId: string
    locator: ProviderLocatorValue
    displayName: string
    allowedSenderUserIds: string[]
    idempotencyKey: string
  }): Promise<StoredProjection> {
    assertText(input.displayName, 'displayName', 1, 200)
    const allowed = [...new Set([actor.userId, ...input.allowedSenderUserIds])]
    if (allowed.length > 100) fail('validation_failed', 'A shared Session may allow at most 100 users.')
    if (allowed.length !== 1) {
      fail('permission_denied', 'A personal managed Channel projection may only authorize its owner.')
    }
    return this.commit(actor, 'projection.create', input.idempotencyKey, { ...input, allowedSenderUserIds: allowed }, async (tx, at) => {
      const agentRoute = await prepareAgentRouteLocks(tx, [{
        agentId: input.agentId,
        label: 'Projection Agent',
        unavailableMessage: 'Projection Agent must have an active owner and linked Device.'
      }])
      await lockProviderLocator(tx, input.locator)
      const agent = required((await finishAgentRouteLocks(tx, agentRoute)).get(input.agentId) ?? null, 'Projection Agent')
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Projection endpoint')
      if (agent.ownerUserId !== actor.userId) {
        fail('permission_denied', 'Projection Agent must be active and owned by the user.')
      }
      if (endpoint.userId !== actor.userId || endpoint.status !== 'active') fail('permission_denied', 'Projection endpoint must be active and owned by the user.')
      if (endpoint.provider !== input.locator.provider || endpoint.realmId !== input.locator.realmId) {
        fail('validation_failed', 'Projection locator must use the bound endpoint provider and realm.')
      }
      await requireOwnedManagedLocator(tx, actor.userId, endpoint, input.locator)
      for (const userId of allowed) required(await tx.getUser(userId), 'Allowed sender')
      if (await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId, input.locator.containerId, input.locator.topicId)) {
        fail('identity_conflict', 'This provider locator already resolves to a personal Session projection.')
      }
      if (await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId, input.locator.containerId, input.locator.topicId)) {
        fail('identity_conflict', 'This provider locator already resolves to a Project topic.')
      }
      const projection: StoredProjection = { projectionId: newId('rsp'), ownerUserId: actor.userId,
        agentId: agent.agentId, humanEndpointId: endpoint.humanEndpointId, locator: input.locator, locatorRevision: 1,
        displayName: input.displayName, status: 'active', allowedSenderUserIds: allowed,
        revision: 1, createdAt: at, updatedAt: at }
      await tx.insertProjection(projection)
      return { response: entityResponse('projection.created', projection), resourceKind: 'projection', resourceId: projection.projectionId }
    }).then(responseEntity<StoredProjection>)
  }

  async updateProjection(actor: UserActor, input: {
    projectionId: string
    expectedRevision: number
    displayName?: string
    status?: 'active' | 'paused' | 'closed'
    locator?: ProviderLocatorValue
    locatorRevision?: number
    allowedSenderUserIds?: string[]
    idempotencyKey: string
  }): Promise<StoredProjection> {
    return this.commit(actor, 'projection.update', input.idempotencyKey, input, async (tx, at) => {
      const projection = required(await tx.getProjection(input.projectionId), 'Projection')
      if (projection.ownerUserId !== actor.userId) fail('permission_denied', 'Only the projection owner may update it.')
      expectRevision(projection.revision, input.expectedRevision)
      if (
        projection.status === 'closed' &&
        (
          input.status !== 'paused' ||
          input.displayName !== undefined ||
          input.locator !== undefined ||
          input.allowedSenderUserIds !== undefined
        )
      ) {
        fail('invalid_state_transition', 'A closed projection can only be restored to paused before reactivation.')
      }
      if (input.displayName) assertText(input.displayName, 'displayName', 1, 200)
      let locator = projection.locator
      let locatorRevision = projection.locatorRevision
      if (input.locator) {
        await lockProviderLocator(tx, input.locator)
        if (input.locatorRevision !== projection.locatorRevision) fail('revision_conflict', 'The locator revision is stale.')
        const endpoint = required(await tx.getEndpoint(projection.humanEndpointId), 'Projection endpoint')
        if (endpoint.provider !== input.locator.provider || endpoint.realmId !== input.locator.realmId) {
          fail('validation_failed', 'Updated locator must remain in the verified endpoint provider realm.')
        }
        await requireOwnedManagedLocator(tx, actor.userId, endpoint, input.locator)
        const otherProjection = await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)
        if (otherProjection && otherProjection.projectionId !== projection.projectionId) {
          fail('identity_conflict', 'The provider locator belongs to another personal Session projection.')
        }
        if (await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)) {
          fail('identity_conflict', 'The provider locator belongs to a Project topic.')
        }
        locator = input.locator
        locatorRevision += 1
      }
      const allowed = input.allowedSenderUserIds
        ? [...new Set([actor.userId, ...input.allowedSenderUserIds])]
        : projection.allowedSenderUserIds
      if (allowed.length > 100) fail('validation_failed', 'A shared Session may allow at most 100 users.')
      if (allowed.length !== 1) {
        fail('permission_denied', 'A personal managed Channel projection may only authorize its owner.')
      }
      const updated: StoredProjection = { ...projection, locator, locatorRevision,
        displayName: input.displayName ?? projection.displayName, status: input.status ?? projection.status,
        allowedSenderUserIds: allowed, revision: projection.revision + 1, updatedAt: at }
      await tx.updateProjection(updated, projection.revision)
      return { response: entityResponse('projection.updated', updated), resourceKind: 'projection', resourceId: projection.projectionId }
    }).then(responseEntity<StoredProjection>)
  }

  async getProjection(actor: AuthContext, projectionId: string): Promise<StoredProjection> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read a private projection.')
    const projection = required(await this.repository.getProjection(projectionId), 'Projection')
    if (!projection.allowedSenderUserIds.includes(actor.userId)) fail('permission_denied', 'The projection is not shared with this user.')
    return projection
  }

  async listProjections(actor: AuthContext, ownerUserId: string): Promise<StoredProjection[]> {
    if (actor.kind === 'system' || actor.userId !== ownerUserId) fail('permission_denied', 'Only the owner may list private projections.')
    return this.repository.listProjectionsForOwner(ownerUserId)
  }

  async publishProjectionMessage(actor: AgentActor, input: {
    projectionId: string
    projectionRevision: number
    localItemId: string
    localTurnId?: string
    kind: 'user_message' | 'assistant_final' | 'system_status'
    text: string
    occurredAt: string
    idempotencyKey: string
  }): Promise<Record<string, unknown>> {
    assertText(input.text, 'text', 1, 32_000)
    return this.commit(actor, 'projection.message.publish', input.idempotencyKey, input, async (tx, at) => {
      const projection = required(await tx.getProjection(input.projectionId), 'Projection')
      if (projection.agentId !== actor.agentId || projection.ownerUserId !== actor.userId) {
        fail('permission_denied', 'Only the fixed projection Agent may publish this Session message.')
      }
      expectRevision(projection.revision, input.projectionRevision)
      if (projection.status !== 'active') fail('invalid_state_transition', 'Projection messages require an active projection.')
      const payload = { protocolVersion: '1.0', type: 'projection.message.outbound', projectionId: projection.projectionId,
        projectionRevision: projection.revision, locator: projection.locator, localItemId: input.localItemId,
        ...(input.localTurnId ? { localTurnId: input.localTurnId } : {}), kind: input.kind, text: input.text,
        occurredAt: input.occurredAt }
      const message = await this.appendInbox(tx, { kind: 'human_endpoint', id: projection.humanEndpointId },
        'projection.message.outbound', payload, at)
      return { response: { protocolVersion: '1.0', type: 'projection.message.accepted',
        projectionId: projection.projectionId, localItemId: input.localItemId, inboxSequence: message.sequence },
        resourceKind: 'projection', resourceId: projection.projectionId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    })
  }

  async acceptPersonalProviderMessage(actor: HumanEndpointActor, input: {
    locator: ProviderLocatorValue
    providerMessageId: string
    text: string
    occurredAt: string
    providerEventId: string
  }): Promise<Record<string, unknown>> {
    assertText(input.text, 'text', 1, 32_000)
    return this.commit(actor, 'personal.message.receive', `idem_${stableDigest(input.providerEventId)}`, input, async (tx, at) => {
      const projection = await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId,
        input.locator.containerId, input.locator.topicId)
      if (!projection) fail('not_found', 'The provider locator does not uniquely resolve to a personal Session.')
      authorize({ actor, operation: 'personal_message', resourceOwnerUserId: projection.ownerUserId,
        senderAllowedByProjection: projection.allowedSenderUserIds.includes(actor.userId) })
      if (projection.status !== 'active') fail('invalid_state_transition', 'The personal Session projection is not active.')
      const message = await this.appendInbox(tx, { kind: 'agent', id: projection.agentId }, 'personal.message.received', {
        protocolVersion: '1.0', type: 'personal.message.received', projectionId: projection.projectionId,
        projectionRevision: projection.revision, senderUserId: actor.userId, humanEndpointId: actor.humanEndpointId,
        providerMessageId: input.providerMessageId, text: input.text, occurredAt: input.occurredAt
      }, at)
      return { response: { protocolVersion: '1.0', type: 'personal.message.accepted', projectionId: projection.projectionId,
        inboxMessageId: message.messageId, sequence: message.sequence }, resourceKind: 'projection',
        resourceId: projection.projectionId, notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    })
  }

  async applyProviderLocatorChange(input: {
    previousLocator: ProviderLocatorValue
    currentLocator: ProviderLocatorValue
    providerEventId: string
  }): Promise<{ kind: 'personal_projection' | 'project'; resourceId: string }> {
    if (input.previousLocator.provider !== input.currentLocator.provider ||
        input.previousLocator.realmId !== input.currentLocator.realmId ||
        input.previousLocator.topicId !== input.currentLocator.topicId) {
      fail('validation_failed', 'A provider locator change must preserve provider, realm, and stable topic ID.')
    }
    const actor: AuthContext = { kind: 'system',
      actorKey: `provider-locator:${input.currentLocator.provider}:${stableDigest(input.providerEventId)}` }
    return this.commit(actor, 'provider.locator.changed', `idem_${stableDigest(input.providerEventId)}`, input, async (tx, at) => {
      await lockProviderLocators(tx, [input.previousLocator, input.currentLocator])
      const [projection, projectBinding] = await Promise.all([
        tx.getProjectionByLocator(input.previousLocator.provider, input.previousLocator.realmId,
          input.previousLocator.containerId, input.previousLocator.topicId),
        tx.getProjectBindingByLocator(input.previousLocator.provider, input.previousLocator.realmId,
          input.previousLocator.containerId, input.previousLocator.topicId)
      ])
      const [currentProjection, currentProject] = await Promise.all([
        tx.getProjectionByLocator(input.currentLocator.provider, input.currentLocator.realmId,
          input.currentLocator.containerId, input.currentLocator.topicId),
        tx.getProjectBindingByLocator(input.currentLocator.provider, input.currentLocator.realmId,
          input.currentLocator.containerId, input.currentLocator.topicId)
      ])
      if (projection && projectBinding) {
        fail('identity_conflict', 'The previous locator ambiguously resolves to multiple collaboration targets.')
      }
      if (!projection && !projectBinding) {
        if (Boolean(currentProjection) === Boolean(currentProject)) {
          fail(currentProjection ? 'identity_conflict' : 'not_found', currentProjection
            ? 'The current locator ambiguously resolves to multiple collaboration targets.'
            : 'Neither locator resolves to an active collaboration target.')
        }
        const kind = currentProjection ? 'personal_projection' as const : 'project' as const
        const resourceId = currentProjection ? currentProjection.projectionId : currentProject!.projectId
        return { response: { protocolVersion: '1.0', type: 'provider.locator.applied', kind, resourceId },
          resourceKind: currentProjection ? 'projection' : 'project_endpoint_binding',
          resourceId: currentProjection ? currentProjection.projectionId : currentProject!.projectEndpointBindingId }
      }
      if (projection) {
        if (stableDigest(projection.locator) === stableDigest(input.currentLocator)) {
          return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
            kind: 'personal_projection', resourceId: projection.projectionId },
          resourceKind: 'projection', resourceId: projection.projectionId }
        }
        if (stableDigest(projection.locator) !== stableDigest(input.previousLocator)) {
          fail('revision_conflict', 'The stored projection locator no longer matches the confirmed previous locator.')
        }
        if ((currentProjection && currentProjection.projectionId !== projection.projectionId) || currentProject) {
          fail('identity_conflict', 'The new locator already belongs to another collaboration target.')
        }
        if (projection.status === 'closed') fail('invalid_state_transition', 'A closed projection cannot move.')
        const endpoint = required(await tx.getEndpoint(projection.humanEndpointId), 'Projection endpoint')
        await requireOwnedManagedLocator(tx, projection.ownerUserId, endpoint, input.currentLocator)
        const updated: StoredProjection = { ...projection, locator: input.currentLocator,
          locatorRevision: projection.locatorRevision + 1, revision: projection.revision + 1,
          lastErrorCode: undefined, updatedAt: at }
        await tx.updateProjection(updated, projection.revision)
        const message = await this.appendInbox(tx, { kind: 'agent', id: projection.agentId }, 'projection.updated', {
          protocolVersion: '1.0', type: 'projection.updated', projectionId: projection.projectionId,
          revision: updated.revision
        }, at)
        return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
          kind: 'personal_projection', resourceId: projection.projectionId },
        resourceKind: 'projection', resourceId: projection.projectionId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
      }
      const binding = projectBinding!
      if (stableDigest(binding.locator) === stableDigest(input.currentLocator)) {
        return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
          kind: 'project', resourceId: binding.projectId },
        resourceKind: 'project_endpoint_binding', resourceId: binding.projectEndpointBindingId }
      }
      if (stableDigest(binding.locator) !== stableDigest(input.previousLocator)) {
        fail('revision_conflict', 'The stored Project locator no longer matches the confirmed previous locator.')
      }
      if (currentProjection || (currentProject && currentProject.projectEndpointBindingId !== binding.projectEndpointBindingId)) {
        fail('identity_conflict', 'The new locator already belongs to another collaboration target.')
      }
      if (binding.status === 'closed') fail('invalid_state_transition', 'A closed Project endpoint binding cannot move.')
      const updated: StoredProjectEndpointBinding = { ...binding, locator: input.currentLocator,
        locatorRevision: binding.locatorRevision + 1, revision: binding.revision + 1,
        lastErrorCode: undefined, updatedAt: at }
      await tx.upsertProjectEndpointBinding(updated, binding.revision)
      const project = required(await tx.getProject(binding.projectId), 'Project')
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId },
        'project.endpoint.updated', {
          protocolVersion: '1.0', type: 'project.endpoint.updated', projectId: binding.projectId,
          projectEndpointBindingId: binding.projectEndpointBindingId, revision: updated.revision,
          locatorRevision: updated.locatorRevision
        }, at)
      return { response: { protocolVersion: '1.0', type: 'provider.locator.applied',
        kind: 'project', resourceId: binding.projectId },
      resourceKind: 'project_endpoint_binding', resourceId: binding.projectEndpointBindingId,
      notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then((response) => ({ kind: response.kind as 'personal_projection' | 'project', resourceId: String(response.resourceId) }))
  }

  async bindProjectEndpoint(actor: UserActor, input: {
    projectId: string
    locator: ProviderLocatorValue
    expectedRevision: number | null
    idempotencyKey: string
  }): Promise<StoredProjectEndpointBinding> {
    return this.commit(actor, 'project.endpoint.bind', input.idempotencyKey, input, async (tx, at) => {
      await lockProviderLocator(tx, input.locator)
      const project = required(await tx.getProject(input.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      const existing = await tx.getProjectEndpointBinding(project.projectId)
      if ((existing?.revision ?? null) !== input.expectedRevision) fail('revision_conflict', 'The Project endpoint binding revision is stale.')
      if (await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId, input.locator.containerId, input.locator.topicId)) {
        fail('identity_conflict', 'The provider locator belongs to a personal Session projection.')
      }
      const otherProject = await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
        input.locator.containerId, input.locator.topicId)
      if (otherProject && otherProject.projectId !== project.projectId) fail('identity_conflict', 'The provider locator belongs to another Project.')
      const binding: StoredProjectEndpointBinding = existing
        ? { ...existing, locator: input.locator, locatorRevision: existing.locatorRevision + 1,
            status: 'active', lastErrorCode: undefined, revision: existing.revision + 1, updatedAt: at }
        : { projectEndpointBindingId: newId('peb'), projectId: project.projectId, locator: input.locator,
            locatorRevision: 1, status: 'active', revision: 1, createdAt: at, updatedAt: at }
      await tx.upsertProjectEndpointBinding(binding, existing?.revision ?? null)
      return { response: entityResponse('project_endpoint.updated', binding), resourceKind: 'project_endpoint_binding',
        resourceId: binding.projectEndpointBindingId }
    }).then(responseEntity<StoredProjectEndpointBinding>)
  }

  async getProjectEndpointBinding(actor: AuthContext, projectId: string): Promise<StoredProjectEndpointBinding> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project bindings.')
    const member = await this.repository.getProjectMember(projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return required(await this.repository.getProjectEndpointBinding(projectId), 'Project endpoint binding')
  }

  async bindProjectContentSpace(actor: UserActor, input: {
    projectId: string
    rootResourceRefId: string
    expectedProjectRevision: number
    expectedBindingRevision?: number
    idempotencyKey: string
  }): Promise<StoredProjectContentSpaceBinding> {
    return this.commit(actor, 'project.content_space.bind', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      expectRevision(project.revision, input.expectedProjectRevision)
      if (!['active', 'paused'].includes(project.status)) {
        fail('invalid_state_transition', 'A terminal Project cannot bind a Content Space root.')
      }
      const existing = await tx.getProjectContentSpaceBindingForUpdate(project.projectId)
      if ((existing?.revision ?? undefined) !== input.expectedBindingRevision) {
        fail('revision_conflict', 'The Project Content Space binding revision is stale.', {
          retryable: true,
          details: { currentRevision: existing?.revision ?? null }
        })
      }
      if (existing && await tx.countOpenProjectFileTasks(project.projectId) > 0) {
        fail('invalid_state_transition', 'Close every open file Task before changing the Project Content Space binding.')
      }
      // The ResourceRef row is the cross-Project serialization point. Every bind
      // of the same root takes this lock before checking the active unique claim.
      const root = required(await tx.getResourceRefForUpdate(input.rootResourceRefId), 'Content Space root ResourceRef')
      assertProjectContentSpaceRoot(root, project.projectId)
      const rootReferenceDigest = stableDigest(root.portableReference)
      const other = await tx.getActiveProjectContentSpaceBindingByRootReferenceDigest(rootReferenceDigest)
      if (other && other.projectId !== project.projectId) {
        fail('identity_conflict', 'The Content Space root is already active for another Project.')
      }
      const binding: StoredProjectContentSpaceBinding = existing
        ? { ...existing, rootResourceRefId: root.resourceRefId, rootReferenceDigest, status: 'active',
            revision: existing.revision + 1, updatedAt: at }
        : { projectId: project.projectId, rootResourceRefId: root.resourceRefId, rootReferenceDigest, status: 'active',
            revision: 1, createdAt: at, updatedAt: at }
      await tx.upsertProjectContentSpaceBinding(binding, existing?.revision ?? null)
      await tx.updateProject({ ...project, revision: project.revision + 1, updatedAt: at }, project.revision)
      return {
        response: entityResponse('project_content_space_binding.updated', binding),
        resourceKind: 'project_content_space_binding',
        resourceId: binding.projectId
      }
    }).then(responseEntity<StoredProjectContentSpaceBinding>)
  }

  async unbindProjectContentSpace(actor: UserActor, input: {
    projectId: string
    expectedProjectRevision: number
    expectedBindingRevision: number
    idempotencyKey: string
  }): Promise<StoredProjectContentSpaceBinding> {
    return this.commit(actor, 'project.content_space.unbind', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      expectRevision(project.revision, input.expectedProjectRevision)
      const binding = required(
        await tx.getProjectContentSpaceBindingForUpdate(project.projectId),
        'Project Content Space binding'
      )
      expectRevision(binding.revision, input.expectedBindingRevision)
      if (binding.status !== 'active') {
        fail('invalid_state_transition', 'The Project Content Space binding is already closed.')
      }
      if (await tx.countOpenProjectFileTasks(project.projectId) > 0) {
        fail('invalid_state_transition', 'Close every open file Task before closing the Project Content Space binding.')
      }
      const updated: StoredProjectContentSpaceBinding = {
        ...binding,
        status: 'closed',
        revision: binding.revision + 1,
        updatedAt: at
      }
      await tx.upsertProjectContentSpaceBinding(updated, binding.revision)
      await tx.updateProject({ ...project, revision: project.revision + 1, updatedAt: at }, project.revision)
      return {
        response: entityResponse('project_content_space_binding.updated', updated),
        resourceKind: 'project_content_space_binding',
        resourceId: updated.projectId
      }
    }).then(responseEntity<StoredProjectContentSpaceBinding>)
  }

  async getProjectContentSpaceBinding(
    actor: AuthContext,
    projectId: string
  ): Promise<StoredProjectContentSpaceBinding> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project bindings.')
    const member = await this.repository.getProjectMember(projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return required(
      await this.repository.getProjectContentSpaceBinding(projectId),
      'Project Content Space binding'
    )
  }

  async updateProjectEndpointBinding(actor: UserActor, input: {
    projectEndpointBindingId: string
    expectedRevision: number
    locator?: ProviderLocatorValue
    locatorRevision?: number
    status?: 'active' | 'closed'
    idempotencyKey: string
  }): Promise<StoredProjectEndpointBinding> {
    return this.commit(actor, 'project.endpoint.update', input.idempotencyKey, input, async (tx, at) => {
      const binding = required(await tx.getProjectEndpointBindingById(input.projectEndpointBindingId),
        'Project endpoint binding')
      const member = await tx.getProjectMember(binding.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      expectRevision(binding.revision, input.expectedRevision)
      if (binding.status === 'closed' && input.status !== 'closed') {
        fail('invalid_state_transition', 'A closed Project endpoint binding cannot be reopened.')
      }
      let locator = binding.locator
      let locatorRevision = binding.locatorRevision
      if (input.locator) {
        await lockProviderLocator(tx, input.locator)
        if (input.locatorRevision !== binding.locatorRevision) {
          fail('revision_conflict', 'The Project endpoint locator revision is stale.')
        }
        const projection = await tx.getProjectionByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)
        if (projection) fail('identity_conflict', 'The provider locator belongs to a personal Session projection.')
        const otherProject = await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
          input.locator.containerId, input.locator.topicId)
        if (otherProject && otherProject.projectEndpointBindingId !== binding.projectEndpointBindingId) {
          fail('identity_conflict', 'The provider locator belongs to another Project.')
        }
        locator = input.locator
        locatorRevision += 1
      } else if (input.locatorRevision !== undefined) {
        fail('validation_failed', 'locatorRevision is only valid together with a new locator.')
      }
      if (!input.locator && input.status === undefined) fail('validation_failed', 'Project endpoint update has no changes.')
      const updated: StoredProjectEndpointBinding = { ...binding, locator, locatorRevision,
        status: input.status ?? binding.status, lastErrorCode: undefined,
        revision: binding.revision + 1, updatedAt: at }
      await tx.upsertProjectEndpointBinding(updated, binding.revision)
      return { response: entityResponse('project_endpoint.updated', updated), resourceKind: 'project_endpoint_binding',
        resourceId: updated.projectEndpointBindingId }
    }).then(responseEntity<StoredProjectEndpointBinding>)
  }

  async acceptProjectInput(actor: HumanEndpointActor, input: {
    locator?: ProviderLocatorValue
    projectId?: string
    providerMessageId: string
    text: string
    occurredAt: string
    providerEventId?: string
    idempotencyKey?: string
  }): Promise<StoredProjectInput> {
    assertText(input.text, 'text', 1, 32_000)
    if ((input.locator === undefined) === (input.projectId === undefined)) {
      fail('validation_failed', 'Project input requires exactly one locator or Project ID target.')
    }
    const idempotencyKey = input.idempotencyKey ?? `idem_${stableDigest(required(input.providerEventId ?? null, 'Provider event ID'))}`
    return this.commit(actor, 'project.input.create', idempotencyKey, input, async (tx, at) => {
      const binding = input.locator
        ? await tx.getProjectBindingByLocator(input.locator.provider, input.locator.realmId,
            input.locator.containerId, input.locator.topicId)
        : await tx.getProjectEndpointBinding(input.projectId!)
      if (!binding || binding.status !== 'active') fail('not_found', 'The provider locator does not uniquely resolve to an active Project topic.')
      if (input.projectId && binding.projectId !== input.projectId) fail('not_found', 'The active Project endpoint binding does not match this Project.')
      const project = required(await tx.getProject(binding.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_input', projectMember: Boolean(member?.active) })
      const existing = await tx.getProjectInputByProviderMessage(actor.humanEndpointId, input.providerMessageId)
      if (existing) return { response: entityResponse('project_input.created', existing), resourceKind: 'project_input',
        resourceId: existing.projectInputId }
      const projectInput = await tx.insertProjectInput({ projectInputId: newId('pin'), projectId: project.projectId,
        senderUserId: actor.userId, sourceHumanEndpointId: actor.humanEndpointId,
        providerMessageId: input.providerMessageId, text: input.text, status: 'queued', revision: 1,
        occurredAt: input.occurredAt, createdAt: at, updatedAt: at })
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'project.input.received', {
        protocolVersion: '1.0', type: 'project.input.received', projectId: project.projectId,
        projectInputId: projectInput.projectInputId, revision: projectInput.revision
      }, at)
      return { response: entityResponse('project_input.created', projectInput), resourceKind: 'project_input',
        resourceId: projectInput.projectInputId, notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredProjectInput>)
  }

  async createHumanNeeded(actor: AgentActor, input: {
    projectId: string
    source: { kind: 'worker'; taskId: string; executionId: string; expectedTaskRevision: number } |
      { kind: 'coordinator'; sourceInboxMessageId: string }
    targetUserId: string
    requiredAssurance: 'basic' | 'verified' | 'strong'
    prompt: string
    expiresAt: string
    confirmableAction?: StoredConfirmableAction
    idempotencyKey: string
  }): Promise<StoredHumanRequest> {
    assertText(input.prompt, 'prompt', 1, 32_000)
    return this.commit(actor, 'human.needed.create', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
      await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      const member = await tx.getProjectMember(project.projectId, input.targetUserId)
      if (!member?.active) fail('permission_denied', 'HumanNeeded target must be an active Project member.')
      if (project.status !== 'active') fail('invalid_state_transition', 'HumanNeeded requires an active Project.')
      if (new Date(input.expiresAt).getTime() <= new Date(at).getTime()) fail('request_expired', 'HumanNeeded expiry must be in the future.')
      if (await tx.countProjectHumanRequests(project.projectId) >= MAX_HUMAN_REQUESTS_PER_PROJECT) {
        fail('validation_failed', 'A Project may have at most 10000 HumanNeeded requests.')
      }
      const source = input.source
      let task: StoredTask | undefined
      if (source.kind === 'worker') {
        task = required(await tx.getTaskForUpdate(source.taskId), 'Task')
        if (task.projectId !== project.projectId) fail('validation_failed', 'The Task belongs to another Project.')
        await assertCurrentTaskActorMembership(tx, actor, project, task, source.executionId, actingAgent)
        expectRevision(task.revision, source.expectedTaskRevision)
        if (task.status !== 'in_progress' && task.status !== 'needs_human') fail('invalid_state_transition', 'HumanNeeded requires a running Task.')
      } else {
        if (actor.agentId !== project.coordinatorAgentId) {
          fail('coordinator_mismatch', 'Only the current Coordinator Agent may create a Project-level HumanNeeded request.')
        }
        const sourceMessage = await tx.getInboxMessageById(
          { kind: 'agent', id: actor.agentId }, source.sourceInboxMessageId
        )
        if (!sourceMessage || sourceMessage.disposition !== 'active' ||
            !COORDINATOR_HUMAN_SOURCE_MESSAGE_TYPES.has(sourceMessage.messageType) ||
            inboxMessageProjectId(sourceMessage) !== project.projectId) {
          fail('not_found', 'The Coordinator HumanNeeded source is not an active Project coordination Inbox message.')
        }
      }
      if (input.confirmableAction && input.source.kind !== 'coordinator') {
        fail('validation_failed', 'Only a Coordinator request may carry a confirmable action.')
      }
      if (input.confirmableAction) {
        if (input.targetUserId !== project.ownerUserId) {
          fail('permission_denied', 'A governed action must be confirmed by the Project owner.')
        }
        if (input.confirmableAction.projectId !== project.projectId) {
          fail('validation_failed', 'The governed action belongs to another Project.')
        }
        if (input.confirmableAction.kind === 'task.retry_reassign' || input.confirmableAction.kind === 'task.cancel') {
          const governedTask = await tx.getTask(input.confirmableAction.taskId)
          if (!governedTask || governedTask.projectId !== project.projectId) {
            fail('validation_failed', 'The governed Task must belong to the HumanNeeded Project.')
          }
          const governedExecutionId = input.confirmableAction.kind === 'task.retry_reassign'
            ? input.confirmableAction.fromExecutionId
            : input.confirmableAction.executionId
          if (governedTask.executionId !== governedExecutionId) {
            fail('execution_conflict', 'The governed Task execution is no longer current.', {
              details: { currentRevision: governedTask.revision, currentExecutionId: governedTask.executionId }
            })
          }
        }
      }
      const request: StoredHumanRequest = { humanRequestId: newId('hrq'), projectId: project.projectId,
        sourceKind: source.kind,
        ...(task
          ? { taskId: task.taskId, executionId: task.executionId }
          : source.kind === 'coordinator' ? { sourceInboxMessageId: source.sourceInboxMessageId } : {}),
        targetUserId: input.targetUserId, requestedByAgentId: actor.agentId,
        requiredAssurance: input.requiredAssurance, prompt: input.prompt, status: 'pending', revision: 1,
        ...(input.confirmableAction ? { confirmableAction: input.confirmableAction } : {}),
        expiresAt: input.expiresAt, createdAt: at, updatedAt: at }
      await tx.insertHumanRequest(request)
      let taskRevision = task?.revision
      if (task && task.status !== 'needs_human') {
        const updatedTask: StoredTask = { ...task, status: 'needs_human', revision: task.revision + 1, updatedAt: at }
        await tx.updateTask(updatedTask, task.revision)
        taskRevision = updatedTask.revision
      }
      const message = await this.appendInbox(tx, { kind: 'user', id: input.targetUserId }, 'human.needed', {
        protocolVersion: '1.0', type: 'human.needed', request: toHumanNeededEntity(request)
      }, at)
      const notifications = [{ recipient: message.recipient, sequence: message.sequence }]
      if (task) {
        const coordinatorMessage = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated', {
          protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
          executionId: task.executionId, revision: taskRevision, status: 'needs_human', humanRequestId: request.humanRequestId
        }, at)
        notifications.push({ recipient: coordinatorMessage.recipient, sequence: coordinatorMessage.sequence })
      }
      const [participant, binding] = await Promise.all([
        tx.getParticipant(input.targetUserId),
        tx.getProjectEndpointBinding(project.projectId)
      ])
      if (participant?.primaryHumanEndpointId && binding?.status === 'active') {
        const endpoint = await tx.getEndpoint(participant.primaryHumanEndpointId)
        if (endpoint?.status === 'active' && endpoint.userId === input.targetUserId &&
            endpoint.provider === binding.locator.provider && endpoint.realmId === binding.locator.realmId) {
          const providerMessage = await this.appendInbox(tx,
            { kind: 'human_endpoint', id: endpoint.humanEndpointId }, 'provider.notification.outbound', {
              protocolVersion: '1.0', type: 'provider.notification.outbound', locator: binding.locator,
              notificationKind: 'human_needed', text: humanNeededProviderText(request),
              resourceId: request.humanRequestId
            }, at)
          notifications.push({ recipient: providerMessage.recipient, sequence: providerMessage.sequence })
        }
      }
      return { response: entityResponse('human_needed.created', request), resourceKind: 'human_needed',
        resourceId: request.humanRequestId, notifications }
    }).then(responseEntity<StoredHumanRequest>)
  }

  async answerHumanNeeded(actor: HumanEndpointActor, input: {
    humanRequestId: string
    requestRevision: number
    answer: string
    decision?: 'approve' | 'reject'
    sourceLocator?: ProviderLocatorValue
    idempotencyKey: string
  }): Promise<StoredHumanAnswer> {
    assertText(input.answer, 'answer', 1, 32_000)
    const commandAt = this.timestamp()
    const initialRequest = required(
      await this.repository.getHumanRequest(input.humanRequestId),
      'HumanNeeded request'
    )
    authorize({ actor, operation: 'human_answer', targetUserId: initialRequest.targetUserId,
      requiredAssurance: initialRequest.requiredAssurance })
    if (initialRequest.status === 'pending' && initialRequest.expiresAt <= commandAt) {
      // Expiry is authoritative state, not a rejected-answer side effect. Scope the
      // durable transition to the already-authorized request before the rejected
      // command audit transaction so it cannot be rolled back with that rejection.
      await this.repository.transaction((tx) => tx.expireHumanRequestIfPending(
        initialRequest.humanRequestId,
        initialRequest.targetUserId,
        initialRequest.revision,
        commandAt
      ))
    }
    // The explicit atOverride freezes every main-transaction expiry check at
    // command admission, even if lock acquisition crosses the wall-clock expiry.
    return this.commit(actor, 'human.answer', input.idempotencyKey, input, async (tx, at) => {
      const currentRequest = required(await tx.getHumanRequest(input.humanRequestId), 'HumanNeeded request')
      const project = required(await tx.getProjectForUpdate(currentRequest.projectId), 'Project')
      authorize({ actor, operation: 'human_answer', targetUserId: currentRequest.targetUserId,
        requiredAssurance: currentRequest.requiredAssurance })
      if (input.sourceLocator) {
        const [endpoint, binding] = await Promise.all([
          tx.getEndpoint(actor.humanEndpointId),
          tx.getProjectBindingByLocator(input.sourceLocator.provider, input.sourceLocator.realmId,
            input.sourceLocator.containerId, input.sourceLocator.topicId)
        ])
        if (!endpoint || endpoint.status !== 'active' || endpoint.userId !== actor.userId ||
            endpoint.provider !== input.sourceLocator.provider || endpoint.realmId !== input.sourceLocator.realmId ||
            !binding || binding.status !== 'active' || binding.projectId !== currentRequest.projectId) {
          fail('not_found', 'The provider answer does not originate from the active Project endpoint binding.')
        }
      }
      if (currentRequest.status !== 'pending' || currentRequest.expiresAt <= at) {
        fail('request_expired', 'The HumanNeeded request is no longer current.')
      }
      const request = required(await tx.getHumanRequestForUpdate(input.humanRequestId), 'HumanNeeded request')
      if (request.status !== 'pending' || request.expiresAt <= at) fail('request_expired', 'The HumanNeeded request is no longer current.')
      expectRevision(request.revision, input.requestRevision)
      if (request.confirmableAction && input.decision === undefined) {
        fail('validation_failed', 'A governed action answer requires an explicit approve or reject decision.')
      }
      if (!request.confirmableAction && input.decision !== undefined) {
        fail('validation_failed', 'A free-form HumanNeeded answer cannot create an action confirmation.')
      }
      const existing = await tx.getHumanAnswerForRequest(request.humanRequestId)
      if (existing) return { response: entityResponse('human_answer.created', existing), resourceKind: 'human_answer',
        resourceId: existing.humanAnswerId }
      const answer: StoredHumanAnswer = { humanAnswerId: newId('han'), humanRequestId: request.humanRequestId,
        projectId: request.projectId, ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(request.executionId ? { executionId: request.executionId } : {}), requestRevision: request.revision,
        answeredByUserId: actor.userId, answeredFromHumanEndpointId: actor.humanEndpointId,
        assurance: actor.assurance, answer: input.answer, ...(input.decision ? { decision: input.decision } : {}),
        revision: 1, answeredAt: at, createdAt: at, updatedAt: at }
      if (request.confirmableAction && input.decision === 'approve') {
        if (request.requestedByAgentId !== project.coordinatorAgentId) {
          fail('coordinator_mismatch', 'The governed action was requested by a former Coordinator Agent.')
        }
        const confirmationId = newId('cnf')
        const confirmation: StoredActionConfirmation = {
          confirmationId, humanRequestId: request.humanRequestId, projectId: request.projectId,
          targetUserId: request.targetUserId, coordinatorAgentId: request.requestedByAgentId,
          action: request.confirmableAction, actionDigest: stableDigest(request.confirmableAction), status: 'approved',
          approvedAt: at, expiresAt: request.expiresAt, createdAt: at, updatedAt: at
        }
        await tx.insertActionConfirmation(confirmation)
        answer.confirmationId = confirmationId
      }
      await tx.insertHumanAnswer(answer)
      await tx.updateHumanRequest({ ...request, status: 'answered', revision: request.revision + 1, updatedAt: at }, request.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      for (const agentId of new Set([request.requestedByAgentId, project.coordinatorAgentId])) {
        const message = await this.appendInbox(tx, { kind: 'agent', id: agentId }, 'human.answer.received', {
          protocolVersion: '1.0', type: 'human.answer.received', answer: toHumanAnswerEntity(answer)
        }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      return { response: entityResponse('human_answer.created', answer), resourceKind: 'human_answer',
        resourceId: answer.humanAnswerId, notifications }
    }, commandAt).then(responseEntity<StoredHumanAnswer>)
  }

  async createProject(actor: UserActor, input: {
    displayName: string
    goal: string
    memberUserIds: string[]
    coordinatorAgentId: string
    budgets?: Partial<ProjectBudgets>
    idempotencyKey: string
  }): Promise<StoredProject> {
    assertText(input.displayName, 'displayName', 1, 200)
    assertText(input.goal, 'goal', 1, 20_000)
    const memberUserIds = [...new Set([actor.userId, ...input.memberUserIds])]
    if (memberUserIds.length > 1_000) fail('validation_failed', 'A Project may have at most 1000 members.')
    const budgets = normalizeBudgets(input.budgets)
    return this.commit(actor, 'project.create', input.idempotencyKey, { ...input, memberUserIds, budgets }, async (tx, at) => {
      for (const userId of memberUserIds) {
        const user = required(await tx.getUser(userId), 'Project member')
        if (user.status !== 'active' || !await tx.hasActiveOidcIdentityForUser(userId, actor.issuer)) {
          fail('permission_denied', 'Every Project member must be an active User from the same OIDC issuer.')
        }
      }
      await assertActiveProjectMembershipCapacity(tx, memberUserIds)
      const coordinatorRoute = await prepareAgentRouteLocks(tx, [{
        agentId: input.coordinatorAgentId,
        label: 'Coordinator Agent',
        unavailableMessage: 'The Coordinator must have an active owner and linked Device.'
      }])
      // A new Project has no row to lock yet, so the linked Device and then the
      // Coordinator Agent are the serialization points shared with revocation.
      const coordinator = required(
        (await finishAgentRouteLocks(tx, coordinatorRoute)).get(input.coordinatorAgentId) ?? null,
        'Coordinator Agent'
      )
      if (!memberUserIds.includes(coordinator.ownerUserId)) {
        fail('permission_denied', 'Coordinator ownership must resolve to an active Project member.')
      }
      const projectId = newId('prj')
      const project: StoredProject = { projectId, ownerUserId: actor.userId, displayName: input.displayName,
        goal: input.goal, status: 'active',
        coordinatorAgentId: coordinator.agentId, budgets, coordinationRound: 1, revision: 1, createdAt: at, updatedAt: at }
      const members: StoredProjectMember[] = memberUserIds.map((userId) => ({ projectId, userId,
        role: userId === actor.userId ? 'owner' : 'member', active: true, createdAt: at }))
      await tx.insertProject(project, members)
      const message = await this.appendInbox(tx, { kind: 'agent', id: coordinator.agentId }, 'project.started',
        { protocolVersion: '1.0', type: 'project.started', projectId, revision: project.revision }, at)
      return { response: entityResponse('project.created', project), resourceKind: 'project', resourceId: projectId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredProject>)
  }

  async transferCoordinator(actor: UserActor, input: {
    projectId: string
    coordinatorAgentId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.coordinator.transfer', input.idempotencyKey, input, async (tx, at) => {
      const coordinatorRoute = await prepareAgentRouteLocks(tx, [{
        agentId: input.coordinatorAgentId,
        label: 'Coordinator Agent',
        unavailableMessage: 'The new Coordinator must have an active owner and linked Device.'
      }])
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      expectRevision(project.revision, input.expectedRevision)
      if (['completed', 'failed', 'cancelled'].includes(project.status)) {
        fail('invalid_state_transition', 'A terminal Project cannot transfer its Coordinator.')
      }
      const coordinator = required(
        (await finishAgentRouteLocks(tx, coordinatorRoute)).get(input.coordinatorAgentId) ?? null,
        'Coordinator Agent'
      )
      const coordinatorMember = await tx.getProjectMember(project.projectId, coordinator.ownerUserId)
      if (!coordinatorMember?.active) {
        fail('permission_denied', 'The new Coordinator must belong to an active Project member.')
      }
      const oldCoordinatorAgentId = project.coordinatorAgentId
      const updated: StoredProject = { ...project, coordinatorAgentId: coordinator.agentId,
        revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updated, project.revision)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      if (oldCoordinatorAgentId !== coordinator.agentId) {
        for (const request of await tx.listHumanRequestsForProject(project.projectId)) {
          if (request.status === 'pending' && request.sourceKind === 'coordinator' &&
              request.requestedByAgentId === oldCoordinatorAgentId && request.confirmableAction) {
            await tx.updateHumanRequest({ ...request, status: request.expiresAt <= at ? 'expired' : 'cancelled',
              revision: request.revision + 1, updatedAt: at }, request.revision)
          }
        }
        await supersedeApprovedActionConfirmations(tx, project.projectId, at,
          (confirmation) => confirmation.coordinatorAgentId === oldCoordinatorAgentId)
      }
      const superseded = oldCoordinatorAgentId === coordinator.agentId
        ? []
        : await tx.supersedeCoordinatorInbox(project.projectId, oldCoordinatorAgentId, at)
      for (const stale of superseded) {
        const replay = await this.appendInbox(tx, { kind: 'agent', id: coordinator.agentId }, stale.messageType,
          { ...stale.payload, reroutedFromMessageId: stale.messageId }, at)
        notifications.push({ recipient: replay.recipient, sequence: replay.sequence })
      }
      for (const recipient of [
        { kind: 'agent', id: coordinator.agentId } as InboxRecipient,
        { kind: 'agent', id: oldCoordinatorAgentId } as InboxRecipient
      ]) {
        const message = await this.appendInbox(tx, recipient, 'coordinator.transferred',
          { protocolVersion: '1.0', type: 'coordinator.transferred', projectId: project.projectId,
            previousCoordinatorAgentId: oldCoordinatorAgentId, coordinatorAgentId: coordinator.agentId,
            revision: updated.revision }, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      return { response: entityResponse('project.updated', updated), resourceKind: 'project', resourceId: project.projectId, notifications }
    }).then(responseEntity<StoredProject>)
  }

  async transitionProject(actor: UserActor | AgentActor, input: {
    projectId: string
    status: 'active' | 'paused' | 'completed' | 'cancelled'
    expectedRevision: number
    finalRecordDigest?: string
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.transition', input.idempotencyKey, input, async (tx, at) => {
      const initialProject = required(await tx.getProject(input.projectId), 'Project')
      const coordinatorRoute = initialProject.status === 'paused' && input.status === 'active'
        ? await prepareAgentRouteLocks(tx, [{
            agentId: initialProject.coordinatorAgentId,
            label: 'Coordinator Agent',
            unavailableCode: 'credential_revoked',
            unavailableMessage: 'The paused Project Coordinator must have an active owner and linked Device.'
          }])
        : undefined
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      if (actor.kind === 'user') {
        authorize({ actor, operation: 'project_admin', projectRole: member?.role })
      } else {
        if (input.status !== 'completed' || !input.finalRecordDigest || actor.agentId !== project.coordinatorAgentId) {
          fail('confirmation_required', 'An Agent may only execute a confirmed Project completion.')
        }
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'project.complete', projectId: project.projectId, finalRecordDigest: input.finalRecordDigest
        }, project, 'project.complete', at)
      }
      expectRevision(project.revision, input.expectedRevision)
      if (!canTransition('project', project.status, input.status)) {
        fail('invalid_state_transition', `Project cannot transition from ${project.status} to ${input.status}.`)
      }
      if (project.status === 'paused' && input.status === 'active') {
        if (!coordinatorRoute || project.coordinatorAgentId !== initialProject.coordinatorAgentId) {
          fail('revision_conflict', 'The paused Project Coordinator changed while acquiring route locks.', {
            retryable: true,
            details: { currentRevision: project.revision }
          })
        }
        // Resuming restores execution authority. The Device row was locked before
        // the Project, and the Agent is now locked and revalidated against it.
        const coordinator = required(
          (await finishAgentRouteLocks(tx, coordinatorRoute)).get(project.coordinatorAgentId) ?? null,
          'Coordinator Agent'
        )
        if (coordinator.status !== 'active') {
          fail('credential_revoked', 'The paused Project Coordinator Agent is no longer active.')
        }
        const coordinatorMember = await tx.getProjectMember(project.projectId, coordinator.ownerUserId)
        if (!coordinatorMember?.active || coordinatorMember.role === 'observer') {
          fail('permission_denied', 'The paused Project Coordinator owner is not an executable Project member.')
        }
      }
      if (input.status === 'completed' || input.status === 'cancelled') {
        const openTasks = await tx.countOpenProjectTasks(project.projectId)
        if (openTasks > 0) {
          fail('invalid_state_transition', 'Complete or cancel every open Task before closing the Project.')
        }
      }
      const updated: StoredProject = { ...project, status: input.status, revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updated, project.revision)
      if (input.status === 'completed' || input.status === 'cancelled') {
        await invalidateApprovedGovernedActions(tx, project.projectId, at, () => true)
      }
      return { response: entityResponse('project.updated', updated), resourceKind: 'project', resourceId: project.projectId }
    }).then(responseEntity<StoredProject>)
  }

  async createTask(actor: UserActor | AgentActor, input: {
    projectId: string
    assigneeAgentId: string
    title: string
    objective: string
    completionCriteria: Array<string | { criterionId: string; text: string }>
    dependencyTaskIds: string[]
    requiredCapabilities?: StoredWorkerRequirement
    resourceRefIds?: string[]
    fileIntent?: StoredTask['fileIntent']
    authorizationRequirements?: StoredAuthorizationRequirement[]
    expectedProjectRevision: number
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    // Preserve the existing Cloud execution bound even though the public wire
    // schema accepts the protocol-wide non-empty text maximum.
    assertText(input.objective, 'objective', 1, 20_000)
    const proposalInput = {
      projectId: input.projectId,
      assigneeAgentId: input.assigneeAgentId,
      title: input.title,
      objective: input.objective,
      completionCriteria: input.completionCriteria,
      dependencyTaskIds: input.dependencyTaskIds,
      requiredCapabilities: input.requiredCapabilities,
      resourceRefIds: input.resourceRefIds,
      fileIntent: input.fileIntent,
      authorizationRequirements: input.authorizationRequirements
    }
    let proposal: ReturnType<typeof normalizeTaskCreateProposal>
    try {
      proposal = normalizeTaskCreateProposal(proposalInput)
    } catch {
      fail('validation_failed', 'Task proposal fields do not satisfy the public normalization contract.')
    }
    const criterionInputs = proposal.completionCriteria.map((criterion) => ({ ...criterion }))
    const dependencies = [...proposal.dependencyTaskIds]
    const requiredCapabilities = {
      ...proposal.requiredCapabilities,
      ...(proposal.requiredCapabilities.osFamilies
        ? { osFamilies: [...proposal.requiredCapabilities.osFamilies] }
        : {}),
      capabilityIds: [...proposal.requiredCapabilities.capabilityIds],
      vpnAccessIds: [...proposal.requiredCapabilities.vpnAccessIds],
      slurmClusterIds: [...proposal.requiredCapabilities.slurmClusterIds],
      requiredResourceRefIds: [...proposal.requiredCapabilities.requiredResourceRefIds]
    }
    const resourceRefIds = [...proposal.resourceRefIds]
    const fileIntent = proposal.fileIntent
      ? {
          ...proposal.fileIntent,
          inputs: proposal.fileIntent.inputs.map((file) => ({ ...file })),
          output: { ...proposal.fileIntent.output }
        }
      : undefined
    const authorizationRequirements = proposal.authorizationRequirements.map((requirement) => ({ ...requirement }))
    for (const requirement of authorizationRequirements) validateProjectSummary(requirement.description)
    return this.commit(actor, 'task.create', input.idempotencyKey, { ...input, ...proposal,
      completionCriteria: criterionInputs, dependencyTaskIds: dependencies,
      requiredCapabilities, resourceRefIds, authorizationRequirements }, async (tx, at) => {
      const agentRoute = await prepareAgentRouteLocks(tx, [
        {
          agentId: proposal.assigneeAgentId,
          label: 'Assignee Agent',
          unavailableMessage: 'The assignee Agent must have an active owner and linked Device.'
        },
        ...(actor.kind === 'agent_device' ? [{
          agentId: actor.agentId,
          label: 'Coordinator Agent',
          unavailableCode: 'credential_revoked' as const,
          unavailableMessage: 'The authenticated Coordinator Agent must have an active owner and linked Device.'
        }] : [])
      ])
      const project = required(await tx.getProjectForUpdate(proposal.projectId), 'Project')
      if (project.status !== 'active') fail('invalid_state_transition', 'Tasks may only be created for an active Project.')
      const lockedAgents = await finishAgentRouteLocks(tx, agentRoute)
      const assignee = required(lockedAgents.get(proposal.assigneeAgentId) ?? null, 'Assignee Agent')
      const actorMember = await tx.getProjectMember(project.projectId, actor.userId)
      const proposalDigest = computeTaskCreateProposalDigest(proposalInput)
      if (actor.kind === 'user') {
        authorize({ actor, operation: 'task_create', projectRole: actorMember?.role })
      } else {
        if (actor.agentId !== project.coordinatorAgentId) fail('coordinator_mismatch', 'Only the current Coordinator may execute a confirmed Task proposal.')
        await assertCurrentAgentProjectMembership(tx, actor, project,
          required(lockedAgents.get(actor.agentId) ?? null, 'Coordinator Agent'))
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'tasks.create', projectId: project.projectId,
          proposalDigest
        }, project, 'task.create', at)
      }
      expectRevision(project.revision, input.expectedProjectRevision)
      const member = await tx.getProjectMember(project.projectId, assignee.ownerUserId)
      if (!member?.active || member.role === 'observer') {
        fail('permission_denied', 'The assignee Agent owner is not an executable Project member.')
      }
      const profile = await tx.getAgentCapabilityProfile(assignee.agentId)
      if (!profile || profile.ownerUserId !== assignee.ownerUserId || profile.expiresAt <= at) {
        fail('capability_profile_expired', 'The assignee Agent capability profile is missing, stale, or owner-mismatched.')
      }
      assertCapabilityRequirements(profile, requiredCapabilities)
      const totalTasks = await tx.countProjectTasks(project.projectId)
      const roundTasks = await tx.countProjectTasks(project.projectId, project.coordinationRound)
      if (totalTasks >= project.budgets.maxTasks || roundTasks >= project.budgets.maxTasksPerRound) {
        fail('budget_exhausted', 'The Project task budget for this Project or coordination round is exhausted.')
      }
      for (const dependencyTaskId of dependencies) {
        const dependency = required(await tx.getTask(dependencyTaskId), 'Dependency Task')
        if (dependency.projectId !== project.projectId) fail('validation_failed', 'Dependencies must belong to the same Project.')
      }
      const referencedResourceIds = new Set([...resourceRefIds, ...requiredCapabilities.requiredResourceRefIds])
      const referencedResources = new Map<string, StoredResourceRef>()
      for (const resourceRefId of referencedResourceIds) {
        const resource = required(await tx.getResourceRef(resourceRefId), 'Task ResourceRef')
        if (resource.projectId !== project.projectId || resource.status !== 'available') {
          fail('resource_unavailable', 'Task requirements cite a ResourceRef unavailable to this Project.')
        }
        referencedResources.set(resourceRefId, resource)
      }
      if (fileIntent) {
        const binding = required(
          await tx.getProjectContentSpaceBinding(project.projectId),
          'Project Content Space binding'
        )
        if (binding.status !== 'active') {
          fail('resource_unavailable', 'The Project Content Space binding is not active.')
        }
        expectRevision(binding.revision, fileIntent.bindingRevision)
        if (fileIntent.output.containerResourceRefId !== binding.rootResourceRefId) {
          fail('validation_failed', 'Task output container must be the active Project Content Space root.')
        }
        const output = required(
          referencedResources.get(fileIntent.output.containerResourceRefId) ?? null,
          'Task output container ResourceRef'
        )
        assertProjectContentSpaceRoot(output, project.projectId)
        for (const file of fileIntent.inputs) {
          const resource = required(
            referencedResources.get(file.resourceRefId) ?? null,
            'Task input ResourceRef'
          )
          if (
            resource.projectId !== project.projectId ||
            resource.kind !== 'content-space.file-reference' ||
            !resource.portableReference ||
            resource.taskId !== undefined
          ) {
            fail('resource_unavailable', 'Task file inputs must be portable Project-level Content Space files.')
          }
        }
      }
      const taskId = newId('tsk')
      const criteria = criterionInputs.map((criterion, index) => ({
        criterionId: criterion.criterionId ?? taskCriterionId(taskId, index),
        text: criterion.text
      }))
      if (new Set(criteria.map((criterion) => criterion.criterionId)).size !== criteria.length) {
        fail('validation_failed', 'Task acceptance criterion IDs must be unique.')
      }
      const task: StoredTask = { taskId, projectId: project.projectId, executionId: newId('exe'),
        assigneeAgentId: assignee.agentId, assigneeUserId: assignee.ownerUserId,
        createdByAgentId: project.coordinatorAgentId, title: proposal.title, objective: proposal.objective,
        completionCriteria: criteria,
        dependencyTaskIds: dependencies, requiredCapabilities, resourceRefIds,
        ...(fileIntent ? { fileIntent } : {}), authorizationRequirements,
        status: 'offered', retryCount: 0, maxRetries: project.budgets.maxTaskRetries,
        coordinationRound: project.coordinationRound, revision: 1, createdAt: at, updatedAt: at }
      await tx.insertTask(task)
      const updatedProject: StoredProject = { ...project, revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updatedProject, project.revision)
      await invalidateApprovedGovernedActions(tx, project.projectId, at,
        (action) => action.kind === 'tasks.create' && action.proposalDigest === proposalDigest)
      const message = await this.appendInbox(tx, { kind: 'agent', id: assignee.agentId }, 'task.offered',
        { protocolVersion: '1.0', type: 'task.offered', projectId: project.projectId,
          taskId: task.taskId, executionId: task.executionId, revision: task.revision }, at)
      return { response: entityResponse('task.created', task), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async transitionTask(actor: AgentActor, input: {
    taskId: string
    executionId: string
    status: 'accepted' | 'rejected' | 'in_progress' | 'needs_human' | 'completed' | 'failed'
    expectedRevision: number
    resultSummary?: string
    result?: TaskResultInput
    safeFailureCode?: string
    safeFailureSummary?: string
    targetUserId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    if (input.resultSummary && input.result && input.resultSummary.trim() !== input.result.summary.trim()) {
      fail('validation_failed', 'Legacy resultSummary must match the structured result summary.')
    }
    const result = input.result ?? (input.resultSummary ? {
      summary: input.resultSummary,
      criterionEvidence: [],
      resourceRefIds: []
    } : undefined)
    if (result) {
      assertText(result.summary, 'result.summary', 1, 32_000)
      validateProjectSummary(result.summary)
      if (result.logSummary !== undefined) {
        assertText(result.logSummary, 'result.logSummary', 1, 2_000)
        validateProjectSummary(result.logSummary)
      }
      if (result.criterionEvidence.length > 100 || result.resourceRefIds.length > 1_000) {
        fail('validation_failed', 'Task result evidence exceeds the bounded public contract.')
      }
    }
    if (input.safeFailureCode && !/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.safeFailureCode)) {
      fail('validation_failed', 'safeFailureCode must be a bounded machine-readable code.')
    }
    if (input.safeFailureSummary !== undefined) {
      assertText(input.safeFailureSummary, 'safeFailureSummary', 1, 2_000)
      validateProjectSummary(input.safeFailureSummary)
    }
    if (input.status !== 'completed' && result !== undefined) {
      fail('validation_failed', 'A result is accepted only when completing a Task.')
    }
    if (input.status !== 'failed' && input.safeFailureCode !== undefined) {
      fail('validation_failed', 'safeFailureCode is accepted only when failing a Task.')
    }
    if (input.status !== 'failed' && input.safeFailureSummary !== undefined) {
      fail('validation_failed', 'safeFailureSummary is accepted only when failing a Task.')
    }
    if (input.status === 'needs_human') {
      fail('invalid_state_transition', 'Use human.needed.create to enter needs_human with a bounded request and explicit target.')
    }
    return this.commit(actor, `task.${input.status}`, input.idempotencyKey, input, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const lockedAgents = await lockAgentsForUpdate(tx, [initialTask.assigneeAgentId, actor.agentId])
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      await assertCurrentTaskActorMembership(tx, actor, project, task, input.executionId,
        required(lockedAgents.get(actor.agentId) ?? null, 'Worker Agent'))
      if (project.status !== 'active') fail('invalid_state_transition', 'Task updates require an active Project.')
      expectRevision(task.revision, input.expectedRevision)
      if (!TASK_TRANSITIONS[task.status].includes(input.status)) {
        fail('invalid_state_transition', `Task cannot transition from ${task.status} to ${input.status}.`)
      }
      if (input.status === 'completed' && !result) fail('validation_failed', 'Completed tasks require a bounded result.')
      if (input.status === 'failed' && !input.safeFailureCode) fail('validation_failed', 'Failed tasks require a safe failure code.')
      let resultRecord: StoredProjectRecord | undefined
      if (input.status === 'completed' && result) {
        if (await tx.countProjectRecords(project.projectId) >= MAX_PROJECT_RECORDS_PER_PROJECT) {
          fail('validation_failed', 'A Project may have at most 50000 records.')
        }
        const validCriterionIds = new Set(task.completionCriteria.map((criterion) => criterion.criterionId))
        const citedResources = new Set(result.resourceRefIds)
        for (const evidence of result.criterionEvidence) {
          if (!validCriterionIds.has(evidence.criterionId)) {
            fail('validation_failed', 'Task result cites an unknown acceptance criterion.')
          }
          assertText(evidence.summary, 'criterionEvidence.summary', 1, 2_000)
          validateProjectSummary(evidence.summary)
          for (const resourceRefId of evidence.resourceRefIds) citedResources.add(resourceRefId)
        }
        for (const resourceRefId of citedResources) {
          const resource = required(await tx.getResourceRef(resourceRefId), 'Result ResourceRef')
          if (resource.projectId !== project.projectId || resource.status !== 'available') {
            fail('resource_unavailable', 'Task result cites a ResourceRef that is not available to this Project.')
          }
          if (resource.taskId && (resource.taskId !== task.taskId || resource.executionId !== task.executionId)) {
            fail('execution_conflict', 'Task result cites a ResourceRef from another execution.', {
              details: { currentExecutionId: task.executionId }
            })
          }
        }
        resultRecord = {
          projectRecordId: newId('rec'), projectId: project.projectId, kind: 'task_result', status: 'candidate',
          summary: result.summary.trim(), authorUserId: actor.userId, authorAgentId: actor.agentId,
          sourceTaskId: task.taskId, sourceExecutionId: task.executionId, sourceRevision: task.revision + 1,
          criterionEvidence: result.criterionEvidence.map((evidence) => ({ ...evidence,
            summary: evidence.summary.trim(), resourceRefIds: [...new Set(evidence.resourceRefIds)] })),
          resourceRefIds: [...citedResources], ...(result.logSummary ? { logSummary: result.logSummary.trim() } : {}),
          revision: 1, createdAt: at, updatedAt: at
        }
        await tx.insertProjectRecord(resultRecord)
      }
      const updated: StoredTask = { ...task, status: input.status, resultSummary: result?.summary.trim() ?? task.resultSummary,
        ...(resultRecord ? { resultRecordId: resultRecord.projectRecordId } : {}),
        safeFailureCode: input.safeFailureCode ?? task.safeFailureCode,
        safeFailureSummary: input.safeFailureSummary?.trim() ?? task.safeFailureSummary,
        revision: task.revision + 1, updatedAt: at,
        completedAt: ['completed', 'failed', 'rejected'].includes(input.status) ? at : undefined }
      await tx.updateTask(updated, task.revision)
      if (['completed', 'failed', 'rejected'].includes(input.status)) {
        await invalidateApprovedGovernedActions(tx, project.projectId, at,
          (action) => action.kind === 'task.cancel' &&
            action.taskId === task.taskId && action.executionId === task.executionId)
      }
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      const coordinatorMessage = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated',
        { protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
          revision: updated.revision, status: contractTaskStatus(updated.status),
          executionId: updated.executionId,
          ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}),
          ...(input.safeFailureSummary ? { safeFailureSummary: input.safeFailureSummary.trim() } : {}),
          ...(resultRecord ? { resultProjectRecordId: resultRecord.projectRecordId } : {}) }, at)
      notifications.push({ recipient: coordinatorMessage.recipient, sequence: coordinatorMessage.sequence })
      if (resultRecord) {
        const recordMessage = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId },
          'project_record.submitted', { protocolVersion: '1.0', type: 'project_record.submitted',
            projectId: project.projectId, projectRecordId: resultRecord.projectRecordId,
            sourceTaskId: task.taskId, sourceExecutionId: task.executionId,
            revision: resultRecord.revision }, at)
        notifications.push({ recipient: recordMessage.recipient, sequence: recordMessage.sequence })
      }
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId, notifications }
    }).then(responseEntity<StoredTask>)
  }

  async reportTaskProgress(actor: AgentActor, input: {
    taskId: string
    executionId: string
    expectedRevision: number
    percent: number
    summary: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    const percent = integer(input.percent, 'percent', 0, 100)
    assertText(input.summary, 'summary', 1, 2_000)
    validateProjectSummary(input.summary)
    return this.commit(actor, 'task.progress.report', input.idempotencyKey, { ...input, percent }, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const lockedAgents = await lockAgentsForUpdate(tx, [initialTask.assigneeAgentId, actor.agentId])
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      await assertCurrentTaskActorMembership(tx, actor, project, task, input.executionId,
        required(lockedAgents.get(actor.agentId) ?? null, 'Worker Agent'))
      if (project.status !== 'active') fail('invalid_state_transition', 'Task progress requires an active Project.')
      expectRevision(task.revision, input.expectedRevision)
      if (task.status !== 'in_progress') {
        fail('invalid_state_transition', 'Task progress may only be reported for a running Task.')
      }
      if (task.progress && percent < task.progress.percent) {
        fail('invalid_state_transition', 'Task progress cannot decrease within the current attempt.')
      }
      const updated: StoredTask = { ...task, progress: { percent, summary: input.summary.trim(), reportedAt: at },
        revision: task.revision + 1, updatedAt: at }
      await tx.updateTask(updated, task.revision)
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'task.updated', {
        protocolVersion: '1.0', type: 'task.updated', projectId: project.projectId, taskId: task.taskId,
        executionId: updated.executionId, revision: updated.revision, status: 'running'
      }, at)
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async getTask(actor: AuthContext, taskId: string): Promise<StoredTask> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project Tasks.')
    const task = required(await this.repository.getTask(taskId), 'Task')
    const member = await this.repository.getProjectMember(task.projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return task
  }

  async retryOrReassignTask(actor: UserActor | AgentActor, input: {
    taskId: string
    executionId: string
    assigneeAgentId: string
    expectedRevision: number
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    return this.commit(actor, 'task.retry', input.idempotencyKey, input, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const agentRoute = await prepareAgentRouteLocks(tx, [
        {
          agentId: input.assigneeAgentId,
          label: 'Assignee Agent',
          unavailableMessage: 'The assignee Agent must have an active owner and linked Device.'
        },
        ...(actor.kind === 'agent_device' ? [{
          agentId: actor.agentId,
          label: 'Coordinator Agent',
          unavailableCode: 'credential_revoked' as const,
          unavailableMessage: 'The authenticated Coordinator Agent must have an active owner and linked Device.'
        }] : [])
      ])
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const lockedAgents = await finishAgentRouteLocks(tx, agentRoute)
      const assignee = required(lockedAgents.get(input.assigneeAgentId) ?? null, 'Assignee Agent')
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      const actorMember = await tx.getProjectMember(project.projectId, actor.userId)
      const isOwner = actor.kind === 'user' && actorMember?.role === 'owner'
      const isCoordinator = actor.kind === 'agent_device' && actor.agentId === project.coordinatorAgentId
      if (!isOwner && !isCoordinator) {
        if (actor.kind === 'agent_device') {
          fail('coordinator_mismatch', 'Only the current Coordinator Agent may retry or reassign a Task.')
        }
        fail('permission_denied', 'Task retry or reassignment requires the Project owner or active Coordinator Agent.')
      }
      if (actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project,
          required(lockedAgents.get(actor.agentId) ?? null, 'Coordinator Agent'))
      }
      if (project.status !== 'active') fail('invalid_state_transition', 'Task retry requires an active Project.')
      if (input.executionId !== task.executionId) fail('execution_conflict', 'The Task execution is no longer current.', {
        details: { currentRevision: task.revision, currentExecutionId: task.executionId }
      })
      expectRevision(task.revision, input.expectedRevision)
      const sameAssignee = input.assigneeAgentId === task.assigneeAgentId
      if (sameAssignee) {
        authorize({ actor, operation: 'task_retry', coordinatorAgentId: project.coordinatorAgentId, projectRole: actorMember?.role })
      } else if (actor.kind === 'user') {
        authorize({ actor, operation: 'task_reassign', projectRole: actorMember?.role })
      } else {
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'task.retry_reassign', projectId: project.projectId,
          taskId: task.taskId, fromExecutionId: task.executionId,
          assigneeAgentId: input.assigneeAgentId
        }, project, 'task.retry', at)
      }
      if (sameAssignee && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'rejected') {
        fail('invalid_state_transition', 'Only succeeded, rejected, or failed tasks may be retried by the current assignee.')
      }
      if (!sameAssignee && !['offered', 'accepted', 'in_progress', 'needs_human', 'completed', 'failed', 'rejected'].includes(task.status)) {
        fail('invalid_state_transition', 'Cancelled tasks cannot be reassigned.')
      }
      if (task.retryCount >= project.budgets.maxTaskRetries) fail('budget_exhausted', 'The task automatic retry budget is exhausted.')
      const member = await tx.getProjectMember(project.projectId, assignee.ownerUserId)
      if (!member?.active || member.role === 'observer') fail('permission_denied', 'The assignee is not authorized for this Project.')
      const profile = await tx.getAgentCapabilityProfile(assignee.agentId)
      if (!profile || profile.ownerUserId !== assignee.ownerUserId || profile.expiresAt <= at) {
        fail('capability_profile_expired', 'The assignee Agent capability profile is missing, stale, or owner-mismatched.')
      }
      assertCapabilityRequirements(profile, task.requiredCapabilities)
      const priorResult = await tx.getTaskResultForExecutionForUpdate(task.taskId, task.executionId)
      if (priorResult?.status === 'accepted') {
        fail('invalid_state_transition', 'An accepted Task result cannot be superseded by an ordinary retry.')
      }
      const pendingRequests = await tx.listPendingHumanRequestsForTaskForUpdate(task.taskId)
      for (const request of pendingRequests) {
        const status = request.expiresAt <= at ? 'expired' as const : 'cancelled' as const
        await tx.updateHumanRequest({ ...request, status, revision: request.revision + 1, updatedAt: at }, request.revision)
      }
      if (priorResult && priorResult.status !== 'superseded') {
        await tx.updateProjectRecord({ ...priorResult, status: 'superseded', revision: priorResult.revision + 1,
          updatedAt: at }, priorResult.revision)
      }
      const updated: StoredTask = { ...clearTaskAttemptOutputs(task), executionId: newId('exe'),
        assigneeAgentId: assignee.agentId, assigneeUserId: assignee.ownerUserId, status: 'offered',
        retryCount: task.retryCount + 1,
        completedAt: undefined, revision: task.revision + 1, updatedAt: at }
      await tx.updateTask(updated, task.revision)
      await invalidateApprovedGovernedActions(tx, project.projectId, at, (action) => (
        action.kind === 'task.cancel' && action.taskId === task.taskId && action.executionId === task.executionId
      ) || (
        action.kind === 'task.retry_reassign' && action.taskId === task.taskId &&
          action.fromExecutionId === task.executionId
      ))
      const message = await this.appendInbox(tx, { kind: 'agent', id: assignee.agentId }, 'task.offered',
        { protocolVersion: '1.0', type: 'task.offered', projectId: project.projectId,
          taskId: task.taskId, executionId: updated.executionId, revision: updated.revision }, at)
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async cancelTask(actor: UserActor | AgentActor, input: {
    taskId: string
    executionId: string
    expectedRevision: number
    confirmationId?: string
    idempotencyKey: string
  }): Promise<StoredTask> {
    return this.commit(actor, 'task.cancel', input.idempotencyKey, input, async (tx, at) => {
      const initialTask = required(await tx.getTask(input.taskId), 'Task')
      const project = required(await tx.getProjectForUpdate(initialTask.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = required(await tx.getTaskForUpdate(input.taskId), 'Task')
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const actorMember = await tx.getProjectMember(project.projectId, actor.userId)
      if (actor.kind === 'user') {
        authorize({ actor, operation: 'task_cancel', projectRole: actorMember?.role })
      } else {
        if (actor.agentId !== project.coordinatorAgentId) fail('coordinator_mismatch', 'Only the current Coordinator may execute a confirmed cancellation.')
        await consumeActionConfirmation(tx, actor, input.confirmationId, {
          kind: 'task.cancel', projectId: project.projectId,
          taskId: task.taskId, executionId: task.executionId
        }, project, 'task.cancel', at)
      }
      if (input.executionId !== task.executionId) fail('execution_conflict', 'The Task execution is no longer current.', {
        details: { currentRevision: task.revision, currentExecutionId: task.executionId }
      })
      expectRevision(task.revision, input.expectedRevision)
      if (['rejected', 'completed', 'failed', 'cancelled'].includes(task.status)) fail('invalid_state_transition', 'The task is already terminal.')
      const updated: StoredTask = { ...task, status: 'cancelled', completedAt: at,
        revision: task.revision + 1, updatedAt: at }
      await tx.updateTask(updated, task.revision)
      await invalidateApprovedGovernedActions(tx, project.projectId, at, (action) => (
        action.kind === 'task.cancel' && action.taskId === task.taskId && action.executionId === task.executionId
      ) || (
        action.kind === 'task.retry_reassign' && action.taskId === task.taskId &&
          action.fromExecutionId === task.executionId
      ))
      const message = await this.appendInbox(tx, { kind: 'agent', id: task.assigneeAgentId }, 'task.cancelled',
        { protocolVersion: '1.0', type: 'task.cancelled', projectId: project.projectId,
          taskId: task.taskId, executionId: task.executionId, revision: updated.revision,
          reason: 'Cancelled through the Project governance boundary.' }, at)
      return { response: entityResponse('task.updated', updated), resourceKind: 'task', resourceId: task.taskId,
        notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredTask>)
  }

  async advanceCoordinationRound(actor: AgentActor, input: {
    projectId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.round.advance', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = required(await tx.getAgentForUpdate(actor.agentId), 'Coordinator Agent')
      await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      authorize({ actor, operation: 'coordination_write', coordinatorAgentId: project.coordinatorAgentId })
      if (project.status !== 'active') fail('invalid_state_transition', 'Coordination rounds require an active Project.')
      expectRevision(project.revision, input.expectedRevision)
      if (project.coordinationRound >= project.budgets.maxCoordinationRounds) {
        fail('budget_exhausted', 'The Project coordination-round budget is exhausted.')
      }
      const updated: StoredProject = { ...project, coordinationRound: project.coordinationRound + 1,
        revision: project.revision + 1, updatedAt: at }
      await tx.updateProject(updated, project.revision)
      return { response: entityResponse('project.updated', updated), resourceKind: 'project', resourceId: project.projectId }
    }).then(responseEntity<StoredProject>)
  }

  async submitProjectRecord(actor: UserActor | AgentActor, input: {
    projectId: string
    kind: ProjectRecordKind
    summary: string
    sourceTaskId?: string
    sourceExecutionId?: string
    sourceRevision?: number
    resourceRefIds?: string[]
    idempotencyKey: string
  }): Promise<StoredProjectRecord> {
    validateProjectSummary(input.summary)
    if ((input.sourceTaskId === undefined) !== (input.sourceExecutionId === undefined)) {
      fail('validation_failed', 'Task provenance requires Task and execution identity together.')
    }
    if (input.kind === 'task_result' && (!input.sourceTaskId || !input.sourceExecutionId)) {
      fail('validation_failed', 'A Task result requires explicit Task execution provenance.')
    }
    return this.commit(actor, 'project_record.submit', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'record_submit', projectMember: Boolean(member?.active) })
      let sourceTask: StoredTask | undefined
      if (input.sourceTaskId) {
        const task = required(await tx.getTaskForUpdate(input.sourceTaskId), 'Source task')
        sourceTask = task
        if (task.projectId !== project.projectId) fail('validation_failed', 'The source task belongs to another Project.')
        if (input.sourceRevision !== task.revision) fail('revision_conflict', 'The source task revision is stale.')
        if (input.sourceExecutionId !== undefined && input.sourceExecutionId !== task.executionId) fail('execution_conflict', 'The source Task execution is stale.', {
          details: { currentRevision: task.revision, currentExecutionId: task.executionId }
        })
        if (actor.kind === 'agent_device' && actor.agentId !== task.assigneeAgentId && actor.agentId !== project.coordinatorAgentId) {
          fail('permission_denied', 'An Agent may only cite its assigned Task or a Task it coordinates.')
        }
        if (actingAgent && actor.kind === 'agent_device' && actor.agentId === task.assigneeAgentId) {
          await assertCurrentTaskActorMembership(tx, actor, project, task, input.sourceExecutionId ?? '', actingAgent)
        }
      } else if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        fail('permission_denied', 'Worker records require explicit Task provenance.')
      }
      if (input.kind === 'task_result') {
        const existing = await tx.getTaskResultForExecution(
          input.sourceTaskId!,
          input.sourceExecutionId!
        )
        if (!existing) {
          fail('invalid_state_transition', 'Task results are created atomically by the successful Task execution.')
        }
        if (existing.summary !== input.summary.trim()) {
          fail('idempotency_conflict', 'This execution already has a different canonical Task result.')
        }
        return { response: entityResponse('project_record.created', existing), resourceKind: 'project_record',
          resourceId: existing.projectRecordId }
      }
      if (await tx.countProjectRecords(project.projectId) >= MAX_PROJECT_RECORDS_PER_PROJECT) {
        fail('validation_failed', 'A Project may have at most 50000 records.')
      }
      const resourceRefIds = [...new Set(input.resourceRefIds ?? [])]
      if (resourceRefIds.length > 1_000) fail('validation_failed', 'ProjectRecord ResourceRef list is too large.')
      for (const resourceRefId of resourceRefIds) {
        const resource = required(await tx.getResourceRef(resourceRefId), 'ProjectRecord ResourceRef')
        if (resource.projectId !== project.projectId || resource.status !== 'available') {
          fail('resource_unavailable', 'ProjectRecord cites an unavailable ResourceRef.')
        }
        if (sourceTask && resource.taskId &&
            (resource.taskId !== sourceTask.taskId || resource.executionId !== sourceTask.executionId)) {
          fail('execution_conflict', 'ProjectRecord cites a ResourceRef from another Task execution.', {
            details: { currentRevision: sourceTask.revision, currentExecutionId: sourceTask.executionId }
          })
        }
      }
      if ((input.kind === 'decision' || input.kind === 'summary') &&
          !(actor.kind === 'agent_device' && actor.agentId === project.coordinatorAgentId)) {
        fail('permission_denied', 'Formal decisions and summaries must be accepted, not directly authored by a Worker or member.')
      }
      const record: StoredProjectRecord = {
        projectRecordId: newId('rec'), projectId: project.projectId, kind: input.kind,
        status: 'candidate', summary: input.summary,
        ...(actor.kind === 'agent_device' ? { authorAgentId: actor.agentId, authorUserId: actor.userId } : { authorUserId: actor.userId }),
        ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId,
          sourceExecutionId: input.sourceExecutionId ?? required(await tx.getTask(input.sourceTaskId), 'Source task').executionId,
          sourceRevision: input.sourceRevision } : {}),
        criterionEvidence: [], resourceRefIds,
        revision: 1, createdAt: at, updatedAt: at
      }
      await tx.insertProjectRecord(record)
      const message = await this.appendInbox(tx, { kind: 'agent', id: project.coordinatorAgentId }, 'project_record.submitted',
        { protocolVersion: '1.0', type: 'project_record.submitted', projectId: project.projectId,
          projectRecordId: record.projectRecordId, sourceTaskId: record.sourceTaskId ?? null,
          sourceExecutionId: record.sourceExecutionId ?? null, revision: record.revision }, at)
      return { response: entityResponse('project_record.created', record), resourceKind: 'project_record',
        resourceId: record.projectRecordId, notifications: [{ recipient: message.recipient, sequence: message.sequence }] }
    }).then(responseEntity<StoredProjectRecord>)
  }

  async getProjectRecord(actor: AuthContext, projectRecordId: string): Promise<StoredProjectRecord> {
    if (actor.kind !== 'user' && actor.kind !== 'agent_device') {
      fail('permission_denied', 'Only a user or Agent credential may read Project records.')
    }
    const record = required(await this.repository.getProjectRecord(projectRecordId), 'Project record')
    const member = await this.repository.getProjectMember(record.projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    return record
  }

  async acceptProjectRecord(actor: UserActor | AgentActor, input: {
    projectRecordId: string
    decision?: 'accepted' | 'rejected'
    acceptedKind?: 'observation' | 'decision' | 'summary' | 'task_result'
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredProjectRecord> {
    return this.commit(actor, 'project_record.accept', input.idempotencyKey, input, async (tx, at) => {
      const initialRecord = required(await tx.getProjectRecord(input.projectRecordId), 'Project record')
      const project = required(await tx.getProjectForUpdate(initialRecord.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Coordinator Agent')
        : undefined
      if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      const record = required(await tx.getProjectRecord(input.projectRecordId), 'Project record')
      const member = await tx.getProjectMember(project.projectId, actor.userId)
      const decision = input.decision ?? 'accepted'
      const kind = input.acceptedKind ?? (record.kind === 'proposal' && decision === 'accepted' ? 'decision' : record.kind)
      authorize({ actor, operation: 'record_accept', projectRole: member?.role,
        coordinatorAgentId: project.coordinatorAgentId, recordKind: record.kind })
      authorize({ actor, operation: 'record_accept', projectRole: member?.role,
        coordinatorAgentId: project.coordinatorAgentId, recordKind: kind })
      expectRevision(record.revision, input.expectedRevision)
      if (record.status !== 'candidate') fail('invalid_state_transition', 'Only a candidate Project record may be accepted.')
      const updated: StoredProjectRecord = { ...record, kind, status: decision,
        ...(decision === 'accepted'
          ? actor.kind === 'agent_device' ? { acceptedByAgentId: actor.agentId } : { acceptedByUserId: actor.userId }
          : {}),
        ...(decision === 'accepted' ? { acceptedAt: at } : {}), revision: record.revision + 1, updatedAt: at }
      await tx.updateProjectRecord(updated, record.revision)
      if (decision === 'accepted' && kind === 'task_result' && record.sourceTaskId && record.sourceExecutionId) {
        await invalidateApprovedGovernedActions(tx, project.projectId, at,
          (action) => action.kind === 'task.retry_reassign' &&
            action.taskId === record.sourceTaskId && action.fromExecutionId === record.sourceExecutionId)
      }
      return { response: entityResponse('project_record.updated', updated), resourceKind: 'project_record',
        resourceId: record.projectRecordId }
    }).then(responseEntity<StoredProjectRecord>)
  }

  async createResourceRef(actor: UserActor | AgentActor, input: ResourceRefCreateMetadata & {
    projectId: string
    taskId?: string
    executionId?: string
    expectedTaskRevision?: number
    idempotencyKey: string
  }): Promise<StoredResourceRef> {
    const parsed = resourceRefCreateMetadataSchema.safeParse({
      provider: input.provider,
      externalId: input.externalId,
      kind: input.kind,
      name: input.name,
      openUrl: input.openUrl,
      portableReference: input.portableReference,
      version: input.version
    })
    if (!parsed.success) {
      fail('validation_failed', 'ResourceRef accepts bounded metadata, optional safe HTTPS links, and canonical portable references only.')
    }
    if (new Set([input.taskId, input.executionId, input.expectedTaskRevision].map((value) => value === undefined)).size > 1) {
      fail('validation_failed', 'Task-scoped ResourceRef requires Task, execution, and revision together.')
    }
    const request = { projectId: input.projectId, taskId: input.taskId, executionId: input.executionId,
      expectedTaskRevision: input.expectedTaskRevision, ...parsed.data }
    return this.commit(actor, 'resource.create', input.idempotencyKey, request, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = input.taskId
        ? required(await tx.getTaskForUpdate(input.taskId), 'ResourceRef Task')
        : undefined
      if (actingAgent) await assertCurrentAgentProjectMembership(tx, actor as AgentActor, project, actingAgent)
      await authorizeResourceCreate(tx, actor, project, task, input.executionId)
      if (task) {
        if (actingAgent && actor.kind === 'agent_device' && actor.agentId === task.assigneeAgentId) {
          await assertCurrentTaskActorMembership(tx, actor, project, task, input.executionId ?? '', actingAgent)
        }
        expectRevision(task.revision, input.expectedTaskRevision!)
      }
      const resource: StoredResourceRef = {
        resourceRefId: newId('rrf'),
        projectId: project.projectId,
        ...(task ? { taskId: task.taskId, executionId: task.executionId, taskRevision: task.revision } : {}),
        createdByUserId: actor.userId,
        ...(actor.kind === 'agent_device' ? { createdByAgentId: actor.agentId } : {}),
        ...parsed.data,
        status: 'available',
        revision: 1,
        createdAt: at,
        updatedAt: at
      }
      await tx.insertResourceRef(resource)
      return {
        response: entityResponse('resource.created', resource),
        resourceKind: 'resource_ref',
        resourceId: resource.resourceRefId
      }
    }).then(responseEntity<StoredResourceRef>)
  }

  async getResourceRef(actor: AuthContext, resourceRefId: string): Promise<StoredResourceRef> {
    if (actor.kind === 'system') fail('permission_denied', 'System context cannot read Project resources.')
    const resource = required(await this.repository.getResourceRef(resourceRefId), 'ResourceRef')
    const member = await this.repository.getProjectMember(resource.projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    if (actor.kind === 'agent_device') {
      const project = required(await this.repository.getProject(resource.projectId), 'Project')
      if (actor.agentId !== project.coordinatorAgentId) {
        if (resource.taskId && resource.executionId) {
          const task = required(await this.repository.getTask(resource.taskId), 'ResourceRef Task')
          assertCurrentTaskExecution(actor, task, resource.executionId)
        } else {
          const referencingTask = (await this.repository.listOpenTasksForAgent(actor.agentId)).find((task) => (
            task.projectId === resource.projectId &&
            (task.resourceRefIds.includes(resource.resourceRefId) ||
              task.requiredCapabilities.requiredResourceRefIds.includes(resource.resourceRefId))
          ))
          if (!referencingTask) {
            fail('permission_denied', 'A Worker may only read ResourceRefs explicitly referenced by its current Task.')
          }
        }
      }
    }
    if (resource.status !== 'available') fail('resource_unavailable', 'The ResourceRef is not currently available.')
    return resource
  }

  async invalidateResourceRef(actor: UserActor | AgentActor, input: {
    resourceRefId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredResourceRef> {
    return this.commit(actor, 'resource.invalidate', input.idempotencyKey, input, async (tx, at) => {
      const initialResource = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      const project = required(await tx.getProjectForUpdate(initialResource.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = initialResource.taskId
        ? required(await tx.getTaskForUpdate(initialResource.taskId), 'ResourceRef Task')
        : undefined
      const resource = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      if (resource.projectId !== project.projectId || resource.taskId !== initialResource.taskId) {
        fail('revision_conflict', 'ResourceRef Task provenance changed before this write.')
      }
      if (task && actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        await assertCurrentTaskActorMembership(tx, actor, project, task, resource.executionId ?? '',
          required(actingAgent ?? null, 'Worker Agent'))
      } else if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      await authorizeResourceInvalidation(tx, actor, project, task)
      expectRevision(resource.revision, input.expectedRevision)
      if (resource.status !== 'available') {
        fail('invalid_state_transition', 'Only an available ResourceRef may be invalidated.')
      }
      const updated: StoredResourceRef = {
        ...resource,
        status: 'invalidated',
        invalidatedAt: at,
        revision: resource.revision + 1,
        updatedAt: at
      }
      await tx.updateResourceRef(updated, resource.revision)
      return {
        response: entityResponse('resource.invalidated', updated),
        resourceKind: 'resource_ref',
        resourceId: resource.resourceRefId
      }
    }).then(responseEntity<StoredResourceRef>)
  }

  async transitionResourceRef(actor: UserActor | AgentActor, input: {
    resourceRefId: string
    status: 'available' | 'unavailable' | 'revoked'
    safeReasonCode?: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredResourceRef> {
    if ((input.status === 'available') === (input.safeReasonCode !== undefined)) {
      fail('validation_failed', 'Unavailable or revoked resources require a safe reason; available resources do not.')
    }
    if (input.safeReasonCode && !/^[a-z][a-z0-9_.-]{0,63}$/u.test(input.safeReasonCode)) {
      fail('validation_failed', 'ResourceRef reason must be a bounded machine-readable code.')
    }
    return this.commit(actor, 'resource.transition', input.idempotencyKey, input, async (tx, at) => {
      const initial = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      const project = required(await tx.getProjectForUpdate(initial.projectId), 'Project')
      const actingAgent = actor.kind === 'agent_device'
        ? required(await tx.getAgentForUpdate(actor.agentId), 'Agent')
        : undefined
      const task = initial.taskId ? required(await tx.getTaskForUpdate(initial.taskId), 'ResourceRef Task') : undefined
      const resource = required(await tx.getResourceRef(input.resourceRefId), 'ResourceRef')
      await authorizeResourceInvalidation(tx, actor, project, task)
      if (task && actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        await assertCurrentTaskActorMembership(tx, actor, project, task, resource.executionId ?? '',
          required(actingAgent ?? null, 'Worker Agent'))
      } else if (actingAgent && actor.kind === 'agent_device') {
        await assertCurrentAgentProjectMembership(tx, actor, project, actingAgent)
      }
      expectRevision(resource.revision, input.expectedRevision)
      if (!canTransition('resource_ref', resource.status, input.status)) {
        fail('invalid_state_transition', `ResourceRef cannot transition from ${resource.status} to ${input.status}.`)
      }
      const updated: StoredResourceRef = {
        ...resource,
        status: input.status,
        revision: resource.revision + 1,
        updatedAt: at
      }
      delete updated.statusReasonCode
      delete updated.unavailableAt
      delete updated.revokedAt
      if (input.safeReasonCode) updated.statusReasonCode = input.safeReasonCode
      if (input.status === 'unavailable') updated.unavailableAt = at
      if (input.status === 'revoked') updated.revokedAt = at
      await tx.updateResourceRef(updated, resource.revision)
      return { response: entityResponse('resource.updated', updated), resourceKind: 'resource_ref',
        resourceId: resource.resourceRefId }
    }).then(responseEntity<StoredResourceRef>)
  }

  async listProjects(actor: UserActor, input: {
    statuses?: Array<'draft' | 'active' | 'paused' | 'completed' | 'cancelled'>
    cursor?: string
    limit: number
  }): Promise<ProjectListPageView> {
    assertPageLimit(input.limit)
    return this.repository.readSnapshot(async (repository) => {
      const page = await repository.listProjectSummaryPageForUser({
        userId: actor.userId,
        ...(input.statuses ? { statuses: [...new Set(input.statuses.flatMap((status) => (
          status === 'cancelled' ? ['cancelled', 'failed'] as const : [status]
        )))] } : {}),
        ...(input.cursor ? { after: decodeProjectPageCursor(input.cursor) } : {}),
        limit: input.limit
      })
      const last = page.items.at(-1)
      return {
        items: page.items,
        ...(page.hasMore && last
          ? { nextCursor: encodePageCursor('projects', `${last.updatedAt}\u001f${last.projectId}`) }
          : {})
      }
    })
  }

  async listOwnedAgents(actor: UserActor): Promise<OwnedAgentListView> {
    return this.repository.readSnapshot(async (repository) => {
      const agents = await repository.listUsableOwnedAgentsBounded(actor.userId, 101)
      const items = agents
        .slice(0, 100)
        .map((agent) => ({
          agentId: agent.agentId,
          displayName: agent.displayName,
          nodeType: agent.nodeType as 'desktop' | 'server',
          connectionStatus: agent.connectionStatus,
          ...(agent.lastSeenAt ? { lastSeenAt: agent.lastSeenAt } : {}),
          revision: agent.revision
        }))
      return { items }
    })
  }

  async getWorkerDirectoryPage(actor: UserActor, input: {
    cursor?: string
    limit: number
  }): Promise<WorkerDirectoryPageView> {
    if (!this.testWorkerDirectoryEnabled) {
      fail('not_found', 'The test Worker directory is not enabled in this environment.')
    }
    assertPageLimit(input.limit)
    const readAt = this.timestamp()
    return this.repository.readSnapshot(async (repository) => {
      const currentIdentity = await repository.getOidcIdentity(actor.identityId)
      if (!currentIdentity || currentIdentity.status !== 'active' || currentIdentity.userId !== actor.userId ||
          currentIdentity.issuer !== actor.issuer || currentIdentity.subject !== actor.subject) {
        fail('credential_revoked', 'The OIDC identity is no longer eligible for the test Worker directory.')
      }
      const page = await repository.getWorkerDirectoryPage({
        issuer: actor.issuer,
        readAt,
        ...(input.cursor ? { afterAgentId: decodePageCursor(input.cursor, 'workers') } : {}),
        limit: input.limit
      })
      const last = page.items.at(-1)
      return {
        stats: page.stats,
        items: page.items,
        ...(page.hasMore && last ? { nextCursor: encodePageCursor('workers', last.agentId) } : {}),
        readAt
      }
    })
  }

  async updateProjectMembers(actor: UserActor, input: {
    projectId: string
    expectedRevision: number
    addMemberUserIds: string[]
    removeMemberUserIds: string[]
    idempotencyKey: string
  }): Promise<StoredProject> {
    return this.commit(actor, 'project.members.update', input.idempotencyKey, input, async (tx, at) => {
      const project = required(await tx.getProjectForUpdate(input.projectId), 'Project')
      const ownerMembership = await tx.getProjectMember(project.projectId, actor.userId)
      authorize({ actor, operation: 'project_admin', projectRole: ownerMembership?.role })
      expectRevision(project.revision, input.expectedRevision)
      if (project.status !== 'active' && project.status !== 'paused') {
        fail('invalid_state_transition', 'Membership can change only while a Project is active or paused.')
      }
      const additions = [...new Set(input.addMemberUserIds)].sort(compareStable)
      const removals = [...new Set(input.removeMemberUserIds)].sort(compareStable)
      if (additions.length + removals.length === 0 || additions.some((userId) => removals.includes(userId))) {
        fail('validation_failed', 'Project membership additions and removals must be non-empty and disjoint.')
      }
      const targetUserIds = [...new Set([...additions, ...removals])].sort(compareStable)
      const [coordinator, memberRows, activeMemberCount] = await Promise.all([
        tx.getAgent(project.coordinatorAgentId),
        tx.listProjectMembersByUserIds(project.projectId, targetUserIds),
        tx.countActiveProjectMembers(project.projectId)
      ])
      const requiredCoordinator = required(coordinator, 'Coordinator Agent')
      const memberMap = new Map(memberRows.map((member) => [member.userId, member]))
      for (const userId of additions) {
        const user = required(await tx.getUser(userId), 'Added Project member')
        if (user.status !== 'active' || !await tx.hasActiveOidcIdentityForUser(userId, actor.issuer)) {
          fail('permission_denied', 'An added Project member must be an active User from the same OIDC issuer.')
        }
        if (memberMap.get(userId)?.active) {
          fail('invalid_state_transition', 'The added User is already an active Project member.')
        }
      }
      await assertActiveProjectMembershipCapacity(tx, additions)
      for (const userId of removals) {
        const member = memberMap.get(userId)
        if (!member?.active) fail('not_found', 'The removed User is not an active Project member.')
        if (userId === project.ownerUserId) {
          fail('invalid_state_transition', 'The Project owner cannot be removed.')
        }
        if (userId === requiredCoordinator.ownerUserId) {
          fail('invalid_state_transition', 'The current Coordinator owner cannot be removed.')
        }
      }
      if (activeMemberCount + additions.length - removals.length > 1_000) {
        fail('validation_failed', 'A Project may have at most 1000 active members.')
      }
      const blockers = removals.length > 0
        ? await tx.getProjectMemberRemovalBlockers(project.projectId, removals, at)
        : { openTaskUserIds: [], pendingHumanRequestUserIds: [] }
      const openTaskUsers = new Set(blockers.openTaskUserIds)
      const pendingHumanRequestUsers = new Set(blockers.pendingHumanRequestUserIds)
      for (const userId of removals) {
        if (openTaskUsers.has(userId)) {
          fail('invalid_state_transition', 'A member with an open Task cannot be removed.')
        }
        if (pendingHumanRequestUsers.has(userId)) {
          fail('invalid_state_transition', 'A member with pending HumanNeeded work cannot be removed.')
        }
      }
      for (const userId of additions) {
        const existing = memberMap.get(userId)
        await tx.upsertProjectMember({
          projectId: project.projectId,
          userId,
          role: existing?.role ?? 'member',
          active: true,
          createdAt: existing?.createdAt ?? at
        })
      }
      for (const userId of removals) {
        const existing = memberMap.get(userId)!
        await tx.upsertProjectMember({ ...existing, active: false })
      }
      const updated: StoredProject = {
        ...project,
        revision: project.revision + 1,
        updatedAt: at
      }
      await tx.updateProject(updated, project.revision)
      const notificationPayload = {
        protocolVersion: '1.0' as const,
        type: 'project.members.updated' as const,
        projectId: project.projectId,
        revision: updated.revision,
        addedUserIds: additions,
        removedUserIds: removals
      }
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      const affectedUsers = new Set([
        project.ownerUserId,
        requiredCoordinator.ownerUserId,
        ...additions,
        ...removals
      ])
      for (const userId of [...affectedUsers].sort(compareStable)) {
        const message = await this.appendInbox(tx, { kind: 'user', id: userId },
          'project.members.updated', notificationPayload, at)
        notifications.push({ recipient: message.recipient, sequence: message.sequence })
      }
      const coordinatorMessage = await this.appendInbox(tx, { kind: 'agent', id: requiredCoordinator.agentId },
        'project.members.updated', notificationPayload, at)
      notifications.push({ recipient: coordinatorMessage.recipient, sequence: coordinatorMessage.sequence })
      return {
        response: entityResponse('project.updated', updated),
        resourceKind: 'project',
        resourceId: project.projectId,
        notifications
      }
    }).then(responseEntity<StoredProject>)
  }

  async getProject(actor: AuthContext, projectId: string): Promise<{
    project: StoredProject
    members: StoredProjectMember[]
  }> {
    if (actor.kind === 'system') fail('permission_denied', 'System context is not an interactive Project member.')
    const project = required(await this.repository.getProject(projectId), 'Project')
    const member = await this.repository.getProjectMember(projectId, actor.userId)
    authorize({ actor, operation: 'project_read', projectMember: Boolean(member?.active) })
    const members = await this.repository.listActiveProjectMembersBounded(projectId, 1_001)
    if (members.length > 1_000) {
      fail('internal_error', 'The Project active-member invariant was violated.')
    }
    return { project, members }
  }

  async getProjectCoordinationView(actor: UserActor | AgentActor, projectId: string): Promise<{
    project: StoredProject
    members: Array<StoredProjectMember & { displayName: string }>
    tasks: StoredTask[]
    records: StoredProjectRecord[]
    humanRequests: StoredHumanRequest[]
    humanAnswers: StoredHumanAnswer[]
    readAt: string
  }> {
    const readAt = this.timestamp()
    return this.repository.readSnapshot(async (repository) => {
      const actorMember = await repository.getProjectMember(projectId, actor.userId)
      authorize({ actor, operation: 'project_read', projectMember: Boolean(actorMember?.active) })
      const project = required(await repository.getProject(projectId), 'Project')
      if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
        fail('coordinator_mismatch', 'Only the current Coordinator Agent may use an Agent credential for the coordination view.')
      }
      if (actor.kind === 'user' && actorMember?.role !== 'owner') {
        fail('permission_denied', 'Only the Project owner User or current Coordinator Agent may read the coordination view.')
      }
      const materializationCounts = await repository.getProjectCoordinationMaterializationCounts(projectId)
      const materializationRows = assertProjectCoordinationMaterializationCounts(materializationCounts)
      const materializationBytes = await repository.getProjectCoordinationMaterializationBytes(projectId)
      assertProjectCoordinationMaterializationBytes(project, materializationRows, materializationBytes)
      const members = await repository.listActiveProjectMemberViewsBounded(projectId, 1_001)
      if (members.length > 1_000) {
        fail('internal_error', 'The Project active-member invariant was violated.')
      }
      const [tasks, records, humanRequests, humanAnswers] = await Promise.all([
        repository.listProjectTasks(projectId),
        repository.listProjectRecords(projectId, false),
        repository.listHumanRequestsForProject(projectId),
        repository.listHumanAnswersForProject(projectId)
      ])
      const view = {
        project,
        members: members.sort((left, right) => compareStable(left.userId, right.userId)),
        tasks: tasks.sort((left, right) => compareStable(left.taskId, right.taskId)),
        records: records.sort((left, right) => compareStable(left.projectRecordId, right.projectRecordId)),
        humanRequests: humanRequests
          .map((request) => (
            request.status === 'pending' && !isTimestampAfter(request.expiresAt, readAt)
              ? { ...request, status: 'expired' as const }
              : request
          ))
          .sort((left, right) => compareStable(left.humanRequestId, right.humanRequestId)),
        humanAnswers: humanAnswers.sort((left, right) => compareStable(left.humanAnswerId, right.humanAnswerId)),
        readAt
      }
      assertProjectCoordinationMaterializedBytes(view)
      return view
    })
  }

  async getPortalProjectCoordinationView(actor: UserActor, projectId: string, input: {
    tasksCursor?: string
    recordsCursor?: string
    humanCursor?: string
    tasksLimit?: number
    recordsLimit?: number
    humanLimit?: number
  } = {}): Promise<{
    project: StoredProject
    members: Array<StoredProjectMember & { displayName: string }>
    tasks: StoredTask[]
    records: StoredProjectRecord[]
    humanRequests: StoredHumanRequest[]
    pagination: {
      tasks: { limit: number; version: string; nextCursor?: string }
      records: { limit: number; version: string; nextCursor?: string }
      humanRequests: { limit: number; version: string; nextCursor?: string }
    }
    readAt: string
  }> {
    const readAt = this.timestamp()
    const tasksLimit = integer(input.tasksLimit ?? PORTAL_COORDINATION_PAGE_DEFAULTS.tasks,
      'tasksLimit', 1, PORTAL_COORDINATION_PAGE_MAXIMUMS.tasks)
    const recordsLimit = integer(input.recordsLimit ?? PORTAL_COORDINATION_PAGE_DEFAULTS.records,
      'recordsLimit', 1, PORTAL_COORDINATION_PAGE_MAXIMUMS.records)
    const humanLimit = integer(input.humanLimit ?? PORTAL_COORDINATION_PAGE_DEFAULTS.humanRequests,
      'humanLimit', 1, PORTAL_COORDINATION_PAGE_MAXIMUMS.humanRequests)
    const afterTaskId = input.tasksCursor
      ? decodeCoordinationPageCursor(input.tasksCursor, 'coordination.tasks', projectId, 'tsk_')
      : undefined
    const afterProjectRecordId = input.recordsCursor
      ? decodeCoordinationPageCursor(input.recordsCursor, 'coordination.records', projectId, 'rec_')
      : undefined
    const afterHumanRequestId = input.humanCursor
      ? decodeCoordinationPageCursor(input.humanCursor, 'coordination.human', projectId, 'hrq_')
      : undefined
    return this.repository.readSnapshot(async (repository) => {
      const actorMember = await repository.getProjectMember(projectId, actor.userId)
      authorize({ actor, operation: 'project_read', projectMember: Boolean(actorMember?.active) })
      const project = required(await repository.getProject(projectId), 'Project')
      if (actorMember?.role !== 'owner') {
        fail('permission_denied', 'Only the Project owner User may read the Portal coordination view.')
      }
      const [memberRows, tasks, records, humanRequests, watermarks] = await Promise.all([
        repository.listActiveProjectMemberViewsBounded(projectId, PORTAL_COORDINATION_LIMITS.activeMembers + 1),
        repository.listProjectTasksBounded(projectId, afterTaskId, tasksLimit + 1),
        repository.listProjectRecordsBounded(projectId, afterProjectRecordId, recordsLimit + 1),
        repository.listTargetHumanRequestsForProjectBounded(
          projectId,
          actor.userId,
          afterHumanRequestId,
          humanLimit + 1
        ),
        repository.getPortalProjectWakeWatermarks(projectId, actor.userId)
      ])
      assertPortalCoordinationBound('active members', memberRows, PORTAL_COORDINATION_LIMITS.activeMembers)
      const taskPage = tasks.slice(0, tasksLimit)
      const recordPage = records.slice(0, recordsLimit)
      const humanRequestPage = humanRequests.slice(0, humanLimit)
      const projectedHumanRequests = humanRequestPage.map((request) => (
        request.status === 'pending' && !isTimestampAfter(request.expiresAt, readAt)
          ? { ...request, status: 'expired' as const }
          : request
      ))
      return {
        project,
        members: memberRows,
        tasks: taskPage,
        records: recordPage,
        humanRequests: projectedHumanRequests.sort((left, right) => compareStable(left.humanRequestId, right.humanRequestId)),
        pagination: {
          tasks: {
            limit: tasksLimit,
            version: portalTaskVersion(watermarks),
            ...(tasks.length > tasksLimit && taskPage.length > 0
              ? { nextCursor: encodeCoordinationPageCursor(
                  'coordination.tasks', projectId, taskPage.at(-1)!.taskId
                ) }
              : {})
          },
          records: {
            limit: recordsLimit,
            version: portalRecordVersion(watermarks),
            ...(records.length > recordsLimit && recordPage.length > 0
              ? { nextCursor: encodeCoordinationPageCursor(
                  'coordination.records', projectId, recordPage.at(-1)!.projectRecordId
                ) }
              : {})
          },
          humanRequests: {
            limit: humanLimit,
            version: portalHumanVersion(watermarks),
            ...(humanRequests.length > humanLimit && humanRequestPage.length > 0
              ? { nextCursor: encodeCoordinationPageCursor(
                  'coordination.human', projectId, humanRequestPage.at(-1)!.humanRequestId
                ) }
              : {})
          }
        },
        readAt
      }
    })
  }

  async getPortalProjectWakeSnapshot(actor: UserActor, projectId: string): Promise<{
    projectId: string
    projectRevision: number
    projectVersion: string
    taskVersion: string
    recordVersion: string
    humanVersion: string
  }> {
    return this.repository.readSnapshot(async (repository) => {
      const actorMember = await repository.getProjectMember(projectId, actor.userId)
      authorize({ actor, operation: 'project_read', projectMember: Boolean(actorMember?.active) })
      const project = required(await repository.getProject(projectId), 'Project')
      if (actorMember?.role !== 'owner') {
        fail('permission_denied', 'Only the Project owner User may subscribe to Portal Project events.')
      }
      const watermarks = await repository.getPortalProjectWakeWatermarks(projectId, actor.userId)
      return {
        projectId,
        projectRevision: project.revision,
        projectVersion: `project:${project.revision}`,
        taskVersion: portalTaskVersion(watermarks),
        recordVersion: portalRecordVersion(watermarks),
        humanVersion: portalHumanVersion(watermarks)
      }
    })
  }

  async getActionConfirmation(
    actor: UserActor | AgentActor,
    confirmationId: string
  ): Promise<StoredActionConfirmation> {
    const readAt = this.timestamp()
    const confirmation = required(
      await this.repository.getActionConfirmation(confirmationId),
      'Action confirmation'
    )
    const mayRead = actor.kind === 'user'
      ? actor.userId === confirmation.targetUserId
      : actor.agentId === confirmation.coordinatorAgentId
    if (!mayRead) {
      fail('permission_denied', 'The action confirmation belongs to another Project actor.')
    }
    if (confirmation.status === 'approved' && confirmation.expiresAt <= readAt) {
      return { ...confirmation, status: 'superseded' }
    }
    return confirmation
  }

  async reportAgentCapabilityProfile(actor: AgentActor, input: {
    agentId: string
    ownerUserId: string
    nodeType: 'personal_computer' | 'institution_server'
    os: { family: 'windows' | 'macos' | 'linux'; architecture: 'x64' | 'arm64'; version?: string }
    runtimeIds: string[]
    capabilities: StoredAgentCapabilityProfile['capabilities']
    gpu?: StoredAgentCapabilityProfile['gpu']
    vpnAccessIds: string[]
    slurmClusterIds: string[]
    accessibleResourceRefIds: string[]
    resultReturnPolicy: StoredAgentCapabilityProfile['resultReturnPolicy']
    reportedAt: string
    expiresAt: string
    expectedRevision?: number
    idempotencyKey: string
  }): Promise<StoredAgentCapabilityProfile> {
    if (input.agentId !== actor.agentId || input.ownerUserId !== actor.userId) {
      fail('assignee_mismatch', 'Capability profile identity must match the authenticated Agent credential.')
    }
    const reportedTime = new Date(input.reportedAt).getTime()
    const expiresTime = new Date(input.expiresAt).getTime()
    const nowTime = this.now().getTime()
    if (!Number.isFinite(reportedTime) || !Number.isFinite(expiresTime) || reportedTime > nowTime + 60_000 ||
        expiresTime <= nowTime || expiresTime - reportedTime > 7 * 86_400_000) {
      fail('validation_failed', 'Capability profile timestamps are outside the accepted freshness window.')
    }
    return this.commit(actor, 'agent.capability_profile.report', input.idempotencyKey, input, async (tx, at) => {
      const agent = required(await tx.getAgent(input.agentId), 'Agent')
      if (agent.ownerUserId !== actor.userId || agent.status !== 'active') {
        fail('credential_revoked', 'Only an active Agent may report its capability profile.')
      }
      const expectedNodeType = agent.nodeType === 'desktop' ? 'personal_computer' : 'institution_server'
      if (input.nodeType !== expectedNodeType) fail('validation_failed', 'Capability profile nodeType conflicts with Agent registration.')
      const current = await tx.getAgentCapabilityProfile(agent.agentId)
      if (current) {
        if (input.expectedRevision === undefined) fail('revision_conflict', 'Capability profile revision is required.', {
          details: { currentRevision: current.revision }
        })
        expectRevision(current.revision, input.expectedRevision)
      } else if (input.expectedRevision !== undefined) {
        fail('revision_conflict', 'A new capability profile must not claim an existing revision.')
      }
      for (const resourceRefId of input.accessibleResourceRefIds) {
        const resource = required(await tx.getResourceRef(resourceRefId), 'Accessible ResourceRef')
        if (resource.createdByUserId !== actor.userId || resource.status !== 'available') {
          fail('resource_unavailable', 'Capability profile contains a ResourceRef unavailable to this Agent owner.')
        }
      }
      const profile: StoredAgentCapabilityProfile = {
        agentId: agent.agentId, ownerUserId: agent.ownerUserId, nodeType: input.nodeType,
        osFamily: input.os.family, osArchitecture: input.os.architecture,
        ...(input.os.version ? { osVersion: input.os.version } : {}),
        runtimeIds: [...new Set(input.runtimeIds)], capabilities: input.capabilities,
        gpu: input.gpu ?? [], vpnAccessIds: [...new Set(input.vpnAccessIds)],
        slurmClusterIds: [...new Set(input.slurmClusterIds)],
        accessibleResourceRefIds: [...new Set(input.accessibleResourceRefIds)],
        resultReturnPolicy: input.resultReturnPolicy, reportedAt: input.reportedAt, expiresAt: input.expiresAt,
        revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? at, updatedAt: at
      }
      await tx.upsertAgentCapabilityProfile(profile, current?.revision ?? null)
      return { response: entityResponse('agent.capability_profile.updated', profile), resourceKind: 'agent_capability_profile',
        resourceId: agent.agentId }
    }).then(responseEntity<StoredAgentCapabilityProfile>)
  }

  async getProjectCapabilityDirectory(
    actor: UserActor | AgentActor,
    projectId: string
  ): Promise<ProjectCapabilityDirectoryView> {
    const now = this.timestamp()
    return this.repository.readSnapshot(async (repository) => {
      const actorMember = await repository.getProjectMember(projectId, actor.userId)
      authorize({ actor, operation: 'project_read', projectMember: Boolean(actorMember?.active) })
      const project = required(await repository.getProject(projectId), 'Project')
      if (project.status !== 'active') {
        fail('invalid_state_transition', 'Capability directory is available only for an active Project.')
      }
      const members = await repository.listActiveProjectMembersBounded(projectId, 1_001)
      if (members.length > 1_000) {
        fail('internal_error', 'The Project active-member invariant was violated.')
      }
      const agents = (await Promise.all(members.map(async (member) => {
        const user = await repository.getUser(member.userId)
        if (!user || user.status !== 'active') return []
        return (await Promise.all((await repository.listAgentsForUser(member.userId))
          .filter((agent): agent is StoredAgent & { lastSeenAt: string } => (
            agent.status === 'active' && agent.lastSeenAt !== undefined
          ))
          .map(async (agent) => ({ agent, usable: await isUsableAgent(repository, agent, user),
            profile: await repository.getAgentCapabilityProfile(agent.agentId),
            busy: (await repository.listOpenTasksForAgent(agent.agentId))
              .some((task) => ['accepted', 'in_progress', 'needs_human'].includes(task.status)) }))))
          .filter((entry): entry is {
            agent: StoredAgent & { lastSeenAt: string }
            usable: boolean
            profile: StoredAgentCapabilityProfile
            busy: boolean
          } => (
            entry.usable && entry.profile !== null && isTimestampAfter(entry.profile.expiresAt, now) &&
            entry.profile.ownerUserId === entry.agent.ownerUserId
          ))
      }))).flat()
        .sort((left, right) => left.agent.ownerUserId === right.agent.ownerUserId
          ? compareStable(left.agent.agentId, right.agent.agentId)
          : compareStable(left.agent.ownerUserId, right.agent.ownerUserId))
        .map(({ agent, profile, busy }): ProjectCapabilityDirectoryView['agents'][number] => ({
          agentId: agent.agentId,
          ownerUserId: agent.ownerUserId,
          displayName: agent.displayName,
          nodeType: agent.nodeType,
          capabilities: profile.capabilities.map((capability) => capability.capabilityId).sort(compareStable),
          status: deriveWorkerPresence(agent, busy, now),
          lastSeenAt: agent.lastSeenAt,
          profile,
          revision: agent.revision
        }))
      return { projectId: project.projectId, projectRevision: project.revision, agents }
    })
  }

  async pullInbox(actor: AuthContext, input: { afterSequence: number; limit: number }): Promise<{
    messages: StoredInboxMessage[]
    ackedSequence: number
    nextSequence: number
  }> {
    const recipient = actorInboxRecipient(actor)
    const afterSequence = integer(input.afterSequence, 'afterSequence', 0, Number.MAX_SAFE_INTEGER)
    const limit = integer(input.limit, 'limit', 1, 1_000)
    const readAt = this.timestamp()
    // Expired, unacknowledged messages remain sequence-preserving tombstones.
    // Lock this recipient's cursor first, then materialize only its tombstones
    // and read the page in one short transaction so cursor and page agree.
    return this.repository.transaction(async (tx) => {
      const cursor = await tx.supersedeExpiredInboxMessages(recipient, readAt)
      if (!cursor) return { messages: [], ackedSequence: 0, nextSequence: 1 }
      const messages = await tx.pullInbox(recipient, afterSequence, limit, readAt)
      return { messages, ackedSequence: cursor.ackedSequence, nextSequence: cursor.nextSequence }
    })
  }

  async ackInbox(actor: AuthContext, input: { throughSequence: number; idempotencyKey: string }): Promise<{
    ackedSequence: number
    nextSequence: number
  }> {
    const recipient = actorInboxRecipient(actor)
    integer(input.throughSequence, 'throughSequence', 0, Number.MAX_SAFE_INTEGER)
    return this.commit(actor, 'inbox.ack', input.idempotencyKey, input, async (tx, at) => {
      const current = await tx.getInboxCursor(recipient)
      const acked = current?.ackedSequence ?? 0
      if (input.throughSequence > acked + 1) {
        for (let sequence = acked + 1; sequence < input.throughSequence; sequence += 1) {
          const skipped = await tx.getInboxMessage(recipient, sequence)
          if (!skipped || skipped.disposition !== 'superseded') {
            fail('inbox_ack_gap', 'Inbox ACK cannot pass an unfinished active message.', {
              details: { ackedSequence: acked, nextSequence: current?.nextSequence ?? 1 }
            })
          }
        }
      }
      const cursor = await tx.ackInbox(recipient, input.throughSequence, at)
      return { response: { protocolVersion: '1.0', type: 'inbox.acked', ackedSequence: cursor.ackedSequence,
        nextSequence: cursor.nextSequence }, resourceKind: 'inbox', resourceId: recipient.id }
    }).then((response) => ({ ackedSequence: Number(response.ackedSequence), nextSequence: Number(response.nextSequence) }))
  }

  async ackInboxMessage(actor: AuthContext, input: {
    inboxMessageId: string
    sequence: number
    idempotencyKey: string
  }): Promise<{ ackedSequence: number; nextSequence: number }> {
    integer(input.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER)
    const recipient = actorInboxRecipient(actor)
    return this.commit(actor, 'inbox.ack', input.idempotencyKey, input, async (tx, at) => {
      const message = await tx.getInboxMessage(recipient, input.sequence)
      if (!message || message.messageId !== input.inboxMessageId) {
        fail('not_found', 'The inbox message does not match this authenticated recipient and sequence.')
      }
      const current = await tx.getInboxCursor(recipient)
      const acked = current?.ackedSequence ?? 0
      if (input.sequence > acked + 1) {
        for (let sequence = acked + 1; sequence < input.sequence; sequence += 1) {
          const skipped = await tx.getInboxMessage(recipient, sequence)
          if (!skipped || skipped.disposition !== 'superseded') {
            fail('inbox_ack_gap', 'Inbox ACK cannot pass an unfinished active message.', {
              details: { ackedSequence: acked, nextSequence: current?.nextSequence ?? 1 }
            })
          }
        }
      }
      const cursor = await tx.ackInbox(recipient, input.sequence, at)
      return { response: { protocolVersion: '1.0', type: 'inbox.acked', inboxMessageId: input.inboxMessageId,
        sequence: input.sequence, ackedSequence: cursor.ackedSequence, nextSequence: cursor.nextSequence },
      resourceKind: 'inbox', resourceId: recipient.id }
    }).then((response) => ({ ackedSequence: Number(response.ackedSequence), nextSequence: Number(response.nextSequence) }))
  }

  async reconcileReceipt(actor: AuthContext, idempotencyKey: string): Promise<StoredReceipt | null> {
    assertText(idempotencyKey, 'idempotencyKey', 8, 300)
    return this.repository.getReceipt(actor.actorKey, idempotencyKey)
  }

  async ensureManagedContainer(actor: UserActor, input: {
    humanEndpointId: string
    displayName?: string
    policy: StoredManagedContainer['policy']
    idempotencyKey: string
  }): Promise<StoredManagedContainer> {
    const expectedName = `sciforge-${stableDigest(actor.userId).slice(0, 12)}`
    if (input.displayName !== undefined && input.displayName !== expectedName) {
      fail('validation_failed', 'Managed Channel name must use the server-derived stable user handle.')
    }
    const response = await this.commit(actor, 'managed_container.ensure', input.idempotencyKey, input, async (tx, at) => {
      const endpoint = required(await tx.getEndpoint(input.humanEndpointId), 'Human endpoint')
      if (endpoint.userId !== actor.userId || endpoint.status !== 'active') {
        fail('permission_denied', 'Managed Channel requires an active endpoint owned by the authenticated user.')
      }
      const existing = await tx.getManagedContainerForOwner(actor.userId, endpoint.provider, endpoint.realmId)
      if (existing) {
        if (existing.status === 'failed' && !existing.externalContainerId) {
          const retried: StoredManagedContainer = {
            ...existing,
            status: 'requested',
            safeErrorCode: undefined,
            revision: existing.revision + 1,
            updatedAt: at
          }
          await tx.updateManagedContainer(retried, existing.revision)
          await tx.insertManagedContainerJob({
            jobId: newId('mcj'), managedContainerId: retried.managedContainerId, operation: 'ensure',
            desiredRevision: retried.revision, state: 'queued', attemptCount: 0, nextAttemptAt: at,
            createdAt: at, updatedAt: at
          })
          return {
            response: entityResponse('managed_container.ensure_retried', retried),
            resourceKind: 'managed_provider_container',
            resourceId: retried.managedContainerId
          }
        }
        return {
          response: entityResponse('managed_container.ensured', existing),
          resourceKind: 'managed_provider_container',
          resourceId: existing.managedContainerId
        }
      }
      const managedContainerId = newId('mco')
      const container: StoredManagedContainer = {
        managedContainerId,
        ownerUserId: actor.userId,
        humanEndpointId: endpoint.humanEndpointId,
        provider: endpoint.provider,
        realmId: endpoint.realmId,
        ownerProviderUserId: endpoint.providerUserId,
        stableKey: `managed-${stableDigest({ ownerUserId: actor.userId, provider: endpoint.provider, realmId: endpoint.realmId })}`,
        displayName: expectedName,
        policy: input.policy,
        status: 'requested',
        revision: 1,
        createdAt: at,
        updatedAt: at
      }
      const job: StoredManagedContainerJob = {
        jobId: newId('mcj'),
        managedContainerId,
        operation: 'ensure',
        desiredRevision: 1,
        state: 'queued',
        attemptCount: 0,
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at
      }
      await tx.insertManagedContainer(container)
      await tx.insertManagedContainerJob(job)
      return {
        response: entityResponse('managed_container.ensured', container),
        resourceKind: 'managed_provider_container',
        resourceId: managedContainerId
      }
    })
    const committed = responseEntity<StoredManagedContainer>(response)
    return required(await this.repository.getManagedContainer(committed.managedContainerId), 'Managed container')
  }

  async getManagedContainer(actor: AuthContext, managedContainerId: string): Promise<StoredManagedContainer> {
    const container = required(await this.repository.getManagedContainer(managedContainerId), 'Managed container')
    if (actor.kind === 'system' || actor.userId !== container.ownerUserId) {
      fail('permission_denied', 'Managed Channel belongs to another user.')
    }
    return container
  }

  async listManagedContainers(actor: UserActor): Promise<StoredManagedContainer[]> {
    return this.repository.listManagedContainersForOwner(actor.userId)
  }

  async inspectManagedContainer(actor: UserActor, input: {
    managedContainerId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredManagedContainer> {
    const response = await this.commit(actor, 'managed_container.inspect', input.idempotencyKey, input, async (tx, at) => {
      const current = required(await tx.getManagedContainer(input.managedContainerId), 'Managed container')
      await requireManagedContainerOwner(tx, actor.userId, current)
      if (current.revision !== input.expectedRevision) fail('revision_conflict', 'Managed Channel revision changed.')
      if (!current.externalContainerId) fail('validation_failed', 'Managed Channel has not completed initial provisioning.')
      if (!['active', 'drifted', 'failed'].includes(current.status)) {
        fail('invalid_state_transition', 'Managed Channel cannot be inspected during this lifecycle state.')
      }
      await tx.insertManagedContainerJob({
        jobId: newId('mcj'), managedContainerId: current.managedContainerId, operation: 'inspect',
        desiredRevision: current.revision, state: 'queued', attemptCount: 0, nextAttemptAt: at,
        createdAt: at, updatedAt: at
      })
      return {
        response: entityResponse('managed_container.inspect_requested', current),
        resourceKind: 'managed_provider_container',
        resourceId: current.managedContainerId
      }
    })
    return responseEntity<StoredManagedContainer>(response)
  }

  async reconcileManagedContainer(actor: UserActor, input: {
    managedContainerId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredManagedContainer> {
    const response = await this.commit(actor, 'managed_container.reconcile', input.idempotencyKey, input, async (tx, at) => {
      const current = required(await tx.getManagedContainer(input.managedContainerId), 'Managed container')
      await requireManagedContainerOwner(tx, actor.userId, current)
      if (current.revision !== input.expectedRevision) fail('revision_conflict', 'Managed Channel revision changed.')
      if (!current.externalContainerId) fail('validation_failed', 'Managed Channel has not completed initial provisioning.')
      if (!['drifted', 'failed'].includes(current.status)) {
        fail('invalid_state_transition', 'Only a drifted or failed managed Channel can be reconciled.')
      }
      const updated: StoredManagedContainer = {
        ...current,
        status: 'provisioning',
        safeErrorCode: undefined,
        revision: current.revision + 1,
        updatedAt: at
      }
      await tx.updateManagedContainer(updated, current.revision)
      await tx.insertManagedContainerJob({
        jobId: newId('mcj'), managedContainerId: updated.managedContainerId, operation: 'reconcile',
        desiredRevision: updated.revision, state: 'queued', attemptCount: 0, nextAttemptAt: at,
        createdAt: at, updatedAt: at
      })
      return { response: entityResponse('managed_container.reconciled', updated),
        resourceKind: 'managed_provider_container', resourceId: updated.managedContainerId }
    })
    return responseEntity<StoredManagedContainer>(response)
  }

  async archiveManagedContainer(actor: UserActor, input: {
    managedContainerId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<StoredManagedContainer> {
    const response = await this.commit(actor, 'managed_container.archive', input.idempotencyKey, input, async (tx, at) => {
      const current = required(await tx.getManagedContainer(input.managedContainerId), 'Managed container')
      await requireManagedContainerOwner(tx, actor.userId, current)
      if (current.revision !== input.expectedRevision) fail('revision_conflict', 'Managed Channel revision changed.')
      if (!current.externalContainerId) fail('validation_failed', 'Managed Channel has not completed initial provisioning.')
      if (!['active', 'drifted'].includes(current.status)) {
        fail('invalid_state_transition', 'Managed Channel cannot be archived during this lifecycle state.')
      }
      const projections = await tx.listProjectionsForOwner(actor.userId)
      const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
      for (const projection of projections) {
        if (
          projection.status === 'active' &&
          projection.locator.provider === current.provider &&
          projection.locator.realmId === current.realmId &&
          projection.locator.containerId === current.externalContainerId
        ) {
          const changed = {
            ...projection,
            status: 'paused',
            lastErrorCode: 'managed_container_archived',
            revision: projection.revision + 1,
            updatedAt: at
          } satisfies StoredProjection
          await tx.updateProjection(changed, projection.revision)
          const message = await this.appendInbox(tx, { kind: 'agent', id: projection.agentId }, 'projection.updated', {
            protocolVersion: '1.0', type: 'projection.updated', projectionId: projection.projectionId,
            revision: changed.revision
          }, at)
          notifications.push({ recipient: message.recipient, sequence: message.sequence })
        }
      }
      const updated: StoredManagedContainer = {
        ...current,
        status: 'suspended',
        safeErrorCode: undefined,
        revision: current.revision + 1,
        updatedAt: at
      }
      await tx.updateManagedContainer(updated, current.revision)
      await tx.insertManagedContainerJob({
        jobId: newId('mcj'), managedContainerId: updated.managedContainerId, operation: 'archive',
        desiredRevision: updated.revision, state: 'queued', attemptCount: 0, nextAttemptAt: at,
        createdAt: at, updatedAt: at
      })
      return { response: entityResponse('managed_container.archive_requested', updated),
        resourceKind: 'managed_provider_container', resourceId: updated.managedContainerId, notifications }
    })
    return responseEntity<StoredManagedContainer>(response)
  }

  async getReceipt(actor: AuthContext, receiptId: string): Promise<StoredReceipt | null> {
    assertText(receiptId, 'receiptId', 8, 100)
    const receipt = await this.repository.getReceiptById(receiptId)
    if (!receipt) return null
    if (receipt.actorKey !== actor.actorKey) fail('permission_denied', 'The receipt belongs to another authenticated actor.')
    return receipt
  }

  pruneExpired(): Promise<{ inboxMessages: number; receipts: number; challenges: number; humanRequests: number }> {
    return this.repository.pruneExpired(this.timestamp())
  }

  async recordRejectedBoundary(actor: AuthContext, operation: string, error: CollaborationServiceError): Promise<void> {
    if (error.auditRecorded) return
    await this.repository.transaction((tx) => tx.insertAudit({
      auditEventId: newId('audit'), actorKind: actor.kind, ...actorAuditIdentity(actor), action: operation,
      outcome: 'rejected', metadata: safeAuditMetadata({ errorCode: error.code }), createdAt: this.timestamp()
    }))
    error.auditRecorded = true
  }

  private async pauseEndpointProjections(
    repository: CollaborationTransaction,
    endpoint: StoredEndpoint,
    at: string,
    errorCode: string
  ): Promise<Array<{ recipient: InboxRecipient; sequence: number }>> {
    const notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
    for (const projection of await repository.listProjectionsForOwner(endpoint.userId)) {
      if (projection.humanEndpointId !== endpoint.humanEndpointId || projection.status !== 'active') continue
      const changed = { ...projection, status: 'paused' as const, lastErrorCode: errorCode,
        revision: projection.revision + 1, updatedAt: at }
      await repository.updateProjection(changed, projection.revision)
      const message = await this.appendInbox(
        repository,
        { kind: 'agent', id: projection.agentId },
        'projection.updated',
        { protocolVersion: '1.0', type: 'projection.updated', projectionId: projection.projectionId,
          revision: changed.revision },
        at
      )
      notifications.push({ recipient: message.recipient, sequence: message.sequence })
    }
    return notifications
  }

  private async appendInbox(
    tx: CollaborationTransaction,
    recipient: InboxRecipient,
    messageType: string,
    payload: Record<string, unknown>,
    at: string
  ): Promise<StoredInboxMessage> {
    return tx.appendInbox({ recipient, messageId: newId('ibx'), messageType, payload,
      createdAt: at, expiresAt: new Date(new Date(at).getTime() + this.inboxRetentionMs).toISOString() })
  }

  private async commit(
    actor: AuthContext,
    operation: string,
    idempotencyKey: string,
    request: unknown,
    work: (tx: CollaborationTransaction, at: string) => Promise<CommandResult<Record<string, unknown>>>,
    atOverride?: string
  ): Promise<Record<string, unknown>> {
    assertText(idempotencyKey, 'idempotencyKey', 8, 300)
    const requestDigest = stableDigest(idempotencyBusinessPayload(request))
    const at = atOverride ?? this.timestamp()
    let notifications: Array<{ recipient: InboxRecipient; sequence: number }> = []
    let response: Record<string, unknown>
    try {
      response = await this.repository.transaction(async (tx) => {
      await tx.lockIdempotency(actor.actorKey, idempotencyKey)
      let actorDevice: StoredDevice | undefined
      const routeLocksActorDevice = actor.kind === 'agent_device' &&
        (operation === 'task.create' || operation === 'task.retry')
      if (actor.kind === 'agent_device' && !routeLocksActorDevice) {
        const device = await tx.getDeviceForUpdate(actor.deviceId)
        if (!device || device.status !== 'active' || device.userId !== actor.userId) {
          fail('credential_revoked', 'The Agent Device is no longer active.')
        }
        actorDevice = device
        if (operation === 'credential.revoke_current') {
          await assertCurrentAgentBearer(tx, actor, device, this.timestamp())
        }
      }
      const existing = await tx.getReceipt(actor.actorKey, idempotencyKey)
      if (existing) {
        if (existing.requestDigest !== requestDigest || existing.operation !== operation) {
          fail('idempotency_conflict', 'The idempotency key was already used for a different request.')
        }
        if (actor.kind === 'agent_device' && operation !== 'credential.revoke_current') {
          actorDevice ??= required(await tx.getDeviceForUpdate(actor.deviceId), 'Agent Device')
          await assertCurrentAgentBearer(tx, actor, actorDevice, this.timestamp())
        }
        return existing.response
      }
      const result = await work(tx, at)
      if (actor.kind === 'agent_device' && operation !== 'credential.revoke_current') {
        // Task routing locked every participating Device in stable deviceId
        // order inside work(); this lookup reuses that row lock. Other Agent
        // writes retain the generic Device-first fence above.
        actorDevice ??= required(await tx.getDeviceForUpdate(actor.deviceId), 'Agent Device')
        await assertCurrentAgentBearer(tx, actor, actorDevice, this.timestamp())
      }
      notifications = result.notifications ?? []
      const audit: StoredAuditEvent = {
        auditEventId: newId('audit'), actorKind: actor.kind,
        ...actorAuditIdentity(actor), action: operation, resourceKind: result.resourceKind, resourceId: result.resourceId,
        outcome: 'accepted', metadata: safeAuditMetadata({ idempotencyKeyDigest: stableDigest(idempotencyKey) }), createdAt: at
      }
      await tx.insertAudit(audit)
      if (result.persistReceipt !== false) {
        const receiptResponse = result.receiptResponse ?? result.response
        const receipt: StoredReceipt = {
          receiptId: operationReceiptId(actor.actorKey, idempotencyKey), actorKey: actor.actorKey,
          idempotencyKey, requestDigest, operation, resourceKind: result.resourceKind,
          resourceId: result.resourceId, response: receiptResponse, createdAt: at,
          expiresAt: new Date(new Date(at).getTime() + this.receiptRetentionMs).toISOString()
        }
        await tx.insertReceipt(receipt)
      }
      return result.response
      })
    } catch (error) {
      const serviceError = error instanceof CollaborationServiceError ? error : undefined
      const auditRecorded = await this.repository.transaction((tx) => tx.insertAudit({
        auditEventId: newId('audit'), actorKind: actor.kind, ...actorAuditIdentity(actor), action: operation,
        outcome: 'rejected', metadata: safeAuditMetadata({ idempotencyKeyDigest: stableDigest(idempotencyKey),
          errorCode: serviceError?.code ?? 'internal_error' }), createdAt: this.timestamp()
      })).then(() => true).catch(() => false)
      if (serviceError && auditRecorded) serviceError.auditRecorded = true
      throw error
    }
    for (const notification of notifications) {
      await this.notifier?.notifyInboxAvailable(notification.recipient, notification.sequence)
    }
    return response
  }

  private timestamp(): string { return this.now().toISOString() }
}

async function requireOwnedManagedLocator(
  repository: CollaborationReadRepository,
  ownerUserId: string,
  endpoint: StoredEndpoint,
  locator: ProviderLocatorValue
): Promise<void> {
  const container = await repository.getManagedContainerForOwner(
    ownerUserId,
    endpoint.provider,
    endpoint.realmId
  )
  if (
    !container ||
    container.humanEndpointId !== endpoint.humanEndpointId ||
    container.status !== 'active' ||
    !container.externalContainerId ||
    locator.containerId !== container.externalContainerId
  ) {
    fail('permission_denied', 'Projection locator must belong to the authenticated user\'s active managed Channel.')
  }
}

async function requireManagedContainerOwner(
  repository: CollaborationReadRepository,
  ownerUserId: string,
  container: StoredManagedContainer
): Promise<StoredEndpoint> {
  if (container.ownerUserId !== ownerUserId) {
    fail('permission_denied', 'Managed Channel belongs to another user.')
  }
  const endpoint = required(await repository.getEndpoint(container.humanEndpointId), 'Managed Channel endpoint')
  if (
    endpoint.userId !== ownerUserId ||
    endpoint.status !== 'active' ||
    endpoint.provider !== container.provider ||
    endpoint.realmId !== container.realmId ||
    endpoint.providerUserId !== container.ownerProviderUserId
  ) {
    fail('permission_denied', 'Managed Channel requires its active verified owner endpoint.')
  }
  return endpoint
}

function actorAuditIdentity(actor: AuthContext): Pick<StoredAuditEvent, 'actorUserId' | 'actorEndpointId' | 'actorAgentId'> {
  switch (actor.kind) {
    case 'system': return {}
    case 'user': return { actorUserId: actor.userId }
    case 'human_endpoint': return { actorUserId: actor.userId, actorEndpointId: actor.humanEndpointId }
    case 'agent_device': return { actorUserId: actor.userId, actorAgentId: actor.agentId }
  }
}

function idempotencyBusinessPayload(request: unknown): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request
  const record = request as Record<string, unknown>
  if (record.protocolVersion !== '1.0' || typeof record.requestId !== 'string' ||
      typeof record.type !== 'string') {
    return request
  }
  const businessPayload = { ...record }
  delete businessPayload.protocolVersion
  delete businessPayload.requestId
  delete businessPayload.type
  return businessPayload
}

function entityResponse<T>(type: string, entity: T): Record<string, unknown> {
  return { protocolVersion: '1.0', type, entity }
}

function operationReceiptId(actorKey: string, idempotencyKey: string): string {
  return `rcp_${stableDigest({ actorKey, idempotencyKey }).slice(0, 24)}`
}

export function providerIdentityInboxId(recipient: ProviderDirectRecipient): string {
  return `pdi_${stableDigest({
    provider: recipient.provider,
    realmId: recipient.realmId,
    providerUserId: recipient.providerUserId
  })}`
}

function assertProviderIdentityInboxId(value: string): void {
  if (!/^pdi_[a-f0-9]{64}$/u.test(value)) {
    fail('validation_failed', 'A valid provider identity inbox ID is required.')
  }
}

function providerCommandResultText(
  result: 'success' | 'invalid_or_expired' | 'identity_conflict'
): string {
  switch (result) {
    case 'success': return '绑定成功，可以返回 SciForge 继续使用。'
    case 'invalid_or_expired': return '绑定码无效或已失效，请重新生成。'
    case 'identity_conflict': return '该聊天身份无法完成绑定，请在 SciForge 中检查当前绑定状态。'
  }
}

function responseEntity<T>(response: Record<string, unknown>): T {
  return response.entity as T
}

function required<T>(value: T | null, label: string): T {
  if (value === null) fail('not_found', `${label} was not found.`)
  return value
}

function expectRevision(current: number, expected: number): void {
  if (current !== expected) fail('revision_conflict', 'The resource revision is stale.', { details: { currentRevision: current } })
}

function completeParticipant(participant: StoredParticipant): StoredParticipant {
  return { ...participant, status: participant.primaryHumanEndpointId && participant.primaryAgentId ? 'complete' : 'incomplete' }
}

function contractTaskStatus(status: TaskStatus):
  'offered' | 'accepted' | 'rejected' | 'running' | 'needs_human' | 'succeeded' | 'failed' | 'cancelled' {
  if (status === 'in_progress') return 'running'
  if (status === 'completed') return 'succeeded'
  return status
}

const WORKER_PRESENCE_LEASE_MS = 60_000

function deriveWorkerPresence(
  agent: Pick<StoredAgent, 'connectionStatus' | 'lastSeenAt'>,
  busy: boolean,
  at: string
): 'online' | 'busy' | 'offline' {
  const lastSeen = agent.lastSeenAt ? new Date(agent.lastSeenAt).getTime() : Number.NaN
  const now = new Date(at).getTime()
  const online = agent.connectionStatus === 'online' && Number.isFinite(lastSeen) && Number.isFinite(now) &&
    now - lastSeen <= WORKER_PRESENCE_LEASE_MS && lastSeen <= now + 60_000
  return online ? (busy ? 'busy' : 'online') : 'offline'
}

function isTimestampAfter(value: string, boundary: string): boolean {
  const timestamp = new Date(value).getTime()
  const boundaryTimestamp = new Date(boundary).getTime()
  return Number.isFinite(timestamp) && Number.isFinite(boundaryTimestamp) && timestamp > boundaryTimestamp
}

function assertPageLimit(limit: number): void {
  integer(limit, 'limit', 1, 50)
}

function assertPortalCoordinationBound(label: string, values: readonly unknown[], maximum: number): void {
  if (values.length > maximum) {
    fail('payload_too_large', `The Portal coordination ${label} exceed the fixed bounded view.`)
  }
}

function assertProjectCoordinationMaterializationCounts(
  counts: ProjectCoordinationMaterializationCounts
): bigint {
  const metrics = [
    ['activeMembers', counts.activeMembers, 1_000],
    ['tasks', counts.tasks, MAX_PROJECT_COORDINATION_TASKS],
    ['records', counts.records, MAX_PROJECT_RECORDS_PER_PROJECT],
    ['humanRequests', counts.humanRequests, MAX_HUMAN_REQUESTS_PER_PROJECT],
    ['humanAnswers', counts.humanAnswers, MAX_HUMAN_REQUESTS_PER_PROJECT]
  ] as const
  let rowCount = 0n
  for (const [label, count, maximumRows] of metrics) {
    const collectionRows = projectCoordinationPreflightInteger(count, `${label}.rowCount`)
    if (collectionRows > BigInt(maximumRows)) failProjectCoordinationMaterializationLimit()
    rowCount += collectionRows
  }
  if (rowCount > BigInt(MAX_PROJECT_COORDINATION_MATERIALIZED_ROWS)) {
    failProjectCoordinationMaterializationLimit()
  }
  return rowCount
}

function assertProjectCoordinationMaterializationBytes(
  project: StoredProject,
  rowCount: bigint,
  bytes: ProjectCoordinationMaterializationBytes
): void {
  const metrics = [
    ['activeMembers', bytes.activeMembers],
    ['tasks', bytes.tasks],
    ['records', bytes.records],
    ['humanRequests', bytes.humanRequests],
    ['humanAnswers', bytes.humanAnswers]
  ] as const
  let serializedBytes = 0n
  for (const [label, value] of metrics) {
    serializedBytes += projectCoordinationPreflightInteger(value, `${label}.serializedBytes`)
  }
  const projectBytes = BigInt(Buffer.byteLength(JSON.stringify(project), 'utf8'))
  const conservativeBytes = serializedBytes +
    rowCount * BigInt(PROJECT_COORDINATION_MATERIALIZATION_ROW_OVERHEAD_BYTES) +
    projectBytes + BigInt(PROJECT_COORDINATION_MATERIALIZATION_FIXED_OVERHEAD_BYTES)
  if (conservativeBytes > BigInt(MAX_PROJECT_COORDINATION_MATERIALIZED_BYTES)) {
    failProjectCoordinationMaterializationLimit()
  }
}

function assertProjectCoordinationMaterializedBytes(view: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')
  if (bytes > MAX_PROJECT_COORDINATION_MATERIALIZED_BYTES) {
    failProjectCoordinationMaterializationLimit()
  }
}

function projectCoordinationPreflightInteger(value: string, label: string): bigint {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    fail('internal_error', `The Project coordination preflight ${label} is invalid.`)
  }
  return BigInt(value)
}

function failProjectCoordinationMaterializationLimit(): never {
  fail('payload_too_large', 'The Project coordination view exceeds the fixed materialization limit.')
}

function encodePageCursor(scope: string, key: string): string {
  return `p1.${Buffer.from(`${scope}\u0000${key}`, 'utf8').toString('base64url')}`
}

function decodePageCursor(cursor: string, scope: string): string {
  const match = /^p1\.([A-Za-z0-9_-]{1,2048})$/u.exec(cursor)
  if (!match) fail('validation_failed', 'The page cursor is malformed.')
  let decoded: string
  try {
    decoded = Buffer.from(match[1]!, 'base64url').toString('utf8')
  } catch {
    fail('validation_failed', 'The page cursor is malformed.')
  }
  const prefix = `${scope}\u0000`
  if (!decoded!.startsWith(prefix) || decoded!.length <= prefix.length || decoded!.length > prefix.length + 512 ||
      encodePageCursor(scope, decoded!.slice(prefix.length)) !== cursor) {
    fail('validation_failed', 'The page cursor does not belong to this directory.')
  }
  return decoded!.slice(prefix.length)
}

function decodeProjectPageCursor(cursor: string): { updatedAt: string; projectId: string } {
  const key = decodePageCursor(cursor, 'projects')
  const separator = key.indexOf('\u001f')
  if (separator < 1 || separator !== key.lastIndexOf('\u001f') || separator >= key.length - 1) {
    fail('validation_failed', 'The Project page cursor is malformed.')
  }
  const updatedAt = key.slice(0, separator)
  const projectId = key.slice(separator + 1)
  const timestamp = new Date(updatedAt)
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== updatedAt ||
      !/^prj_[A-Za-z0-9_-]{8,128}$/u.test(projectId)) {
    fail('validation_failed', 'The Project page cursor is malformed.')
  }
  return { updatedAt, projectId }
}

function encodeCoordinationPageCursor(scope: string, projectId: string, entityId: string): string {
  return encodePageCursor(scope, `${projectId}\u001f${entityId}`)
}

function decodeCoordinationPageCursor(
  cursor: string,
  scope: string,
  projectId: string,
  entityPrefix: 'tsk_' | 'rec_' | 'hrq_'
): string {
  const key = decodePageCursor(cursor, scope)
  const separator = key.indexOf('\u001f')
  if (separator < 1 || separator !== key.lastIndexOf('\u001f') || separator >= key.length - 1 ||
      key.slice(0, separator) !== projectId) {
    fail('validation_failed', 'The coordination page cursor does not belong to this Project.')
  }
  const entityId = key.slice(separator + 1)
  if (!entityId.startsWith(entityPrefix) || !/^[A-Za-z0-9_-]{12,160}$/u.test(entityId)) {
    fail('validation_failed', 'The coordination page cursor is malformed.')
  }
  return entityId
}

async function lockProviderLocator(tx: CollaborationTransaction, locator: ProviderLocatorValue): Promise<void> {
  await tx.lockIdempotency('provider-locator', stableDigest({
    provider: locator.provider,
    realmId: locator.realmId,
    containerId: locator.containerId,
    topicId: locator.topicId
  }))
}

async function lockProviderLocators(tx: CollaborationTransaction, locators: ProviderLocatorValue[]): Promise<void> {
  const unique = [...new Map(locators.map((locator) => [stableDigest(locator), locator])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
  for (const [, locator] of unique) await lockProviderLocator(tx, locator)
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('validation_failed', `${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value
}

function assertText(value: string, label: string, minimum: number, maximum: number): void {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum) {
    fail('validation_failed', `${label} must contain between ${minimum} and ${maximum} characters.`)
  }
}

function uniqueTexts(values: string[], maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) fail('validation_failed', `At most ${maximumItems} values are allowed.`)
  const output = [...new Set(values)]
  for (const value of output) assertText(value, 'list item', 1, maximumLength)
  return output
}

function assertCapabilityRequirements(
  profile: StoredAgentCapabilityProfile,
  requirements: StoredWorkerRequirement
): void {
  if (requirements.osFamilies && !requirements.osFamilies.includes(profile.osFamily)) {
    fail('permission_denied', 'The assignee capability profile does not satisfy the Task OS requirement.')
  }
  const evidenceRanks = { detected: 0, configured: 1, verified: 2 } as const
  const minimumEvidence = requirements.minimumEvidenceLevel
  const capabilities = new Map(profile.capabilities.map((capability) => [capability.capabilityId, capability]))
  for (const capabilityId of requirements.capabilityIds) {
    const capability = capabilities.get(capabilityId)
    if (!capability || (minimumEvidence !== undefined &&
        evidenceRanks[capability.evidence.level] < evidenceRanks[minimumEvidence])) {
      fail('permission_denied', 'The assignee capability profile does not satisfy the Task capability requirement.')
    }
  }
  if (requirements.minGpuMemoryGB !== undefined &&
      !profile.gpu.some((gpu) => gpu.memoryGB !== undefined && gpu.memoryGB >= requirements.minGpuMemoryGB!)) {
    fail('permission_denied', 'The assignee capability profile does not satisfy the Task GPU requirement.')
  }
  for (const vpnAccessId of requirements.vpnAccessIds) {
    if (!profile.vpnAccessIds.includes(vpnAccessId)) {
      fail('permission_denied', 'The assignee capability profile does not satisfy the Task VPN requirement.')
    }
  }
  for (const slurmClusterId of requirements.slurmClusterIds) {
    if (!profile.slurmClusterIds.includes(slurmClusterId)) {
      fail('permission_denied', 'The assignee capability profile does not satisfy the Task Slurm requirement.')
    }
  }
  for (const resourceRefId of requirements.requiredResourceRefIds) {
    if (!profile.accessibleResourceRefIds.includes(resourceRefId)) {
      fail('permission_denied', 'The assignee capability profile cannot access a required ResourceRef.')
    }
  }
  if (requirements.requireLogSummary === true && !profile.resultReturnPolicy.logSummary) {
    fail('permission_denied', 'The assignee capability profile cannot return the required log summary.')
  }
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function assertActiveProjectMembershipCapacity(
  tx: CollaborationTransaction,
  userIds: readonly string[]
): Promise<void> {
  const stableUserIds = [...new Set(userIds)].sort(compareStable)
  if (stableUserIds.length === 0) return
  await tx.lockProjectMembershipUsers(stableUserIds)
  const countRows = await tx.countActiveProjectMembershipsByUserIds(stableUserIds)
  const counts = new Map<string, number>()
  for (const row of countRows) {
    if (!stableUserIds.includes(row.userId) || !Number.isSafeInteger(row.count) || row.count < 0 ||
        counts.has(row.userId)) {
      fail('internal_error', 'The active Project membership count invariant could not be verified.')
    }
    counts.set(row.userId, row.count)
  }
  if (stableUserIds.some((userId) => (
    (counts.get(userId) ?? 0) >= MAX_ACTIVE_PROJECT_MEMBERSHIPS_PER_USER
  ))) {
    fail('validation_failed', 'A User may belong to at most 1000 active Projects.')
  }
}

function clearTaskAttemptOutputs(task: StoredTask): StoredTask {
  const cleared = { ...task }
  delete cleared.progress
  delete cleared.resultSummary
  delete cleared.resultRecordId
  delete cleared.safeFailureCode
  delete cleared.safeFailureSummary
  return cleared
}

function inboxMessageProjectId(message: StoredInboxMessage): string | undefined {
  if (typeof message.payload.projectId === 'string') return message.payload.projectId
  const answer = message.payload.answer
  if (answer && typeof answer === 'object' && !Array.isArray(answer) &&
      typeof (answer as Record<string, unknown>).projectId === 'string') {
    return (answer as Record<string, unknown>).projectId as string
  }
  return undefined
}

function taskCriterionId(taskId: string, index: number): string {
  return `cri_${stableDigest({ taskId, index }).slice(0, 24)}`
}

async function affectedAgentProjectIds(
  tx: CollaborationTransaction,
  agentId: string
): Promise<string[]> {
  const projectIds = new Set(
    (await tx.listActiveProjectsForCoordinator(agentId)).map((project) => project.projectId)
  )
  for (const task of await tx.listOpenTasksForAgent(agentId)) projectIds.add(task.projectId)
  return [...projectIds].sort(compareStable)
}

async function assertNoActiveOwnedAgents(
  tx: CollaborationTransaction,
  userId: string
): Promise<void> {
  if ((await tx.listAgentsForUser(userId)).some((agent) => agent.status === 'active')) {
    fail('invalid_state_transition', 'Active Agents must be revoked or transferred before the User can become inactive.')
  }
}

async function isUsableAgent(
  repository: Pick<CollaborationReadRepository, 'getUser' | 'getDevice'>,
  agent: StoredAgent,
  knownOwner?: StoredUser
): Promise<boolean> {
  const deviceId = agent.deviceId
  if (agent.status !== 'active' || !deviceId) return false
  const [owner, device] = await Promise.all([
    knownOwner ? Promise.resolve(knownOwner) : repository.getUser(agent.ownerUserId),
    repository.getDevice(deviceId)
  ])
  return owner?.userId === agent.ownerUserId && owner.status === 'active' &&
    device?.status === 'active' && device.userId === agent.ownerUserId
}

async function assertUsableAgent(
  repository: Pick<CollaborationReadRepository, 'getUser' | 'getDevice'>,
  agent: StoredAgent,
  message: string
): Promise<void> {
  if (!await isUsableAgent(repository, agent)) fail('permission_denied', message)
}

async function activeCoordinatorProjectIds(
  tx: CollaborationTransaction,
  agentId: string
): Promise<string[]> {
  return (await tx.listActiveProjectsForCoordinator(agentId))
    .map((project) => project.projectId)
    .sort(compareStable)
}

async function lockProjectsForUpdate(
  tx: CollaborationTransaction,
  projectIds: string[]
): Promise<Map<string, StoredProject>> {
  const locked = new Map<string, StoredProject>()
  for (const projectId of [...new Set(projectIds)].sort(compareStable)) {
    locked.set(projectId, required(await tx.getProjectForUpdate(projectId), 'Project'))
  }
  return locked
}

function assertProjectLocksCover(
  lockedProjects: ReadonlyMap<string, StoredProject>,
  projectIds: string[]
): void {
  if (projectIds.some((projectId) => !lockedProjects.has(projectId))) {
    fail('revision_conflict', 'Agent Project assignments changed while acquiring write locks.', { retryable: true })
  }
}

async function lockAgentsForUpdate(
  tx: CollaborationTransaction,
  agentIds: string[]
): Promise<Map<string, StoredAgent>> {
  const locked = new Map<string, StoredAgent>()
  for (const agentId of [...new Set(agentIds)].sort(compareStable)) {
    locked.set(agentId, required(await tx.getAgentForUpdate(agentId), 'Agent'))
  }
  return locked
}

type AgentRouteLockRequest = Readonly<{
  agentId: string
  label: string
  unavailableCode?: CollaborationErrorCode
  unavailableMessage: string
}>

type AgentRouteLockPlan = Readonly<{
  requests: ReadonlyMap<string, AgentRouteLockRequest>
  initialAgents: ReadonlyMap<string, StoredAgent>
  devices: ReadonlyMap<string, StoredDevice>
}>

async function prepareAgentRouteLocks(
  tx: CollaborationTransaction,
  requestedAgents: AgentRouteLockRequest[]
): Promise<AgentRouteLockPlan> {
  const requests = new Map<string, AgentRouteLockRequest>()
  for (const request of requestedAgents) {
    const existing = requests.get(request.agentId)
    if (!existing || request.unavailableCode === 'credential_revoked') requests.set(request.agentId, request)
  }

  // Agent is read without a row lock only to discover the immutable active
  // Device link. Every Device is then locked in a stable order before any
  // Agent row, matching the Agent-actor transaction fence and Device revoke.
  const initialAgents = new Map<string, StoredAgent>()
  for (const agentId of [...requests.keys()].sort(compareStable)) {
    const request = requests.get(agentId)!
    const agent = required(await tx.getAgent(agentId), request.label)
    if (!agent.deviceId) fail(request.unavailableCode ?? 'permission_denied', request.unavailableMessage)
    initialAgents.set(agentId, agent)
  }

  const devices = new Map<string, StoredDevice>()
  const deviceIds = [...new Set([...initialAgents.values()].map((agent) => agent.deviceId!))]
    .sort(compareStable)
  for (const deviceId of deviceIds) {
    const device = await tx.getDeviceForUpdate(deviceId)
    if (device) devices.set(deviceId, device)
  }
  return { requests, initialAgents, devices }
}

async function finishAgentRouteLocks(
  tx: CollaborationTransaction,
  plan: AgentRouteLockPlan
): Promise<Map<string, StoredAgent>> {
  const lockedAgents = new Map<string, StoredAgent>()
  for (const agentId of [...plan.requests.keys()].sort(compareStable)) {
    const request = plan.requests.get(agentId)!
    const initial = plan.initialAgents.get(agentId)!
    const agent = required(await tx.getAgentForUpdate(agentId), request.label)
    const device = initial.deviceId ? plan.devices.get(initial.deviceId) : undefined
    const owner = await tx.getUser(agent.ownerUserId)
    if (agent.status !== 'active' || !agent.deviceId || agent.deviceId !== initial.deviceId ||
        agent.ownerUserId !== initial.ownerUserId || !device || device.deviceId !== agent.deviceId ||
        device.status !== 'active' || device.userId !== agent.ownerUserId ||
        !owner || owner.userId !== agent.ownerUserId || owner.status !== 'active') {
      fail(request.unavailableCode ?? 'permission_denied', request.unavailableMessage)
    }
    lockedAgents.set(agentId, agent)
  }
  return lockedAgents
}

async function assertCurrentAgentProjectMembership(
  tx: CollaborationTransaction,
  actor: AgentActor,
  project: Pick<StoredProject, 'projectId'>,
  agent: StoredAgent
): Promise<void> {
  assertCurrentAgentActor(actor, agent)
  const membership = await tx.getProjectMember(project.projectId, agent.ownerUserId)
  if (!membership?.active || membership.role === 'observer') {
    fail('permission_denied', 'The authenticated Agent owner is not an executable Project member.')
  }
}

function assertCurrentAgentActor(actor: AgentActor, agent: StoredAgent): void {
  if (agent.agentId !== actor.agentId || agent.status !== 'active' || agent.ownerUserId !== actor.userId) {
    fail('credential_revoked', 'The authenticated Agent ownership is no longer current.')
  }
}

async function assertCurrentAgentBearer(
  tx: CollaborationTransaction,
  actor: AgentActor,
  device: StoredDevice,
  at: string
): Promise<void> {
  const agent = await tx.getAgentForUpdate(actor.agentId)
  const credential = await tx.getCredentialForUpdate(actor.credentialId)
  if (device.deviceId !== actor.deviceId || device.status !== 'active' || device.userId !== actor.userId ||
      !agent || agent.agentId !== actor.agentId || agent.status !== 'active' || agent.ownerUserId !== actor.userId ||
      agent.deviceId !== actor.deviceId || agent.deviceId !== device.deviceId ||
      agent.credentialGeneration !== actor.credentialGeneration) {
    fail('credential_revoked', 'The authenticated Agent identity is no longer current.')
  }
  if (!credential || credential.credentialId !== actor.credentialId || credential.kind !== 'agent_device' ||
      credential.subjectUserId !== actor.userId ||
      credential.subjectAgentId !== actor.agentId || credential.assurance !== actor.assurance ||
      credential.generation !== actor.credentialGeneration || credential.revokedAt ||
      (credential.expiresAt !== undefined && credential.expiresAt <= at)) {
    fail('credential_revoked', 'The authenticated Agent credential has expired or was revoked.')
  }
}

async function assertCurrentTaskActorMembership(
  tx: CollaborationTransaction,
  actor: AgentActor,
  project: Pick<StoredProject, 'projectId'>,
  task: StoredTask,
  executionId: string,
  agent: StoredAgent
): Promise<void> {
  assertCurrentTaskExecution(actor, task, executionId)
  await assertCurrentAgentProjectMembership(tx, actor, project, agent)
  if (task.assigneeUserId !== agent.ownerUserId) {
    fail('assignee_mismatch', 'The authenticated Agent owner is no longer the current Task assignee.')
  }
}

function assertCurrentTaskExecution(actor: AgentActor, task: StoredTask, executionId: string): void {
  if (actor.agentId !== task.assigneeAgentId) {
    fail('assignee_mismatch', 'The authenticated Agent is not the current Task assignee.')
  }
  if (executionId !== task.executionId) {
    fail('execution_conflict', 'The Task execution is no longer current.', {
      details: { currentRevision: task.revision, currentExecutionId: task.executionId }
    })
  }
}

async function consumeActionConfirmation(
  tx: CollaborationTransaction,
  actor: AgentActor,
  confirmationId: string | undefined,
  expectedAction: StoredConfirmableAction,
  project: Pick<StoredProject, 'projectId' | 'ownerUserId'>,
  operation: string,
  at: string
): Promise<void> {
  if (!confirmationId) fail('confirmation_required', 'This delegated action requires a Project owner confirmation.')
  const confirmation = required(await tx.getActionConfirmationForUpdate(confirmationId), 'Action confirmation')
  if (confirmation.status !== 'approved' || confirmation.expiresAt <= at) {
    fail('confirmation_mismatch', 'The action confirmation is expired, consumed, or superseded.')
  }
  if (expectedAction.projectId !== project.projectId ||
      confirmation.projectId !== project.projectId ||
      confirmation.targetUserId !== project.ownerUserId ||
      confirmation.action.projectId !== confirmation.projectId ||
      confirmation.coordinatorAgentId !== actor.agentId ||
      confirmation.actionDigest !== stableDigest(expectedAction)) {
    fail('confirmation_mismatch', 'The action confirmation does not match this actor or immutable action.')
  }
  await tx.updateActionConfirmation({ ...confirmation, status: 'consumed', consumedAt: at,
    consumedByActorKey: actor.actorKey, consumedOperation: operation, updatedAt: at })
}

async function supersedeApprovedActionConfirmations(
  tx: CollaborationTransaction,
  projectId: string,
  at: string,
  conflicts: (confirmation: StoredActionConfirmation) => boolean
): Promise<void> {
  const confirmations = await tx.listApprovedActionConfirmationsForProjectForUpdate(projectId)
  for (const confirmation of confirmations) {
    if (!conflicts(confirmation)) continue
    await tx.updateActionConfirmation({ ...confirmation, status: 'superseded', updatedAt: at })
  }
}

async function invalidateApprovedGovernedActions(
  tx: CollaborationTransaction,
  projectId: string,
  at: string,
  conflicts: (action: StoredConfirmableAction) => boolean
): Promise<void> {
  for (const request of await tx.listHumanRequestsForProject(projectId)) {
    if (request.status !== 'pending' || !request.confirmableAction || !conflicts(request.confirmableAction)) continue
    await tx.updateHumanRequest({ ...request, status: request.expiresAt <= at ? 'expired' : 'cancelled',
      revision: request.revision + 1, updatedAt: at }, request.revision)
  }
  await supersedeApprovedActionConfirmations(tx, projectId, at,
    (confirmation) => conflicts(confirmation.action))
}

function normalizeBudgets(input: Partial<ProjectBudgets> | undefined): ProjectBudgets {
  return {
    maxTasks: integer(input?.maxTasks ?? DEFAULT_BUDGETS.maxTasks, 'maxTasks', 1, 10_000),
    maxTasksPerRound: integer(input?.maxTasksPerRound ?? DEFAULT_BUDGETS.maxTasksPerRound, 'maxTasksPerRound', 1, 1_000),
    maxTaskRetries: integer(input?.maxTaskRetries ?? DEFAULT_BUDGETS.maxTaskRetries, 'maxTaskRetries', 0, 100),
    maxCoordinationRounds: integer(input?.maxCoordinationRounds ?? DEFAULT_BUDGETS.maxCoordinationRounds, 'maxCoordinationRounds', 1, 1_000)
  }
}

function validateProjectSummary(summary: string): void {
  assertText(summary, 'summary', 1, 50_000)
  const forbidden = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(?:api[_ -]?key|password|bearer token)\s*[:=]/i,
    /(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/,
    /\b(?:full transcript|complete tool log)\b/i
  ]
  if (forbidden.some((pattern) => pattern.test(summary))) {
    fail('validation_failed', 'Project records accept bounded shared summaries only; credentials, local paths, transcripts, and tool logs are forbidden.')
  }
}

function assertProjectContentSpaceRoot(resource: StoredResourceRef, projectId: string): void {
  if (
    resource.projectId !== projectId ||
    resource.status !== 'available' ||
    resource.kind !== 'content-space.container-reference' ||
    !resource.portableReference ||
    resource.taskId !== undefined
  ) {
    fail(
      'resource_unavailable',
      'A Project Content Space root must be an available portable Project-level container ResourceRef.'
    )
  }
}

const RESOURCE_ACTIVE_TASK_STATUSES = new Set<TaskStatus>(['accepted', 'in_progress', 'needs_human'])

async function authorizeResourceCreate(
  tx: CollaborationTransaction,
  actor: UserActor | AgentActor,
  project: StoredProject,
  task: StoredTask | undefined,
  executionId: string | undefined
): Promise<void> {
  const member = await tx.getProjectMember(project.projectId, actor.userId)
  authorize({ actor, operation: 'record_submit', projectMember: Boolean(member?.active) })
  if (project.status !== 'active') {
    fail('invalid_state_transition', 'ResourceRefs may only be created for an active Project.')
  }
  if (task) {
    if (task.projectId !== project.projectId) {
      fail('validation_failed', 'The ResourceRef Task belongs to another Project.')
    }
    if (executionId !== task.executionId) {
      fail('execution_conflict', 'The ResourceRef Task execution is no longer current.', {
        details: { currentRevision: task.revision, currentExecutionId: task.executionId }
      })
    }
    if (
      actor.kind === 'agent_device' &&
      actor.agentId !== task.assigneeAgentId &&
      actor.agentId !== project.coordinatorAgentId
    ) {
      fail('assignee_mismatch', 'The authenticated Agent is not the current Task assignee or Coordinator.')
    }
    if (!RESOURCE_ACTIVE_TASK_STATUSES.has(task.status)) {
      fail('invalid_state_transition', 'Task-scoped ResourceRefs require an active Task execution.')
    }
  } else if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
    fail('permission_denied', 'Worker ResourceRefs require explicit Task provenance.')
  }
}

async function authorizeResourceInvalidation(
  tx: CollaborationTransaction,
  actor: UserActor | AgentActor,
  project: StoredProject,
  task: StoredTask | undefined
): Promise<void> {
  const member = await tx.getProjectMember(project.projectId, actor.userId)
  authorize({ actor, operation: 'record_submit', projectMember: Boolean(member?.active) })
  if (project.status !== 'active') {
    fail('invalid_state_transition', 'ResourceRefs may only be invalidated for an active Project.')
  }
  if (!task) {
    if (actor.kind === 'agent_device' && actor.agentId !== project.coordinatorAgentId) {
      fail('permission_denied', 'Only the Coordinator Agent may manage Project-level ResourceRefs.')
    }
    return
  }
  if (task.projectId !== project.projectId) {
    fail('validation_failed', 'The ResourceRef Task belongs to another Project.')
  }
  if (actor.kind !== 'agent_device' || actor.agentId === project.coordinatorAgentId) return
  if (actor.agentId !== task.assigneeAgentId) {
    fail('assignee_mismatch', 'The authenticated Agent is not the current Task assignee or Coordinator.')
  }
  if (!RESOURCE_ACTIVE_TASK_STATUSES.has(task.status)) {
    fail('invalid_state_transition', 'A Worker may only invalidate ResourceRefs for its active Task execution.')
  }
}

function toHumanNeededEntity(request: StoredHumanRequest): Record<string, unknown> {
  return { schemaVersion: 1, type: 'human_needed', humanRequestId: request.humanRequestId,
    projectId: request.projectId, sourceKind: request.sourceKind,
    taskId: request.taskId ?? null,
    executionId: request.executionId ?? null,
    sourceInboxMessageId: request.sourceInboxMessageId ?? null,
    targetUserId: request.targetUserId,
    requestedByAgentId: request.requestedByAgentId, requiredAssurance: request.requiredAssurance,
    prompt: request.prompt, confirmableAction: request.confirmableAction ?? null,
    status: request.status, expiresAt: request.expiresAt,
    revision: request.revision, createdAt: request.createdAt, updatedAt: request.updatedAt }
}

function humanNeededProviderText(request: StoredHumanRequest): string {
  const replyInstruction = `\n\n回复命令：sciforge-answer ${request.humanRequestId} ${request.revision} <answer>`
  return `${request.prompt.slice(0, Math.max(0, 32_000 - replyInstruction.length))}${replyInstruction}`
}

function toHumanAnswerEntity(answer: StoredHumanAnswer): Record<string, unknown> {
  return { schemaVersion: 1, type: 'human_answer', humanAnswerId: answer.humanAnswerId,
    humanRequestId: answer.humanRequestId, projectId: answer.projectId,
    taskId: answer.taskId ?? null,
    executionId: answer.executionId ?? null,
    requestRevision: answer.requestRevision, answeredByUserId: answer.answeredByUserId,
    answeredFromHumanEndpointId: answer.answeredFromHumanEndpointId, assurance: answer.assurance,
    answer: answer.answer, decision: answer.decision ?? null,
    confirmationId: answer.confirmationId ?? null,
    answeredAt: answer.answeredAt, revision: answer.revision,
    createdAt: answer.createdAt, updatedAt: answer.updatedAt }
}
