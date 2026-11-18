import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Field, MessageBar, MessageBarBody, Select, Slider, SpinButton, Spinner, Switch, Tab, TabList,
} from '@fluentui/react-components';
import { ArrowReset20Regular, DismissCircle20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { aiComplete, type AiResponse } from '../../ai/client.ts';
import { getEntity, loaded } from '../../data/pack.ts';
import { ARCHETYPES, ARCHETYPE_PROFILES, classifyIndustry, type Archetype, type Lens } from '../../domain/resourceIndustry.ts';
import {
  applyOverrides, buildNetworkModel, buildPeopleModel, countOverrides, defaultPeopleParams, emptyOverrides, linkKey, runScenario,
  type NetworkParams, type Overrides, type PeopleParams, type Provenance, type ResourceModel, type Scenario,
} from '../../domain/resourceModel.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useActiveProject } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { LiveNotice, MockNotice } from '../ai/AiCommon.tsx';
import { liveReady, useAiSettings } from '../ai/settingsStore.ts';
import { openAiSettings } from '../ai/uiStore.ts';
import { buildFacts, narrativePrompt, RESOURCE_STAGE, type Fact } from './facts.ts';
import { ResourceFlowMap, type Selection, type View } from './ResourceFlowMap.tsx';
import './resource.css';

const PROV_COLOR: Record<Provenance, 'brand' | 'informative' | 'warning' | 'important'> = {
  pack: 'brand', derived: 'informative', assumption: 'warning', simulation: 'important',
};

export function ProvenanceBadge({ value }: { value: Provenance }) {
  const { t } = useI18n();
  return <Badge size="small" appearance="tint" color={PROV_COLOR[value]} className="res-prov" data-prov={value}>{t(`res.prov.${value}`)}</Badge>;
}

/** Commentary already generated this session, per scenario signature (avoids paying twice for the same facts). */
const narrativeCache = new Map<string, AiResponse>();

/**
 * FR-326: industry-aware resource optimization. The customer's industry picks the lens (people → work or sites → regions)
 * and the assumptions; the facts, the visual and the simulation all read the same scenario.
 */
export function ResourceWorkbench() {
  const { t, tx } = useI18n();
  const { company } = useActiveProject();
  const pack = loaded.pack;
  const entered = company?.industry?.trim();
  const industryText = entered || tx(pack.company.industry);
  const detected = useMemo(
    () => classifyIndustry(entered || `${pack.company.industry.ja} ${pack.company.industry.en}`),
    [entered, pack.company.industry.ja, pack.company.industry.en],
  );
  const [override, setOverride] = useState<Archetype | 'auto'>('auto');
  const archetype = override === 'auto' ? detected.archetype : override;
  const networkAvailable = !!pack.optimization;
  const preferred = ARCHETYPE_PROFILES[archetype].preferredLens;
  const [lensChoice, setLensChoice] = useState<Lens | null>(null);
  const lens: Lens = lensChoice === 'network' && networkAvailable ? 'network' : lensChoice === 'people' ? 'people' : preferred === 'network' && networkAvailable ? 'network' : 'people';

  return (
    <>
      <Panel title={t('res.brief')} testId="resource-brief" className="span-full res-brief">
        <p className="res-lead">{t('res.brief.lead')}</p>
        <div className="res-industry" data-testid="resource-industry">
          <div className="res-industry-main">
            <Caption1>{t('res.industry')} · {t(entered ? 'res.industry.source.project' : 'res.industry.source.pack')}</Caption1>
            <div className="res-industry-line">
              <strong>{industryText || t('res.industry.none')}</strong>
              <span aria-hidden>→</span>
              <Badge appearance="filled" color="brand" data-testid="resource-archetype" data-archetype={archetype}>{t(`res.arch.${archetype}`)}</Badge>
            </div>
            <Caption1 className="muted">
              {detected.matched.length ? t('res.industry.matched', { words: detected.matched.join(', ') }) : t('res.industry.unmatched')}
            </Caption1>
          </div>
          <Field label={t('res.industry.override')} className="res-industry-pick">
            <Select value={override} onChange={(_, d) => { setOverride(d.value as Archetype | 'auto'); setLensChoice(null); }} data-testid="resource-archetype-select">
              <option value="auto">{t('res.industry.auto', { name: t(`res.arch.${detected.archetype}`) })}</option>
              {ARCHETYPES.map((a) => <option key={a} value={a}>{t(`res.arch.${a}`)}</option>)}
            </Select>
          </Field>
          {networkAvailable && (
            <div className="res-lens">
              <Caption1>{t('res.lens')}</Caption1>
              <TabList size="small" selectedValue={lens} onTabSelect={(_, d) => setLensChoice(d.value as Lens)} aria-label={t('res.lens')} data-testid="resource-lens">
                <Tab value="people">{t('res.lens.people')}</Tab>
                <Tab value="network">{t('res.lens.network')}</Tab>
              </TabList>
            </div>
          )}
        </div>
        <p className="res-why">{t(`res.archWhy.${archetype}`)}</p>
        {preferred === 'network' && !networkAvailable && (
          <MessageBar intent="info" data-testid="optimize-unavailable"><MessageBarBody>{t('optimize.unavailable')}</MessageBarBody></MessageBar>
        )}
        <ScenarioView key={`${archetype}|${lens}`} archetype={archetype} lens={lens} industryLabel={industryText || t(`res.arch.${archetype}`)} />
      </Panel>
    </>
  );
}

function ScenarioView({ archetype, lens, industryLabel }: { archetype: Archetype; lens: Lens; industryLabel: string }) {
  const { t, tx, fmt, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const pack = loaded.pack;
  const [people, setPeople] = useState<PeopleParams>(() => defaultPeopleParams(archetype));
  const [network, setNetwork] = useState<NetworkParams>({ growth: 0, carbon: 10000 });
  const [overrides, setOverrides] = useState<Overrides>(emptyOverrides);
  const [selected, setSelected] = useState<Selection>(null);
  const [view, setView] = useState<View>('after');

  const base: ResourceModel = useMemo(() => {
    if (lens === 'network' && pack.optimization) {
      return buildNetworkModel(pack.optimization, pack.regions, (id) => getEntity(id)?.name ?? { ja: id, en: id }, network);
    }
    return buildPeopleModel(pack, archetype, people, (e) => !isHidden(e, audience), audience === 'internal');
  }, [lens, pack, archetype, people, network, audience]);
  const scenario: Scenario = useMemo(() => runScenario(applyOverrides(base, overrides)), [base, overrides]);
  const unit = t(lens === 'network' ? 'res.unit.tonnes' : 'res.unit.hours');
  const changes = countOverrides(overrides)
    + (lens === 'people' ? (Object.keys(people) as (keyof PeopleParams)[]).filter((k) => people[k] !== defaultPeopleParams(archetype)[k]).length : 0)
    + (lens === 'network' ? (network.growth !== 0 ? 1 : 0) + (network.carbon !== 10000 ? 1 : 0) : 0);

  const poolName = (id: string) => { const p = scenario.model.pools.find((x) => x.id === id); return p ? tx(p.name) : id; };
  const facts = buildFacts(scenario, {
    archetype, simulatedChanges: changes, hoursPerPerson: people.hoursPerPerson, maxUtilization: people.maxUtilization, effortBase: people.effortBase,
  }, { integer: fmt.integer, number: fmt.number, percent: fmt.percent, unit, name: poolName });

  const reset = () => { setOverrides(emptyOverrides()); setPeople(defaultPeopleParams(archetype)); setNetwork({ growth: 0, carbon: 10000 }); };

  return (
    <>
      <FactList facts={facts} />
      <Narrative facts={facts} industryLabel={industryLabel} signature={`${lang}|${archetype}|${lens}|${facts.map((f) => JSON.stringify(f.vars)).join('|')}`} />
      <section className="res-stage" aria-labelledby="res-flow-title" data-testid="resource-flow">
        <div className="res-stage-head">
          <div>
            <h3 id="res-flow-title" className="res-h3">{t('res.flow')}</h3>
            <Caption1 className="muted">{t('res.flow.lead')}</Caption1>
          </div>
          <div className="res-stage-actions">
            <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as View)} aria-label={t('res.view')} data-testid="resource-view">
              <Tab value="before">{t('res.view.before')}</Tab>
              <Tab value="after">{t('res.view.after')}</Tab>
            </TabList>
          </div>
        </div>
        <KpiStrip scenario={scenario} />
        <div className="res-workspace">
          <ResourceFlowMap scenario={scenario} view={view} selected={selected} onSelect={setSelected} unit={unit} />
          <Inspector
            scenario={scenario} lens={lens} unit={unit} selected={selected} onSelect={setSelected}
            overrides={overrides} setOverrides={setOverrides} people={people} setPeople={setPeople} network={network} setNetwork={setNetwork}
            changes={changes} onReset={reset}
          />
        </div>
        <Caption1 className="muted res-legend">
          {t('res.prov.legend')}: {(['pack', 'derived', 'assumption', 'simulation'] as const).map((p) => <ProvenanceBadge key={p} value={p} />)} · {t('res.map.hint')}
        </Caption1>
      </section>
    </>
  );
}

