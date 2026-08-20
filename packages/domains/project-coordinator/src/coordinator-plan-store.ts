import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import {
  agentIdSchema,
  confirmationIdSchema,
  humanRequestIdSchema,
  inboxMessageIdSchema,
  projectIdSchema,
  resourceRefIdSchema,
  revisionSchema,
  taskCriterionSchema,
  taskIdSchema,
  timestampSchema,
  workerRequirementSchema
} from '@sciforge/collaboration-contracts'
import type { ProjectPlan } from './coordinator.js'

const taskProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(32_000),
  completionCriteria: z.array(taskCriterionSchema).min(1).max(100),
  dependencyTaskIds: z.array(taskIdSchema).max(1_000),
  requiredCapabilities: workerRequirementSchema,
  resourceRefIds: z.array(resourceRefIdSchema).max(1_000),
  assigneeAgentId: agentIdSchema
}).strict()

const projectPlanSchema = z.object({
  projectId: projectIdSchema,
  basedOnProjectRevision: revisionSchema,
  objective: z.string().trim().min(1).max(32_000),
  tasks: z.array(taskProposalSchema).min(1).max(1_000)
}).strict()

const planTaskActionSchema = z.object({
  taskIndex: z.number().int().nonnegative(),
  state: z.enum(['awaiting_request', 'awaiting_confirmation', 'approved', 'rejected', 'created']),
  humanRequestId: humanRequestIdSchema.optional(),
  confirmationId: confirmationIdSchema.optional(),
  taskId: taskIdSchema.optional(),
  updatedAt: timestampSchema
}).strict().superRefine((action, context) => {
  if (action.state !== 'awaiting_request' && action.humanRequestId === undefined) {
    context.addIssue({ code: 'custom', path: ['humanRequestId'], message: 'Persisted confirmation state requires its HumanNeeded identity.' })
  }
  if ((action.state === 'approved' || action.state === 'created') && action.confirmationId === undefined) {
    context.addIssue({ code: 'custom', path: ['confirmationId'], message: 'Approved Task proposal requires its A confirmation identity.' })
  }
  if ((action.state === 'created') !== (action.taskId !== undefined)) {
    context.addIssue({ code: 'custom', path: ['taskId'], message: 'Created Task state requires its A Task identity exclusively.' })
  }
})

const planRecordSchema = z.object({
  sourceInboxMessageId: inboxMessageIdSchema,
  plan: projectPlanSchema,
  state: z.enum(['requesting_confirmations', 'awaiting_confirmations', 'creating_tasks', 'completed']),
  taskActions: z.array(planTaskActionSchema).min(1).max(1_000),
  savedAt: timestampSchema,
  updatedAt: timestampSchema
}).strict().superRefine((record, context) => {
  if (record.taskActions.length !== record.plan.tasks.length) {
    context.addIssue({ code: 'custom', path: ['taskActions'], message: 'Every Task proposal requires exactly one durable action state.' })
  }
  record.taskActions.forEach((action, index) => {
    if (action.taskIndex !== index) {
      context.addIssue({ code: 'custom', path: ['taskActions', index, 'taskIndex'], message: 'Task action order must match the immutable Project Plan.' })
    }
  })
  if (record.state !== planState(record.taskActions)) {
    context.addIssue({ code: 'custom', path: ['state'], message: 'Coordinator plan state does not match its Task actions.' })
  }
})

const fileSchema = z.object({
  version: z.literal(2),
  records: z.array(planRecordSchema).max(10_000)
}).strict()

export type CoordinatorPlanTaskAction = z.infer<typeof planTaskActionSchema>
export type CoordinatorPlanRecord = z.infer<typeof planRecordSchema>
export type CoordinatorPlanMatch = Readonly<{
  record: CoordinatorPlanRecord
  taskIndex: number
}>

export class FileCoordinatorPlanStore {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async get(sourceInboxMessageId: string): Promise<CoordinatorPlanRecord | undefined> {
    return clone((await this.read()).records.find((record) => (
      record.sourceInboxMessageId === sourceInboxMessageId
    )))
  }

  async findByHumanRequestId(humanRequestId: string): Promise<CoordinatorPlanMatch | undefined> {
    for (const record of (await this.read()).records) {
      const taskIndex = record.taskActions.findIndex((action) => action.humanRequestId === humanRequestId)
      if (taskIndex >= 0) return { record: structuredClone(record), taskIndex }
    }
    return undefined
  }

  async save(sourceInboxMessageId: string, plan: ProjectPlan, savedAt: string): Promise<CoordinatorPlanRecord> {
    let saved!: CoordinatorPlanRecord
    await this.mutate((state) => {
      const existing = state.records.find((record) => record.sourceInboxMessageId === sourceInboxMessageId)
      saved = planRecordSchema.parse({
        sourceInboxMessageId,
        plan,
        state: 'requesting_confirmations',
        taskActions: plan.tasks.map((_, taskIndex) => ({
          taskIndex,
          state: 'awaiting_request',
          updatedAt: savedAt
        })),
        savedAt,
        updatedAt: savedAt
      })
      if (existing) {
        if (JSON.stringify(existing.plan) !== JSON.stringify(saved.plan)) {
          throw new Error('Coordinator plan is immutable for its source Inbox message.')
        }
        saved = existing
        return
      }
      state.records.push(saved)
    })
    return structuredClone(saved)
  }

