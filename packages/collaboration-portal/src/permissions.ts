import type { CoordinationView, ProjectSummary } from './types'

export function canOpenCoordinationView(project: Pick<ProjectSummary, 'role'>): boolean {
  return project.role === 'owner'
}

export function canMutateProject(view: CoordinationView | null, userId: string): boolean {
  return view?.project.ownerUserId === userId
}
