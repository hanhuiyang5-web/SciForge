import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResourceRef, RestResponse } from '@sciforge/collaboration-contracts'
import { FileWorkerJournal } from './journal.js'
import { WorkerRunner, ManualRecoveryRequiredError } from './worker-runner.js'
import { taskFixture } from './test-fixtures.js'
import { AgentRuntimeTerminalError, type BCloudRequest } from './ports.js'

function dependencies(journal: FileWorkerJournal) {
  let agentRuns = 0
  let uploads = 0
  const task = taskFixture()
  return {
    counts: () => ({ agentRuns, uploads }),
    options: {
      journal,
      cloud: { execute: async () => { throw new Error('not expected') } },
      principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
      contentSpace: {
        materialize: async () => ({ resourceHandle: 'local-handle', resourceKind: 'content-space.file' }),
        agentDownload: async () => ({ workspaceRelativePath: 'input/file.txt' }),
        agentUploadNew: async () => {
          uploads += 1
          throw new Error('upload timeout')
        }
      },
      agentRuntime: {
        run: async () => {
          agentRuns += 1
          return { summary: 'done', criterionEvidence: [], outputs: [], logSummary: 'ok' }
        }
      },
      loadTask: async () => task
    }
  }
}

test('recovery never reruns an Agent whose start was journaled', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const fixture = dependencies(journal)
  await journal.save({ taskId: 'tsk_123456789012', executionId: 'exe_123456789012', phase: 'agent_started', updatedAt: 'now' })
  const runner = new WorkerRunner(fixture.options)
  await assert.rejects(runner.run('tsk_123456789012', 'exe_123456789012'), ManualRecoveryRequiredError)
  assert.deepEqual(fixture.counts(), { agentRuns: 0, uploads: 0 })
})

test('recovery never retries an upload whose outcome is unknown', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const fixture = dependencies(journal)
  await journal.save({
    taskId: 'tsk_123456789012', executionId: 'exe_123456789012', phase: 'output_uploading',
    updatedAt: 'now', agentResult: { summary: 'done', criterionEvidence: [], outputs: [{ name: 'x', workspaceRelativePath: 'x' }] },
    nextOutputIndex: 0, resourceRefIds: []
  })
  const runner = new WorkerRunner(fixture.options)
  await assert.rejects(runner.run('tsk_123456789012', 'exe_123456789012'), ManualRecoveryRequiredError)
  assert.deepEqual(fixture.counts(), { agentRuns: 0, uploads: 0 })
})

test('phase-one Worker skips E and submits a metadata-only StructuredTaskResult', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const task = taskFixture({ resourceRefIds: [], authorizationRequirements: [] })
  const calls: BCloudRequest[] = []
  const effects: string[] = []
  const cloud = {
    execute: async (request: BCloudRequest): Promise<RestResponse> => {
      calls.push(structuredClone(request))
      return receiptResponse(request)
    }
  }
  const runner = new WorkerRunner({
    journal,
    cloud,
    principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
    contentSpace: {
      materialize: async () => { effects.push('E:materialize'); throw new Error('must not materialize') },
      agentDownload: async () => { effects.push('E:download'); throw new Error('must not download') },
      agentUploadNew: async () => { effects.push('E:upload'); throw new Error('must not upload') }
    },
    agentRuntime: {
      run: async ({ inputs }) => {
        effects.push('AgentRuntime:run')
        assert.deepEqual(inputs, [])
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
    loadTask: async () => task
  })

  await runner.run(task.taskId, task.executionId)

  assert.deepEqual(effects, ['AgentRuntime:run'])
  assert.equal(calls.some((request) => request.type === 'resource.get'), false)
  assert.equal(calls.some((request) => request.type === 'resource.create'), false)
  assert.equal(calls.some((request) => (request as { type: string }).type === 'project_record.submit'), false)
  const terminal = calls.find((request) => (
    request.type === 'task.transition' && request.status === 'succeeded'
  ))
  assert.equal(terminal?.type, 'task.transition')
  if (terminal?.type !== 'task.transition') throw new Error('Missing terminal transition.')
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
  assert.equal((await journal.get(task.taskId, task.executionId))?.phase, 'succeeded')
})

test('Worker durably rejects resource-bearing Tasks without file intent before E or AgentRuntime side effects', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const task = taskFixture({ resourceRefIds: ['rrf_Input00000001'] })
  const cloudCalls: BCloudRequest[] = []
  let contentSpaceCalls = 0
  let agentRuns = 0
  const runner = new WorkerRunner({
    journal,
    cloud: {
      execute: async (request) => {
        cloudCalls.push(structuredClone(request))
        return receiptResponse(request)
      }
    },
    principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
    contentSpace: {
      materialize: async () => { contentSpaceCalls += 1; throw new Error('must not materialize') },
      agentDownload: async () => { contentSpaceCalls += 1; throw new Error('must not download') },
      agentUploadNew: async () => { contentSpaceCalls += 1; throw new Error('must not upload') }
    },
    agentRuntime: { run: async () => { agentRuns += 1; throw new Error('must not run') } },
    loadTask: async () => task
  })

  await runner.run(task.taskId, task.executionId)
  assert.equal(cloudCalls.length, 1)
  assert.equal(cloudCalls[0]?.type, 'task.transition')
  if (cloudCalls[0]?.type !== 'task.transition') throw new Error('Missing rejected transition.')
  assert.equal(cloudCalls[0].status, 'rejected')
  assert.equal(contentSpaceCalls, 0)
  assert.equal(agentRuns, 0)
  const entry = await journal.get(task.taskId, task.executionId)
  assert.equal(entry?.phase, 'rejected')
  assert.match(entry?.recoveryReason ?? '', /require an explicit Task file intent/u)
})

