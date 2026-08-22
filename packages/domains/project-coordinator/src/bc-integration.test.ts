import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  agentInboxMessageSchema,
  restResponseSchema,
  taskSchema,
  type AgentInboxMessage,
  type RestResponse,
  type Task
} from '@sciforge/collaboration-contracts'
import {
  CollaborationBCNodePortImpl,
  type CollaborationBCCloudRequest
} from '@sciforge/domain-collaboration/bc-node-port'
import { Coordinator } from './coordinator.js'
import { FileCoordinatorPlanStore } from './coordinator-plan-store.js'
import { FileWorkerJournal } from './journal.js'
import type { EContentSpacePort } from './ports.js'
import { BCRuntime } from './runtime.js'
import { taskFixture } from './test-fixtures.js'
import { WorkerRunner } from './worker-runner.js'

const RESULT_RECORD_ID = 'rec_Result0000001'
const NOW = '2026-08-20T00:00:00.000Z'

test('C and B complete one metadata-only Task through the durable production Worker path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bc-integration-'))
  const journal = new FileWorkerJournal(join(directory, 'worker.json'))
  const plans = new FileCoordinatorPlanStore(join(directory, 'plans.json'))
  const task = taskSchema.parse(taskFixture({
    status: 'offered',
    revision: 1,
    resourceRefIds: [],
    authorizationRequirements: []
  }))
  const events: string[] = []
  const fakeA = new FakeA(task, events)
  let registered = false
  let wakeCount = 0
  const node = new CollaborationBCNodePortImpl({
    current: async () => ({
      userId: task.assigneeUserId,
      agentId: task.assigneeAgentId,
      connected: true
    }),
    execute: (request) => fakeA.execute(request),
    wake: () => { wakeCount += 1 },
    registrationChanged: (enabled) => { registered = enabled }
  })
  let releaseAgent!: () => void
  const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve })
  const worker = new WorkerRunner({
    journal,
    cloud: node,
    principal: node,
    contentSpace: unavailableContentSpace(events),
    agentRuntime: {
      run: async ({ task: runningTask, inputs }) => {
        events.push('AgentRuntime:run')
        assert.equal(runningTask.status, 'running')
        assert.deepEqual(inputs, [])
        await agentGate
        return {
          summary: 'Analysis completed.',
          criterionEvidence: [{
            criterionId: task.completionCriteria[0]!.criterionId,
            summary: 'The analysis summary satisfies the criterion.',
            resourceRefIds: [],
            outputNames: []
          }],
          outputs: [],
          logSummary: 'Completed without warnings.'
        }
      }
    },
    now: () => new Date(NOW)
  })
  const coordinator = new Coordinator(node, node, journal)
  const errors: string[] = []
  const runtime = new BCRuntime({
    node,
    journal,
    coordinatorPlans: plans,
    coordinator,
    workerRunner: worker,
    plannerFor: () => { throw new Error('Owner-direct phase one must not invoke Coordinator planning.') },
    now: () => new Date(NOW),
    log: (level, message) => {
      if (level === 'error') errors.push(message)
    }
  })

  await runtime.activate()
  assert.equal(registered, true)
  assert.equal(wakeCount, 1)
  try {
    await node.handle(taskOffer(task), new AbortController().signal)

    const durableAtAck = await journal.get(task.taskId, task.executionId)
    assert.ok(durableAtAck, 'C may ACK only after B durably queues the execution.')
    assert.equal(durableAtAck.taskId, task.taskId)
    assert.equal(durableAtAck.executionId, task.executionId)

    await waitFor(
      () => journal.get(task.taskId, task.executionId),
      (entry) => entry?.phase === 'agent_started'
    )
    releaseAgent()
    await waitFor(
      () => journal.get(task.taskId, task.executionId),
      (entry) => entry?.phase === 'succeeded'
    )

    const requests = fakeA.requests
    assert.equal(requests.some((request) => request.type === 'resource.get'), false)
    assert.equal(requests.some((request) => request.type === 'resource.create'), false)
    assert.equal(requests.some((request) => request.type === 'human.needed.create'), false)
    assert.equal(requests.some((request) => request.type === 'task.create'), false)
    const terminal = requests.find((request) => (
      request.type === 'task.transition' && request.status === 'succeeded'
    ))
    assert.ok(terminal && terminal.type === 'task.transition')
    assert.equal('resultSummary' in terminal, false)
    assert.deepEqual(terminal.result, {
      summary: 'Analysis completed.',
      criterionEvidence: [{
        criterionId: task.completionCriteria[0]!.criterionId,
        summary: 'The analysis summary satisfies the criterion.',
        resourceRefIds: []
      }],
      resourceRefIds: [],
      logSummary: 'Completed without warnings.'
    })

    assertOrdered(events, [
      'A:task.transition:accepted',
      'A:task.transition:running',
      'A:task.progress.report',
      'AgentRuntime:run',
      'A:task.transition:succeeded'
    ])
    assert.equal(events.some((event) => event.startsWith('E:')), false)
    const cloudJson = JSON.stringify(requests)
    for (const forbidden of [
      'resourceHandle', 'workspaceRelativePath', 'local:', 'private/workspace',
      '/tmp/', 'accessToken', 'refreshToken', 'Bearer '
    ]) {
      assert.equal(cloudJson.includes(forbidden), false, `A request leaked ${forbidden}.`)
    }
    assert.equal(await journal.pendingCount(), 0)
    assert.deepEqual(errors, [])
  } finally {
    releaseAgent()
    await runtime.dispose()
  }
  assert.equal(registered, false)
})

