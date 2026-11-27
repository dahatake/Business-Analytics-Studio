import { createElement, lazy, useState, type ComponentType, type LazyExoticComponent } from 'react';
import type { FluentIcon } from '@fluentui/react-icons';
import {
  Diagram24Regular, Map24Regular, ArrowFlowDiagonalUpRight24Regular, GanttChart24Regular,
  DataTrending24Regular, People24Regular, Settings24Regular, Board24Regular, SlideText24Regular, Flowchart24Regular,
  Briefcase24Regular, DataPie24Regular, Chat24Regular, BookOpen24Regular, Database24Regular,
  PlugConnected24Regular, Color24Regular, LayoutCellFour24Regular, Rocket24Regular, TaskListSquareLtr24Regular,
  DocumentDatabase24Regular, Gauge24Regular,
} from '@fluentui/react-icons';
import type { MessageKey } from '../i18n/index.ts';
import { HomeScreen } from '../modules/project/HomeScreen.tsx';

export type NavGroup = 'start' | 'analyze' | 'collaborate' | 'present' | 'manage';

export interface ScreenDef {
  /** First path segment, e.g. '/board' (sub-paths such as '/board/abc' route to the same screen). */
  path: string;
  label: MessageKey;
  Icon: FluentIcon;
  group: NavGroup;
  hiddenFromNav?: boolean;
  component: ComponentType | LazyExoticComponent<ComponentType>;
}

type LoadableScreen = ComponentType & { preload: () => Promise<unknown> };

/**
 * A code-split screen. Once its module has loaded (on first visit or by `preloadScreens`), it renders
 * synchronously, so later visits never fall back to the Suspense spinner and its reveal delay.
 */
const lazyNamed = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): LoadableScreen => {
  let ready: ComponentType | undefined;
  let pending: Promise<ComponentType> | undefined;
  const preload = () => (pending ??= load().then((m) => (ready = m[name])).catch((err: unknown) => { pending = undefined; throw err; }));
  const Lazy = lazy(async (): Promise<{ default: ComponentType }> => ({ default: await preload() }));
  const Screen = () => {
    const [{ Component }] = useState<{ Component: ComponentType }>(() => ({ Component: ready ?? Lazy }));
    return createElement(Component);
  };
  return Object.assign(Screen, { preload });
};