test('Worker follows Task file intent for deterministic download, Agent execution, upload-new, and A result', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const inputResourceRefId = 'rrf_InputFile00001'
  const outputContainerResourceRefId = 'rrf_OutputRoot0001'
  const uploadedResourceRefId = 'rrf_UploadedFile01'
  const task = taskFixture({
    resourceRefIds: [inputResourceRefId, outputContainerResourceRefId],
    fileIntent: {
      schemaVersion: 1,
      bindingRevision: 4,
      inputs: [{ resourceRefId: inputResourceRefId, destinationName: 'source-data.csv' }],
      output: { containerResourceRefId: outputContainerResourceRefId, mode: 'upload-new' }
    }
  })
  const calls: BCloudRequest[] = []
  const effects: string[] = []
  const runner = new WorkerRunner({
    journal,
    cloud: {
      execute: async (request) => {
        calls.push(structuredClone(request))
        if (request.type === 'resource.get') {
          const kind = request.resourceRefId === outputContainerResourceRefId
            ? 'content-space.container-reference'
            : 'content-space.file-reference'
          return entityResponse(request.requestId, resourceFixture(request.resourceRefId, kind))
        }
        if (request.type === 'resource.create') {
          return entityResponse(
            request.requestId,
            resourceFixture(uploadedResourceRefId, 'content-space.file-reference')
          )
        }
        return receiptResponse(request)
      }
    },
    principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
    contentSpace: {
      materialize: async (reference) => {
        const kind = reference.kind.includes('container') ? 'container' : 'file'
        effects.push(`E:materialize:${kind}`)
        return { resourceHandle: `${kind}-handle`, resourceKind: `content-space.${kind}` }
      },
      agentDownload: async (input, destinationName) => {
        effects.push(`E:download:${input.resourceHandle}:${destinationName}`)
        return { workspaceRelativePath: `inputs/${destinationName}` }
      },
      agentUploadNew: async (input) => {
        effects.push(`E:upload:${input.outputContainer.resourceHandle}:${input.name}:${input.workspaceRelativePath}`)
        return {
          provider: 'opencontent',
          externalId: 'uploaded-output-file',
          kind: 'content-space.file-reference',
          name: input.name,
          portableReference: portable('content-space.file-reference'),
          version: 'version-1'
        }
      }
    },
    agentRuntime: {
      run: async ({ inputs }) => {
        effects.push('AgentRuntime:run')
        assert.deepEqual(inputs, [{ workspaceRelativePath: 'inputs/source-data.csv' }])
        return {
          summary: 'Processed the real input file.',
          criterionEvidence: [{
            criterionId: task.completionCriteria[0]!.criterionId,
            summary: 'The output was generated from the supplied input.',
            resourceRefIds: [inputResourceRefId],
            outputNames: ['result.csv']
          }],
          outputs: [{ name: 'result.csv', workspaceRelativePath: 'outputs/result.csv' }],
          logSummary: 'One input and one output processed.'
        }
      }
    },
    loadTask: async () => task
  })

  await runner.run(task.taskId, task.executionId)

  assert.deepEqual(effects, [
    'E:materialize:file',
    'E:download:file-handle:source-data.csv',
    'E:materialize:container',
    'AgentRuntime:run',
    'E:upload:container-handle:result.csv:outputs/result.csv'
  ])
  const resourceReads = calls.filter((request) => request.type === 'resource.get')
  assert.deepEqual(resourceReads.map((request) => (
    request.type === 'resource.get' ? request.resourceRefId : undefined
  )), [inputResourceRefId, outputContainerResourceRefId])
  const create = calls.find((request) => request.type === 'resource.create')
  assert.equal(create?.type, 'resource.create')
  if (create?.type !== 'resource.create') throw new Error('Missing uploaded ResourceRef creation.')
  assert.equal(create.executionId, task.executionId)
  assert.equal(create.portableReference?.kind, 'content-space.file-reference')
  const terminal = calls.find((request) => request.type === 'task.transition' && request.status === 'succeeded')
  assert.equal(terminal?.type, 'task.transition')
  if (terminal?.type !== 'task.transition' || terminal.status !== 'succeeded') {
    throw new Error('Missing succeeded Task transition.')
  }
  assert.deepEqual(terminal.result, {
    summary: 'Processed the real input file.',
    criterionEvidence: [{
      criterionId: task.completionCriteria[0]!.criterionId,
      summary: 'The output was generated from the supplied input.',
      resourceRefIds: [inputResourceRefId, uploadedResourceRefId]
    }],
    resourceRefIds: [uploadedResourceRefId, inputResourceRefId],
    logSummary: 'One input and one output processed.'
  })
  assert.equal((await journal.get(task.taskId, task.executionId))?.phase, 'succeeded')
})