class FakeA {
  readonly requests: CollaborationBCCloudRequest[] = []
  private task: Task

  constructor(task: Task, private readonly events: string[]) {
    this.task = task
  }

  async execute(request: CollaborationBCCloudRequest): Promise<RestResponse> {
    this.requests.push(structuredClone(request))
    if (request.type === 'task.get') {
      assert.equal(request.taskId, this.task.taskId)
      this.events.push('A:task.get')
      return entity(request.requestId, this.task)
    }
    if (request.type === 'task.transition') {
      this.assertTaskFence(request.taskId, request.executionId, request.expectedRevision)
      this.events.push(`A:task.transition:${request.status}`)
      this.task = request.status === 'succeeded'
        ? taskSchema.parse({
            ...this.task,
            status: 'succeeded',
            resultSummary: request.result?.summary,
            resultProjectRecordId: RESULT_RECORD_ID,
            completedAt: NOW,
            revision: this.task.revision + 1,
            updatedAt: NOW
          })
        : taskSchema.parse({
            ...this.task,
            status: request.status,
            revision: this.task.revision + 1,
            updatedAt: NOW
          })
      return entity(request.requestId, this.task)
    }
    if (request.type === 'task.progress.report') {
      this.assertTaskFence(request.taskId, request.executionId, request.expectedRevision)
      assert.equal(this.task.status, 'running')
      this.events.push('A:task.progress.report')
      this.task = taskSchema.parse({
        ...this.task,
        progress: { percent: request.percent, summary: request.summary, reportedAt: NOW },
        revision: this.task.revision + 1,
        updatedAt: NOW
      })
      return entity(request.requestId, this.task)
    }
    throw new Error(`Unexpected A command in phase-one Worker integration: ${request.type}`)
  }

  private assertTaskFence(taskId: string, executionId: string, revision: number): void {
    assert.equal(taskId, this.task.taskId)
    assert.equal(executionId, this.task.executionId)
    assert.equal(revision, this.task.revision)
    assert.equal(this.task.assigneeAgentId, 'agt_123456789012')
  }
}

function unavailableContentSpace(events: string[]): EContentSpacePort {
  const fail = async (): Promise<never> => {
    events.push('E:unexpected')
    throw new Error('Phase-one metadata-only execution must not call E.')
  }
  return { materialize: fail, agentDownload: fail, agentUploadNew: fail }
}

function taskOffer(task: Task): AgentInboxMessage {
  return agentInboxMessageSchema.parse({
    schemaVersion: 1,
    type: 'inbox_message',
    inboxMessageId: 'ibx_Inbox0000001',
    recipientType: 'agent',
    recipientAgentId: task.assigneeAgentId,
    sequence: 1,
    status: 'pending',
    disposition: 'active',
    createdAt: NOW,
    payload: {
      protocolVersion: '1.0',
      type: 'task.offered',
      projectId: task.projectId,
      taskId: task.taskId,
      executionId: task.executionId,
      revision: task.revision
    }
  })
}

function entity(requestId: string, value: Task): RestResponse {
  return restResponseSchema.parse({
    protocolVersion: '1.0',
    type: 'rest.entity',
    requestId,
    entity: value
  })
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean
): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the Worker integration flow.')
}

function assertOrdered(actual: readonly string[], expected: readonly string[]): void {
  let position = -1
  for (const item of expected) {
    position = actual.indexOf(item, position + 1)
    assert.notEqual(position, -1, `Missing ordered event ${item}. Events: ${actual.join(', ')}`)
  }
}
