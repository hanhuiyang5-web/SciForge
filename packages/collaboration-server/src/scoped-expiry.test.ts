import { describe, expect, it } from 'vitest'

import { FakeCollaborationRepository } from '../../../test-fixtures/collaboration/fake-adapters.mjs'
import type { HumanEndpointActor, UserActor } from './auth.js'
import type {
  InboxRecipient,
  StoredActionConfirmation,
  StoredHumanRequest,
  StoredProject
} from './model.js'
import { CollaborationService } from './service.js'

const COMMAND_AT = '2026-08-15T04:00:00.000Z'
const CREATED_AT = '2026-08-15T01:00:00.000Z'
const EXPIRED_AT = '2026-08-15T03:00:00.000Z'
const FUTURE_AT = '2026-08-15T05:00:00.000Z'

function userActor(userId: string): UserActor {
  return {
    kind: 'user',
    actorKey: `user:${userId}`,
    userId,
    identityId: `oid_${userId}`,
    issuer: 'https://issuer.example.invalid',
    subject: `subject-${userId}`,
    authTime: 1,
    assurance: 'verified'
  }
}

function endpointActor(userId: string): HumanEndpointActor {
  return {
    kind: 'human_endpoint',
    actorKey: `endpoint:hep_${userId}:revision:1`,
    userId,
    humanEndpointId: `hep_${userId}`,
    assurance: 'verified'
  }
}

function project(projectId: string, ownerUserId: string): StoredProject {
  return {
    projectId,
    ownerUserId,
    displayName: 'Scoped expiry project',
    goal: 'Prove public reads and writes never invoke global expiry pruning.',
    status: 'active',
    coordinatorAgentId: `agt_${projectId}`,
    budgets: { maxTasks: 10, maxTasksPerRound: 5, maxTaskRetries: 2, maxCoordinationRounds: 5 },
    coordinationRound: 1,
    revision: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  }
}

function humanRequest(input: {
  humanRequestId: string
  projectId: string
  targetUserId: string
  expiresAt?: string
}): StoredHumanRequest {
  return {
    humanRequestId: input.humanRequestId,
    projectId: input.projectId,
    sourceKind: 'coordinator',
    targetUserId: input.targetUserId,
    requestedByAgentId: `agt_${input.projectId}`,
    requiredAssurance: 'verified',
    prompt: 'Continue?',
    status: 'pending',
    revision: 1,
    expiresAt: input.expiresAt ?? EXPIRED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  }
}

function confirmation(input: {
  confirmationId: string
  projectId: string
  targetUserId: string
  expiresAt?: string
}): StoredActionConfirmation {
  return {
    confirmationId: input.confirmationId,
    humanRequestId: `hrq_${input.confirmationId}`,
    projectId: input.projectId,
    targetUserId: input.targetUserId,
    coordinatorAgentId: `agt_${input.projectId}`,
    action: { kind: 'project.complete', projectId: input.projectId, finalRecordDigest: 'sha256:final' },
    actionDigest: '0'.repeat(64),
    status: 'approved',
    approvedAt: CREATED_AT,
    expiresAt: input.expiresAt ?? EXPIRED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT
  }
}

async function appendInboxMessage(
  repository: FakeCollaborationRepository,
  recipient: InboxRecipient,
  messageId: string,
  expiresAt: string
): Promise<void> {
  await repository.transaction((tx) => tx.appendInbox({
    recipient,
    messageId,
    messageType: 'test.message',
    payload: { protocolVersion: '1.0', type: 'test.message' },
    createdAt: CREATED_AT,
    expiresAt
  }).then(() => undefined))
}

