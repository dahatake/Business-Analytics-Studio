import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, Button, Tab, TabList } from '@fluentui/react-components';
import { Dismiss16Regular, Open16Regular, Sparkle20Regular } from '@fluentui/react-icons';
import type { MessageKey } from '../../i18n/core.ts';
import { useI18n } from '../../i18n/index.ts';
import { motionMs, useReducedMotion } from '../../state/motion.ts';
import { IMPROVEMENT_STEPS, type ImprovementStep } from '../../state/projects.ts';
import { loc } from '../../state/text.ts';
import { Panel } from '../../ui/Panel.tsx';
import { categoryKey, methodKey } from './analysisText.ts';
import { HIGH, QUADRANTS, type Basis, type OverviewFacts, type Quadrant, type ScoredTarget } from './analysisTargets.ts';
import { FIELD, fieldX, fieldY, joinBubbles, layoutField, nextBubble, paintBubbles, type BubbleEvents, type BubbleMark } from './analysisTargetsRender.ts';
import { ScrollRegion } from './common.tsx';
import type { Analysis } from './model.ts';

type T = ReturnType<typeof useI18n>['t'];
type TargetMap = Record<ImprovementStep, ScoredTarget[]>;

const pct = (v: number) => `${Math.round(v * 100)}`;
const stepKey = (s: ImprovementStep) => `proj.step.${s}` as MessageKey;
const quadKey = (q: Quadrant) => `proj.tg.q.${q}` as MessageKey;
const quadDescKey = (q: Quadrant) => `proj.tg.qd.${q}` as MessageKey;
const kindKey = (k: ScoredTarget['kind']) => `proj.tg.kind.${k}` as MessageKey;

export function basisText(b: Basis, t: T): string {
  if (b.kind === 'kpi') return b.progress === null ? t('proj.tg.basisKpiNone') : t('proj.tg.basis.kpi', { progress: pct(b.progress) });
  if (b.kind === 'initiative') return t('proj.tg.basis.initiative', { remaining: pct(1 - b.progress), dependents: b.dependents });
  if (b.kind === 'solution') return t('proj.tg.basis.solution', { roi: b.roi });
  return t(`proj.tg.basis.${b.kind}` as MessageKey, b as unknown as Record<string, string | number>);
}

/** A translated sentence whose `{name}` becomes an interactive element (the message itself stays one translatable unit). */
function withName(t: T, key: MessageKey, params: Record<string, string | number>, name: ReactNode): ReactNode {
  const mark = '\u0001';
  const [before, after] = t(key, { ...params, name: mark }).split(mark);
  return <>{before}{name}{after}</>;
}

export interface TargetSelection {
  /** The selected target, if any. */
  targetId: string | null;
  select: (id: string | null) => void;
  /** Targets the selected dashboard items are evidence for (reverse cross-highlight). */
  linkedIds: ReadonlySet<string>;
  /** True while dashboard items are selected. */
  itemsActive: boolean;
}

