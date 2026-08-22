import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('shared SciForge design tokens', () => {
  it('keeps Desktop and Portal mapped to one visual primitive source', () => {
    const shared = readFileSync(new URL('../../../src/shared/sciforge-design-tokens.css', import.meta.url), 'utf8')
    const portalMain = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
    const portal = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8')
    const desktopMain = readFileSync(new URL('../../../src/renderer/src/main.tsx', import.meta.url), 'utf8')
    const desktop = readFileSync(new URL('../../../src/renderer/src/styles/base-shell.css', import.meta.url), 'utf8')

    expect(shared).toContain('--sf-accent: #0088ff')
    expect(shared).toContain('--sf-accent: #339cff')
    expect(shared).toContain('--sf-font-body:')
    expect(shared).toContain('--sf-motion-medium: 180ms')
    expect(portalMain).toContain("../../../src/shared/sciforge-design-tokens.css")
    expect(desktopMain).toContain("../../shared/sciforge-design-tokens.css")
    expect(portal).toContain('--accent: var(--sf-accent)')
    expect(portal).toContain('--font-body: var(--sf-font-body)')
    expect(desktop).toContain('--ds-accent: var(--sf-accent)')
    expect(desktop).toContain('--bg-app: var(--sf-bg-app)')
  })
})
