import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectContentSpaceBindingSchema,
  type RestRequest,
  type RestResponse
} from '@sciforge/collaboration-contracts'
import {
  TEST_IDS,
  TEST_TIMESTAMP,
  projectFixture
} from '@sciforge/collaboration-contracts/testing'

import {
  CollaborationRuntime,
  type CollaborationRuntimeOptions
} from './runtime.js'
import {
  CollaborationLocalStore,
  EMPTY_COLLABORATION_LOCAL_STATE,
  type CollaborationLocalState,
  type CollaborationStateBackend
} from './store.js'

const binding = projectContentSpaceBindingSchema.parse({
  schemaVersion: 1,
  type: 'project_content_space_binding',
  projectId: projectFixture.projectId,
  rootResourceRefId: 'rrf_ContentRoot0001',
  status: 'active',
  revision: 3,
  createdAt: TEST_TIMESTAMP,
  updatedAt: TEST_TIMESTAMP
})

test('a cleared Desktop store recovers and later removes the authoritative Cloud Content Space binding', async () => {
  const backend = new MemoryBackend({
    ...structuredClone(EMPTY_COLLABORATION_LOCAL_STATE),
    projects: [projectFixture]
  })
  const runtime = new CollaborationRuntime({
    statePath: '/unused/collaboration-state.json',
    stateBackend: backend,
    packageSettings: {},
    packageSecrets: {},
    cloudIdentitySession: {}
  } as unknown as CollaborationRuntimeOptions)
  const internals = runtime as unknown as RuntimeInternals
  await internals.store.open()
  internals.active = true

  const requests: RestRequest['type'][] = []
  let bindingAvailable = true
  const execute = async (request: RestRequest): Promise<RestResponse> => {
    requests.push(request.type)
    if (request.type === 'project.get') {
      return {
        protocolVersion: '1.0',
        type: 'rest.entity',
        requestId: request.requestId,
        entity: projectFixture
      }
    }
    assert.equal(request.type, 'project.content_space.get')
    if (bindingAvailable) {
      return {
        protocolVersion: '1.0',
        type: 'rest.entity',
        requestId: request.requestId,
        entity: binding
      }
    }
    return {
      protocolVersion: '1.0',
      type: 'rest.error',
      requestId: request.requestId,
      error: {
        protocolVersion: '1.0',
        type: 'error',
        requestId: request.requestId,
        traceId: 'trc_Trace0000001',
        code: 'not_found',
        category: 'validation',
        httpStatus: 404,
        retryable: false,
        message: 'The Project has no active Content Space binding.'
      }
    }
  }
  internals.connection = {
    executeAsUser: execute,
    executeAsDevice: execute
  }

  await internals.refreshProject(projectFixture.projectId, 'device')
  assert.deepEqual(internals.store.snapshot().contentSpaceBindings, [binding])

  bindingAvailable = false
  await internals.refreshProject(projectFixture.projectId, 'user')
  assert.deepEqual(internals.store.snapshot().contentSpaceBindings, [])
  assert.deepEqual(requests, [
    'project.get',
    'project.content_space.get',
    'project.get',
    'project.content_space.get'
  ])
})

type RuntimeInternals = {
  active: boolean
  store: CollaborationLocalStore
  connection: {
    executeAsUser(request: RestRequest): Promise<RestResponse>
    executeAsDevice(request: RestRequest): Promise<RestResponse>
  }
  refreshProject(projectId: string, authority: 'user' | 'device'): Promise<void>
}

class MemoryBackend implements CollaborationStateBackend {
  constructor(private value: CollaborationLocalState) {}

  async read(): Promise<unknown> {
    return structuredClone(this.value)
  }

  async write(value: CollaborationLocalState): Promise<void> {
    this.value = structuredClone(value)
  }
}