/** The dynamic overview at the head of the dashboard (FR-340): written from the current facts, so every edit rewrites it. */
export function TargetOverview({ facts, onPick }: { facts: OverviewFacts; onPick: (x: ScoredTarget) => void }) {
  const { t, lang } = useI18n();
  const step = facts.step;
  const pick = (x: ScoredTarget) => (
    <button type="button" className="proj-tg-namelink" onClick={() => onPick(x)} data-testid={`proj-tg-name-${x.id}`}>{loc(x.name, lang)}</button>
  );
  return (
    <section className="proj-tg-overview" aria-labelledby="proj-tg-ov-h" data-testid="proj-tg-overview">
      <h3 id="proj-tg-ov-h" className="proj-tg-ov-title"><Sparkle20Regular aria-hidden />{t('proj.tg.overview')}</h3>
      <ul className="proj-tg-ov-list" aria-live="polite">
        <li>{facts.analyses > 0 ? t('proj.tg.ov.summary', { analyses: facts.analyses, items: facts.items, targets: facts.targets }) : t('proj.tg.ov.noAnalyses', { targets: facts.targets })}</li>
        <li data-testid="proj-tg-ov-top">
          {facts.top
            ? withName(t, 'proj.tg.ov.top', { step: t(stepKey(step)), data: pct(facts.top.data), support: pct(facts.top.supportN) }, pick(facts.top))
            : t('proj.tg.ov.noTop', { step: t(stepKey(step)) })}
        </li>
        {facts.underexamined[0] && <li className="q-underexamined" data-testid="proj-tg-ov-under">{withName(t, 'proj.tg.ov.under', { count: facts.underexamined.length }, pick(facts.underexamined[0]))}</li>}
        {facts.unbacked[0] && <li className="q-unbacked" data-testid="proj-tg-ov-unbacked">{withName(t, 'proj.tg.ov.unbacked', { count: facts.unbacked.length }, pick(facts.unbacked[0]))}</li>}
        {facts.mostCited && facts.mostCited.analyses > 1 && <li>{withName(t, 'proj.tg.ov.cited', { count: facts.mostCited.analyses }, pick(facts.mostCited.target))}</li>}
        <li>{facts.uncovered > 0 ? t('proj.tg.ov.uncovered', { count: facts.uncovered }) : t('proj.tg.ov.allCovered')}</li>
      </ul>
    </section>
  );
}

/** FR-340: analysis targets of each improvement step, with data-vs-analysis signals as reference for prioritising. */
export function AnalysisTargets({ all, step, onStep, currentStep, sel, analyses, onOpen }: {
  all: TargetMap;
  step: ImprovementStep;
  onStep: (s: ImprovementStep) => void;
  currentStep: ImprovementStep;
  sel: TargetSelection;
  analyses: readonly Analysis[];
  onOpen: (analysisId: string) => void;
}) {
  const { t } = useI18n();
  const list = all[step];
  const selected = sel.targetId ? list.find((x) => x.id === sel.targetId) ?? null : null;

  return (
    <Panel title={t('proj.tg.title')} rationale="proj.tg.why" className="span-full proj-tg-panel" testId="proj-targets" id="proj-targets">
      <TabList selectedValue={step} onTabSelect={(_, d) => onStep(d.value as ImprovementStep)} aria-label={t('proj.tg.steps')} className="proj-tg-steps" size="small">
        {IMPROVEMENT_STEPS.map((s, i) => (
          <Tab key={s} value={s} data-testid={`proj-tg-step-${s}`}>
            {t('proj.tg.stepTab', { n: i + 1, step: t(stepKey(s)) })}
            <Badge appearance="tint" size="small" className="proj-tg-count">{all[s].length}</Badge>
            {s === currentStep && <Badge appearance="outline" size="small" color="brand" className="proj-tg-now">{t('proj.tg.now')}</Badge>}
          </Tab>
        ))}
      </TabList>

      {sel.itemsActive && <p className="proj-tg-linked" role="status" data-testid="proj-tg-linked">{t('proj.tg.linkedCount', { count: list.filter((x) => sel.linkedIds.has(x.id)).length })}</p>}

      {list.length === 0
        ? <p className="muted">{t('proj.tg.empty')}</p>
        : (
          <div className="proj-tg-body">
            <PriorityField list={list} step={step} sel={sel} />
            {selected
              ? <TargetDetail target={selected} analyses={analyses} onClose={() => sel.select(null)} onOpen={onOpen} />
              : <Legend />}
          </div>
        )}
      {list.length > 0 && <TargetTable list={list} sel={sel} />}
    </Panel>
  );
}

