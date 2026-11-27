import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, Select } from '@fluentui/react-components';
import { Add16Regular, ArrowUndo16Regular, Delete16Regular } from '@fluentui/react-icons';
import { AI_BASES, AI_LAYERS, type AiArea, type AiAreaCheckId, type AiBasis, type AiCapabilityId, type AiPlatformExtension } from '../../data/extensionSchemas.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { replaceQuery, useRoute, useRouteTarget } from '../../state/router.ts';
import { usePackVersion } from '../../state/packEdits.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { AI_APPROACHES, type AiApproach } from '../project/strategy.ts';
import { useProjUi, useStrategy } from '../project/stores.ts';
import { HillMap, LoopDiagram, ScoreTrend } from './HillMap.tsx';
import {
  addEvaluation, areasOf, buildAiFirst, CAPABILITY, LEVELS, linearOrder, LOOP_STEPS, orderCheck, removeEvaluation, setCapability,
  setCheck, stageOrder, STAGES, withAreas, type AiFirstView, type AreaView, type GateItem, type Level, type Stage,
} from './model.ts';
import { effectivePlatform, savePlatform, solutionInfos, usePlatformEdits } from './store.ts';
import './aifirst.css';

const by = () => useProjUi.getState().editor.trim();
const now = () => new Date().toISOString();

export function AiFirstScreen() {
  const { t, lang } = useI18n();
  const route = useRoute();
  useRouteTarget();
  const version = usePackVersion((s) => s.version);
  const stored = usePlatformEdits((s) => s.value);
  const strategyRaw = useStrategy((s) => s.value);
  const audience = useSettings((s) => s.audience);
  const { platform, origin, stale } = effectivePlatform(stored);
  // The pack version is a dependency because a replaced pack changes the solutions.
  const solutions = useMemo(() => solutionInfos(strategyRaw), [strategyRaw, version]);
  const view = buildAiFirst(platform, solutions);
  const shareable = new Set(loaded.pack.entities.filter((e) => audience === 'internal' || e.classification === 'shareable').map((e) => e.id));
  const areas = view.areas.filter((a) => !a.solutionIds.length || a.solutionIds.some((id) => shareable.has(id)));
  const sel = route.query.get('sel');
  const selected = areas.find((a) => a.id === sel) ?? areas[0] ?? null;
  const rawAreas = areasOf(platform, solutions).areas;
  const save = (next: AiPlatformExtension) => savePlatform(next);
  const editArea = (id: string, fn: (a: AiArea) => AiArea) => save(withAreas(platform, rawAreas, (list) => list.map((a) => (a.id === id ? fn(a) : a))));
  const solutionName = (id: string) => {
    const s = solutions.find((x) => x.id === id);
    return s ? loc(s.name, lang) : id;
  };

  return (
    <div className="screen screen-aifirst">
      <PageHeader
        title={t('aif.title')}
        subtitle={t('aif.subtitle')}
        actions={origin === 'edited'
          ? <Button appearance="subtle" icon={<ArrowUndo16Regular />} onClick={() => usePlatformEdits.getState().reset()} data-testid="aif-reset">{t('aif.action.reset')}</Button>
          : undefined}
      />
      <MessageBar intent="info" className="aif-notice" data-testid="aif-not-linear"><MessageBarBody>{t('aif.notLinear')}</MessageBarBody></MessageBar>
      <p className="muted aif-origin" data-testid="aif-origin" data-origin={origin}>{t(`aif.origin.${origin}`)}</p>
      {stale && <MessageBar intent="warning" data-testid="aif-stale"><MessageBarBody>{t('aif.stale')}</MessageBarBody></MessageBar>}

      <SummaryTiles view={view} areas={areas} />

      <div className="aif-grid">
        <Panel title={t('aif.map.title')} rationale="aif.map.why" className="aif-map-panel" testId="aif-map">
          {areas.length
            ? <HillMap areas={areas} selected={selected?.id ?? null} onSelect={(id) => replaceQuery({ sel: id })} />
            : <p className="muted">{t('aif.area.none')}</p>}
          <ul className="aif-legend">
            <li>{t('aif.map.legend.height')}</li>
            <li>{t('aif.map.legend.loop')}</li>
            <li>{t('aif.map.legend.basis')}</li>
            <li>{t('aif.map.legend.trail')}</li>
          </ul>
        </Panel>
        <Panel title={t('aif.area.title')} className="aif-area-panel" testId="aif-area">
          {selected
            ? <AreaDetail key={selected.id} area={selected} raw={rawAreas.find((a) => a.id === selected.id)!} view={view} solutionName={solutionName}
                solutions={solutions.filter((s) => shareable.has(s.id)).map((s) => s.id)}
                onEdit={(fn) => editArea(selected.id, fn)}
                onRemove={() => {
                  save(withAreas(platform, rawAreas, (list) => list.filter((a) => a.id !== selected.id)));
                  replaceQuery({ sel: undefined });
                }} />
            : <p className="muted">{t('aif.area.none')}</p>}
          <AddArea onAdd={(name) => {
            const used = new Set(rawAreas.map((a) => a.id));
            let n = rawAreas.length + 1;
            while (used.has(`area-${n}`)) n++;
            const id = `area-${n}`;
            save(withAreas(platform, rawAreas, (list) => [...list, { id, name, solutionIds: [], checks: [], evaluations: [] }]));
            replaceQuery({ sel: id });
          }} />
        </Panel>
      </div>

      <AreaTable areas={areas} selected={selected?.id ?? null} />
      <PlatformPanel view={view} onSet={(id, state) => save(setCapability(platform, id, state && { ...state, by: by(), at: now() }))} />
      <ViolationsPanel view={view} areaName={(id) => loc(view.areas.find((a) => a.id === id)?.name ?? id, lang)} />
      <RoadmapPanel view={view} solutionName={solutionName} />
      <ModelPanel />
    </div>
  );
}