  async recordConfirmationRequest(
    sourceInboxMessageId: string,
    taskIndex: number,
    humanRequestId: string,
    updatedAt: string
  ): Promise<CoordinatorPlanRecord> {
    return this.update(sourceInboxMessageId, updatedAt, (record) => {
      const action = requireTaskAction(record, taskIndex)
      if (action.humanRequestId && action.humanRequestId !== humanRequestId) {
        throw new Error('Task proposal confirmation identity is immutable.')
      }
      if (action.state !== 'awaiting_request') return
      record.taskActions[taskIndex] = {
        ...action,
        state: 'awaiting_confirmation',
        humanRequestId,
        updatedAt
      }
    })
  }

  async recordAnswer(
    humanRequestId: string,
    answer: Readonly<{ decision: 'approve' | 'reject'; confirmationId: string | null }>,
    updatedAt: string
  ): Promise<CoordinatorPlanMatch> {
    let match!: CoordinatorPlanMatch
    await this.mutate((state) => {
      const record = state.records.find((candidate) => (
        candidate.taskActions.some((action) => action.humanRequestId === humanRequestId)
      ))
      if (!record) throw new Error('Coordinator confirmation does not match a durable Project Plan.')
      const taskIndex = record.taskActions.findIndex((action) => action.humanRequestId === humanRequestId)
      const action = requireTaskAction(record, taskIndex)
      if (action.state === 'created' || action.state === 'rejected' || action.state === 'approved') {
        const previouslyApproved = action.state === 'created' || action.state === 'approved'
        if (previouslyApproved !== (answer.decision === 'approve')) {
          throw new Error('Coordinator confirmation decision is immutable.')
        }
        if (previouslyApproved && action.confirmationId !== answer.confirmationId) {
          throw new Error('Coordinator A confirmation identity is immutable.')
        }
        match = { record, taskIndex }
        return
      }
      if (action.state !== 'awaiting_confirmation') {
        throw new Error('Coordinator confirmation arrived before its request was persisted.')
      }
      if (answer.decision === 'approve' && !answer.confirmationId) {
        throw new Error('Approved Task proposal is missing A confirmationId.')
      }
      record.taskActions[taskIndex] = answer.decision === 'approve'
        ? { ...action, state: 'approved', confirmationId: answer.confirmationId!, updatedAt }
        : { ...action, state: 'rejected', updatedAt }
      refreshState(record, updatedAt)
      match = { record, taskIndex }
    })
    return { record: structuredClone(match.record), taskIndex: match.taskIndex }
  }

  async recordCreatedTask(
    sourceInboxMessageId: string,
    taskIndex: number,
    taskId: string,
    updatedAt: string
  ): Promise<CoordinatorPlanRecord> {
    return this.update(sourceInboxMessageId, updatedAt, (record) => {
      const action = requireTaskAction(record, taskIndex)
      if (action.taskId && action.taskId !== taskId) throw new Error('Created A Task identity is immutable.')
      if (action.state === 'created') return
      if (action.state !== 'approved') throw new Error('Task proposal must be approved before Task creation is persisted.')
      record.taskActions[taskIndex] = { ...action, state: 'created', taskId, updatedAt }
    })
  }

  async list(): Promise<readonly CoordinatorPlanRecord[]> {
    return (await this.read()).records.map((record) => structuredClone(record))
  }

  private async update(
    sourceInboxMessageId: string,
    updatedAt: string,
    change: (record: z.infer<typeof planRecordSchema>) => void
  ): Promise<CoordinatorPlanRecord> {
    let updated!: CoordinatorPlanRecord
    await this.mutate((state) => {
      const record = state.records.find((candidate) => candidate.sourceInboxMessageId === sourceInboxMessageId)
      if (!record) throw new Error('Coordinator Project Plan was not found.')
      change(record)
      refreshState(record, updatedAt)
      updated = record
    })
    return structuredClone(updated)
  }

  private async mutate(change: (state: z.infer<typeof fileSchema>) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      const state = await this.read()
      change(state)
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(fileSchema.parse(state), null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600
      })
      await rename(temporary, this.filePath)
      await chmod(this.filePath, 0o600)
    })
    this.tail = operation.catch(() => undefined)
    await operation
  }

  private async read(): Promise<z.infer<typeof fileSchema>> {
    try {
      return fileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, records: [] }
      throw error
    }
  }
}

function requireTaskAction(
  record: z.infer<typeof planRecordSchema>,
  taskIndex: number
): z.infer<typeof planTaskActionSchema> {
  const action = record.taskActions[taskIndex]
  if (!action || action.taskIndex !== taskIndex) throw new Error('Coordinator Task proposal state was not found.')
  return action
}

function refreshState(record: z.infer<typeof planRecordSchema>, updatedAt: string): void {
  record.state = planState(record.taskActions)
  record.updatedAt = updatedAt
}

function planState(
  actions: readonly z.infer<typeof planTaskActionSchema>[]
): z.infer<typeof planRecordSchema>['state'] {
  if (actions.every((action) => action.state === 'created' || action.state === 'rejected')) return 'completed'
  if (actions.some((action) => action.state === 'approved')) return 'creating_tasks'
  if (actions.some((action) => action.state === 'awaiting_request')) return 'requesting_confirmations'
  return 'awaiting_confirmations'
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}

export function coordinatorPlanStatePath(userDataDir: string): string {
  return join(userDataDir, 'domains', 'project-coordinator', 'coordinator-plans.json')
}