function Legend() {
  const { t } = useI18n();
  return (
    <aside className="proj-tg-legend" aria-label={t('proj.tg.legend')}>
      <ul>
        {QUADRANTS.map((q) => (
          <li key={q} className={`q-${q}`}>
            <span className="proj-tg-swatch" aria-hidden />
            <span><strong>{t(quadKey(q))}</strong>{t(quadDescKey(q))}</span>
          </li>
        ))}
      </ul>
      <p className="muted">{t('proj.tg.formula', { high: pct(HIGH) })}</p>
      <p className="muted">{t('proj.tg.hint')}</p>
    </aside>
  );
}

function PriorityField({ list, step, sel }: { list: ScoredTarget[]; step: ImprovementStep; sel: TargetSelection }) {
  const { t, lang } = useI18n();
  const reduced = useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const nodes = useMemo(() => layoutField(list), [list]);
  const byId = useMemo(() => new Map(list.map((x) => [x.id, x])), [list]);
  const [hover, setHover] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const live = useRef(sel);
  useLayoutEffect(() => { live.current = sel; });

  const events = useMemo<BubbleEvents>(() => ({
    select: (id) => {
      setFocusId(id);
      live.current.select(live.current.targetId === id ? null : id);
    },
    hover: setHover,
  }), []);

  useEffect(() => {
    if (ref.current) joinBubbles(ref.current, nodes, motionMs(reduced, 720), events);
  }, [nodes, reduced, events]);

  const tabStop = focusId && byId.has(focusId) ? focusId : sel.targetId && byId.has(sel.targetId) ? sel.targetId : nodes.find((n) => n.rank === 1)?.id ?? null;
  useEffect(() => {
    if (!ref.current) return;
    const mark = (id: string): BubbleMark => {
      if (sel.targetId) return id === sel.targetId ? 'selected' : 'dimmed';
      if (sel.itemsActive) return sel.linkedIds.has(id) ? 'linked' : 'dimmed';
      return null;
    };
    paintBubbles(ref.current, {
      mark: (n) => mark(n.id),
      label: (n) => {
        const x = byId.get(n.id)!;
        return t('proj.tg.bubble', { rank: x.rank, name: loc(x.name, lang), quadrant: t(quadKey(x.quadrant)), data: pct(x.data), support: pct(x.supportN), count: x.evidence.length });
      },
      tabStop,
    });
  }, [nodes, sel, byId, tabStop, t, lang]);

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const id = (e.target as Element).getAttribute?.('data-target-id');
    if (!id) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); events.select(id); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = nextBubble(nodes, id, e.key);
    if (!next) return;
    setFocusId(next);
    ref.current?.querySelector<SVGElement>(`g[data-target-id="${CSS.escape(next)}"]:not(.exiting)`)?.focus();
  };

  const tip = hover ? byId.get(hover) : undefined;
  const tipNode = tip ? nodes.find((n) => n.id === tip.id) : undefined;
  const x0 = fieldX(0);
  const x1 = fieldX(1);
  const y0 = fieldY(1);
  const y1 = fieldY(0);
  const xm = fieldX(HIGH);
  const ym = fieldY(HIGH);
  const quads: { q: Quadrant; x: number; y: number; w: number; h: number; lx: number; ly: number; anchor: 'start' | 'end' }[] = [
    { q: 'focus', x: xm, y: y0, w: x1 - xm, h: ym - y0, lx: x1 - 8, ly: y0 + 18, anchor: 'end' },
    { q: 'underexamined', x: x0, y: y0, w: xm - x0, h: ym - y0, lx: x0 + 8, ly: y0 + 18, anchor: 'start' },
    { q: 'unbacked', x: xm, y: ym, w: x1 - xm, h: y1 - ym, lx: x1 - 8, ly: y1 - 10, anchor: 'end' },
    { q: 'later', x: x0, y: ym, w: xm - x0, h: y1 - ym, lx: x0 + 8, ly: y1 - 10, anchor: 'start' },
  ];
  const label = t('proj.tg.fieldLabel', { step: t(stepKey(step)) });
  return (
    <div className="proj-tg-stage" data-testid="proj-tg-field">
      <svg
        ref={ref}
        className={`proj-tg-svg${sel.targetId || sel.itemsActive ? ' has-selection' : ''}`}
        viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}
        role="group"
        aria-label={label}
        onKeyDown={onKey}
      >
        <defs>
          <radialGradient id="proj-tg-glow-bg" cx="78%" cy="18%" r="95%">
            <stop offset="0%" className="proj-tg-bg-hot" />
            <stop offset="55%" className="proj-tg-bg-mid" />
            <stop offset="100%" className="proj-tg-bg-cold" />
          </radialGradient>
          <filter id="proj-tg-bloom" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect className="proj-tg-bg" x={0} y={0} width={FIELD.width} height={FIELD.height} rx={12} fill="url(#proj-tg-glow-bg)" onClick={() => sel.select(null)} aria-hidden />
        <g aria-hidden>
          {quads.map((r) => (
            <g key={r.q} className={`proj-tg-quad q-${r.q}`}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} />
              <text x={r.lx} y={r.ly} textAnchor={r.anchor} className="proj-tg-quad-label">{t(quadKey(r.q))}</text>
            </g>
          ))}
          {[0.25, 0.75].map((v) => (
            <g key={v} className="proj-tg-grid">
              <line x1={fieldX(v)} x2={fieldX(v)} y1={y0} y2={y1} />
              <line x1={x0} x2={x1} y1={fieldY(v)} y2={fieldY(v)} />
            </g>
          ))}
          <line className="proj-tg-threshold" x1={xm} x2={xm} y1={y0} y2={y1} />
          <line className="proj-tg-threshold" x1={x0} x2={x1} y1={ym} y2={ym} />
          <text className="proj-tg-axis" x={x1} y={FIELD.height - 12} textAnchor="end">{t('proj.tg.axisSupport')}</text>
          <text className="proj-tg-axis" transform={`translate(18,${y0}) rotate(-90)`} textAnchor="end">{t('proj.tg.axisData')}</text>
          <g className="proj-tg-tethers" />
        </g>
        <g className="proj-tg-bubbles" filter="url(#proj-tg-bloom)" />
      </svg>
      {tip && tipNode && (
        <div
          className="proj-tg-tip"
          role="presentation"
          style={{ left: `${(tipNode.x / FIELD.width) * 100}%`, top: `${(tipNode.y / FIELD.height) * 100}%` }}
          data-testid="proj-tg-tip"
        >
          <strong>{t('proj.tg.tipTitle', { rank: tip.rank, name: loc(tip.name, lang) })}</strong>
          <span className={`proj-tg-tip-q q-${tip.quadrant}`}>{t(quadKey(tip.quadrant))}</span>
          <span>{t('proj.tg.signals', { data: pct(tip.data), support: pct(tip.supportN), count: tip.evidence.length })}</span>
        </div>
      )}
    </div>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  return (
    <span className="proj-tg-meter" title={label}>
      <span className="proj-tg-meter-fill" style={{ width: `${Math.round(value * 100)}%` }} aria-hidden />
      <span className="proj-tg-meter-text">{pct(value)}</span>
    </span>
  );
}

