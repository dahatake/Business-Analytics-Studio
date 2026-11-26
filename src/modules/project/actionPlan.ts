/**
 * FR-378: from the chosen solutions to an action plan. A solution is usually delivered by several kinds of action — a
 * prompt a person runs in Microsoft 365 Copilot, an agent with an agentic loop, an application with UI/API/database,
 * a data integration (ETL/ELT), a report/visualisation, a machine-learning model — plus non-software changes (process,
 * people and organisation, investment, sourcing; Ward & Daniel's business and enabling changes).
 *
 * The kinds are inferred from the solution's stated type, products and wording, always with the reason, and a person
 * can add, remove or change them. The plan orders the actions inside a solution by their technical dependencies (data
 * before what consumes it, adoption after go-live) and the solutions by their priority, in as many parallel lanes as
 * the team can run (list scheduling; the WSJF order of the what-if).
 */
import type { EntityOf } from '../../data/schema.ts';
import type { SolutionType } from './strategy.ts';

export const ACTION_TYPES = ['copilotPrompt', 'agent', 'app', 'dataPipeline', 'analytics', 'mlModel', 'process', 'change', 'investment', 'sourcing'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
/** Software actions: each gets a production requirements definition. */
export const DEV_TYPES: readonly ActionType[] = ['copilotPrompt', 'agent', 'app', 'dataPipeline', 'analytics', 'mlModel'];
export const isDevType = (t: ActionType) => DEV_TYPES.includes(t);

/** PARAM-215: default duration in weeks per kind (planning guide, AI proposal; a person's estimate replaces it). */
export const DEFAULT_WEEKS: Record<ActionType, number> = {
  copilotPrompt: 2, agent: 10, app: 16, dataPipeline: 8, analytics: 6, mlModel: 12, process: 6, change: 8, investment: 12, sourcing: 10,
};

/** Wording and products that indicate a kind (Japanese and English). The first match is kept as the reason. */
const SIGNALS: [ActionType, RegExp][] = [
  ['copilotPrompt', /Microsoft 365 Copilot|Copilot Chat|Cowork|Autopilot|プロンプト|\bprompts?\b/i],
  ['agent', /Copilot Studio|Microsoft Foundry|AI Foundry|Agent Service|エージェント|\bagents?\b|\bagentic\b|Semantic Kernel|AutoGen/i],
  ['dataPipeline', /Microsoft Fabric|Data Factory|Synapse|Databricks|IoT|Event Hubs|Stream Analytics|Power Automate|Logic Apps|AI Search|データ連携|連携|統合|取り込|ETL|ELT|pipeline|integrat|unif/i],
  ['analytics', /Power BI|Digital Twins|可視化|見える化|ダッシュボード|visuali[sz]|dashboard/i],
  ['mlModel', /Machine Learning|AI Vision|Custom Vision|Document Intelligence|機械学習|予測|異常検知|画像 ?AI|最適化|forecast|anomal|image AI|optimi[sz]/i],
  ['app', /Power Apps|App Service|Dynamics 365|Container Apps|Azure Functions|Static Web Apps|アプリ|画面|ポータル|\bapps?\b|\bapplications?\b|portal/i],
];

export interface ActionDef {
  type: ActionType;
  origin: 'inferred' | 'user';
  /** The words or product the inference matched, or a rule name (`type`, `adoption`, `default`). */
  reason: string;
  /** A person's estimate; absent = PARAM-215. */
  weeks?: number;
  owner?: string;
}

const flatText = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>).map(flatText).join(' ') : '');

const TYPE_ACTION: Partial<Record<SolutionType, ActionType>> = {
  prompt: 'copilotPrompt', agent: 'agent', process: 'process', people: 'change', asset: 'investment', partner: 'sourcing',
};