/* ---------- Summary ---------- */

function SummaryTiles({ view, areas }: { view: AiFirstView; areas: AreaView[] }) {
  const { t } = useI18n();
  const contradictions = view.violations.filter((v) => v.severity === 'contradiction').length;
  const unverified = view.violations.length - contradictions;
  const next = view.roadmap[0];
  return (
    <div className="aif-tiles" data-testid="aif-summary">
      <div className="aif-tile" data-testid="aif-sum-position">
        <span className="aif-tile-label">{t('aif.sum.position')}</span>
        <span className="aif-tile-value">
          {STAGES.map((s) => {
            const n = areas.filter((a) => a.position === s && !a.summit).length + (s === 'p4' ? areas.filter((a) => a.summit).length : 0);
            return n ? <span key={s} className={`aif-chip aif-chip-${s}`} data-stage={s} data-count={n}>{t('aif.sum.positionItem', { stage: s.toUpperCase(), n })}</span> : null;
          })}
        </span>
      </div>
      <div className="aif-tile" data-testid="aif-sum-loops">
        <span className="aif-tile-label">{t('aif.sum.loops')}</span>
        <span className="aif-tile-value">{t('aif.sum.loopsValue', { n: areas.filter((a) => a.loop.closed).length, total: areas.length })}</span>
      </div>
      <div className="aif-tile" data-testid="aif-sum-violations" data-count={contradictions}>
        <span className="aif-tile-label">{t('aif.sum.violations')}</span>
        <span className="aif-tile-value">{t('aif.sum.violationsValue', { n: contradictions, m: unverified })}</span>
      </div>
      <div className="aif-tile" data-testid="aif-sum-next">
        <span className="aif-tile-label">{t('aif.sum.next')}</span>
        <span className="aif-tile-value">{next ? t(`aif.cap.${next.id}`) : t('aif.sum.nextNone')}</span>
      </div>
    </div>
  );
}

/* ---------- One business area: position, loop, gate checks, evaluations ---------- */

