import type { Locale, ThemePreference } from './types'

const PREFERENCE_KEY = 'sciforge.portal.preferences.v1'

export interface PortalPreferences {
  theme: ThemePreference
  locale: Locale
}

const fallback: PortalPreferences = { theme: 'system', locale: 'zh' }

export function loadPreferences(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): PortalPreferences {
  if (!storage) return fallback
  try {
    const value = JSON.parse(storage.getItem(PREFERENCE_KEY) ?? 'null') as Partial<PortalPreferences> | null
    return {
      theme: value?.theme === 'light' || value?.theme === 'dark' || value?.theme === 'system' ? value.theme : fallback.theme,
      locale: value?.locale === 'en' || value?.locale === 'zh' ? value.locale : fallback.locale
    }
  } catch {
    return fallback
  }
}

export function savePreferences(preferences: PortalPreferences, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  storage?.setItem(PREFERENCE_KEY, JSON.stringify({ theme: preferences.theme, locale: preferences.locale }))
}

export function applyPreferences(preferences: PortalPreferences): void {
  const root = document.documentElement
  root.lang = preferences.locale === 'zh' ? 'zh-CN' : 'en'
  const resolve = (): 'light' | 'dark' => {
    if (preferences.theme === 'light' || preferences.theme === 'dark') return preferences.theme
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  root.dataset.theme = resolve()
}