describe('public scoped expiry paths', () => {
  it('pulls a cursor-consistent page after superseding only this recipient\'s unacknowledged expiry', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now: () => new Date(COMMAND_AT) })
    const actor = userActor('usr_InboxOwner001')
    const recipient: InboxRecipient = { kind: 'user', id: actor.userId }
    const otherRecipient: InboxRecipient = { kind: 'user', id: 'usr_OtherInbox001' }

    await appendInboxMessage(repository, recipient, 'ibx_AckedExpired001', EXPIRED_AT)
    await appendInboxMessage(repository, recipient, 'ibx_UnackedExpired1', EXPIRED_AT)
    await appendInboxMessage(repository, recipient, 'ibx_ActiveFuture001', FUTURE_AT)
    await appendInboxMessage(repository, recipient, 'ibx_ActiveFuture002', FUTURE_AT)
    await appendInboxMessage(repository, otherRecipient, 'ibx_OtherExpired001', EXPIRED_AT)
    await repository.transaction((tx) => tx.ackInbox(recipient, 1, CREATED_AT).then(() => undefined))

    const unrelatedRequest = humanRequest({
      humanRequestId: 'hrq_UnrelatedExpiry1',
      projectId: 'prj_UnrelatedExpiry1',
      targetUserId: actor.userId
    })
    const unrelatedConfirmation = confirmation({
      confirmationId: 'cnf_UnrelatedExpiry1',
      projectId: unrelatedRequest.projectId,
      targetUserId: actor.userId
    })
    repository.state.humanRequests.set(unrelatedRequest.humanRequestId, structuredClone(unrelatedRequest))
    repository.state.actionConfirmations.set(
      unrelatedConfirmation.confirmationId,
      structuredClone(unrelatedConfirmation)
    )
    repository.pruneExpired = async () => { throw new Error('public Inbox pull must not globally prune') }

    const page = await service.pullInbox(actor, { afterSequence: 0, limit: 20 })

    expect(page).toMatchObject({ ackedSequence: 1, nextSequence: 5 })
    expect(page.messages.map(({ sequence, disposition }) => ({ sequence, disposition }))).toEqual([
      { sequence: 2, disposition: 'superseded' },
      { sequence: 3, disposition: 'active' },
      { sequence: 4, disposition: 'active' }
    ])
    expect(page.messages[0]).toMatchObject({ supersededAt: COMMAND_AT })
    expect(repository.state.inboxes.get('user:usr_InboxOwner001')?.[0]).toMatchObject({
      sequence: 1,
      disposition: 'active'
    })
    expect(repository.state.inboxes.get('user:usr_OtherInbox001')?.[0]).toMatchObject({
      disposition: 'active'
    })
    expect(repository.state.humanRequests.get(unrelatedRequest.humanRequestId)).toEqual(unrelatedRequest)
    expect(repository.state.actionConfirmations.get(unrelatedConfirmation.confirmationId))
      .toEqual(unrelatedConfirmation)

    await expect(service.ackInbox(actor, {
      throughSequence: 4,
      idempotencyKey: 'idem_scoped_gap_reject'
    })).rejects.toMatchObject({ code: 'inbox_ack_gap' })
    await expect(service.ackInbox(actor, {
      throughSequence: 3,
      idempotencyKey: 'idem_scoped_gap_to_three'
    })).resolves.toEqual({ ackedSequence: 3, nextSequence: 5 })
    await expect(service.ackInbox(actor, {
      throughSequence: 4,
      idempotencyKey: 'idem_scoped_gap_to_four'
    })).resolves.toEqual({ ackedSequence: 4, nextSequence: 5 })
  })

  it('projects expired approvals by id without mutating durable confirmation state', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now: () => new Date(COMMAND_AT) })
    const owner = userActor('usr_ConfirmationOwner')
    const stranger = userActor('usr_ConfirmationOther')
    const expired = confirmation({
      confirmationId: 'cnf_ScopedExpired001',
      projectId: 'prj_ScopedConfirm01',
      targetUserId: owner.userId
    })
    const future = confirmation({
      confirmationId: 'cnf_ScopedFuture0001',
      projectId: expired.projectId,
      targetUserId: owner.userId,
      expiresAt: FUTURE_AT
    })
    const unrelated = confirmation({
      confirmationId: 'cnf_ScopedOther0001',
      projectId: 'prj_ScopedConfirm02',
      targetUserId: stranger.userId
    })
    for (const item of [expired, future, unrelated]) {
      repository.state.actionConfirmations.set(item.confirmationId, structuredClone(item))
    }
    repository.pruneExpired = async () => { throw new Error('confirmation GET must not globally prune') }

    await expect(service.getActionConfirmation(owner, expired.confirmationId)).resolves.toEqual({
      ...expired,
      status: 'superseded'
    })
    await expect(service.getActionConfirmation(owner, future.confirmationId)).resolves.toEqual(future)
    await expect(service.getActionConfirmation(stranger, expired.confirmationId))
      .rejects.toMatchObject({ code: 'permission_denied' })
    await expect(service.getActionConfirmation(owner, 'cnf_ScopedUnknown01'))
      .rejects.toMatchObject({ code: 'not_found' })
    expect(repository.state.actionConfirmations.get(expired.confirmationId)).toEqual(expired)
    expect(repository.state.actionConfirmations.get(future.confirmationId)).toEqual(future)
    expect(repository.state.actionConfirmations.get(unrelated.confirmationId)).toEqual(unrelated)
  })

  it('authorizes by id before atomically expiring exactly one HumanNeeded request', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now: () => new Date(COMMAND_AT) })
    const owner = endpointActor('usr_HumanOwner001')
    const stranger = endpointActor('usr_HumanOther001')
    const storedProject = project('prj_ScopedHuman001', owner.userId)
    const target = humanRequest({
      humanRequestId: 'hrq_ScopedHuman001',
      projectId: storedProject.projectId,
      targetUserId: owner.userId
    })
    const unauthorizedTarget = humanRequest({
      humanRequestId: 'hrq_ScopedHuman002',
      projectId: storedProject.projectId,
      targetUserId: owner.userId
    })
    const unrelated = humanRequest({
      humanRequestId: 'hrq_ScopedHuman003',
      projectId: storedProject.projectId,
      targetUserId: owner.userId
    })
    repository.state.projects.set(storedProject.projectId, structuredClone(storedProject))
    for (const request of [target, unauthorizedTarget, unrelated]) {
      repository.state.humanRequests.set(request.humanRequestId, structuredClone(request))
    }
    repository.pruneExpired = async () => { throw new Error('human answer must not globally prune') }
    const originalExpire = repository.expireHumanRequestIfPending.bind(repository)
    const calls: unknown[][] = []
    repository.expireHumanRequestIfPending = async (...args) => {
      calls.push(args)
      return originalExpire(...args)
    }

    await expect(service.answerHumanNeeded(owner, {
      humanRequestId: 'hrq_ScopedUnknown01',
      requestRevision: 1,
      answer: 'Unknown.',
      idempotencyKey: 'idem_scoped_human_unknown'
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.answerHumanNeeded(stranger, {
      humanRequestId: unauthorizedTarget.humanRequestId,
      requestRevision: unauthorizedTarget.revision,
      answer: 'Not mine.',
      idempotencyKey: 'idem_scoped_human_denied'
    })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(calls).toHaveLength(0)

    await expect(service.answerHumanNeeded(owner, {
      humanRequestId: target.humanRequestId,
      requestRevision: target.revision,
      answer: 'Too late.',
      idempotencyKey: 'idem_scoped_human_expired'
    })).rejects.toMatchObject({ code: 'request_expired' })

    expect(calls).toEqual([[
      target.humanRequestId,
      target.targetUserId,
      target.revision,
      COMMAND_AT
    ]])
    expect(repository.state.humanRequests.get(target.humanRequestId)).toMatchObject({
      status: 'expired',
      revision: target.revision + 1,
      updatedAt: COMMAND_AT
    })
    expect(repository.state.humanRequests.get(unauthorizedTarget.humanRequestId)).toEqual(unauthorizedTarget)
    expect(repository.state.humanRequests.get(unrelated.humanRequestId)).toEqual(unrelated)
    expect(repository.state.humanAnswers.size).toBe(0)
  })

  it('increments an expired HumanNeeded revision only once under concurrent answers', async () => {
    const repository = new FakeCollaborationRepository()
    const service = new CollaborationService({ repository, now: () => new Date(COMMAND_AT) })
    const owner = endpointActor('usr_HumanRace001')
    const storedProject = project('prj_ScopedRace001', owner.userId)
    const target = humanRequest({
      humanRequestId: 'hrq_ScopedRace001',
      projectId: storedProject.projectId,
      targetUserId: owner.userId
    })
    repository.state.projects.set(storedProject.projectId, structuredClone(storedProject))
    repository.state.humanRequests.set(target.humanRequestId, structuredClone(target))
    repository.pruneExpired = async () => { throw new Error('human answer must not globally prune') }

    const results = await Promise.allSettled([
      service.answerHumanNeeded(owner, {
        humanRequestId: target.humanRequestId,
        requestRevision: target.revision,
        answer: 'Late A.',
        idempotencyKey: 'idem_scoped_human_race_a'
      }),
      service.answerHumanNeeded(owner, {
        humanRequestId: target.humanRequestId,
        requestRevision: target.revision,
        answer: 'Late B.',
        idempotencyKey: 'idem_scoped_human_race_b'
      })
    ])

    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'request_expired' })
    }
    expect(repository.state.humanRequests.get(target.humanRequestId)).toMatchObject({
      status: 'expired',
      revision: target.revision + 1,
      updatedAt: COMMAND_AT
    })
    expect(repository.state.humanAnswers.size).toBe(0)
  })

  it('uses the command-entry cutoff when a future HumanNeeded crosses expiry during authorization', async () => {
    const repository = new FakeCollaborationRepository()
    const owner = endpointActor('usr_HumanCutoff001')
    const storedProject = project('prj_ScopedCutoff01', owner.userId)
    const target = humanRequest({
      humanRequestId: 'hrq_ScopedCutoff001',
      projectId: storedProject.projectId,
      targetUserId: owner.userId,
      expiresAt: '2026-08-15T04:30:00.000Z'
    })
    repository.state.projects.set(storedProject.projectId, structuredClone(storedProject))
    repository.state.humanRequests.set(target.humanRequestId, structuredClone(target))
    let clock = COMMAND_AT
    const originalGet = repository.getHumanRequest.bind(repository)
    let reads = 0
    repository.getHumanRequest = async (humanRequestId) => {
      const request = await originalGet(humanRequestId)
      reads += 1
      if (reads === 1) clock = FUTURE_AT
      return request
    }
    repository.pruneExpired = async () => { throw new Error('human answer must not globally prune') }
    const service = new CollaborationService({ repository, now: () => new Date(clock) })

    const answer = await service.answerHumanNeeded(owner, {
      humanRequestId: target.humanRequestId,
      requestRevision: target.revision,
      answer: 'Entered before expiry.',
      idempotencyKey: 'idem_scoped_human_cutoff'
    })

    expect(answer).toMatchObject({
      humanRequestId: target.humanRequestId,
      answeredAt: COMMAND_AT,
      createdAt: COMMAND_AT,
      updatedAt: COMMAND_AT
    })
    expect(repository.state.humanRequests.get(target.humanRequestId)).toMatchObject({
      status: 'answered',
      revision: target.revision + 1,
      updatedAt: COMMAND_AT
    })
  })
})