function AreaDetail({ area, raw, view, solutionName, solutions, onEdit, onRemove }: {
  area: AreaView; raw: AiArea; view: AiFirstView; solutionName: (id: string) => string; solutions: string[];
  onEdit: (fn: (a: AiArea) => AiArea) => void; onRemove: () => void;
}) {
  const { t, lang } = useI18n();
  const at = area.progress.find((p) => p.stage === area.position)!;
  // Sections stay as the person left them: ticking a check may move the position, but never closes the open section.
  const [opened, setOpened] = useState<ReadonlySet<Stage>>(() => new Set([area.position]));
  const toggle = (stage: Stage, isOpen: boolean) => setOpened((prev) => {
    if (prev.has(stage) === isOpen) return prev;
    const next = new Set(prev);
    if (isOpen) next.add(stage);
    else next.delete(stage);
    return next;
  });
  return (
    <div className="aif-area" data-testid={`aif-area-${area.id}`} data-position={area.position}>
      <h3 className="aif-area-name">{loc(area.name, lang)}</h3>
      <div className="aif-badges">
        <Badge appearance="tint" color="brand" data-testid="aif-area-position">{t('aif.area.positionValue', { stage: t(`aif.stage.${area.position}`), met: at.met, total: at.total })}</Badge>
        {area.summit && <Badge appearance="filled" color="success">{t('aif.area.summit')}</Badge>}
        <Badge appearance="outline" color="informative">{t('aif.area.targetValue', { stage: t(`aif.stage.${area.target}`) })}</Badge>
        <Badge appearance="outline" color={area.basis === 'evidence' ? 'success' : 'warning'} data-testid="aif-area-basis">{t(`aif.areaBasis.${area.basis}`)}</Badge>
      </div>
      {area.ahead.length > 0 && <p className="muted" data-testid="aif-area-ahead">{t('aif.area.ahead', { list: area.ahead.map((s) => t(`aif.stage.${s}`)).join(', ') })}</p>}
      {area.derived && <p className="muted">{t('aif.area.derived')}</p>}

      <div className="aif-area-fields">
        <Field label={t('aif.area.approach')} hint={area.approachSource === 'strategy' ? t('aif.area.approachFromStrategy') : undefined}>
          <Select value={raw.approach ?? ''} data-testid="aif-area-approach"
            onChange={(_, d) => onEdit((a) => {
              const { approach: _drop, ...rest } = a;
              return d.value ? { ...rest, approach: d.value as AiApproach } : rest;
            })}>
            <option value="">{area.approachSource === 'strategy' && area.approach ? `${t('aif.area.approachInherit')}: ${t(`sol.approach.short.${area.approach}`)}` : t('sol.approach.none')}</option>
            {AI_APPROACHES.map((x) => <option key={x} value={x}>{t(`sol.approach.${x}`)}</option>)}
          </Select>
        </Field>
        <fieldset className="aif-solutions">
          <legend>{t('aif.area.solutions')}</legend>
          {solutions.map((id) => (
            <Checkbox key={id} label={solutionName(id)} checked={raw.solutionIds.includes(id)} data-testid={`aif-area-solution-${id}`}
              onChange={(_, d) => onEdit((a) => ({ ...a, solutionIds: d.checked ? [...a.solutionIds, id] : a.solutionIds.filter((x) => x !== id) }))} />
          ))}
        </fieldset>
      </div>

      <div className="aif-loop-row">
        <LoopDiagram area={area} />
        <ul className="aif-loop-list" data-testid="aif-loop-list">
          {LOOP_STEPS.map((s) => (
            <li key={s} data-step={s} data-done={area.loop.steps[s]}>
              <strong>{t(`aif.loop.${s}`)}</strong>{': '}{t(area.loop.steps[s] ? 'aif.loop.done' : 'aif.loop.todo')}{' — '}<span className="muted">{t(`aif.loopHint.${s}`)}</span>
            </li>
          ))}
        </ul>
      </div>

      <h4>{t('aif.gate.title')}</h4>
      <p className="muted">{t('aif.gate.intro')}</p>
      {area.progress.map((p) => (
        <details key={p.stage} className={`aif-gate${p.done ? ' is-done' : ''}`} open={opened.has(p.stage)} data-testid={`aif-gate-${p.stage}`} data-done={p.done}
          onToggle={(e) => toggle(p.stage, e.currentTarget.open)}>
          <summary>
            <strong>{t(`aif.stage.${p.stage}`)}</strong>{' '}
            <Badge size="small" appearance={p.done ? 'filled' : 'outline'} color={p.done ? 'success' : 'informative'}>{t('aif.gate.count', { met: p.met, total: p.total })}</Badge>
          </summary>
          <p className="muted">{t(`aif.stageDesc.${p.stage}`)}</p>
          <ul className="aif-gate-items">
            {p.items.map((item) => <GateRow key={`${item.kind}-${item.id}`} item={item} raw={raw} view={view} onEdit={onEdit} />)}
          </ul>
        </details>
      ))}

      <h4>{t('aif.eval.title')}</h4>
      {area.loop.evaluations.length ? <ScoreTrend area={area} /> : <p className="muted">{t('aif.eval.none')}</p>}
      {raw.evaluations.length > 0 && (
        <ul className="aif-evals" data-testid="aif-evals">
          {raw.evaluations.map((e, i) => (
            <li key={`${e.date}-${i}`}>
              {e.date}{' · '}{e.score}{' · '}{loc(e.metric, lang)}{' '}
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label={t('aif.eval.remove')} onClick={() => onEdit((a) => removeEvaluation(a, i))} />
            </li>
          ))}
        </ul>
      )}
      <AddEvaluation lastMetric={raw.evaluations.length ? loc(raw.evaluations[raw.evaluations.length - 1]!.metric, lang) : ''}
        onAdd={(e) => onEdit((a) => addEvaluation(a, e))} />

      <div className="aif-area-actions">
        <AreaName name={loc(area.name, lang)} onSave={(name) => onEdit((a) => ({ ...a, name }))} />
        <Button appearance="subtle" icon={<Delete16Regular />} onClick={onRemove} data-testid="aif-area-remove">{t('aif.area.remove')}</Button>
      </div>
    </div>
  );
}