function TargetDetail({ target, analyses, onClose, onOpen }: { target: ScoredTarget; analyses: readonly Analysis[]; onClose: () => void; onOpen: (id: string) => void }) {
  const { t, lang } = useI18n();
  const byId = new Map(analyses.map((a) => [a.id, a]));
  return (
    <aside className={`proj-tg-detail q-${target.quadrant}`} aria-labelledby="proj-tg-detail-h" data-testid="proj-tg-detail">
      <header className="proj-tg-detail-head">
        <div>
          <span className="proj-tg-detail-q">{t('proj.tg.detailMeta', { rank: target.rank, quadrant: t(quadKey(target.quadrant)) })}</span>
          <h3 id="proj-tg-detail-h" className="proj-tg-detail-title">{loc(target.name, lang)}</h3>
          <span className="muted">{t(kindKey(target.kind))}</span>
        </div>
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={t('proj.link.clear')} onClick={onClose} data-testid="proj-tg-detail-close" />
      </header>
      <dl className="proj-tg-signals">
        <dt>{t('proj.tg.col.data')}</dt>
        <dd><Meter value={target.data} label={t('proj.tg.col.data')} /><span className="proj-tg-basis" data-testid="proj-tg-basis">{basisText(target.basis, t)}</span></dd>
        <dt>{t('proj.tg.col.support')}</dt>
        <dd><Meter value={target.supportN} label={t('proj.tg.col.support')} /><span className="proj-tg-basis">{t('proj.tg.supportBasis', { support: target.support, count: target.evidence.length })}</span></dd>
      </dl>
      <h4 className="proj-tg-ev-title">{t('proj.tg.evidence', { count: target.evidence.length })}</h4>
      {target.evidence.length === 0
        ? <p className="muted" data-testid="proj-tg-noev">{t('proj.tg.noEvidence')}</p>
        : (
          <ol className="proj-tg-ev" data-testid="proj-tg-evidence">
            {target.evidence.map((e) => {
              const a = byId.get(e.analysisId);
              const item = a?.items.find((i) => i.id === e.itemId);
              return (
                <li key={`${e.analysisId}:${e.itemId}`} className={`ev-${e.link}`}>
                  <span className="proj-tg-ev-link">{t(e.link === 'direct' ? 'proj.tg.ev.direct' : 'proj.tg.ev.near')}</span>
                  <span className="proj-tg-ev-text">
                    <span>{item ? loc(item.text, lang) : e.itemId}</span>
                    <span className="muted">{t('proj.tg.evWhere', { method: t(methodKey(e.method)), category: t(categoryKey(e.category)), score: e.score, value: e.value })}</span>
                  </span>
                  {a && <Button size="small" appearance="subtle" icon={<Open16Regular />} aria-label={t('proj.tg.openParams', { title: loc(a.title, lang) })} onClick={() => onOpen(a.id)} />}
                </li>
              );
            })}
          </ol>
        )}
    </aside>
  );
}