/** Every screen of the app. Feature modules own their screen files under src/modules/<module>/. */
export const SCREENS: ScreenDef[] = [
  { path: '/home', label: 'proj.nav.home', Icon: Rocket24Regular, group: 'start', component: HomeScreen },
  { path: '/step', label: 'proj.dash.nav', Icon: Gauge24Regular, group: 'start', hiddenFromNav: true, component: lazyNamed(() => import('../modules/project/StepDashboardScreen.tsx'), 'StepDashboardScreen') },
  { path: '/deliverables', label: 'dlv.nav', Icon: TaskListSquareLtr24Regular, group: 'start', component: lazyNamed(() => import('../modules/project/DeliverablesScreen.tsx'), 'DeliverablesScreen') },
  // The former analysis overview is now the project's main screen; '/' stays as an alias so existing links keep working.
  { path: '/', label: 'proj.nav.home', Icon: Rocket24Regular, group: 'start', hiddenFromNav: true, component: HomeScreen },
  { path: '/analysis', label: 'proj.nav.analysis', Icon: DataPie24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/project/AnalysisScreen.tsx'), 'AnalysisScreen') },
  { path: '/process', label: 'nav.process', Icon: Flowchart24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/process/ProcessScreen.tsx'), 'ProcessScreen') },
  // The relation table is the editor that step tasks open (`edit=`/`create=`); it is reached from those links, not the rail.
  { path: '/relations', label: 'nav.relations', Icon: Diagram24Regular, group: 'analyze', hiddenFromNav: true, component: lazyNamed(() => import('../screens/Relations.tsx'), 'Relations') },
  { path: '/map', label: 'nav.map', Icon: Map24Regular, group: 'analyze', component: lazyNamed(() => import('../screens/MapScreen.tsx'), 'MapScreen') },
  { path: '/flows', label: 'nav.flows', Icon: ArrowFlowDiagonalUpRight24Regular, group: 'analyze', hiddenFromNav: true, component: lazyNamed(() => import('../screens/FlowsRedirect.tsx'), 'FlowsRedirect') },
  { path: '/plan', label: 'nav.plan', Icon: GanttChart24Regular, group: 'analyze', component: lazyNamed(() => import('../screens/Plan.tsx'), 'Plan') },
  { path: '/optimize', label: 'nav.optimize', Icon: DataTrending24Regular, group: 'analyze', component: lazyNamed(() => import('../screens/Optimize.tsx'), 'Optimize') },
  { path: '/catalog', label: 'uc.nav.catalog', Icon: Database24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/usecases/CatalogScreen.tsx'), 'CatalogScreen') },
  { path: '/directory', label: 'nav.directory', Icon: People24Regular, group: 'analyze', component: lazyNamed(() => import('../screens/Directory.tsx'), 'Directory') },
  { path: '/workspace', label: 'ws.title', Icon: LayoutCellFour24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/workspace/WorkspaceScreen.tsx'), 'WorkspaceScreen') },
  { path: '/discussion', label: 'proj.nav.discussion', Icon: Chat24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/project/DiscussionScreen.tsx'), 'DiscussionScreen') },
  { path: '/board', label: 'ink.title', Icon: Board24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/ink/BoardScreen.tsx'), 'BoardScreen') },
  { path: '/usecases', label: 'uc.title', Icon: BookOpen24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/usecases/UseCasesScreen.tsx'), 'UseCasesScreen') },
  { path: '/show', label: 'show.title', Icon: SlideText24Regular, group: 'present', component: lazyNamed(() => import('../modules/show/ShowScreen.tsx'), 'ShowScreen') },
  { path: '/projects', label: 'proj.title', Icon: Briefcase24Regular, group: 'manage', component: lazyNamed(() => import('../modules/project/ProjectsScreen.tsx'), 'ProjectsScreen') },
  { path: '/data', label: 'proj.nav.data', Icon: DocumentDatabase24Regular, group: 'manage', component: lazyNamed(() => import('../modules/project/PackDataScreen.tsx'), 'PackDataScreen') },
  { path: '/integrations', label: 'ops.nav.integrations', Icon: PlugConnected24Regular, group: 'manage', component: lazyNamed(() => import('../modules/ops/IntegrationsScreen.tsx'), 'IntegrationsScreen') },
  { path: '/brand', label: 'ops.title', Icon: Color24Regular, group: 'manage', component: lazyNamed(() => import('../modules/ops/BrandScreen.tsx'), 'BrandScreen') },
  // D-25: AI settings are a tab within Settings, not a separate nav entry.
  { path: '/settings', label: 'nav.settings', Icon: Settings24Regular, group: 'manage', component: lazyNamed(() => import('../screens/Settings.tsx'), 'SettingsScreen') },
];

export const NAV_GROUPS: { group: NavGroup; label: MessageKey }[] = [
  { group: 'start', label: 'nav.group.start' },
  { group: 'analyze', label: 'nav.group.analyze' },
  { group: 'collaborate', label: 'nav.group.collaborate' },
  { group: 'present', label: 'nav.group.present' },
  { group: 'manage', label: 'nav.group.manage' },
];

/** Resolve the screen for a path; entity detail pages are handled separately by the App. */
export function screenFor(path: string): ScreenDef | undefined {
  if (path === '/') return SCREENS.find((s) => s.path === '/');
  const first = `/${path.split('/').filter(Boolean)[0] ?? ''}`;
  return SCREENS.find((s) => s.path === first);
}

/** Light screens loaded in idle time after start-up, so their first visit opens without a loading spinner. */
const IDLE_PRELOAD = ['/step', '/process', '/map', '/plan', '/optimize', '/directory', '/settings'];

export function preloadScreensWhenIdle() {
  const idle = (run: () => void) =>
    (typeof requestIdleCallback === 'function' ? requestIdleCallback(run, { timeout: 5000 }) : setTimeout(run, 500));
  const queue = SCREENS.filter((s) => IDLE_PRELOAD.includes(s.path)).map((s) => s.component as Partial<LoadableScreen>);
  const next = () => {
    const screen = queue.shift();
    if (!screen) return;
    void (screen.preload?.() ?? Promise.resolve()).catch(() => undefined).finally(() => idle(next));
  };
  idle(next);
}