function GateRow({ item, raw, view, onEdit }: { item: GateItem; raw: AiArea; view: AiFirstView; onEdit: (fn: (a: AiArea) => AiArea) => void }) {
  const { t, lang } = useI18n();
  if (item.kind === 'approach') {
    return (
      <li data-item="approach" data-met={item.met}>
        <span className={item.met ? 'aif-met' : 'aif-unmet'}>{t(item.met ? 'aif.gate.met' : 'aif.gate.unmet')}</span>{' '}{t('aif.gate.approach')}
      </li>
    );
  }
  if (item.kind === 'capability') {
    const c = view.capabilities[item.id as AiCapabilityId];
    return (
      <li data-item={item.id} data-met={item.met}>
        <span className={item.met ? 'aif-met' : 'aif-unmet'}>{t(item.met ? 'aif.gate.met' : 'aif.gate.unmet')}</span>{' '}
        {t('aif.gate.capability', { cap: t(`aif.cap.${c.id}`), level: c.level === null ? t('aif.level.unassessed') : t(`aif.level.${c.level}`) })}{' '}
        <a href={`#aif-cap-${c.id}`} className="aif-link">{t('aif.gate.editCapability')}</a>
      </li>
    );
  }
  const id = item.id as AiAreaCheckId;
  const own = raw.checks.find((c) => c.id === id);
  const basis: AiBasis = own?.basis ?? 'selfReport';
  return (
    <li data-item={id} data-met={item.met} className="aif-check">
      <Checkbox
        checked={item.met} data-testid={`aif-check-${id}`}
        label={`${t(`aif.check.${id}`)}${item.source === 'pack' ? ` (${t('aif.source.pack')})` : ''}`}
        onChange={(_, d) => onEdit((a) => setCheck(a, id, { met: !!d.checked, basis, ...(own?.note ? { note: loc(own.note, lang) } : {}), by: by(), at: now() }))}
      />
      {(own || item.met) && item.source === 'area' && (
        <span className="aif-check-fields">
          <Select size="small" value={basis} aria-label={t('aif.check.basis')} data-testid={`aif-check-basis-${id}`}
            onChange={(_, d) => onEdit((a) => setCheck(a, id, { met: item.met, basis: d.value as AiBasis, ...(own?.note ? { note: loc(own.note, lang) } : {}), by: by(), at: now() }))}>
            {AI_BASES.map((b) => <option key={b} value={b}>{t(`aif.basis.${b}`)}</option>)}
          </Select>
          <NoteInput value={own?.note ? loc(own.note, lang) : ''} label={t('aif.check.note')} testId={`aif-check-note-${id}`}
            onSave={(note) => onEdit((a) => setCheck(a, id, { met: item.met, basis, note, by: by(), at: now() }))} />
        </span>
      )}
      {item.source === 'pack' && item.note && <span className="muted aif-check-source">{String(loc(item.note, lang))}</span>}
      <span className="muted aif-check-desc">{t(`aif.checkDesc.${id}`)}</span>
    </li>
  );
}

function NoteInput({ value, label, testId, onSave }: { value: string; label: string; testId: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Input size="small" value={text} aria-label={label} placeholder={label} data-testid={testId}
      onChange={(_, d) => setText(d.value)} onBlur={() => { if (text !== value) onSave(text); }} />
  );
}

