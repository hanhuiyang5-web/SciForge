// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDemoClient } from '../demo'
import { translate } from '../i18n'
import type { CoordinationView, PortalSelection, PortalWorker, Task } from '../types'
import { Inspector } from './Inspector'
import { CreateTaskDialog, ManageMembersDialog } from './PortalDialogs'

let root: Root | undefined
let container: HTMLDivElement | undefined
const t = (key: Parameters<typeof translate>[1]): string => translate('en', key)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function fixtures(): Promise<{ view: CoordinationView; workers: PortalWorker[] }> {
  const client = createDemoClient()
  return { view: await client.getCoordination('prj_proteinatlas01'), workers: (await client.listWorkers()).items }
}

function failedTask(task: Task, fields: Partial<Task>): Task {
  return { ...task, status: 'failed', safeFailureCode: 'worker_failed', safeFailureSummary: 'Bounded test failure.', ...fields }
}

function renderInspector(view: CoordinationView, workers: PortalWorker[], selection: PortalSelection): void {
  root?.render(<Inspector
    view={view}
    workers={workers}
    selection={selection}
    user={{ userId: view.project.ownerUserId, displayName: 'Owner' }}
    locale="en"
    t={t}
    actionPending={false}
    pagination={{
      tasks: { nextCursor: null, limit: 100, version: 'tasks:test', pagesLoaded: 1, loading: false, error: null },
      records: { nextCursor: null, limit: 100, version: 'records:test', pagesLoaded: 1, loading: false, error: null },
      humanRequests: { nextCursor: null, limit: 50, version: 'human:test', pagesLoaded: 1, loading: false, error: null },
      bytes: 0
    }}
    drawerOpen
    onCloseDrawer={() => undefined}
    onLoadMore={async () => undefined}
    onRun={async () => undefined}
  />)
}

describe('Portal optimistic-concurrency UI', () => {
  it('remounts Task recovery state across Task and execution changes and never offers retry for cancelled', async () => {
    const { view, workers } = await fixtures()
    const first = failedTask(view.tasks[0]!, { taskId: 'tsk_stateA00000001', executionId: 'exe_stateA00000001', assigneeAgentId: workers[0]!.agentId })
    const second = failedTask(view.tasks[1]!, { taskId: 'tsk_stateB00000001', executionId: 'exe_stateB00000001', assigneeAgentId: workers[1]!.agentId })
    let nextView = { ...view, tasks: [first, second] }

    await act(async () => renderInspector(nextView, workers, { kind: 'task', id: first.taskId }))
    let select = container?.querySelector<HTMLSelectElement>('.compact-field select')
    expect(select?.value).toBe(first.assigneeAgentId)
    await act(async () => {
      if (select) {
        select.value = workers[2]!.agentId
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    expect(container?.querySelector<HTMLSelectElement>('.compact-field select')?.value).toBe(workers[2]!.agentId)

    await act(async () => renderInspector(nextView, workers, { kind: 'task', id: second.taskId }))
    expect(container?.querySelector<HTMLSelectElement>('.compact-field select')?.value).toBe(second.assigneeAgentId)

    const newExecution = { ...second, executionId: 'exe_stateB00000002', assigneeAgentId: workers[3]!.agentId }
    nextView = { ...view, tasks: [first, newExecution] }
    await act(async () => renderInspector(nextView, workers, { kind: 'task', id: newExecution.taskId }))
    expect(container?.querySelector<HTMLSelectElement>('.compact-field select')?.value).toBe(newExecution.assigneeAgentId)

    const cancelled = { ...newExecution, status: 'cancelled' as const }
    nextView = { ...view, tasks: [first, cancelled] }
    await act(async () => renderInspector(nextView, workers, { kind: 'task', id: cancelled.taskId }))
    expect(container?.querySelector('.compact-field')).toBeNull()
    expect([...container!.querySelectorAll('button')].some((button) => button.textContent?.includes('Retry'))).toBe(false)
  })

  it('freezes the member base revision and blocks submit after a concurrent Project update', async () => {
    const { view, workers } = await fixtures()
    const onRun = vi.fn(async () => undefined)
    const props = { workers, t, actionPending: false, onClose: () => undefined, onRun }
    await act(async () => root?.render(<ManageMembersDialog view={view} {...props} />))

    const concurrent = { ...view, projectRevision: view.projectRevision + 1, project: { ...view.project, revision: view.project.revision + 1 } }
    await act(async () => root?.render(<ManageMembersDialog view={concurrent} {...props} />))
    const save = [...container!.querySelectorAll('button')].find((button) => button.textContent?.includes('Save members'))
    expect(save?.disabled).toBe(true)
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('Cloud state changed')
    await act(async () => { container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onRun).not.toHaveBeenCalled()
  })

  it('freezes Task creation to the opening revision and requires reopen after WSS reconciliation', async () => {
    const { view, workers } = await fixtures()
    const onRun = vi.fn(async () => undefined)
    const props = { workers, t, actionPending: false, onClose: () => undefined, onRun }
    await act(async () => root?.render(<CreateTaskDialog view={view} {...props} />))

    const concurrent = { ...view, projectRevision: view.projectRevision + 1, project: { ...view.project, revision: view.project.revision + 1 } }
    await act(async () => root?.render(<CreateTaskDialog view={concurrent} {...props} />))
    const submit = [...container!.querySelectorAll('button')].find((button) => button.textContent === 'Submit')
    expect(submit?.disabled).toBe(true)
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('Cloud state changed')
    await act(async () => { container?.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onRun).not.toHaveBeenCalled()
  })
})
