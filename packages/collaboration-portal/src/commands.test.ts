import { describe, expect, it } from 'vitest'
import { restRequestSchema } from '../../collaboration-contracts/src/protocol'
import {
  assertExactPortalCommand,
  buildCancelTask,
  buildCoordinationView,
  buildCreateProject,
  buildCreateTask,
  buildOwnedAgentList,
  buildProjectList,
  buildRetryTask,
  buildReviewResult,
  buildUpdateProjectMembers,
  buildWorkerDirectoryPage
} from './commands'

const ids = (prefix: string): string => `${prefix}_aaaaaaaaaaaaaaaa`
const fixtures = {
  user: 'usr_aaaaaaaaaaaaaaaa', user2: 'usr_bbbbbbbbbbbbbbbb', agent: 'agt_aaaaaaaaaaaaaaaa', agent2: 'agt_bbbbbbbbbbbbbbbb',
  project: 'prj_aaaaaaaaaaaaaaaa', task: 'tsk_aaaaaaaaaaaaaaaa', execution: 'exe_aaaaaaaaaaaaaaaa', record: 'rec_aaaaaaaaaaaaaaaa'
}

describe('Portal command builders', () => {
  it('passes every emitted payload through the official strict REST request schema', () => {
    const context = { idFactory: ids }
    const commands = [
      buildProjectList({ statuses: ['active', 'paused'], limit: 50 }, context),
      buildWorkerDirectoryPage({ limit: 50 }, context),
      buildOwnedAgentList(context),
      buildCoordinationView(fixtures.project, context),
      buildCreateProject({ ownerUserId: fixtures.user, displayName: 'Protein atlas', goal: 'Compare structures.', memberUserIds: [fixtures.user2], coordinatorAgentId: fixtures.agent }, context),
      buildUpdateProjectMembers({ projectId: fixtures.project, expectedRevision: 2, addMemberUserIds: [fixtures.user2], removeMemberUserIds: [] }, context),
      buildCreateTask({ projectId: fixtures.project, expectedRevision: 2, assigneeAgentId: fixtures.agent2, title: 'Fold', objective: 'Predict a structure.', completionCriteria: ['Return a ranked structure.'], capabilityIds: ['protein.structure'] }, context),
      buildCancelTask({ taskId: fixtures.task, executionId: fixtures.execution, expectedRevision: 3 }, context),
      buildRetryTask({ taskId: fixtures.task, executionId: fixtures.execution, assigneeAgentId: fixtures.agent2, expectedRevision: 3 }, context),
      buildReviewResult({ projectRecordId: fixtures.record, expectedRevision: 2, decision: 'accepted' }, context)
    ]
    for (const command of commands) {
      expect(restRequestSchema.safeParse(command), `${command.type} must pass the canonical schema`).toMatchObject({ success: true })
    }
  })

  it('always binds cancel and retry to the current execution', () => {
    const context = { idFactory: ids }
    expect(buildCancelTask({ taskId: fixtures.task, executionId: fixtures.execution, expectedRevision: 9 }, context)).toMatchObject({ executionId: fixtures.execution, expectedRevision: 9 })
    expect(buildRetryTask({ taskId: fixtures.task, executionId: fixtures.execution, assigneeAgentId: fixtures.agent2, expectedRevision: 9 }, context)).toMatchObject({ executionId: fixtures.execution, assigneeAgentId: fixtures.agent2 })
  })

  it('deduplicates member changes and rejects ambiguous updates', () => {
    const command = buildUpdateProjectMembers({ projectId: fixtures.project, expectedRevision: 2, addMemberUserIds: [fixtures.user2, fixtures.user2], removeMemberUserIds: [] }, { idFactory: ids })
    expect(command.addMemberUserIds).toEqual([fixtures.user2])
    expect(() => buildUpdateProjectMembers({ projectId: fixtures.project, expectedRevision: 2, addMemberUserIds: [fixtures.user2], removeMemberUserIds: [fixtures.user2] })).toThrow(/added and removed/u)
  })

  it('fails closed on extra command fields', () => {
    const command = { ...buildOwnedAgentList({ idFactory: ids }), accessToken: 'forbidden' }
    expect(() => assertExactPortalCommand(command)).toThrow(/Unexpected fields/u)
    expect(restRequestSchema.safeParse(command).success).toBe(false)
  })
})
