import { ChevronRight, CircleUserRound, FolderKanban, Gauge, Languages, LogOut, Moon, Network, Plus, Sun, SunMoon } from 'lucide-react'
import type { MessageKey } from '../i18n'
import type { DirectoryPaginationState } from '../hooks/usePortalData'
import type { Locale, PortalRoute, PortalUser, ProjectSummary, ThemePreference } from '../types'
import { canOpenCoordinationView } from '../permissions'
import { BrandMark } from './BrandMark'
import { CollectionLoadMore } from './CollectionLoadMore'

interface SidebarProps {
  user: PortalUser
  projects: ProjectSummary[]
  pagination: DirectoryPaginationState
  route: PortalRoute
  selectedProjectId: string | null
  theme: ThemePreference
  locale: Locale
  t(key: MessageKey): string
  onRoute(route: PortalRoute): void
  onProject(projectId: string): void
  onCreateProject(): void
  onLoadMoreProjects(): Promise<void>
  onTheme(theme: ThemePreference): void
  onLocale(locale: Locale): void
  onLogout(): void
}

export function Sidebar({ user, projects, pagination, route, selectedProjectId, theme, locale, t, onRoute, onProject, onCreateProject, onLoadMoreProjects, onTheme, onLocale, onLogout }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <header className="sidebar__brand"><BrandMark /><span>{t('researchControlRoom')}</span></header>
      <nav className="primary-nav" aria-label={t('pageTitle')}>
        <button className={route === 'dashboard' ? 'is-active' : ''} onClick={() => onRoute('dashboard')}><Gauge size={16} />{t('dashboard')}<ChevronRight size={13} /></button>
        <button className={route === 'workers' ? 'is-active' : ''} onClick={() => onRoute('workers')}><Network size={16} />{t('workers')}<ChevronRight size={13} /></button>
      </nav>
      <div className="sidebar__section-title"><span>{t('projects')}</span><button aria-label={t('newProject')} onClick={onCreateProject}><Plus size={14} /></button></div>
      <nav className="project-nav" aria-label={t('projects')}>
        {projects.length === 0 && <p>{t('noProjects')}</p>}
        {projects.map((project) => (
          <button className={selectedProjectId === project.projectId && route === 'project' ? 'is-active' : ''} key={project.projectId} disabled={!canOpenCoordinationView(project)} title={!canOpenCoordinationView(project) ? t('ownerRoleOnly') : undefined} onClick={() => onProject(project.projectId)}>
            <i><FolderKanban size={14} /></i><span><strong>{project.displayName}</strong><small>{project.role} · {project.taskCounts.running + project.taskCounts.needsHuman} {t('activeTasks')}</small></span>
            {project.taskCounts.needsHuman > 0 && <b aria-label={`${project.taskCounts.needsHuman} ${t('needs_human')}`}>{project.taskCounts.needsHuman}</b>}
          </button>
        ))}
      </nav>
      <CollectionLoadMore state={pagination} label={t('projects')} t={t} onLoad={onLoadMoreProjects} />
      <footer className="sidebar__footer">
        <div className="preference-row" aria-label={t('theme')}>
          {(['light', 'system', 'dark'] as const).map((value) => <button className={theme === value ? 'is-active' : ''} aria-label={t(value)} aria-pressed={theme === value} onClick={() => onTheme(value)} key={value}>{value === 'light' ? <Sun size={14} /> : value === 'dark' ? <Moon size={14} /> : <SunMoon size={14} />}</button>)}
          <button aria-label={t('language')} onClick={() => onLocale(locale === 'zh' ? 'en' : 'zh')}><Languages size={14} /><small>{locale === 'zh' ? '中' : 'EN'}</small></button>
        </div>
        <div className="account-card"><i>{user.displayName.slice(0, 1).toUpperCase()}</i><span><strong>{user.displayName}</strong><small>{t('account')}</small></span><button aria-label={t('signOut')} onClick={onLogout}><LogOut size={14} /></button></div>
      </footer>
    </aside>
  )
}

export function MobileNavigation({ route, t, onRoute }: { route: PortalRoute; t(key: MessageKey): string; onRoute(route: PortalRoute): void }): React.JSX.Element {
  return <nav className="mobile-nav" aria-label={t('pageTitle')}>
    <button className={route === 'dashboard' ? 'is-active' : ''} onClick={() => onRoute('dashboard')}><Gauge size={18} /><span>{t('mobileDashboard')}</span></button>
    <button className={route === 'workers' ? 'is-active' : ''} onClick={() => onRoute('workers')}><Network size={18} /><span>{t('mobileWorkers')}</span></button>
    <button className={route === 'project' ? 'is-active' : ''} onClick={() => onRoute('project')}><FolderKanban size={18} /><span>{t('mobileProjects')}</span></button>
    <button><CircleUserRound size={18} /><span>{t('account')}</span></button>
  </nav>
}
