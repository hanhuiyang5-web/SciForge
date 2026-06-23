import {
  readBrowserStorageItem,
  writeBrowserStorageItem
} from '../../lib/browser-storage'

export type FigureStylePanelPage = 'style' | 'canvas'

export const FIGURE_STYLE_PANEL_PAGE_KEY = 'deepseekgui.figureStyle.activePage'

export function readStoredFigureStylePanelPage(fallback: FigureStylePanelPage = 'style'): FigureStylePanelPage {
  const raw = readBrowserStorageItem(FIGURE_STYLE_PANEL_PAGE_KEY)
  return raw === 'style' || raw === 'canvas' ? raw : fallback
}

export function persistFigureStylePanelPage(page: FigureStylePanelPage): void {
  writeBrowserStorageItem(FIGURE_STYLE_PANEL_PAGE_KEY, page)
}