function AreaName({ name, onSave }: { name: string; onSave: (v: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  return (
    <Field label={t('aif.area.name')} className="aif-area-namefield">
      <Input value={text} data-testid="aif-area-name" onChange={(_, d) => setText(d.value)} onBlur={() => { if (text.trim() && text !== name) onSave(text.trim()); }} />
    </Field>
  );
}

function AddEvaluation({ lastMetric, onAdd }: { lastMetric: string; onAdd: (e: { date: string; score: number; metric: string }) => void }) {
  const { t } = useI18n();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [score, setScore] = useState('');
  const [metric, setMetric] = useState(lastMetric);
  const n = Number(score);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(date) && score.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 && metric.trim() !== '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    onAdd({ date, score: n, metric: metric.trim() });
    setScore('');
  };
  return (
    <form className="aif-eval-form" onSubmit={submit} data-testid="aif-eval-form">
      <Field label={t('aif.eval.date')}><Input type="date" value={date} onChange={(_, d) => setDate(d.value)} data-testid="aif-eval-date" /></Field>
      <Field label={t('aif.eval.score')}><Input type="number" min={0} max={100} value={score} onChange={(_, d) => setScore(d.value)} data-testid="aif-eval-score" /></Field>
      <Field label={t('aif.eval.metric')}><Input value={metric} onChange={(_, d) => setMetric(d.value)} data-testid="aif-eval-metric" /></Field>
      <Button type="submit" icon={<Add16Regular />} disabled={!ok} data-testid="aif-eval-add">{t('aif.eval.add')}</Button>
    </form>
  );
}

function AddArea({ onAdd }: { onAdd: (name: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  return (
    <form className="aif-add-area" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onAdd(name.trim()); setName(''); } }}>
      <Field label={t('aif.area.newName')}><Input value={name} onChange={(_, d) => setName(d.value)} data-testid="aif-area-new-name" /></Field>
      <Button type="submit" icon={<Add16Regular />} disabled={!name.trim()} data-testid="aif-area-add">{t('aif.area.add')}</Button>
    </form>
  );
}

/* ---------- The same content as the map, as a table ---------- */

