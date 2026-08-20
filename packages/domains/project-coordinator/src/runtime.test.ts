import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInboxMessage } from '@sciforge/collaboration-contracts'
import {
  TEST_IDS,
  TEST_LATER_TIMESTAMP,
  TEST_TIMESTAMP,
  humanNeededFixture
} from '@sciforge/collaboration-contracts/testing'
import type { CollaborationBCNodePort } from '@sciforge/domain-collaboration/bc-node-port'
import type { Coordinator } from './coordinator.js'
import type { AgentCoordinatorPlanner } from './coordinator-planner.js'
import { FileCoordinatorPlanStore } from './coordinator-plan-store.js'
import type { FileWorkerJournal } from './journal.js'
import { BCRuntime } from './runtime.js'
import { taskFixture } from './test-fixtures.js'
import type { WorkerRunner } from './worker-runner.js'

test('B durably queues a Task offer before C may ACK it', async () => {
  let handler: Parameters<CollaborationBCNodePort['register']>[0] | undefined
  let woke = 0
  const events: string[] = []
  let releaseQueue!: () => void
  const queueGate = new Promise<void>((resolve) => { releaseQueue = resolve })
  const runtime = new BCRuntime({
    node: {
      register: (candidate) => {
        handler = candidate
        return () => { handler = undefined }
      },
      current: async () => ({
        userId: 'usr_123456789012', agentId: 'agt_123456789012', connected: true
      }),
      execute: async () => { throw new Error('unused') },
      wake: () => { woke += 1 }
    },
    journal: {
      entries: async () => []
    } as unknown as FileWorkerJournal,
    coordinatorPlans: {
      get: async () => undefined,
      save: async () => { throw new Error('unused') },
      list: async () => []
    } as unknown as FileCoordinatorPlanStore,
    coordinator: {
      recoverPendingWrites: async () => 0,
      plan: async () => { throw new Error('unused') }
    } as unknown as Coordinator,
    workerRunner: {
      recoverPendingWrites: async () => 0,
      queue: async () => {
        events.push('journal-queue-start')
        await queueGate
        events.push('journal-queue-committed')
      },
      run: async () => { events.push('worker-started') }
    } as unknown as WorkerRunner,
    plannerFor: () => { throw new Error('unused') }
  })

  await runtime.activate()
  assert.equal(woke, 1)
  assert.ok(handler)
  const delivery = handler(taskOffer(), new AbortController().signal)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['journal-queue-start'])

  releaseQueue()
  assert.deepEqual(await delivery, { status: 'completed' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [
    'journal-queue-start',
    'journal-queue-committed',
    'worker-started'
  ])
  await runtime.dispose()
})

