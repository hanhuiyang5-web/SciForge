import assert from 'node:assert/strict'
import test from 'node:test'
import {
  remoteSessionProjectionSchema
} from '@sciforge/collaboration-contracts'
import {
  remoteSessionProjectionFixture
} from '@sciforge/collaboration-contracts/testing'
import { localProjectionFromRemote } from './projection-coordinator.js'
import { activeProjectionBindingsForSession, phaseOneTaskProposal } from './runtime.js'

test('a closed Topic history does not block outbound mirroring for the active Topic on the same Session', () => {
  const active = localProjectionFromRemote(remoteSessionProjectionFixture, {
    runtimeId: 'codex',
    threadId: 'fixed-thread-1',
    bindingMode: 'existing'
  })
  const closed = localProjectionFromRemote(remoteSessionProjectionSchema.parse({
    ...remoteSessionProjectionFixture,
    projectionId: 'rsp_123456789012',
    status: 'closed',
    revision: 2
  }), {
    runtimeId: 'codex',
    threadId: 'fixed-thread-1',
    bindingMode: 'existing'
  })

  assert.deepEqual(
    activeProjectionBindingsForSession([closed, active], 'codex', 'fixed-thread-1'),
    [active]
  )
})

test('Owner-direct phase-one Tasks cannot smuggle ResourceRefs or authorization requirements', () => {
  assert.deepEqual(phaseOneTaskProposal({
    projectId: 'prj_PhaseOneTest001',
    assigneeAgentId: 'agt_PhaseOneWorker01',
    title: 'Return a text result',
    objective: 'Run on the selected Worker and return the summary.',
    completionCriteria: ['Return one concise summary.']
  }), {
    assigneeAgentId: 'agt_PhaseOneWorker01',
    title: 'Return a text result',
    objective: 'Run on the selected Worker and return the summary.',
    completionCriteria: ['Return one concise summary.'],
    dependencyTaskIds: [],
    requiredCapabilities: {
      capabilityIds: ['project.worker.v1'],
      vpnAccessIds: [],
      slurmClusterIds: [],
      requiredResourceRefIds: []
    },
    resourceRefIds: [],
    authorizationRequirements: []
  })
})
