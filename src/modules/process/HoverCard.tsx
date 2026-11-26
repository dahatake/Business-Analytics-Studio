import { useLayoutEffect, useRef, useState } from 'react';
import { getEntity } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { effortHours, laneResources, leadHours, metricsIn, presentIn, stepDelta, type Metrics, type ProcessView, type ProcState, type PStep } from './model.ts';
import { duration, formKey, hoursMonth, loopShort, signedPercent } from './format.ts';

export interface HoverTarget { type: 'step' | 'lane' | 'loop'; id: string; anchor?: Element }

const CARD_W = 340;
const GAP = 10;

/**
 * The summary card for the item under the pointer or keyboard focus (WCAG 1.4.13: it stays while hovered, Esc closes
 * it, and focus shows the same content as hover).
 */
export function HoverCard({ id, target, view, state, wrap, onEnter, onLeave }: {
  id: string; target: HoverTarget; view: ProcessView; state: ProcState; wrap: HTMLElement | null;
  onEnter: () => void; onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!wrap || !target.anchor || !ref.current) return;
    const w = wrap.getBoundingClientRect(), a = target.anchor.getBoundingClientRect(), h = ref.current.offsetHeight;
    let left = a.right - w.left + GAP;
    if (left + CARD_W > w.width) left = Math.max(4, a.left - w.left - CARD_W - GAP);
    let top = a.top - w.top;
    if (top + h > w.height) top = Math.max(4, w.height - h - 4);
    setPos({ left, top: Math.max(4, top) });
  }, [target, wrap]);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="bp-hovercard"
      data-testid="bp-hovercard"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: CARD_W }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {target.type === 'step' && <StepSummary step={view.byId.get(target.id)!} view={view} state={state} />}
      {target.type === 'lane' && <LaneSummary laneId={target.id} view={view} />}
      {target.type === 'loop' && <LoopSummary loopId={target.id} view={view} />}
    </div>
  );
}

function MetricRows({ m, label }: { m: Metrics | null; label: string }) {
  const { t, fmt } = useI18n();
  if (!m) return <tr><th scope="row">{label}</th><td colSpan={2}>{t('bp.card.absent')}</td></tr>;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{duration(leadHours(m), t, fmt)}{m.estimate ? ` (${t('bp.basis.estimate')})` : ''}</td>
      <td>{hoursMonth(effortHours(m), t, fmt)}</td>
    </tr>
  );
}