test('recovery after E upload replays only the exact pending A ResourceRef write', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const task = taskFixture()
  const cloudKey = 'idem_resource_recovery_123456789012'
  const request = {
    protocolVersion: '1.0', requestId: 'req_resource_recovery_123456789012', idempotencyKey: cloudKey,
    type: 'resource.create', projectId: task.projectId, taskId: task.taskId,
    executionId: task.executionId, expectedTaskRevision: task.revision,
    provider: 'opencontent', externalId: 'uploaded-once', kind: 'content-space.file-reference',
    name: 'result.csv', portableReference: portable('content-space.file-reference')
  } as const
  await journal.saveAndEnqueue({
    taskId: task.taskId, executionId: task.executionId, phase: 'resource_registering',
    updatedAt: '2026-08-19T00:00:00.000Z', pendingCloudKey: cloudKey,
    nextOutputIndex: 0, resourceRefIds: [],
    agentResult: {
      summary: 'Recovered result.', criterionEvidence: [],
      outputs: [{ name: 'result.csv', workspaceRelativePath: 'outputs/result.csv' }]
    }
  }, { idempotencyKey: cloudKey, request })
  let agentRuns = 0
  let uploads = 0
  const calls: BCloudRequest[] = []
  const runner = new WorkerRunner({
    journal,
    cloud: {
      execute: async (command) => {
        calls.push(structuredClone(command))
        if (command.type === 'resource.create') {
          return entityResponse(command.requestId, resourceFixture('rrf_Recovered001', 'content-space.file-reference'))
        }
        return receiptResponse(command)
      }
    },
    principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
    contentSpace: {
      materialize: async () => { throw new Error('must not materialize') },
      agentDownload: async () => { throw new Error('must not download') },
      agentUploadNew: async () => { uploads += 1; throw new Error('must not upload') }
    },
    agentRuntime: { run: async () => { agentRuns += 1; throw new Error('must not run') } },
    loadTask: async () => task
  })

  await runner.run(task.taskId, task.executionId)

  assert.equal(agentRuns, 0)
  assert.equal(uploads, 0)
  assert.deepEqual(calls.find((command) => command.type === 'resource.create'), request)
  assert.equal((await journal.get(task.taskId, task.executionId))?.phase, 'succeeded')
})

