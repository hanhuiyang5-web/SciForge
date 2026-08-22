import { describe, expect, it } from 'vitest'
import { loadPreferences, savePreferences } from './preferences'

describe('Portal preferences', () => {
  it('persists only non-sensitive theme and locale choices', () => {
    let saved = ''
    savePreferences({ theme: 'dark', locale: 'en' }, { setItem: (_key, value) => { saved = value } })
    expect(JSON.parse(saved)).toEqual({ theme: 'dark', locale: 'en' })
    expect(saved).not.toMatch(/token|secret|credential|session/iu)
  })

  it('fails safely on malformed storage', () => {
    expect(loadPreferences({ getItem: () => '{broken' })).toEqual({ theme: 'system', locale: 'zh' })
  })
})
