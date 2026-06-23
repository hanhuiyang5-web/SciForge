import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIGURE_STYLE_PANEL_PAGE_KEY } from './figure-style/figure-style-panel-state'
import { readStoredRightPanelMode } from './workbench-layout'

const RIGHT_PANEL_MODE_KEY = 'deepseekgui.layout.rightPanelMode'

function stubLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  })
  return values
}

describe('workbench layout right panel persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('migrates the old standalone Canvas right panel mode into Figure style canvas page', () => {
    const values = stubLocalStorage({
      [RIGHT_PANEL_MODE_KEY]: 'sciforge-canvas'
    })

    expect(readStoredRightPanelMode()).toBe('figure-style')
    expect(values.get(RIGHT_PANEL_MODE_KEY)).toBe('figure-style')
    expect(values.get(FIGURE_STYLE_PANEL_PAGE_KEY)).toBe('canvas')
  })
})
