import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WorkbenchTopBar } from './WorkbenchTopBar'

describe('WorkbenchTopBar', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('keeps Canvas under the Figure style panel instead of rendering a standalone topbar button', () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchTopBar, {
        rightPanelMode: null,
        onToggleRightPanelMode: vi.fn()
      })
    )

    expect(html).toContain('aria-label="Figure style"')
    expect(html).not.toContain('aria-label="Canvas"')
    expect(html).not.toContain('rightPanelSciforgeCanvas')
  })
})