test('startup recovers a timed-out human request with the same key and payload', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const task = taskFixture()
  const cloudKey = 'idem_human_recovery_123456789012'
  const request = {
    protocolVersion: '1.0', requestId: 'req_human_recovery_123456789012', idempotencyKey: cloudKey,
    type: 'human.needed.create', projectId: task.projectId, sourceKind: 'worker',
    taskId: task.taskId, executionId: task.executionId, expectedTaskRevision: task.revision,
    targetUserId: task.assigneeUserId, requiredAssurance: 'verified',
    prompt: 'Approve continuing the analysis.', expiresAt: '2026-08-20T01:00:00.000Z'
  } as const
  await journal.enqueue({ idempotencyKey: cloudKey, request })
  const calls: BCloudRequest[] = []
  const runner = new WorkerRunner({
    journal,
    cloud: {
      execute: async (command) => {
        calls.push(structuredClone(command))
        return {
          protocolVersion: '1.0', type: 'rest.entity', requestId: command.requestId,
          entity: {
            schemaVersion: 1, type: 'human_needed', humanRequestId: 'hrq_123456789012',
            projectId: task.projectId, taskId: task.taskId, executionId: task.executionId,
            sourceKind: 'worker', sourceInboxMessageId: null,
            targetUserId: task.assigneeUserId, requestedByAgentId: task.assigneeAgentId,
            requiredAssurance: 'verified', prompt: request.prompt, status: 'pending',
            confirmableAction: null, revision: 1,
            expiresAt: request.expiresAt, createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z'
          }
        }
      }
    },
    principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
    contentSpace: {
      materialize: async () => { throw new Error('unused') },
      agentDownload: async () => { throw new Error('unused') },
      agentUploadNew: async () => { throw new Error('unused') }
    },
    agentRuntime: { run: async () => { throw new Error('unused') } },
    loadTask: async () => task
  })

  assert.equal(await runner.recoverPendingWrites(), 1)
  assert.deepEqual(calls, [request])
  assert.equal(await journal.pendingCount(), 0)
})

test('a known Agent terminal failure produces one fenced failed transition', async () => {
  const journal = new FileWorkerJournal(join(await mkdtemp(join(tmpdir(), 'b-runner-')), 'state.json'))
  const task = taskFixture()
  const calls: BCloudRequest[] = []
  const runner = new WorkerRunner({
    journal,
    cloud: {
      execute: async (request) => {
        calls.push(structuredClone(request))
        return receiptResponse(request)
      }
    },
    principal: { current: async () => ({ userId: task.assigneeUserId, agentId: task.assigneeAgentId }) },
    contentSpace: {
      materialize: async () => { throw new Error('unused') },
      agentDownload: async () => { throw new Error('unused') },
      agentUploadNew: async () => { throw new Error('unused') }
    },
    agentRuntime: {
      run: async () => { throw new AgentRuntimeTerminalError('failed') }
    },
    loadTask: async () => task
  })

  await runner.run(task.taskId, task.executionId)

  const failed = calls.find((request) => (
    request.type === 'task.transition' && request.status === 'failed'
  ))
  assert.equal(failed?.type, 'task.transition')
  if (failed?.type !== 'task.transition') throw new Error('Missing failed transition.')
  assert.equal(failed.executionId, task.executionId)
  assert.equal(failed.expectedRevision, task.revision)
  assert.equal(failed.safeFailureCode, 'agent.runtime_failed')
  assert.equal((await journal.get(task.taskId, task.executionId))?.phase, 'failed')
})

function portable(kind: 'content-space.file-reference' | 'content-space.container-reference') {
  return {
    contractVersion: 1 as const,
    kind,
    authority: 'mock-opencontent',
    identity: { fileId: kind }
  } as never
}

function resourceFixture(
  resourceRefId: string,
  kind: 'content-space.file-reference' | 'content-space.container-reference'
): ResourceRef {
  return {
    schemaVersion: 1, type: 'resource_ref', resourceRefId,
    projectId: 'prj_123456789012', taskId: 'tsk_123456789012', executionId: 'exe_123456789012',
    taskRevision: 3, createdByUserId: 'usr_123456789012', createdByAgentId: 'agt_123456789012',
    provider: 'opencontent', externalId: `external-${resourceRefId}`, kind,
    name: kind.includes('container') ? 'outputs' : 'data.csv', openUrl: null,
    portableReference: portable(kind), version: null, status: 'available', statusReasonCode: null,
    unavailableAt: null, revokedAt: null, invalidatedAt: null,
    revision: 1, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z'
  }
}

function entityResponse(requestId: string, entity: ResourceRef): RestResponse {
  return { protocolVersion: '1.0', type: 'rest.entity', requestId, entity }
}

function receiptResponse(request: BCloudRequest): RestResponse {
  if (!('idempotencyKey' in request)) throw new Error('Expected write command.')
  return {
    protocolVersion: '1.0', type: 'rest.receipt', requestId: request.requestId,
    receipt: {
      schemaVersion: 1, type: 'operation.receipt', receiptId: 'rcp_123456789012',
      actor: { actorType: 'agent', userId: 'usr_123456789012', agentId: 'agt_123456789012', assurance: 'strong' },
      idempotencyKey: request.idempotencyKey, requestHash: 'a'.repeat(64),
      status: 'succeeded', resultHash: 'b'.repeat(64), createdAt: '2026-08-19T00:00:00.000Z'
    }
  }
}
