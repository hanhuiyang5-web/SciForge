import type { CoordinationCollectionState, DirectoryPaginationState } from '../hooks/usePortalData'
import type { MessageKey } from '../i18n'

export function CollectionLoadMore({ state, label, t, onLoad }: {
  state: CoordinationCollectionState | DirectoryPaginationState
  label: string
  t(key: MessageKey): string
  onLoad(): Promise<void>
}): React.JSX.Element | null {
  const stale = 'stale' in state && state.stale
  if (!state.nextCursor && !state.error && !stale) return null
  return (
    <div className="collection-pagination">
      {state.error && <p role="alert">{state.error}</p>}
      {stale && <p className="collection-pagination__stale">{t('stalePages')}</p>}
      {state.nextCursor && <button className="text-button" disabled={state.loading} onClick={() => { void onLoad() }}>{state.loading ? t('loadingMore') : `${t('loadMore')} ${label}`}</button>}
    </div>
  )
}