function TargetTable({ list, sel }: { list: ScoredTarget[]; sel: TargetSelection }) {
  const { t, lang } = useI18n();
  return (
    <details className="proj-tg-table-wrap" data-testid="proj-tg-table">
      <summary>{t('proj.tg.list', { count: list.length })}</summary>
      <ScrollRegion label={t('proj.tg.listLabel')}>
        <table className="data-table compact proj-tg-table">
          <caption className="visually-hidden">{t('proj.tg.listLabel')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('proj.tg.col.rank')}</th>
              <th scope="col">{t('proj.tg.col.name')}</th>
              <th scope="col">{t('proj.tg.col.quadrant')}</th>
              <th scope="col">{t('proj.tg.col.data')}</th>
              <th scope="col">{t('proj.tg.col.support')}</th>
              <th scope="col">{t('proj.tg.col.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => {
              const on = sel.targetId === x.id;
              const linked = sel.itemsActive && sel.linkedIds.has(x.id);
              return (
                <tr key={x.id} className={`${on ? 'is-selected' : ''}${linked ? ' is-related' : ''}`}>
                  <td>{x.rank}</td>
                  <td>
                    <button type="button" className="proj-tg-namelink" aria-pressed={on} onClick={() => sel.select(on ? null : x.id)} data-testid={`proj-tg-row-${x.id}`}>{loc(x.name, lang)}</button>
                    <span className="muted proj-tg-kind">{t(kindKey(x.kind))}</span>
                  </td>
                  <td><span className={`proj-tg-chip q-${x.quadrant}`}>{t(quadKey(x.quadrant))}</span></td>
                  <td><Meter value={x.data} label={basisText(x.basis, t)} /></td>
                  <td><Meter value={x.supportN} label={t('proj.tg.col.support')} /></td>
                  <td>{x.evidence.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
    </details>
  );
}