test('B durably drives Project Plan through A confirmation to one idempotent Task creation', async () => {
  let handler: Parameters<CollaborationBCNodePort['register']>[0] | undefined
  const directory = await mkdtemp(join(tmpdir(), 'b-runtime-plan-'))
  const plans = new FileCoordinatorPlanStore(join(directory, 'plans.json'))
  const proposal = {
    title: 'Analyze samples',
    objective: 'Produce a validated analysis.',
    completionCriteria: [{ criterionId: TEST_IDS.firstCriterionId, text: 'Analysis is validated.' }],
    dependencyTaskIds: [],
    requiredCapabilities: {
      capabilityIds: [], vpnAccessIds: [], slurmClusterIds: [], requiredResourceRefIds: []
    },
    resourceRefIds: [],
    assigneeAgentId: TEST_IDS.secondAgentId
  }
  const createdTask = taskFixture({
    taskId: TEST_IDS.taskId,
    projectId: TEST_IDS.projectId,
    assigneeAgentId: TEST_IDS.secondAgentId
  })
  let confirmationCalls = 0
  let createCalls = 0
  const runtime = new BCRuntime({
    node: {
      register: (candidate) => {
        handler = candidate
        return () => { handler = undefined }
      },
      current: async () => ({
        userId: TEST_IDS.userId, agentId: TEST_IDS.agentId, connected: true
      }),
      execute: async () => { throw new Error('unused') },
      wake: () => undefined
    },
    journal: { entries: async () => [] } as unknown as FileWorkerJournal,
    coordinatorPlans: plans,
    coordinator: {
      recoverPendingWrites: async () => 0,
      plan: async () => ({
        projectId: TEST_IDS.projectId,
        basedOnProjectRevision: 1,
        objective: 'Analyze the Project inputs.',
        tasks: [proposal]
      }),
      context: async () => ({
        view: { project: { ownerUserId: TEST_IDS.userId } },
        capabilities: {}
      }),
      requestTaskProposalConfirmation: async (
        input: Parameters<Coordinator['requestTaskProposalConfirmation']>[0]
      ) => {
        confirmationCalls += 1
        assert.equal(input.sourceInboxMessageId, TEST_IDS.inboxMessageId)
        assert.equal(input.targetUserId, TEST_IDS.userId)
        assert.deepEqual(input.proposal, proposal)
        return {
          ...humanNeededFixture,
          sourceKind: 'coordinator',
          taskId: null,
          executionId: null,
          sourceInboxMessageId: TEST_IDS.inboxMessageId,
          confirmableAction: {
            kind: 'tasks.create', projectId: TEST_IDS.projectId, proposalDigest: 'a'.repeat(64)
          }
        }
      },
      createTasks: async (
        _projectId: string,
        proposals: Parameters<Coordinator['createTasks']>[1]
      ) => {
        createCalls += 1
        assert.equal(proposals[0]?.confirmationId, TEST_IDS.confirmationId)
        return [createdTask]
      }
    } as unknown as Coordinator,
    workerRunner: {
      recoverPendingWrites: async () => 0,
      queue: async () => undefined,
      run: async () => undefined
    } as unknown as WorkerRunner,
    plannerFor: () => undefined as unknown as AgentCoordinatorPlanner,
    now: () => new Date(TEST_TIMESTAMP)
  })

  await runtime.activate()
  assert.ok(handler)
  assert.deepEqual(await handler(projectStarted(), new AbortController().signal), { status: 'completed' })
  const awaiting = await plans.get(TEST_IDS.inboxMessageId)
  assert.equal(awaiting?.state, 'awaiting_confirmations')
  assert.equal(awaiting?.taskActions[0]?.humanRequestId, TEST_IDS.humanRequestId)
  assert.equal(confirmationCalls, 1)

  const approved = humanAnswerReceived('approve')
  assert.deepEqual(await handler(approved, new AbortController().signal), { status: 'completed' })
  assert.equal((await plans.get(TEST_IDS.inboxMessageId))?.state, 'completed')
  assert.equal((await plans.get(TEST_IDS.inboxMessageId))?.taskActions[0]?.taskId, TEST_IDS.taskId)
  assert.equal(createCalls, 1)

  assert.deepEqual(await handler(approved, new AbortController().signal), { status: 'completed' })
  assert.equal(confirmationCalls, 1)
  assert.equal(createCalls, 1)
  assert.equal((await runtime.status()).pendingCoordinatorPlans, 0)
  await runtime.dispose()
})

function taskOffer(): AgentInboxMessage {
  return {
    schemaVersion: 1,
    type: 'inbox_message',
    inboxMessageId: 'ibx_Inbox0000001',
    recipientType: 'agent',
    recipientAgentId: 'agt_123456789012',
    sequence: 1,
    status: 'pending',
    disposition: 'active',
    createdAt: '2026-08-20T00:00:00.000Z',
    payload: {
      protocolVersion: '1.0',
      type: 'task.offered',
      projectId: 'prj_123456789012',
      taskId: 'tsk_123456789012',
      executionId: 'exe_123456789012',
      revision: 1
    }
  }
}

function projectStarted(): AgentInboxMessage {
  return {
    schemaVersion: 1,
    type: 'inbox_message',
    inboxMessageId: TEST_IDS.inboxMessageId,
    recipientType: 'agent',
    recipientAgentId: TEST_IDS.agentId,
    sequence: 1,
    status: 'pending',
    disposition: 'active',
    createdAt: TEST_TIMESTAMP,
    payload: {
      protocolVersion: '1.0', type: 'project.started', projectId: TEST_IDS.projectId, revision: 1
    }
  }
}

function humanAnswerReceived(decision: 'approve' | 'reject'): AgentInboxMessage {
  return {
    schemaVersion: 1,
    type: 'inbox_message',
    inboxMessageId: 'ibx_Inbox0000002',
    recipientType: 'agent',
    recipientAgentId: TEST_IDS.agentId,
    sequence: 2,
    status: 'pending',
    disposition: 'active',
    createdAt: TEST_LATER_TIMESTAMP,
    payload: {
      protocolVersion: '1.0',
      type: 'human.answer.received',
      answer: {
        schemaVersion: 1,
        type: 'human_answer',
        humanAnswerId: TEST_IDS.humanAnswerId,
        humanRequestId: TEST_IDS.humanRequestId,
        projectId: TEST_IDS.projectId,
        taskId: null,
        executionId: null,
        requestRevision: 1,
        answeredByUserId: TEST_IDS.userId,
        answeredFromHumanEndpointId: TEST_IDS.humanEndpointId,
        assurance: 'verified',
        answer: decision === 'approve' ? 'Approved.' : 'Rejected.',
        decision,
        confirmationId: decision === 'approve' ? TEST_IDS.confirmationId : null,
        answeredAt: TEST_LATER_TIMESTAMP,
        revision: 1,
        createdAt: TEST_TIMESTAMP,
        updatedAt: TEST_LATER_TIMESTAMP
      }
    }
  }
}
