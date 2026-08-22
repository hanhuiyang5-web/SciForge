import { assertExactPortalCommand } from './commands'
import { PortalApiError } from './client'
import type { PortalClient, PortalCommand, PortalWriteContext, ProjectBudget } from './types'

export interface PortalMutationRunner {
  run(command: PortalCommand, csrfToken: string): Promise<unknown>
  clear(): void
}

interface PendingMutation {
  idempotencyKey: string
}

const MAX_PENDING_MUTATIONS = 32

/**
 * Keeps a bounded set of ambiguous mutation retries bound to their original
 * idempotency keys. Interleaving another operation cannot displace a prior
 * lost-response retry; successful or definitively rejected operations clear.
 */
export function createPortalMutationRunner(client: PortalClient): PortalMutationRunner {
  const pending = new Map<string, PendingMutation>()

  return {
    async run(command, csrfToken) {
      assertExactPortalCommand(command)
      const proposedKey = requiredString(command.idempotencyKey, 'idempotencyKey')
      const fingerprint = mutationFingerprint(command)
      const idempotencyKey = pending.get(fingerprint)?.idempotencyKey ?? proposedKey
      rememberPending(pending, fingerprint, { idempotencyKey })
      const context: PortalWriteContext = { csrfToken, idempotencyKey }

      try {
        const result = await dispatchPortalMutation(client, command, context)
        pending.delete(fingerprint)
        return result
      } catch (error) {
        if (!isAmbiguousMutationFailure(error)) pending.delete(fingerprint)
        throw error
      }
    },
    clear() {
      pending.clear()
    }
  }
}

function rememberPending(pending: Map<string, PendingMutation>, fingerprint: string, mutation: PendingMutation): void {
  if (!pending.has(fingerprint) && pending.size >= MAX_PENDING_MUTATIONS) {
    throw new Error('Too many unresolved Portal changes. Reconcile the existing changes before starting another.')
  }
  if (pending.has(fingerprint)) pending.delete(fingerprint)
  pending.set(fingerprint, mutation)
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  return error instanceof PortalApiError && (error.status === 0 || error.status >= 500 || error.retryable || error.code === 'portal_invalid_response')
}

export async function dispatchPortalMutation(client: PortalClient, command: PortalCommand, context: PortalWriteContext): Promise<unknown> {
  switch (command.type) {
    case 'project.create':
      return client.createProject({
        displayName: requiredString(command.displayName, 'displayName'),
        goal: requiredString(command.goal, 'goal'),
        memberUserIds: stringArray(command.memberUserIds, 'memberUserIds'),
        coordinatorAgentId: requiredString(command.coordinatorAgentId, 'coordinatorAgentId'),
        budget: command.budget as ProjectBudget
      }, context)
    case 'project.members.update': {
      const projectId = requiredString(command.projectId, 'projectId')
      return client.updateProjectMembers(projectId, {
        expectedRevision: positiveRevision(command.expectedRevision),
        addMemberUserIds: stringArray(command.addMemberUserIds, 'addMemberUserIds'),
        removeMemberUserIds: stringArray(command.removeMemberUserIds, 'removeMemberUserIds')
      }, context)
    }
    case 'task.create': {
      const projectId = requiredString(command.projectId, 'projectId')
      const capabilities = command.requiredCapabilities as { capabilityIds?: unknown } | undefined
      return client.createTask(projectId, {
        expectedRevision: positiveRevision(command.expectedRevision),
        assigneeAgentId: requiredString(command.assigneeAgentId, 'assigneeAgentId'),
        title: requiredString(command.title, 'title'),
        objective: requiredString(command.objective, 'objective'),
        completionCriteria: stringArray(command.completionCriteria, 'completionCriteria'),
        dependencyTaskIds: stringArray(command.dependencyTaskIds, 'dependencyTaskIds'),
        capabilityIds: stringArray(capabilities?.capabilityIds, 'requiredCapabilities.capabilityIds')
      }, context)
    }
    case 'task.transition':
      if (command.status !== 'cancelled') throw new TypeError('Portal only exposes the Task cancel transition.')
      return client.cancelTask(requiredString(command.taskId, 'taskId'), {
        executionId: requiredString(command.executionId, 'executionId'),
        expectedRevision: positiveRevision(command.expectedRevision)
      }, context)
    case 'task.retry':
      return client.retryTask(requiredString(command.taskId, 'taskId'), {
        executionId: requiredString(command.executionId, 'executionId'),
        assigneeAgentId: requiredString(command.assigneeAgentId, 'assigneeAgentId'),
        expectedRevision: positiveRevision(command.expectedRevision)
      }, context)
    case 'project_record.accept':
      if (command.decision !== 'accepted' && command.decision !== 'rejected') throw new TypeError('Invalid Project Record review decision.')
      return client.reviewProjectRecord(requiredString(command.projectRecordId, 'projectRecordId'), {
        expectedRevision: positiveRevision(command.expectedRevision),
        decision: command.decision
      }, context)
    default:
      throw new TypeError(`Portal mutation is not supported: ${command.type}`)
  }
}

function mutationFingerprint(command: PortalCommand): string {
  const business = Object.fromEntries(Object.entries(command).filter(([key]) => !['protocolVersion', 'requestId', 'idempotencyKey'].includes(key)))
  return stableJson(business)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required.`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new TypeError(`${label} must be a string array.`)
  return [...value]
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError('expectedRevision must be a positive safe integer.')
  return Number(value)
}