function AreaTable({ areas, selected }: { areas: AreaView[]; selected: string | null }) {
  const { t, lang } = useI18n();
  return (
    <Panel title={t('aif.table.title')} testId="aif-table">
      <table className="data-table compact">
        <caption className="visually-hidden">{t('aif.table.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('aif.table.area')}</th>
            <th scope="col">{t('aif.table.approach')}</th>
            <th scope="col">{t('aif.table.position')}</th>
            <th scope="col">{t('aif.table.target')}</th>
            <th scope="col">{t('aif.table.loop')}</th>
            <th scope="col">{t('aif.table.trend')}</th>
            <th scope="col">{t('aif.table.basis')}</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((a) => {
            const at = a.progress.find((p) => p.stage === a.position)!;
            return (
              <tr key={a.id} data-testid={`aif-row-${a.id}`} aria-current={a.id === selected ? 'true' : undefined}>
                <th scope="row"><button type="button" className="aif-linkbutton" onClick={() => replaceQuery({ sel: a.id })}>{loc(a.name, lang)}</button></th>
                <td>{a.approach ? t(`sol.approach.short.${a.approach}`) : t('sol.approach.none')}</td>
                <td>{t('aif.area.positionValue', { stage: t(`aif.stage.${a.position}`), met: at.met, total: at.total })}</td>
                <td>{t(`aif.stage.${a.target}`)}</td>
                <td>{LOOP_STEPS.filter((s) => a.loop.steps[s]).map((s) => t(`aif.loop.${s}`)).join(' → ') || '—'}</td>
                <td>{t(`aif.trend.${a.loop.trend}`)}</td>
                <td>{t(`aif.areaBasis.${a.basis}`)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

/* ---------- The platform: eight layers, two of them vertical ---------- */

function PlatformPanel({ view, onSet }: { view: AiFirstView; onSet: (id: AiCapabilityId, state: { level: Level; basis: AiBasis; note?: string } | null) => void }) {
  const { t, lang, fmt } = useI18n();
  return (
    <Panel title={t('aif.platform.title')} rationale="aif.platform.why" testId="aif-platform">
      <p className="muted">{t('aif.platform.intro')}</p>
      <div className="aif-layers">
        {AI_LAYERS.map((layer) => {
          const l = view.layers.find((x) => x.layer === layer)!;
          const vertical = layer === 'trust' || layer === 'evaluate';
          return (
            <section key={layer} className={`aif-layer${vertical ? ' is-vertical' : ''}`} data-testid={`aif-layer-${layer}`} aria-label={t(`aif.layer.${layer}`)}>
              <div className="aif-layer-head">
                <strong>{t(`aif.layer.${layer}`)}</strong>
                {vertical && <Badge size="small" appearance="outline">{t('aif.platform.vertical')}</Badge>}
                <span className="muted">{l.mean === null ? t('aif.platform.unassessed') : t('aif.platform.mean', { mean: fmt.number(Math.round(l.mean * 10) / 10) })}</span>
              </div>
              <div className="aif-layer-bar" aria-hidden="true"><span style={{ width: `${((l.mean ?? 0) / 3) * 100}%` }} /></div>
              {l.caps.map((c) => (
                <details key={c.id} id={`aif-cap-${c.id}`} className="aif-cap" data-testid={`aif-cap-${c.id}`} data-level={c.level ?? 'none'}>
                  <summary>
                    <span>{t(`aif.cap.${c.id}`)}</span>{' '}
                    <Badge size="small" appearance={c.level === null ? 'outline' : 'filled'} color={c.level === null ? 'informative' : c.level === 0 ? 'danger' : c.level === 1 ? 'warning' : 'success'}>
                      {c.level === null ? t('aif.level.unassessed') : t(`aif.level.${c.level}`)}
                    </Badge>{' '}
                    {c.basis && <span className="muted">{t(`aif.basis.${c.basis}`)}</span>}{' '}
                    <span className="muted">{t('aif.cap.stage', { stage: c.def.stage.toUpperCase() })}</span>
                  </summary>
                  <p className="muted">{t(`aif.capDesc.${c.id}`)}</p>
                  <p className="muted">{t('aif.cap.requires', { list: c.def.requires.length ? c.def.requires.map((r) => t(`aif.cap.${r}`)).join(', ') : t('aif.cap.requiresNone') })}</p>
                  <div className="aif-cap-fields">
                    <Field label={t('aif.cap.level')}>
                      <Select value={c.level === null ? '' : String(c.level)} data-testid={`aif-cap-level-${c.id}`}
                        onChange={(_, d) => onSet(c.id, d.value === '' ? null : { level: Number(d.value) as Level, basis: c.basis ?? 'selfReport', ...(c.note ? { note: loc(c.note, lang) } : {}) })}>
                        <option value="">{t('aif.level.unassessed')}</option>
                        {LEVELS.map((v) => <option key={v} value={v}>{t(`aif.level.${v}`)}</option>)}
                      </Select>
                    </Field>
                    {c.level !== null && (
                      <>
                        <Field label={t('aif.check.basis')}>
                          <Select value={c.basis ?? 'selfReport'} data-testid={`aif-cap-basis-${c.id}`}
                            onChange={(_, d) => onSet(c.id, { level: c.level!, basis: d.value as AiBasis, ...(c.note ? { note: loc(c.note, lang) } : {}) })}>
                            {AI_BASES.map((b) => <option key={b} value={b}>{t(`aif.basis.${b}`)}</option>)}
                          </Select>
                        </Field>
                        <Field label={t('aif.cap.note')}>
                          <NoteInput value={c.note ? loc(c.note, lang) : ''} label={t('aif.cap.note')} testId={`aif-cap-note-${c.id}`}
                            onSave={(note) => onSet(c.id, { level: c.level!, basis: c.basis ?? 'selfReport', note })} />
                        </Field>
                      </>
                    )}
                  </div>
                </details>
              ))}
            </section>
          );
        })}
      </div>
    </Panel>
  );
}

/* ---------- Order contradictions ---------- */

function ViolationsPanel({ view, areaName }: { view: AiFirstView; areaName: (id: string) => string }) {
  const { t } = useI18n();
  const list = [...view.violations].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'contradiction' ? -1 : 1));
  return (
    <Panel title={t('aif.violation.title')} testId="aif-violations">
      <p className="muted">{t('aif.violation.intro')}</p>
      {list.length === 0 ? <p data-testid="aif-violations-none">{t('aif.violation.none')}</p> : (
        <ul className="aif-violations">
          {list.map((v, i) => (
            <li key={i} data-severity={v.severity} data-kind={v.kind} data-id={v.id} data-needs={v.needs}>
              <Badge size="small" appearance="tint" color={v.severity === 'contradiction' ? 'danger' : 'warning'}>{t(`aif.violation.${v.severity}`)}</Badge>{' '}
              {v.kind === 'capability'
                ? t('aif.violation.capability', { cap: t(`aif.cap.${v.id as AiCapabilityId}`), need: t(`aif.cap.${v.needs}`) })
                : t('aif.violation.area', { area: areaName(v.id), stage: t(`aif.stage.${v.stage ?? 'p0'}`), need: t(`aif.cap.${v.needs}`) })}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ---------- Roadmap from the business problems ---------- */

function RoadmapPanel({ view, solutionName }: { view: AiFirstView; solutionName: (id: string) => string }) {
  const { t, fmt } = useI18n();
  return (
    <Panel title={t('aif.roadmap.title')} rationale="aif.roadmap.why" testId="aif-roadmap">
      <p className="muted">{t('aif.roadmap.intro')}</p>
      {view.roadmap.length === 0 ? <p>{t('aif.roadmap.none')}</p> : (
        <table className="data-table compact">
          <caption className="visually-hidden">{t('aif.roadmap.title')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('aif.roadmap.wave')}</th>
              <th scope="col">{t('aif.roadmap.capability')}</th>
              <th scope="col">{t('aif.roadmap.layer')}</th>
              <th scope="col">{t('aif.roadmap.unlocks')}</th>
              <th scope="col" className="num">{t('aif.roadmap.value')}</th>
              <th scope="col">{t('aif.roadmap.missing')}</th>
            </tr>
          </thead>
          <tbody>
            {view.roadmap.map((r) => (
              <tr key={r.id} data-testid={`aif-roadmap-${r.id}`} data-wave={r.wave}>
                <td>{t('aif.roadmap.waveValue', { n: r.wave })}</td>
                <th scope="row">{t(`aif.cap.${r.id}`)}{r.unassessed && <>{' '}<Badge size="small" appearance="outline" color="warning">{t('aif.level.unassessed')}</Badge></>}</th>
                <td>{t(`aif.layer.${CAPABILITY[r.id].layer}`)}</td>
                <td>{r.solutionIds.map(solutionName).join(', ')}</td>
                <td className="num">{r.value ? fmt.yenCompact(r.value) : '—'}</td>
                <td>{r.missing.length ? r.missing.map((m) => t(`aif.cap.${m}`)).join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.notNeeded.length > 0 && <p className="muted" data-testid="aif-roadmap-not-needed">{t('aif.roadmap.notNeeded', { list: view.notNeeded.map((id) => t(`aif.cap.${id}`)).join(', ') })}</p>}
      {view.nonAiSolutions.length > 0 && <p className="muted">{t('aif.roadmap.nonAi', { list: view.nonAiSolutions.map(solutionName).join(', ') })}</p>}
    </Panel>
  );
}

/* ---------- Why the climb is not a straight road ---------- */

function ModelPanel() {
  const { t } = useI18n();
  const linear = orderCheck(linearOrder);
  const revised = orderCheck(stageOrder);
  const pair = ([cap, need]: [AiCapabilityId, AiCapabilityId]) => t('aif.model.pair', { cap: t(`aif.cap.${cap}`), need: t(`aif.cap.${need}`) });
  return (
    <Panel title={t('aif.model.title')} testId="aif-model">
      <p className="muted">{t('aif.model.intro')}</p>
      <div className="aif-model-grid">
        <section data-testid="aif-model-linear" data-backward={linear.backward.length} data-missing={linear.missing.length}>
          <h3>{t('aif.model.linear')}</h3>
          <p>{t('aif.model.counts', { backward: linear.backward.length, missing: linear.missing.length })}</p>
          <ul>{linear.backward.map((p) => <li key={p.join('-')}>{pair(p)}</li>)}</ul>
          <p className="muted">{t('aif.model.missingList', { list: [...new Set(linear.missing.map(([, n]) => t(`aif.cap.${n}`)))].join(', ') })}</p>
        </section>
        <section data-testid="aif-model-revised" data-backward={revised.backward.length} data-missing={revised.missing.length}>
          <h3>{t('aif.model.revised')}</h3>
          <p>{t('aif.model.counts', { backward: revised.backward.length, missing: revised.missing.length })}</p>
          <ul>{STAGES.map((s) => <li key={s}><strong>{t(`aif.stage.${s}`)}</strong>{': '}{t(`aif.stageDesc.${s}`)}</li>)}</ul>
          <p className="muted">{t('aif.model.tracks')}</p>
        </section>
      </div>
    </Panel>
  );
}
