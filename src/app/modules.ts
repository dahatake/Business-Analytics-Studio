import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { FluentIcon } from '@fluentui/react-icons';
import {
  Home24Regular, Diagram24Regular, Map24Regular, ArrowFlowDiagonalUpRight24Regular, GanttChart24Regular,
  DataTrending24Regular, People24Regular, Settings24Regular, Board24Regular, SlideText24Regular, Cube24Regular,
  Organization24Regular, Briefcase24Regular, DataPie24Regular, Chat24Regular, BookOpen24Regular, Database24Regular,
  Bot24Regular, PlugConnected24Regular, Color24Regular, LayoutCellFour24Regular, Rocket24Regular, KeyMultiple24Regular, TaskListSquareLtr24Regular,
  DocumentDatabase24Regular,
} from '@fluentui/react-icons';
import type { MessageKey } from '../i18n/index.ts';
import { Overview } from '../screens/Overview.tsx';
import { Relations } from '../screens/Relations.tsx';
import { MapScreen } from '../screens/MapScreen.tsx';
import { Flows } from '../screens/Flows.tsx';
import { Plan } from '../screens/Plan.tsx';
import { Optimize } from '../screens/Optimize.tsx';
import { Directory } from '../screens/Directory.tsx';
import { SettingsScreen } from '../screens/Settings.tsx';

export type NavGroup = 'start' | 'analyze' | 'collaborate' | 'present' | 'manage';

export interface ScreenDef {
  /** First path segment, e.g. '/board' (sub-paths such as '/board/abc' route to the same screen). */
  path: string;
  label: MessageKey;
  Icon: FluentIcon;
  group: NavGroup;
  component: ComponentType | LazyExoticComponent<ComponentType>;
}

const lazyNamed = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(async () => ({ default: (await load())[name] }));

/** Every screen of the app. Feature modules own their screen files under src/modules/<module>/. */
export const SCREENS: ScreenDef[] = [
  { path: '/home', label: 'proj.nav.home', Icon: Rocket24Regular, group: 'start', component: lazyNamed(() => import('../modules/project/HomeScreen.tsx'), 'HomeScreen') },
  { path: '/deliverables', label: 'dlv.nav', Icon: TaskListSquareLtr24Regular, group: 'start', component: lazyNamed(() => import('../modules/project/DeliverablesScreen.tsx'), 'DeliverablesScreen') },
  { path: '/', label: 'nav.overview', Icon: Home24Regular, group: 'analyze', component: Overview },
  { path: '/analysis', label: 'proj.nav.analysis', Icon: DataPie24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/project/AnalysisScreen.tsx'), 'AnalysisScreen') },
  { path: '/relations', label: 'nav.relations', Icon: Diagram24Regular, group: 'analyze', component: Relations },
  { path: '/graph', label: 'graph.title', Icon: Organization24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/graph/GraphScreen.tsx'), 'GraphScreen') },
  { path: '/twin3d', label: 'td.title', Icon: Cube24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/threed/ThreeDScreen.tsx'), 'ThreeDScreen') },
  { path: '/map', label: 'nav.map', Icon: Map24Regular, group: 'analyze', component: MapScreen },
  { path: '/flows', label: 'nav.flows', Icon: ArrowFlowDiagonalUpRight24Regular, group: 'analyze', component: Flows },
  { path: '/plan', label: 'nav.plan', Icon: GanttChart24Regular, group: 'analyze', component: Plan },
  { path: '/optimize', label: 'nav.optimize', Icon: DataTrending24Regular, group: 'analyze', component: Optimize },
  { path: '/catalog', label: 'uc.nav.catalog', Icon: Database24Regular, group: 'analyze', component: lazyNamed(() => import('../modules/usecases/CatalogScreen.tsx'), 'CatalogScreen') },
  { path: '/directory', label: 'nav.directory', Icon: People24Regular, group: 'analyze', component: Directory },
  { path: '/workspace', label: 'ws.title', Icon: LayoutCellFour24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/workspace/WorkspaceScreen.tsx'), 'WorkspaceScreen') },
  { path: '/discussion', label: 'proj.nav.discussion', Icon: Chat24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/project/DiscussionScreen.tsx'), 'DiscussionScreen') },
  { path: '/board', label: 'ink.title', Icon: Board24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/ink/BoardScreen.tsx'), 'BoardScreen') },
  { path: '/usecases', label: 'uc.title', Icon: BookOpen24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/usecases/UseCasesScreen.tsx'), 'UseCasesScreen') },
  { path: '/assistant', label: 'ai.title', Icon: Bot24Regular, group: 'collaborate', component: lazyNamed(() => import('../modules/ai/AssistantScreen.tsx'), 'AssistantScreen') },
  { path: '/show', label: 'show.title', Icon: SlideText24Regular, group: 'present', component: lazyNamed(() => import('../modules/show/ShowScreen.tsx'), 'ShowScreen') },
  { path: '/projects', label: 'proj.title', Icon: Briefcase24Regular, group: 'manage', component: lazyNamed(() => import('../modules/project/ProjectsScreen.tsx'), 'ProjectsScreen') },
  { path: '/data', label: 'proj.nav.data', Icon: DocumentDatabase24Regular, group: 'manage', component: lazyNamed(() => import('../modules/project/PackDataScreen.tsx'), 'PackDataScreen') },
  { path: '/integrations', label: 'ops.nav.integrations', Icon: PlugConnected24Regular, group: 'manage', component: lazyNamed(() => import('../modules/ops/IntegrationsScreen.tsx'), 'IntegrationsScreen') },
  { path: '/brand', label: 'ops.title', Icon: Color24Regular, group: 'manage', component: lazyNamed(() => import('../modules/ops/BrandScreen.tsx'), 'BrandScreen') },
  { path: '/ai-settings', label: 'ai.nav.settings', Icon: KeyMultiple24Regular, group: 'manage', component: lazyNamed(() => import('../modules/ai/AiSettingsScreen.tsx'), 'AiSettingsScreen') },
  { path: '/settings', label: 'nav.settings', Icon: Settings24Regular, group: 'manage', component: SettingsScreen },
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
