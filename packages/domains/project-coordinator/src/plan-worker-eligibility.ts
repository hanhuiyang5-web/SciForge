import type {
  ProjectPlanTask,
  ProjectWorkerAvailabilityView,
  TaskAuthority
} from '@sciforge/collaboration-contracts'

import type { ProjectCoordinatorProject } from './contract.js'

/**
 * Planning eligibility intentionally differs from live offer eligibility.
 * A newly created Project is paused until its Plan is confirmed, so its Task
 * Authorities are suspended with project_paused even though an online Runtime
 * may already be a valid choice for the draft Plan.
 */
export function isProjectCoordinatorRuntimeOnlineForPlanning(
  projectAvailability: ProjectWorkerAvailabilityView,
  observedAt: string
): boolean {
  const { availability } = projectAvailability
  return projectAvailability.membership?.state === 'active' &&
    availability.agentActive &&
    availability.deviceActive &&
    availability.connectionStatus === 'online' &&
    availability.runtimeReadiness === 'ready' &&
    availability.acceptsNewOffers &&
    availability.expiresAt > observedAt
}

export function canUseProjectCoordinatorTaskScopeWhilePlanning(
  project: ProjectCoordinatorProject,
  projectAvailability: ProjectWorkerAvailabilityView,
  scope: TaskAuthority['scope']
): boolean {
  if (projectAvailability.membership?.state !== 'active') return false
  if (project.project.status === 'completed' || project.project.status === 'cancelled') return false
  if (project.project.status === 'active') {
    return projectAvailability.taskAuthorities.some((authority) => (
      authority.scope === scope && authority.state === 'eligible'
    ))
  }
  if (scope === 'text_tasks') return true
  const binding = project.provisioning.binding
  const readiness = projectAvailability.contentReadiness
  const principal = projectAvailability.providerPrincipalFact
  return project.project.contentMode === 'required' &&
    binding?.status === 'active' &&
    binding.rootLocator !== null &&
    binding.rootLocatorDigest !== null &&
    readiness?.state === 'ready' &&
    readiness.bindingRevision === binding.revision &&
    readiness.providerPrincipalFactId !== null &&
    readiness.snapshottedFactRevision !== null &&
    projectAvailability.providerPrincipalSnapshotStatus === 'match' &&
    principal?.readiness === 'ready'
}

function canProjectCoordinatorRuntimeAcceptPlannedTask(
  project: ProjectCoordinatorProject,
  projectAvailability: ProjectWorkerAvailabilityView,
  task: ProjectPlanTask,
  observedAt: string
): boolean {
  if (!isProjectCoordinatorRuntimeOnlineForPlanning(projectAvailability, observedAt)) return false
  const scope = task.fileIntent === null ? 'text_tasks' : 'file_tasks'
  if (!canUseProjectCoordinatorTaskScopeWhilePlanning(project, projectAvailability, scope)) {
    return false
  }
  if (task.requiredCapabilityTags.some((tag) => (
    !projectAvailability.availability.runtimeCapabilityTags.includes(tag)
  ))) return false
  if (task.fileIntent === null) return true
  const binding = project.provisioning.binding
  const readiness = projectAvailability.contentReadiness
  const principal = projectAvailability.providerPrincipalFact
  return project.project.contentMode === 'required' &&
    binding?.status === 'active' &&
    binding.rootLocator !== null &&
    binding.rootLocatorDigest !== null &&
    binding.revision === task.fileIntent.bindingRevision &&
    readiness?.state === 'ready' &&
    readiness.bindingRevision === binding.revision &&
    readiness.providerPrincipalFactId !== null &&
    readiness.snapshottedFactRevision !== null &&
    projectAvailability.providerPrincipalSnapshotStatus === 'match' &&
    principal?.readiness === 'ready'
}

export function canProjectCoordinatorWorkerGroupAcceptPlannedTask(
  project: ProjectCoordinatorProject,
  group: ProjectCoordinatorProject['workerGroups'][number],
  task: ProjectPlanTask,
  observedAt: string
): boolean {
  return group.agents.some(({ projectAvailability }) => (
    canProjectCoordinatorRuntimeAcceptPlannedTask(
      project,
      projectAvailability,
      task,
      observedAt
    )
  ))
}
