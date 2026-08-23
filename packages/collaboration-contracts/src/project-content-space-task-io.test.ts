import { describe, expect, it } from 'vitest'

import {
  projectContentSpaceBindingSchema,
  taskFileIntentSchema,
  taskSchema
} from './entities.js'
import { restRequestSchema } from './protocol.js'
import { taskCreateProposalInputSchema } from './task-proposal.js'
import { TEST_IDS, TEST_TIMESTAMP, taskFixture } from './testing.js'

const inputResourceRefId = 'rrf_FileIntentInput01'
const rootResourceRefId = 'rrf_FileIntentRoot001'
const fileIntent = {
  schemaVersion: 1 as const,
  bindingRevision: 3,
  inputs: [{ resourceRefId: inputResourceRefId, destinationName: 'input.csv' }],
  output: { containerResourceRefId: rootResourceRefId, mode: 'upload-new' as const }
}

describe('Project Content Space binding and Task file intent', () => {
  it('accepts the strict v1 binding entity and owner write commands', () => {
    expect(projectContentSpaceBindingSchema.parse({
      schemaVersion: 1,
      type: 'project_content_space_binding',
      projectId: TEST_IDS.projectId,
      rootResourceRefId,
      status: 'active',
      revision: 3,
      createdAt: TEST_TIMESTAMP,
      updatedAt: TEST_TIMESTAMP
    })).toMatchObject({ rootResourceRefId, revision: 3 })

    const envelope = {
      protocolVersion: '1.0' as const,
      requestId: TEST_IDS.requestId,
      idempotencyKey: 'idem_content_space_binding_0001'
    }
    expect(restRequestSchema.safeParse({
      ...envelope,
      type: 'project.content_space.bind',
      projectId: TEST_IDS.projectId,
      expectedProjectRevision: 4,
      rootResourceRefId
    }).success).toBe(true)
    expect(restRequestSchema.safeParse({
      ...envelope,
      type: 'project.content_space.unbind',
      projectId: TEST_IDS.projectId,
      expectedProjectRevision: 5,
      expectedBindingRevision: 3
    }).success).toBe(true)
    expect(restRequestSchema.safeParse({
      protocolVersion: '1.0',
      requestId: TEST_IDS.requestId,
      type: 'project.content_space.get',
      projectId: TEST_IDS.projectId
    }).success).toBe(true)
  })

  it('requires unique safe destinations and one upload-new output', () => {
    expect(taskFileIntentSchema.parse(fileIntent)).toEqual(fileIntent)
    for (const candidate of [
      { ...fileIntent, inputs: [{ ...fileIntent.inputs[0]!, destinationName: '../input.csv' }] },
      { ...fileIntent, inputs: [fileIntent.inputs[0]!, fileIntent.inputs[0]!] },
      { ...fileIntent, output: { ...fileIntent.output, mode: 'overwrite' } },
      { ...fileIntent, output: { ...fileIntent.output, containerResourceRefId: inputResourceRefId } }
    ]) {
      expect(taskFileIntentSchema.safeParse(candidate).success).toBe(false)
    }
  })

  it('makes the Task ResourceRef projection exactly match the file intent', () => {
    const proposal = {
      projectId: TEST_IDS.projectId,
      assigneeAgentId: TEST_IDS.secondAgentId,
      title: 'Process one real file',
      objective: 'Download the input and upload one new output.',
      completionCriteria: ['Return one verifiable output.'],
      dependencyTaskIds: [],
      resourceRefIds: [inputResourceRefId, rootResourceRefId],
      fileIntent
    }
    expect(taskCreateProposalInputSchema.safeParse(proposal).success).toBe(true)
    expect(taskCreateProposalInputSchema.safeParse({
      ...proposal,
      resourceRefIds: [rootResourceRefId, inputResourceRefId]
    }).success).toBe(false)
    expect(taskCreateProposalInputSchema.safeParse({
      ...proposal,
      resourceRefIds: [inputResourceRefId]
    }).success).toBe(false)
    expect(taskSchema.parse({
      ...taskFixture,
      resourceRefIds: proposal.resourceRefIds,
      fileIntent
    }).fileIntent).toEqual(fileIntent)
  })
})