/** The kinds of action a solution needs, inferred from its type, products and wording (the display language first). */
export function inferActions(s: Pick<EntityOf<'solution'>, 'name' | 'description' | 'msProducts'>, type: SolutionType, lang: 'ja' | 'en' = 'ja'): ActionDef[] {
  const out = new Map<ActionType, ActionDef>();
  const add = (t: ActionType, reason: string) => { if (!out.has(t)) out.set(t, { type: t, origin: 'inferred', reason }); };
  const own = TYPE_ACTION[type];
  if (own) add(own, 'type');
  const other: 'ja' | 'en' = lang === 'ja' ? 'en' : 'ja';
  const words = (v: unknown, l: 'ja' | 'en') => (typeof v === 'string' ? v : v && typeof v === 'object' ? flatText((v as Record<string, unknown>)[l]) : '');
  const texts = [
    ...s.msProducts.map((p) => ({ text: p, product: true })),
    ...([lang, other] as const).flatMap((l) => [{ text: words(s.name, l), product: false }, { text: words(s.description, l), product: false }]),
  ];
  for (const [t, re] of SIGNALS) {
    for (const { text, product } of texts) {
      const m = re.exec(text);
      if (m) { add(t, product ? text : m[0]); break; }
    }
  }
  const dev = [...out.keys()].filter(isDevType);
  if (type === 'digital' && dev.length === 0) add('app', 'default');
  // Every software change needs people to adopt it (Kotter, HBR 1995): planned after go-live, never silently skipped.
  if ([...out.keys()].some(isDevType)) add('change', 'adoption');
  return ACTION_TYPES.filter((t) => out.has(t)).map((t) => out.get(t)!);
}

/** Inside one solution: what must be finished first (data before its consumers, a model before the app/agent using it). */
export const DEPENDS_ON: Partial<Record<ActionType, ActionType[]>> = {
  analytics: ['dataPipeline'],
  mlModel: ['dataPipeline'],
  agent: ['dataPipeline', 'mlModel'],
  copilotPrompt: ['dataPipeline'],
  app: ['mlModel'],
  change: ['copilotPrompt', 'agent', 'app', 'dataPipeline', 'analytics', 'mlModel', 'process', 'investment', 'sourcing'],
};
const TOPOLOGICAL: readonly ActionType[] = ['dataPipeline', 'mlModel', 'analytics', 'app', 'agent', 'copilotPrompt', 'process', 'investment', 'sourcing', 'change'];

export interface ScheduledAction {
  key: string;
  solutionId: string;
  type: ActionType;
  weeks: number;
  /** Weeks from the plan start. */
  startWeek: number;
  endWeek: number;
  lane: number;
  dependsOn: string[];
}

export const actionKey = (solutionId: string, type: ActionType) => `${solutionId}:${type}`;

/** Solution id → its actions. */
export type ActionsBySolution = Record<string, ActionDef[]>;
export type ActionPatch = Partial<Pick<ActionDef, 'weeks' | 'owner'>>;

export const visibleSolutions = (entities: readonly { kind: string; id: string }[], visible: (id: string) => boolean) =>
  entities.filter((e): e is EntityOf<'solution'> => e.kind === 'solution' && visible(e.id));

/**
 * Schedules the solutions in priority order, one lane per solution at a time (`lanes` = how many the team runs in
 * parallel; null = all at once), and the actions of a solution by their dependencies (earliest start).
 */
export function scheduleActions(order: string[], actions: Record<string, ActionDef[]>, lanes: number | null): ScheduledAction[] {
  const free = Array.from({ length: Math.max(1, lanes === null ? order.length : Math.floor(lanes)) }, () => 0);
  const out: ScheduledAction[] = [];
  for (const solutionId of order) {
    const defs = actions[solutionId] ?? [];
    if (defs.length === 0) continue;
    const lane = free.indexOf(Math.min(...free));
    const t0 = free[lane]!;
    const done = new Map<ActionType, number>();
    const types = new Set(defs.map((d) => d.type));
    // Every kind comes after the kinds it depends on, so one pass in this order is a topological order.
    const ordered = TOPOLOGICAL.filter((t) => types.has(t)).map((t) => defs.find((d) => d.type === t)!);
    for (const d of ordered) {
      const deps = (DEPENDS_ON[d.type] ?? []).filter((t) => types.has(t) && t !== d.type);
      const start = Math.max(t0, ...deps.map((t) => done.get(t) ?? t0));
      const weeks = Math.max(1, Math.round(d.weeks ?? DEFAULT_WEEKS[d.type]));
      done.set(d.type, start + weeks);
      out.push({ key: actionKey(solutionId, d.type), solutionId, type: d.type, weeks, startWeek: start, endWeek: start + weeks, lane, dependsOn: deps.map((t) => actionKey(solutionId, t)) });
    }
    free[lane] = Math.max(...[...done.values()]);
  }
  return out;
}

export const addWeeks = (iso: string, weeks: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);

/** File name from a solution name: Windows/macOS-safe, no path separators, no trailing dot or space. */
export function safeFileStem(name: string): string {
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  const short = [...s].slice(0, 100).join('');
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(short) || short === '' ? `_${short}` : short;
}

/** The file name the user asked for, spelled exactly as requested. */
export const requirementsFileName = (solutionName: string) => `${safeFileStem(solutionName)}-Production-Requirements-Definision.md`;