export function StepSummary({ step, view, state, full = false }: { step: PStep; view: ProcessView; state: ProcState; full?: boolean }) {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const laneOf = view.lanes.find((l) => l.id === step.laneId);
  const phase = view.phases.find((p) => p.id === step.phaseId);
  const m = metricsIn(step, state) ?? step.asIs;
  const d = stepDelta(step);
  const sources = step.sourceIds.filter((sid) => {
    const e = getEntity(sid);
    return e && !isHidden(e, audience);
  });
  const artifacts = (list: PStep['inputs'], key: 'bp.card.inputs' | 'bp.card.outputs') => (
    <div className="bp-hc-io">
      <strong>{t(key)}</strong>
      {list.length ? (
        <ul>{list.map((a, i) => <li key={i}>{loc(a.name, lang)}{a.form ? <span className="bp-form">{t(formKey(a.form))}</span> : null}{a.partyId ? <span className="muted"> · {loc(view.lanes.find((l) => l.id === a.partyId)?.name ?? '', lang)}</span> : null}</li>)}</ul>
      ) : <p className="muted">{t('bp.card.none')}</p>}
    </div>
  );
  return (
    <div className="bp-hc">
      <div className="bp-hc-head">
        <span className={`bp-side-tag is-${laneOf?.side ?? 'internal'}`}>{t(`bp.side.${laneOf?.side ?? 'internal'}`)}</span>
        <strong className="bp-hc-title">{loc(step.name, lang)}</strong>
        <span className="muted">{[laneOf ? loc(laneOf.name, lang) || t('bp.lane.unassigned') : '', phase?.name ? loc(phase.name, lang) : ''].filter(Boolean).join(' · ')}</span>
      </div>
      {step.description && <p>{loc(step.description, lang)}</p>}
      {step.change !== 'keep' && (
        <p className={`bp-hc-change change-${step.change}`}>
          <span className={`bp-tag change-${step.change}`}>{t(`bp.change.${step.change}`)}</span>
          {step.toBeHypothesis && <span className="bp-tag is-hypo">{t('bp.basis.hypothesis')}</span>}
          {step.note ? ` ${loc(step.note, lang)}` : ''}
        </p>
      )}
      <table className="bp-hc-table">
        <thead><tr><th scope="col">{t('bp.card.state')}</th><th scope="col">{t('bp.card.lead')}</th><th scope="col">{t('bp.card.effort')}</th></tr></thead>
        <tbody>
          <MetricRows m={step.asIs} label={t('bp.state.asIs')} />
          <MetricRows m={step.toBe} label={t('bp.state.toBe')} />
        </tbody>
      </table>
      {step.asIs && step.toBe && (d.lead !== null || d.effort !== null) && <p className="bp-hc-delta">{t('bp.card.delta', { lead: signedPercent(d.lead, fmt), effort: signedPercent(d.effort, fmt) })}</p>}
      {m && (
        <p className="muted">
          {[
            m.touchMin !== null ? t('bp.card.touch', { value: duration(m.touchMin / 60, t, fmt) }) : '',
            m.waitH !== null ? t('bp.card.wait', { value: duration(m.waitH, t, fmt) }) : '',
            m.volume !== null ? t('bp.card.volume', { value: fmt.integer(m.volume) }) : '',
            m.firstPass !== null ? t('bp.card.firstPass', { value: fmt.integer(m.firstPass) }) : '',
            m.people !== null ? t('bp.card.people', { value: m.people }) : '',
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      <div className="bp-hc-iogrid">
        {artifacts(step.inputs, 'bp.card.inputs')}
        {artifacts(step.outputs, 'bp.card.outputs')}
      </div>
      {step.hidden.length > 0 && (
        <div className="bp-hc-hidden">
          <strong>{t('bp.card.hidden')}</strong>
          <ul>{step.hidden.map((h, i) => (
            <li key={i}>{loc(h.name, lang)}{h.form ? <span className="bp-form">{t(formKey(h.form))}</span> : null}
              {(h.participants !== null || h.minutes !== null) && <span className="muted"> · {[h.participants !== null ? t('bp.card.participants', { n: h.participants }) : '', h.minutes !== null ? duration(h.minutes / 60, t, fmt) : ''].filter(Boolean).join(' · ')}</span>}
            </li>
          ))}</ul>
        </div>
      )}
      {full && step.activities.length > 0 && <p><strong>{t('bp.card.activities')}</strong> {step.activities.map((a) => loc(a, lang)).join(' / ')}</p>}
      {full && step.data.length > 0 && <p><strong>{t('bp.card.data')}</strong> {step.data.map((a) => loc(a, lang)).join(' / ')}</p>}
      {step.handoffTo.length > 0 && <p><strong>{t('bp.card.handoff')}</strong> {step.handoffTo.map((a) => loc(a, lang)).join(' / ')}</p>}
      <p className="muted bp-hc-sources">{sources.length ? t('bp.card.sources', { list: sources.map((sid) => loc(getEntity(sid)!.name, lang)).join(', ') }) : t('bp.card.noSources')}</p>
      {!presentIn(step, state) && state === 'asIs' && <p className="muted">{t('bp.card.toBeOnly')}</p>}
    </div>
  );
}

function LaneSummary({ laneId, view }: { laneId: string; view: ProcessView }) {
  const { t, lang, fmt } = useI18n();
  const l = view.lanes.find((x) => x.id === laneId)!;
  const r = laneResources(view).find((x) => x.laneId === laneId)!;
  const entity = l.entityId ? getEntity(l.entityId) : undefined;
  return (
    <div className="bp-hc">
      <div className="bp-hc-head">
        <span className={`bp-side-tag is-${l.side}`}>{t(`bp.side.${l.side}`)}</span>
        <strong className="bp-hc-title">{loc(l.name, lang) || t('bp.lane.unassigned')}</strong>
        {l.kind && <span className="muted">{t(`bp.kind.${l.kind}` as 'bp.kind.other')}</span>}
      </div>
      {entity && <p className="muted">{t('bp.card.entity', { name: loc(entity.name, lang) })}</p>}
      <table className="bp-hc-table">
        <thead><tr><th scope="col">{t('bp.card.state')}</th><th scope="col">{t('bp.card.steps')}</th><th scope="col">{t('bp.card.effort')}</th></tr></thead>
        <tbody>
          {(['asIs', 'toBe'] as const).map((s) => (
            <tr key={s}><th scope="row">{t(`bp.state.${s}`)}</th><td>{r.steps[s]}</td><td>{hoursMonth(r.effortHours[s], t, fmt)}</td></tr>
          ))}
        </tbody>
      </table>
      {l.side === 'external' && <p className="muted">{t('bp.card.externalNote')}</p>}
    </div>
  );
}

function LoopSummary({ loopId, view }: { loopId: string; view: ProcessView }) {
  const { t, lang, fmt } = useI18n();
  const l = view.loops.find((x) => x.id === loopId)!;
  return (
    <div className="bp-hc">
      <div className="bp-hc-head">
        <strong className="bp-hc-title">↻ {loopShort(l, t, lang, fmt)}</strong>
        <span className="muted">{t(`bp.loopState.${l.state}`)}</span>
      </div>
      {l.label && <p>{loc(l.label, lang)}</p>}
      <p>{t('bp.card.loopPath', { from: loc(view.byId.get(l.from)!.name, lang), to: loc(view.byId.get(l.to)!.name, lang) })}</p>
      <p className="muted">{t(`bp.loopHelp.${l.kind}`)}</p>
    </div>
  );
}