function FactList({ facts }: { facts: Fact[] }) {
  const { t } = useI18n();
  return (
    <ul className="res-facts" data-testid="resource-facts">
      {facts.map((f) => (
        <li key={f.id} className={f.tone ? `is-${f.tone}` : ''} data-fact={f.id}>
          <span className="res-fact-text">{t(f.key, f.vars)}</span>
          <span className="res-fact-prov">{f.provenance.map((p) => <ProvenanceBadge key={p} value={p} />)}</span>
        </li>
      ))}
    </ul>
  );
}

type NarrativeState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; res: AiResponse };

/** AI rephrases the facts for an executive. It runs by itself only when a live connection is ready (once per scenario). */
function Narrative({ facts, industryLabel, signature }: { facts: Fact[]; industryLabel: string; signature: string }) {
  const { t, lang } = useI18n();
  const live = useAiSettings((s) => liveReady(s));
  const [state, setState] = useState<NarrativeState>(() => {
    const cached = narrativeCache.get(signature);
    return cached ? { status: 'done', res: cached } : { status: 'idle' };
  });
  const [ranFor, setRanFor] = useState<string | null>(null);
  const runId = useRef(0);
  const autoRan = useRef(false);

  const run = () => {
    const id = ++runId.current;
    setState({ status: 'loading' });
    const prompt = narrativePrompt(t('res.ai.prompt', { industry: industryLabel }), facts.map((f) => t(f.key, f.vars)));
    void aiComplete({ use: 'explain', stage: RESOURCE_STAGE, lang, prompt, maxOutputTokens: 900 }).then((res) => {
      if (id !== runId.current) return;
      if (res.mode === 'live') narrativeCache.set(signature, res);
      setRanFor(signature);
      setState({ status: 'done', res });
    });
  };

  useEffect(() => {
    if (!live || autoRan.current || narrativeCache.has(signature)) return;
    autoRan.current = true;
    run();
    // Auto-run only for the first scenario a user sees; later simulations regenerate on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const stale = state.status === 'done' && ranFor !== null && ranFor !== signature;
  return (
    <section className="res-ai" aria-labelledby="res-ai-title" data-testid="resource-narrative" aria-busy={state.status === 'loading'}>
      <div className="res-ai-head">
        <h3 id="res-ai-title" className="res-h3"><Sparkle20Regular aria-hidden /> {t('res.ai.title')}</h3>
        <Button
          size="small"
          appearance={state.status === 'done' && !stale ? 'secondary' : 'primary'}
          icon={<Sparkle20Regular />}
          onClick={run}
          disabled={state.status === 'loading'}
          data-testid="resource-ai-run"
        >
          {t(state.status === 'done' ? 'res.ai.rerun' : 'res.ai.run')}
        </Button>
      </div>
      {state.status === 'idle' && !live && (
        <p className="muted">{t('res.ai.offline')} <Button size="small" appearance="transparent" onClick={openAiSettings}>{t('res.ai.settings')}</Button></p>
      )}
      {state.status === 'loading' && <Spinner size="tiny" label={t('res.ai.loading')} />}
      {state.status === 'done' && state.res.mode === 'live' && (
        <LiveNotice costJpy={state.res.costJpy ?? null} usage={state.res.usage}>
          <p className={`res-ai-text${stale ? ' is-stale' : ''}`} data-testid="resource-ai-text">{state.res.text}</p>
        </LiveNotice>
      )}
      {state.status === 'done' && state.res.mode === 'mock' && (
        <MockNotice reasons={state.res.blockedReasons}>
          <p className={`res-ai-text${stale ? ' is-stale' : ''}`} data-testid="resource-ai-text">{state.res.text}</p>
        </MockNotice>
      )}
    </section>
  );
}

function KpiStrip({ scenario }: { scenario: Scenario }) {
  const { t, fmt } = useI18n();
  const b = scenario.beforeMetrics, a = scenario.afterMetrics;
  type Kpi = { id: string; label: MessageKey; before: string; after: string; better: boolean | null; ratio: number };
  const pct = (v: number) => fmt.percent(v);
  const cmp = (before: number, after: number, lowerIsBetter: boolean) => (Math.abs(after - before) < 1e-9 ? null : lowerIsBetter ? after < before : after > before);
  const kpis: Kpi[] = scenario.model.lens === 'network'
    ? [
      { id: 'cost', label: 'res.kpi.cost', before: `${fmt.number((b.costJpy ?? 0) / 1e6)} ${t('res.unit.mJpy')}`, after: `${fmt.number((a.costJpy ?? 0) / 1e6)} ${t('res.unit.mJpy')}`, better: cmp(b.costJpy ?? 0, a.costJpy ?? 0, true), ratio: (a.costJpy ?? 0) / Math.max(1, b.costJpy ?? 0) },
      { id: 'co2', label: 'res.kpi.co2', before: `${fmt.integer(b.co2T ?? 0)} t`, after: `${fmt.integer(a.co2T ?? 0)} t`, better: cmp(b.co2T ?? 0, a.co2T ?? 0, true), ratio: (a.co2T ?? 0) / Math.max(1, b.co2T ?? 0) },
      { id: 'lead', label: 'res.kpi.lead', before: `${fmt.number(b.avgLeadDays ?? 0)} ${t('res.unit.days')}`, after: `${fmt.number(a.avgLeadDays ?? 0)} ${t('res.unit.days')}`, better: cmp(b.avgLeadDays ?? 0, a.avgLeadDays ?? 0, true), ratio: (a.avgLeadDays ?? 0) / Math.max(0.01, b.avgLeadDays ?? 0) },
      { id: 'served', label: 'res.kpi.served', before: pct(b.servedPct), after: pct(a.servedPct), better: cmp(b.servedPct, a.servedPct, false), ratio: a.servedPct },
    ]
    : [
      { id: 'served', label: 'res.kpi.served', before: pct(b.servedPct), after: pct(a.servedPct), better: cmp(b.servedPct, a.servedPct, false), ratio: a.servedPct },
      { id: 'weighted', label: 'res.kpi.weighted', before: pct(b.weightedPct), after: pct(a.weightedPct), better: cmp(b.weightedPct, a.weightedPct, false), ratio: a.weightedPct },
      { id: 'overloaded', label: 'res.kpi.overloaded', before: `${b.overloaded} ${t('res.unit.people')}`, after: `${a.overloaded} ${t('res.unit.people')}`, better: cmp(b.overloaded, a.overloaded, true), ratio: 1 - a.overloaded / Math.max(1, scenario.model.pools.length) },
      { id: 'util', label: 'res.kpi.utilization', before: pct(b.avgUtilization), after: pct(a.avgUtilization), better: null, ratio: Math.min(1, a.avgUtilization) },
    ];
  return (
    <ul className="res-kpis" data-testid="resource-kpis">
      {kpis.map((k) => (
        <li key={k.id} className={k.better === true ? 'is-better' : k.better === false ? 'is-worse' : ''} data-kpi={k.id}>
          <Caption1>{t(k.label)}</Caption1>
          <strong className="res-kpi-value" data-testid={`resource-kpi-${k.id}`}>{k.after}</strong>
          <Caption1 className="muted">{t('res.kpi.delta', { before: k.before, after: k.after })}</Caption1>
          <span className="res-kpi-bar" aria-hidden><span style={{ width: `${Math.max(0, Math.min(1, k.ratio)) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}

interface InspectorProps {
  scenario: Scenario;
  lens: Lens;
  unit: string;
  selected: Selection;
  onSelect: (s: Selection) => void;
  overrides: Overrides;
  setOverrides: (fn: (o: Overrides) => Overrides) => void;
  people: PeopleParams;
  setPeople: (fn: (p: PeopleParams) => PeopleParams) => void;
  network: NetworkParams;
  setNetwork: (fn: (p: NetworkParams) => NetworkParams) => void;
  changes: number;
  onReset: () => void;
}

const num = (v: number | null | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** SpinButton reports typed text in displayValue and steps in value. */
const spinValue = (d: { value?: number | null; displayValue?: string }, fallback: number) => num(d.value ?? (d.displayValue !== undefined ? Number(d.displayValue) : undefined), fallback);

function Inspector(p: InspectorProps) {
  const { t, tx, fmt } = useI18n();
  const { scenario, selected, unit } = p;
  const pool = selected?.type === 'pool' ? scenario.model.pools.find((x) => x.id === selected.id) : undefined;
  const demand = selected?.type === 'demand' ? scenario.model.demands.find((x) => x.id === selected.id) : undefined;
  const flowsOf = (which: 'before' | 'after') => (selected ? scenario[which].filter((f) => f.poolId === selected.id || f.demandId === selected.id) : []);
  const linkRows = selected
    ? scenario.model.links.filter((l) => (pool ? l.poolId === pool.id : l.demandId === demand?.id)
      && (l.owner || !l.allowed || flowsOf('before').some((f) => f.poolId === l.poolId && f.demandId === l.demandId) || flowsOf('after').some((f) => f.poolId === l.poolId && f.demandId === l.demandId)))
    : [];
  const name = (id: string) => {
    const x = scenario.model.pools.find((q) => q.id === id) ?? scenario.model.demands.find((q) => q.id === id);
    return x ? tx(x.name) : id;
  };
  const setPool = (id: string, patch: Overrides['pools'][string]) => p.setOverrides((o) => ({ ...o, pools: { ...o.pools, [id]: { ...o.pools[id], ...patch } } }));
  const setDemand = (id: string, patch: Overrides['demands'][string]) => p.setOverrides((o) => ({ ...o, demands: { ...o.demands, [id]: { ...o.demands[id], ...patch } } }));
  const resetItem = (id: string) => p.setOverrides((o) => {
    const pools = { ...o.pools }, demands = { ...o.demands }, links = { ...o.links };
    delete pools[id]; delete demands[id];
    for (const k of Object.keys(links)) if (k.startsWith(`${id}|`) || k.endsWith(`|${id}`)) delete links[k];
    return { pools, demands, links };
  });
  const marginal = pool ? scenario.marginals.find((m) => m.poolId === pool.id) : undefined;

  return (
    <aside className="res-inspector" aria-labelledby="res-insp-title" data-testid="resource-inspector">
      <div className="res-insp-head">
        <h3 id="res-insp-title" className="res-h3">{t('res.insp')}</h3>
        {p.changes > 0 && <Badge appearance="tint" color="important" data-testid="resource-changes">{t('res.insp.changes', { count: p.changes })}</Badge>}
      </div>
      <Caption1 className="muted">{t('res.insp.lead')}</Caption1>

      {!selected && (
        <div className="res-insp-body" data-testid="resource-globals">
          <h4 className="res-h4">{t('res.insp.global')} <ProvenanceBadge value={p.changes ? 'simulation' : p.lens === 'network' ? 'pack' : 'assumption'} /></h4>
          {p.lens === 'people' ? (
            <>
              <Field label={t('res.insp.hours')}>
                <SpinButton min={40} max={240} step={10} value={p.people.hoursPerPerson} onChange={(_, d) => p.setPeople((s) => ({ ...s, hoursPerPerson: Math.max(40, Math.min(240, spinValue(d, s.hoursPerPerson))) }))} data-testid="resource-hours" />
              </Field>
              <Field label={`${t('res.insp.util')}: ${fmt.percent(p.people.maxUtilization)}`}>
                <Slider min={50} max={100} step={5} value={Math.round(p.people.maxUtilization * 100)} onChange={(_, d) => p.setPeople((s) => ({ ...s, maxUtilization: d.value / 100 }))} data-testid="resource-util" />
              </Field>
              <Field label={t('res.insp.effort')}>
                <SpinButton min={4} max={200} step={4} value={p.people.effortBase} onChange={(_, d) => p.setPeople((s) => ({ ...s, effortBase: Math.max(4, Math.min(200, spinValue(d, s.effortBase))) }))} data-testid="resource-effort" />
              </Field>
              <Field label={`${t('res.insp.handover')}: ${fmt.number(p.people.handover)}`}>
                <Slider min={0} max={10} step={0.5} value={p.people.handover} onChange={(_, d) => p.setPeople((s) => ({ ...s, handover: d.value }))} data-testid="resource-handover" />
              </Field>
            </>
          ) : (
            <>
              <Field label={`${t('res.insp.growth')}: ${p.network.growth > 0 ? '+' : ''}${Math.round(p.network.growth * 100)}%`}>
                <Slider min={-10} max={30} step={1} value={Math.round(p.network.growth * 100)} onChange={(_, d) => p.setNetwork((s) => ({ ...s, growth: d.value / 100 }))} data-testid="resource-growth" />
              </Field>
              <Field label={`${t('res.insp.carbon')}: ${fmt.integer(p.network.carbon)}`}>
                <Slider min={0} max={20000} step={1000} value={p.network.carbon} onChange={(_, d) => p.setNetwork((s) => ({ ...s, carbon: d.value }))} data-testid="resource-carbon" />
              </Field>
            </>
          )}
        </div>
      )}

      {pool && (
        <div className="res-insp-body" data-testid="resource-pool-editor">
          <div className="res-insp-title">
            {pool.entityId ? <EntityRef id={pool.entityId} /> : <strong>{tx(pool.name)}</strong>}
            {pool.group && <Caption1 className="muted">{tx(pool.group)}</Caption1>}
            {!!pool.history && <Badge appearance="outline" size="small">{t('res.insp.history', { count: pool.history })}</Badge>}
          </div>
          <Field label={<>{t('res.insp.capacity', { unit })} <ProvenanceBadge value={pool.capacity.provenance} /></>}>
            <SpinButton
              min={0} max={100000} step={p.lens === 'network' ? 10 : 8}
              value={Math.round(pool.capacity.value)}
              onChange={(_, d) => setPool(pool.id, { capacity: Math.max(0, spinValue(d, pool.capacity.value)) })}
              data-testid="resource-capacity"
            />
          </Field>
          <Switch label={t('res.insp.include')} checked={!pool.off} onChange={(_, d) => setPool(pool.id, { off: !d.checked })} data-testid="resource-pool-include" />
          <dl className="res-insp-stats">
            <div><dt>{t('res.insp.loadBefore')}</dt><dd>{fmt.integer(scenario.beforeMetrics.load[pool.id] ?? 0)} {unit}</dd></div>
            <div><dt>{t('res.insp.loadAfter')}</dt><dd>{fmt.integer(scenario.afterMetrics.load[pool.id] ?? 0)} {unit}</dd></div>
            <div><dt>{t('res.insp.marginal', { unit })}</dt><dd>{marginal ? t('res.insp.marginalValue', { value: fmt.number(marginal.objectivePerUnit), served: fmt.number(marginal.servedPerUnit), unit }) : t('res.insp.marginalNone')}</dd></div>
          </dl>
        </div>
      )}

      {demand && (
        <div className="res-insp-body" data-testid="resource-demand-editor">
          <div className="res-insp-title">
            <Caption1 className="muted">{t(`res.kind.${demand.kind}`)}</Caption1>
            {demand.entityId ? <EntityRef id={demand.entityId} /> : <strong>{tx(demand.name)}</strong>}
          </div>
          <Field label={<>{t('res.insp.need', { unit })} <ProvenanceBadge value={demand.need.provenance} /></>}>
            <SpinButton
              min={0} max={100000} step={p.lens === 'network' ? 10 : 4}
              value={Math.round(demand.need.value)}
              onChange={(_, d) => setDemand(demand.id, { need: Math.max(0, spinValue(d, demand.need.value)) })}
              data-testid="resource-need"
            />
          </Field>
          {p.lens === 'people' && (
            <Field label={<>{t('res.insp.value')} <ProvenanceBadge value={demand.value.provenance} /></>}>
              <SpinButton
                min={1} max={25} step={1}
                value={demand.value.value}
                onChange={(_, d) => setDemand(demand.id, { value: Math.max(1, Math.min(25, spinValue(d, demand.value.value))) })}
                data-testid="resource-value"
              />
            </Field>
          )}
          <Switch label={t('res.insp.include')} checked={!demand.off} onChange={(_, d) => setDemand(demand.id, { off: !d.checked })} data-testid="resource-demand-include" />
          <dl className="res-insp-stats">
            <div><dt>{t('res.insp.servedBefore')}</dt><dd>{fmt.integer(scenario.beforeMetrics.served_[demand.id] ?? 0)} {unit}</dd></div>
            <div><dt>{t('res.insp.servedAfter')}</dt><dd>{fmt.integer(scenario.afterMetrics.served_[demand.id] ?? 0)} {unit}</dd></div>
          </dl>
        </div>
      )}

      {selected && (
        <div className="res-insp-body">
          <h4 className="res-h4">{t('res.insp.links')}</h4>
          {linkRows.length === 0 && <Caption1 className="muted">{t('res.insp.noLinks')}</Caption1>}
          <ul className="res-insp-links" data-testid="resource-links">
            {linkRows.map((l) => {
              const other = pool ? l.demandId : l.poolId;
              const k = linkKey(l.poolId, l.demandId);
              const after = scenario.after.find((f) => f.poolId === l.poolId && f.demandId === l.demandId)?.qty ?? 0;
              return (
                <li key={k}>
                  <Switch
                    checked={l.allowed}
                    onChange={(_, d) => p.setOverrides((o) => ({ ...o, links: { ...o.links, [k]: d.checked } }))}
                    label={<>{name(other)}{l.owner && <Badge size="small" appearance="outline" className="res-owner-badge">{t('res.insp.owner')}</Badge>}</>}
                    data-testid={`resource-allow-${other}`}
                  />
                  <span className="res-link-qty">{fmt.integer(after)} {unit}</span>
                </li>
              );
            })}
          </ul>
          <div className="res-insp-actions">
            <Button size="small" icon={<ArrowReset20Regular />} onClick={() => resetItem(selected.id)}>{t('res.insp.resetItem')}</Button>
            <Button size="small" appearance="subtle" icon={<DismissCircle20Regular />} onClick={() => p.onSelect(null)} data-testid="resource-clear">{t('res.map.clear')}</Button>
          </div>
        </div>
      )}

      {p.changes > 0 && (
        <Button appearance="secondary" icon={<ArrowReset20Regular />} onClick={p.onReset} data-testid="resource-reset">{t('res.insp.reset')}</Button>
      )}
    </aside>
  );
}
