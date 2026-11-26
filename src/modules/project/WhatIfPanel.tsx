import { useMemo, useState } from 'react';
import {
  Badge, Button, Field, Input, Select, Slider, SpinButton, Switch, Tab, TabList, ToggleButton,
} from '@fluentui/react-components';
import { ArrowReset20Regular, Delete20Regular, Save20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { Panel } from '../../ui/Panel.tsx';
import { ScrollRegion } from './common.tsx';
import { MAX_SAVED_SCENARIOS, normalizeWhatIf, useWhatIf, type WhatIfSet } from './cockpitStore.ts';
import { ChartFigure } from './stepCharts.tsx';
import type { NameOf } from './stepCharts.tsx';
import {
  baselineScenario, changedKeys, DEFAULT_WI_WEIGHTS, frontier, legacyLeader, PRESET_WEIGHTS, PRESETS, rank, rankDeltas, SCORE_KEYS, sensitivity, SENS_MAX, stability,
  WEIGHT_KEYS, type Candidate, type CandidateKind, type Preset, type Ranking, type Scenario, type Score, type ScoreKey, type WeightKey,
} from './whatIf.ts';
import './cockpit.css';

/** PARAM-194: first place counts as settled when it wins at least this share of the uncertainty runs. */
const SETTLED = 0.7;
const SHOWN = 8;
const MILLION = 1_000_000;

type Tool = 'sensitivity' | 'stability' | 'frontier' | 'compare';

/** Sets a weight preset, or null when the weights match none (a person moved a slider). */
function presetOf(w: Scenario['weights']): Preset | null {
  return PRESETS.find((p) => WEIGHT_KEYS.every((k) => PRESET_WEIGHTS[p][k] === w[k])) ?? null;
}

function Delta({ delta, testId }: { delta: number; testId?: string }) {
  const { t } = useI18n();
  if (delta === 0) return <span className="ck-delta is-same" data-testid={testId} data-delta={0}>{t('ck.wi.same')}</span>;
  return (
    <span className={`ck-delta ${delta > 0 ? 'is-up' : 'is-down'}`} data-testid={testId} data-delta={delta}>
      <span aria-hidden="true">{delta > 0 ? '▲' : '▼'}</span>
      {t(delta > 0 ? 'ck.wi.up' : 'ck.wi.down', { n: Math.abs(delta) })}
    </span>
  );
}

function OriginBadge({ origin }: { origin: 'data' | 'rule' | 'unrated' | 'user' }) {
  const { t } = useI18n();
  const color = origin === 'user' ? 'brand' : origin === 'data' ? 'success' : origin === 'rule' ? 'informative' : 'warning';
  return <Badge size="small" appearance="tint" color={color} data-origin={origin}>{t(`ck.origin.${origin}`)}</Badge>;
}

export function WhatIfPanel({ kind, cands, nameOf, onUse, useLabel }: {
  kind: CandidateKind;
  cands: Candidate[];
  nameOf: NameOf;
  /** Optional hand-over of the funded set (the last step builds its action plan from it). */
  onUse?: (ids: string[]) => void;
  useLabel?: MessageKey;
}) {
  const { t, fmt } = useI18n();
  const raw = useWhatIf((s) => s.value);
  const setStore = useWhatIf((s) => s.set);
  const data = useMemo(() => normalizeWhatIf(raw), [raw]);
  const set: WhatIfSet = data[kind];
  const scenario = set.current;
  const write = (fn: (s: WhatIfSet) => WhatIfSet) => setStore((v) => {
    const d = normalizeWhatIf(v);
    return { ...d, [kind]: fn(d[kind]) };
  });
  const update = (fn: (s: Scenario) => Scenario) => write((s) => ({ ...s, current: fn(s.current) }));

  const [focus, setFocus] = useState<string>('');
  const [tool, setTool] = useState<Tool>('sensitivity');
  const ids = useMemo(() => new Set(cands.map((c) => c.id)), [cands]);
  const base = useMemo(() => rank(cands, { ...baselineScenario(), budgetJpy: scenario.budgetJpy, maxItems: scenario.maxItems }), [cands, scenario.budgetJpy, scenario.maxItems]);
  const now = useMemo(() => rank(cands, scenario), [cands, scenario]);
  const deltas = useMemo(() => rankDeltas(base, now), [base, now]);
  const changed = changedKeys(scenario);
  const knownCost = cands.some((c) => c.costJpy !== undefined);
  const preset = presetOf(scenario.weights);
  const prefix = `ck-wi-${kind}`;

  if (cands.length === 0) {
    return (
      <Panel title={t(`ck.wi.title.${kind}`)} rationale="ck.wi.why" testId={prefix} className="span-full ck-hero">
        <p className="muted" data-testid={`${prefix}-empty`}>{t(`ck.wi.empty.${kind}`)}</p>
      </Panel>
    );
  }

  const top = now.rows.find((r) => !r.excluded);
  const legacy = kind === 'issue' ? legacyLeader(cands, scenario.excluded) : null;
  const baseTop = base.rows.find((r) => !r.excluded);
  const valueChange = base.fundedValue > 0 ? now.fundedValue / base.fundedValue - 1 : 0;
  const focusId = focus && ids.has(focus) ? focus : (top?.id ?? cands[0]!.id);
  const focusCand = cands.find((c) => c.id === focusId)!;
  const focusRow = now.rows.find((r) => r.id === focusId)!;
  const maxPriority = Math.max(1, ...now.rows.map((r) => r.priority), ...base.rows.map((r) => r.priority));
  const baseById = new Map(base.rows.map((r) => [r.id, r]));
  const shown = now.rows.slice(0, Math.max(SHOWN, now.rows.filter((r) => r.funded).length));

  const setWeight = (k: WeightKey, v: number) => update((s) => ({ ...s, weights: { ...s.weights, [k]: v } }));
  const setScore = (id: string, k: ScoreKey, v: string) => update((s) => {
    const o = { ...(s.overrides[id] ?? {}) };
    if (v === '') delete o[k]; else o[k] = Number(v) as Score;
    const overrides = { ...s.overrides, [id]: o };
    if (Object.keys(o).length === 0) delete overrides[id];
    return { ...s, overrides };
  });
  const toggle = (id: string, list: 'excluded' | 'required', on: boolean) => update((s) => {
    const other = list === 'excluded' ? 'required' : 'excluded';
    return { ...s, [list]: on ? [...new Set([...s[list], id])] : s[list].filter((x) => x !== id), [other]: on ? s[other].filter((x) => x !== id) : s[other] };
  });
  const saveAs = () => write((s) => {
    if (s.saved.length >= MAX_SAVED_SCENARIOS) return s;
    const used = new Set(s.saved.map((x) => x.name));
    const name = ['A', 'B', 'C', 'D', 'E'].find((x) => !used.has(x)) ?? String(s.saved.length + 1);
    return { ...s, saved: [...s.saved, { ...s.current, name }] };
  });

  const headline = top ? t(baseTop && baseTop.id === top.id ? 'ck.wi.headlineSame' : 'ck.wi.headline', {
    top: nameOf(top.id),
    base: baseTop ? nameOf(baseTop.id) : '—',
    n: now.funded.length,
    total: now.rows.filter((r) => !r.excluded).length,
    change: `${valueChange >= 0 ? '+' : ''}${fmt.percent(valueChange)}`,
  }) : t('ck.wi.allExcluded');

  return (
    <Panel title={t(`ck.wi.title.${kind}`)} rationale="ck.wi.why" testId={prefix} className="span-full ck-hero">
      <p className="muted ck-lead">{t('ck.wi.lead')}</p>
      <div className="ck-wi">
        <div className="ck-wi-levers" role="group" aria-label={t('ck.wi.levers')}>
          <fieldset className="ck-fieldset">
            <legend>{t('ck.wi.preset')}</legend>
            <div className="ck-presets">
              {PRESETS.map((p) => (
                <ToggleButton key={p} size="small" checked={preset === p} appearance={preset === p ? 'primary' : 'secondary'}
                  onClick={() => update((s) => ({ ...s, weights: { ...PRESET_WEIGHTS[p] } }))} data-testid={`${prefix}-preset-${p}`}>
                  {t(`ck.preset.${p}`)}
                </ToggleButton>
              ))}
            </div>
            <p className="muted ck-small">{t(preset ? `ck.preset.${preset}Hint` : 'ck.preset.custom')}</p>
          </fieldset>
          <fieldset className="ck-fieldset">
            <legend>{t('ck.wi.weights')}</legend>
            {WEIGHT_KEYS.map((k) => (
              <Field key={k} size="small" label={(
                <span className="ck-label">
                  {t(k === 'urgency' ? 'ck.wi.urgencyWeight' : 'ck.wi.weight', { name: t(`ck.crit.${k}`), value: scenario.weights[k] })}
                  {changed.weights.includes(k) && <Badge size="small" appearance="outline" color="brand">{t('ck.wi.changed')}</Badge>}
                </span>
              )} hint={t(`ck.crit.${k}Hint`)}>
                <Slider min={0} max={100} step={5} size="small" value={scenario.weights[k]}
                  onChange={(_, d) => setWeight(k, d.value)} data-testid={`${prefix}-weight-${k}`}
                  aria-valuetext={t('ck.wi.weightValue', { name: t(`ck.crit.${k}`), value: scenario.weights[k] })} />
              </Field>
            ))}
          </fieldset>
          <fieldset className="ck-fieldset">
            <legend>{t('ck.wi.constraints')}</legend>
            <Field size="small" label={t('ck.wi.maxItems')} hint={t('ck.wi.maxItemsHint')}>
              <SpinButton size="small" min={0} max={100} value={scenario.maxItems ?? 0}
                onChange={(_, d) => {
                  const v = Math.round(d.value ?? Number(d.displayValue ?? 0));
                  update((s) => ({ ...s, maxItems: Number.isFinite(v) && v > 0 ? Math.min(100, v) : null }));
                }} data-testid={`${prefix}-max`} />
            </Field>
            {knownCost && (
              <Field size="small" label={t('ck.wi.budget')} hint={t('ck.wi.budgetHint')}>
                <Input size="small" type="number" min={0} step={1} value={scenario.budgetJpy === null ? '' : String(scenario.budgetJpy / MILLION)}
                  onChange={(_, d) => {
                    const v = Number(d.value);
                    update((s) => ({ ...s, budgetJpy: d.value.trim() !== '' && Number.isFinite(v) && v > 0 ? v * MILLION : null }));
                  }} data-testid={`${prefix}-budget`} />
              </Field>
            )}
          </fieldset>
          <fieldset className="ck-fieldset" data-testid={`${prefix}-item`}>
            <legend>{t('ck.wi.itemScores')}</legend>
            <Field size="small" label={t('ck.wi.item')}>
              <Select size="small" value={focusId} onChange={(_, d) => setFocus(d.value)} data-testid={`${prefix}-item-select`}>
                {cands.map((c) => <option key={c.id} value={c.id}>{nameOf(c.id)}</option>)}
              </Select>
            </Field>
            <div className="ck-score-grid">
              {SCORE_KEYS.map((k) => {
                const own = scenario.overrides[focusId]?.[k];
                return (
                  <Field key={k} size="small" data-key={k} label={t(`ck.crit.${k}`)} hint={(
                    <span className="ck-score-origin">
                      <OriginBadge origin={own === undefined ? focusCand.scores[k].origin : 'user'} />
                      {t(`ck.basis.${own === undefined ? focusCand.scores[k].basis : 'user'}` as MessageKey)}
                    </span>
                  )}>
                    <Select size="small" value={own === undefined ? '' : String(own)} onChange={(_, d) => setScore(focusId, k, d.value)}
                      aria-label={t('ck.wi.scoreOf', { name: t(`ck.crit.${k}`), item: nameOf(focusId) })} data-testid={`${prefix}-score-${k}`}>
                      <option value="">{t('ck.wi.default', { value: focusCand.scores[k].value })}</option>
                      {[1, 2, 3, 4, 5].map((v) => <option key={v} value={String(v)}>{t(`ck.anchor.${k}.${v}` as MessageKey)}</option>)}
                    </Select>
                  </Field>
                );
              })}
            </div>
            <div className="ck-switches">
              <Switch label={t('ck.wi.exclude')} checked={focusRow.excluded} onChange={(_, d) => toggle(focusId, 'excluded', d.checked)} data-testid={`${prefix}-exclude`} />
              <Switch label={t('ck.wi.require')} checked={focusRow.required} onChange={(_, d) => toggle(focusId, 'required', d.checked)} data-testid={`${prefix}-require`} />
            </div>
          </fieldset>
          <div className="ck-actions">
            <Button icon={<ArrowReset20Regular />} disabled={changed.weights.length === 0 && changed.items.length === 0 && !changed.constraints}
              onClick={() => update(() => baselineScenario())} data-testid={`${prefix}-reset`}>{t('ck.wi.reset')}</Button>
            <Button icon={<Save20Regular />} disabled={set.saved.length >= MAX_SAVED_SCENARIOS} onClick={saveAs} data-testid={`${prefix}-save`}>
              {t('ck.wi.save', { n: set.saved.length, max: MAX_SAVED_SCENARIOS })}
            </Button>
          </div>
        </div>

        <div className="ck-wi-results">
          <p className="ck-headline" aria-live="polite" data-testid={`${prefix}-headline`} data-top={top?.id ?? ''}>{headline}</p>
          {legacy && baseTop && legacy !== baseTop.id && (
            <p className="muted ck-small" data-testid={`${prefix}-legacy`}>{t('ck.wi.legacy', { legacy: nameOf(legacy), top: nameOf(baseTop.id) })}</p>
          )}
          {now.overCommitted && <p role="alert" className="ck-warn" data-testid={`${prefix}-over`}>{t('ck.wi.overCommitted')}</p>}
          {now.unknownCost > 0 && <p className="muted ck-small" data-testid={`${prefix}-unknown-cost`}>{t('ck.wi.unknownCost', { n: now.unknownCost })}</p>}
          <dl className="ck-stats">
            <div><dt>{t('ck.wi.statTop')}</dt><dd data-testid={`${prefix}-stat-top`}>{top ? nameOf(top.id) : '—'}</dd></div>
            <div><dt>{t('ck.wi.statFunded')}</dt><dd data-testid={`${prefix}-stat-funded`}>{t('ck.wi.ofN', { n: now.funded.length, total: now.rows.filter((r) => !r.excluded).length })}</dd></div>
            <div><dt>{t('ck.wi.statValue')}</dt><dd data-testid={`${prefix}-stat-value`}>{t('ck.wi.vsBase', { value: fmt.number(now.fundedValue), change: `${valueChange >= 0 ? '+' : ''}${fmt.percent(valueChange)}` })}</dd></div>
            {knownCost && <div><dt>{t('ck.wi.statCost')}</dt><dd data-testid={`${prefix}-stat-cost`}>{scenario.budgetJpy === null ? fmt.yenCompact(now.fundedCost) : t('ck.wi.ofBudget', { cost: fmt.yenCompact(now.fundedCost), budget: fmt.yenCompact(scenario.budgetJpy) })}</dd></div>}
          </dl>
          <ChartFigure
            id={`${prefix}-rank`}
            title={top ? t('ck.wi.chartTitle', { top: nameOf(top.id) }) : t('ck.wi.allExcluded')}
            read={t('ck.wi.chartRead')}
            legend={<span className="ck-legend"><span className="ck-key is-scenario" />{t('ck.wi.legendScenario')}<span className="ck-key is-base" />{t('ck.wi.legendBase')}</span>}
            visual={(
              <div className="ck-rank" data-testid={`${prefix}-rows`}>
                {shown.map((r) => {
                  const was = baseById.get(r.id);
                  return (
                    <div key={r.id} className="ck-rank-row" data-id={r.id} data-rank={r.rank} data-funded={r.funded} data-excluded={r.excluded}>
                      <span className="ck-rank-no">{r.excluded ? '—' : r.rank}</span>
                      <span className="ck-rank-name">{nameOf(r.id)}</span>
                      <span className="ck-rank-track">
                        <span className={`ck-rank-bar${r.funded ? ' is-funded' : ''}${r.excluded ? ' is-excluded' : ''}`} style={{ width: `${(100 * r.priority) / maxPriority}%` }} />
                        {was && <span className="ck-rank-base" style={{ left: `${(100 * was.priority) / maxPriority}%` }} />}
                      </span>
                      <span className="ck-rank-value">{fmt.integer(r.priority)}</span>
                      <span className="ck-rank-delta"><Delta delta={deltas.get(r.id)?.delta ?? 0} /></span>
                      <span className="ck-rank-tags">
                        {r.funded && <Badge size="small" appearance="filled" color="brand">{t('ck.wi.funded')}</Badge>}
                        {r.required && <Badge size="small" appearance="outline" color="important">{t('ck.wi.required')}</Badge>}
                        {r.excluded && <Badge size="small" appearance="outline">{t('ck.wi.excluded')}</Badge>}
                        {changed.items.includes(r.id) && <Badge size="small" appearance="tint" color="brand">{t('ck.wi.changed')}</Badge>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            table={<RankTable now={now} base={base} nameOf={nameOf} />}
          />
          {onUse && useLabel && (
            <Button appearance="primary" disabled={now.funded.length === 0} onClick={() => onUse(now.funded)} data-testid={`${prefix}-use`}>{t(useLabel, { n: now.funded.length })}</Button>
          )}
          <TabList size="small" selectedValue={tool} onTabSelect={(_, d) => setTool(d.value as Tool)} aria-label={t('ck.wi.tools')}>
            <Tab value="sensitivity" data-testid={`${prefix}-tab-sensitivity`}>{t('ck.wi.tab.sensitivity')}</Tab>
            <Tab value="stability" data-testid={`${prefix}-tab-stability`}>{t('ck.wi.tab.stability')}</Tab>
            <Tab value="frontier" data-testid={`${prefix}-tab-frontier`}>{t('ck.wi.tab.frontier')}</Tab>
            <Tab value="compare" data-testid={`${prefix}-tab-compare`}>{t('ck.wi.tab.compare', { n: set.saved.length })}</Tab>
          </TabList>
          <div className="ck-tool" role="tabpanel" data-testid={`${prefix}-tool-${tool}`}>
            {tool === 'sensitivity' && <SensitivityView cands={cands} scenario={scenario} nameOf={nameOf} prefix={prefix} />}
            {tool === 'stability' && <StabilityView cands={cands} scenario={scenario} nameOf={nameOf} prefix={prefix} />}
            {tool === 'frontier' && <FrontierView cands={cands} scenario={scenario} prefix={prefix} />}
            {tool === 'compare' && (
              <CompareView cands={cands} set={set} base={base} now={now} nameOf={nameOf} prefix={prefix}
                onLoad={(s) => update(() => ({ ...s, name: '' }))}
                onDelete={(name) => write((x) => ({ ...x, saved: x.saved.filter((y) => y.name !== name) }))} />
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function RankTable({ now, base, nameOf }: { now: Ranking; base: Ranking; nameOf: NameOf }) {
  const { t, fmt } = useI18n();
  const baseById = new Map(base.rows.map((r) => [r.id, r]));
  return (
    <table className="data-table compact">
      <thead><tr>
        <th scope="col" className="num">{t('ck.wi.col.rank')}</th>
        <th scope="col">{t('ck.wi.col.item')}</th>
        <th scope="col" className="num">{t('ck.wi.col.priority')}</th>
        <th scope="col" className="num">{t('ck.wi.col.baseRank')}</th>
        <th scope="col" className="num">{t('ck.wi.col.benefit')}</th>
        <th scope="col" className="num">{t('ck.wi.col.time')}</th>
        <th scope="col" className="num">{t('ck.wi.col.size')}</th>
        {SCORE_KEYS.map((k) => <th key={k} scope="col" className="num">{t(`ck.crit.${k}`)}</th>)}
        <th scope="col">{t('ck.wi.col.funded')}</th>
      </tr></thead>
      <tbody>
        {now.rows.map((r) => (
          <tr key={r.id} data-id={r.id}>
            <td className="num">{r.excluded ? '—' : r.rank}</td>
            <th scope="row">{nameOf(r.id)}</th>
            <td className="num">{fmt.integer(r.priority)}</td>
            <td className="num">{baseById.get(r.id)?.rank || '—'}</td>
            <td className="num">{fmt.percent(r.benefit)}</td>
            <td className="num">{fmt.number(r.time)}</td>
            <td className="num">{fmt.number(r.size)}</td>
            {SCORE_KEYS.map((k) => <td key={k} className="num" data-origin={r.scores[k].origin}>{r.scores[k].value}</td>)}
            <td>{t(r.funded ? 'ck.wi.yes' : 'ck.wi.no')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SensitivityView({ cands, scenario, nameOf, prefix }: { cands: Candidate[]; scenario: Scenario; nameOf: NameOf; prefix: string }) {
  const { t, fmt } = useI18n();
  const rows = useMemo(() => sensitivity(cands, scenario), [cands, scenario]);
  if (rows.length === 0) return <p className="muted">{t('ck.wi.allExcluded')}</p>;
  const pos = (m: number) => `${(100 * Math.min(SENS_MAX, m)) / SENS_MAX}%`;
  const gaps = rows.map((r) => ({
    r,
    low: r.lowLeader ? 1 - r.holdsFrom : Number.POSITIVE_INFINITY,
    high: r.highLeader ? r.holdsTo - 1 : Number.POSITIVE_INFINITY,
  })).map((g) => ({ ...g, gap: Math.min(g.low, g.high) })).filter((g) => Number.isFinite(g.gap)).sort((a, b) => a.gap - b.gap);
  const f = gaps[0];
  const title = f
    ? t('ck.sens.title', {
      name: t(`ck.crit.${f.r.key}`),
      m: fmt.number(f.low <= f.high ? Math.max(0, f.r.holdsFrom - 0.05) : f.r.holdsTo + 0.05),
      who: nameOf((f.low <= f.high ? f.r.lowLeader : f.r.highLeader) ?? ''),
    })
    : t('ck.sens.robust');
  return (
    <ChartFigure
      id={`${prefix}-sens`}
      title={title}
      read={t('ck.sens.read', { max: SENS_MAX })}
      visual={(
        <div className="ck-rank">
          {rows.map((r) => (
            <div key={r.key} className="ck-rank-row is-sens" data-key={r.key} data-from={r.holdsFrom} data-to={r.holdsTo}>
              <span className="ck-rank-name">{t(`ck.crit.${r.key}`)}</span>
              <span className="ck-rank-track is-plain">
                <span className="ck-sens-band" style={{ left: pos(r.holdsFrom), width: `calc(${pos(r.holdsTo)} - ${pos(r.holdsFrom)})` }} />
                <span className="ck-sens-now" style={{ left: pos(1) }} />
              </span>
              <span className="ck-rank-value">{t('ck.sens.range', { from: fmt.number(r.holdsFrom), to: fmt.number(r.holdsTo) })}</span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('ck.wi.criterion')}</th>
            <th scope="col" className="num">{t('ck.sens.col.from')}</th>
            <th scope="col">{t('ck.sens.col.low')}</th>
            <th scope="col" className="num">{t('ck.sens.col.to')}</th>
            <th scope="col">{t('ck.sens.col.high')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{t(`ck.crit.${r.key}`)}</th>
                <td className="num">{fmt.number(r.holdsFrom)}</td>
                <td>{r.lowLeader ? nameOf(r.lowLeader) : t('ck.sens.holds')}</td>
                <td className="num">{fmt.number(r.holdsTo)}</td>
                <td>{r.highLeader ? nameOf(r.highLeader) : t('ck.sens.holds')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    />
  );
}

function StabilityView({ cands, scenario, nameOf, prefix }: { cands: Candidate[]; scenario: Scenario; nameOf: NameOf; prefix: string }) {
  const { t, fmt } = useI18n();
  const rows = useMemo(() => stability(cands, scenario), [cands, scenario]);
  const lead = rows[0];
  if (!lead) return <p className="muted">{t('ck.wi.allExcluded')}</p>;
  const settled = lead.first >= SETTLED;
  return (
    <ChartFigure
      id={`${prefix}-stab`}
      title={t(settled ? 'ck.stab.settled' : 'ck.stab.open', { name: nameOf(lead.id), p: fmt.percent(lead.first) })}
      read={t('ck.stab.read', { settled: fmt.percent(SETTLED) })}
      visual={(
        <div className="ck-rank" data-testid={`${prefix}-stab-rows`} data-settled={settled}>
          {rows.slice(0, 5).map((r) => (
            <div key={r.id} className="ck-rank-row is-sens" data-id={r.id} data-first={r.first}>
              <span className="ck-rank-name">{nameOf(r.id)}</span>
              <span className="ck-rank-track">
                <span className="ck-rank-bar is-light" style={{ width: `${100 * r.top3}%` }} />
                <span className="ck-rank-bar is-funded" style={{ width: `${100 * r.first}%` }} />
              </span>
              <span className="ck-rank-value">{t('ck.stab.value', { first: fmt.percent(r.first), top3: fmt.percent(r.top3) })}</span>
            </div>
          ))}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr><th scope="col">{t('ck.wi.col.item')}</th><th scope="col" className="num">{t('ck.stab.col.first')}</th><th scope="col" className="num">{t('ck.stab.col.top3')}</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><th scope="row">{nameOf(r.id)}</th><td className="num">{fmt.percent(r.first)}</td><td className="num">{fmt.percent(r.top3)}</td></tr>)}</tbody>
        </table>
      )}
    />
  );
}

function FrontierView({ cands, scenario, prefix }: { cands: Candidate[]; scenario: Scenario; prefix: string }) {
  const { t, fmt } = useI18n();
  const points = useMemo(() => frontier(cands, scenario), [cands, scenario]);
  if (points.length === 0) return <p className="muted" data-testid={`${prefix}-frontier-empty`}>{t('ck.front.empty')}</p>;
  const max = Math.max(...points.map((p) => p.value), 1e-9);
  const knee = points.find((p) => p.value >= 0.8 * max) ?? points[points.length - 1]!;
  return (
    <ChartFigure
      id={`${prefix}-front`}
      title={t('ck.front.title', { budget: fmt.yenCompact(knee.budgetJpy), share: fmt.percent(knee.value / max) })}
      read={t('ck.front.read')}
      visual={(
        <div className="ck-rank">
          {points.map((p, i) => {
            const mark = scenario.budgetJpy !== null && i > 0 && points[i - 1]!.budgetJpy < scenario.budgetJpy && p.budgetJpy >= scenario.budgetJpy;
            return (
              <div key={i} className={`ck-rank-row is-sens${mark ? ' is-mark' : ''}`} data-budget={p.budgetJpy}>
                <span className="ck-rank-name">{fmt.yenCompact(p.budgetJpy)}</span>
                <span className="ck-rank-track"><span className={`ck-rank-bar${p === knee ? ' is-funded' : ''}`} style={{ width: `${(100 * p.value) / max}%` }} /></span>
                <span className="ck-rank-value">{t('ck.front.value', { value: fmt.number(p.value), n: p.count })}{mark ? ` ${t('ck.front.current')}` : ''}</span>
              </div>
            );
          })}
        </div>
      )}
      table={(
        <table className="data-table compact">
          <thead><tr><th scope="col" className="num">{t('ck.front.col.budget')}</th><th scope="col" className="num">{t('ck.front.col.value')}</th><th scope="col" className="num">{t('ck.front.col.count')}</th></tr></thead>
          <tbody>{points.map((p, i) => <tr key={i}><td className="num">{fmt.yenCompact(p.budgetJpy)}</td><td className="num">{fmt.number(p.value)}</td><td className="num">{p.count}</td></tr>)}</tbody>
        </table>
      )}
    />
  );
}

const firstName = (r: Ranking, nameOf: NameOf) => { const top = r.rows.find((x) => !x.excluded); return top ? nameOf(top.id) : '—'; };

function CompareView({ cands, set, base, now, nameOf, prefix, onLoad, onDelete }: {
  cands: Candidate[]; set: WhatIfSet; base: Ranking; now: Ranking; nameOf: NameOf; prefix: string;
  onLoad: (s: Scenario) => void; onDelete: (name: string) => void;
}) {
  const { t, fmt } = useI18n();
  const cols = [
    { key: 'base', label: t('ck.cmp.base'), r: base, s: { ...baselineScenario(), budgetJpy: set.current.budgetJpy, maxItems: set.current.maxItems } as Scenario },
    { key: 'now', label: t('ck.cmp.now'), r: now, s: set.current },
    ...set.saved.map((s) => ({ key: s.name, label: t('ck.cmp.saved', { name: s.name }), r: rank(cands, s), s })),
  ];
  const weightText = (s: Scenario) => WEIGHT_KEYS.map((k) => `${t(`ck.crit.${k}`)} ${s.weights[k]}`).join(' / ');
  return (
    <div data-testid={`${prefix}-compare`}>
      {set.saved.length === 0 && <p className="muted">{t('ck.cmp.none', { max: MAX_SAVED_SCENARIOS })}</p>}
      <ScrollRegion label={t('ck.wi.tab.compare', { n: set.saved.length })}>
        <table className="data-table compact">
          <thead><tr><th scope="col">{t('ck.cmp.measure')}</th>{cols.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">{t('ck.cmp.top')}</th>{cols.map((c) => <td key={c.key} data-col={c.key}>{firstName(c.r, nameOf)}</td>)}</tr>
            <tr><th scope="row">{t('ck.cmp.funded')}</th>{cols.map((c) => <td key={c.key}>{c.r.funded.map(nameOf).join(t('ck.sep'))}</td>)}</tr>
            <tr><th scope="row">{t('ck.cmp.value')}</th>{cols.map((c) => <td key={c.key} className="num">{fmt.number(c.r.fundedValue)}</td>)}</tr>
            <tr><th scope="row">{t('ck.cmp.cost')}</th>{cols.map((c) => <td key={c.key} className="num">{fmt.yenCompact(c.r.fundedCost)}</td>)}</tr>
            <tr><th scope="row">{t('ck.cmp.weights')}</th>{cols.map((c) => <td key={c.key} className="ck-small">{weightText(c.s)}</td>)}</tr>
            <tr><th scope="row">{t('ck.cmp.weightsDefault')}</th>{cols.map((c) => <td key={c.key}>{t(WEIGHT_KEYS.every((k) => c.s.weights[k] === DEFAULT_WI_WEIGHTS[k]) ? 'ck.wi.yes' : 'ck.wi.no')}</td>)}</tr>
          </tbody>
        </table>
      </ScrollRegion>
      {set.saved.length > 0 && (
        <div className="ck-actions">
          {set.saved.map((s) => (
            <span key={s.name} className="ck-saved">
              <Button size="small" onClick={() => onLoad(s)} data-testid={`${prefix}-load-${s.name}`}>{t('ck.cmp.load', { name: s.name })}</Button>
              <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('ck.cmp.delete', { name: s.name })} onClick={() => onDelete(s.name)} data-testid={`${prefix}-delete-${s.name}`} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
