import { useMemo, useState } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, MessageBar, MessageBarBody, Radio, RadioGroup,
  Select, Spinner, Textarea,
} from '@fluentui/react-components';
import { Edit20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { PARAMS } from '../../config/params.ts';
import type { EntityOf } from '../../data/schema.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { AiProgress } from '../ai/AiProgress.tsx';
import {
  ISSUE_CONTROLS, ISSUE_FRAMES, normalizeDeliverables, setCrux, setFraming, setSituation, SITUATIONS,
  type CheckContext, type DeliverableData, type IssueControl, type IssueFrame, type IssueFraming, type JudgmentOrigin, type Situation,
} from './deliverables.ts';
import { todayIn } from './deliverablesUi.tsx';
import {
  allParts, approveDiagnosis, diagnosisBaseline, diagnosisContext, diagnosisEvidence, diagnosisRules, framingWarnings, requestDiagnosis,
  useDiagnosisDrafts, type DiagnosisPart, type DraftFraming, type DraftOrigin, type IssueEvidence, type SavedDiagnosis,
} from './issueDiagnosis.ts';
import { SITUATION_CYCLE_MONTHS } from './issueTriage.ts';
import { useDeliverables, useProjUi } from './stores.ts';

const editor = () => useProjUi.getState().editor.trim();
type StateKind = `confirmed-${JudgmentOrigin}` | `draft-${DraftOrigin}` | 'none';
const STATE_COLOR: Record<StateKind, 'success' | 'brand' | 'warning' | 'informative' | 'subtle'> = {
  'confirmed-human': 'success', 'confirmed-ai': 'success', 'confirmed-rule': 'warning', 'draft-ai': 'brand', 'draft-rule': 'warning', none: 'subtle',
};

function StateBadge({ kind, testId }: { kind: StateKind; testId?: string }) {
  const { t } = useI18n();
  return <Badge size="small" appearance="tint" color={STATE_COLOR[kind]} data-testid={testId} data-state={kind}>{t(`proj.dx.state.${kind}`)}</Badge>;
}

/**
 * FR-385: the issue diagnosis — business situation, crux, and each issue's decision question, owner, hypothesis, falsifier, frame and
 * control — with every piece of data a person needs to judge it, Copilot's draft (always complete: gaps are BAS placeholders, labelled),
 * and the person's approval or own judgment. Nothing is confirmed until a person approves.
 */
export function IssueDiagnosisPanel({ ctx }: { ctx: CheckContext }) {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const drafts = useDiagnosisDrafts((s) => s.value);
  const setDrafts = useDiagnosisDrafts((s) => s.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const ev = useMemo(() => diagnosisEvidence(ctx, audience), [ctx, audience]);
  const context = useMemo(() => diagnosisContext(ctx, lang, audience), [ctx, lang, audience]);
  const draft: SavedDiagnosis | undefined = drafts[audience];
  const stale = !!draft && draft.baseline !== diagnosisBaseline(context);
  const data = ctx.deliverables;
  const nameOf = (id: string) => {
    const e = ctx.pack.byId.get(id);
    if (!e) return id;
    return isHidden(e, audience) ? t('proj.dash.chart.hidden') : loc(e.name, lang);
  };
  const sep = lang === 'ja' ? '、' : ', ';
  const write: Write = (fn) => useDeliverables.getState().set((v) => fn(normalizeDeliverables(v)));
  const meta = () => ({ by: editor(), at: new Date().toISOString() });
  const approve = (parts: DiagnosisPart[], force: boolean) => {
    if (!draft) return;
    write((d) => approveDiagnosis(d, draft, parts, meta(), force));
  };
  const discard = () => setDrafts((v) => { const next = { ...v }; delete next[audience]; return next; });
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await requestDiagnosis(context, diagnosisRules(ctx, context));
      setDrafts((v) => ({ ...v, [audience]: { ...run, lang, at: new Date().toISOString(), baseline: diagnosisBaseline(context) } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const when = (at: string) => fmt.date(todayIn(PARAMS.timeZone, new Date(at)));
  const savedBy = (x: { at: string; by: string }) => (x.by ? t('proj.qualify.savedBy', { date: when(x.at), by: x.by }) : t('proj.qualify.savedAnon', { date: when(x.at) }));
  const kindOf = (confirmed: { origin: JudgmentOrigin } | undefined, drafted: { origin: DraftOrigin } | undefined): StateKind =>
    confirmed ? `confirmed-${confirmed.origin}` : drafted ? `draft-${drafted.origin}` : 'none';
  const editIssue = editing?.startsWith('issue:') ? ev.issues.find((i) => i.id === editing.slice(6)) : undefined;

  return (
    <Panel title={t('proj.dx.title')} rationale="proj.dx.rationale" testId="step-diagnosis" className="span-full">
      <p className="muted">{t('proj.dx.lead')}</p>
      <div className="proj-row">
        <Button icon={busy ? <Spinner size="tiny" aria-hidden /> : <Sparkle20Regular />} disabled={busy || ev.issues.length === 0} onClick={() => void generate()} data-testid="step-dx-generate">
          {busy ? t('proj.dx.busy') : t('proj.dx.generate')}
        </Button>
        {draft && <Button appearance="primary" onClick={() => { approve(allParts(draft), false); discard(); }} data-testid="step-dx-approve-all">{t('proj.dx.approveAll')}</Button>}
        {draft && <Button onClick={discard} data-testid="step-dx-discard">{t('proj.dx.discard')}</Button>}
      </div>
      {busy && <AiProgress stage="generate" testId="step-dx-progress" />}
      {error && <p role="alert" data-testid="step-dx-error">{t('proj.dx.error', { detail: error })}</p>}
      {ev.issues.length === 0 && <p data-testid="step-dx-empty">{t('proj.dx.empty')}</p>}
      {draft && (
        <p data-testid="step-dx-draft" data-mode={draft.mock ? 'mock' : 'live'} data-placeholders={draft.placeholders.length}>
          {draft.mock && <><Badge size="small" appearance="tint" color="warning">{t('proj.dx.mock')}</Badge>{' '}</>}
          {t('proj.dx.draftNote', { date: when(draft.at), rounds: draft.rounds })}
          {draft.placeholders.length > 0 && <>{' '}{t('proj.dx.placeholders', { n: draft.placeholders.length })}</>}
        </p>
      )}
      {stale && <MessageBar intent="warning" data-testid="step-dx-stale"><MessageBarBody>{t('proj.dx.stale')}</MessageBarBody></MessageBar>}

      <SituationSection ctx={ctx} ev={ev} draft={draft} kindOf={kindOf} savedBy={savedBy} onApprove={() => approve(['situation'], true)} write={write} nameOf={nameOf} sep={sep} />
      <CruxSection ctx={ctx} ev={ev} draft={draft} kindOf={kindOf} savedBy={savedBy} onApprove={() => approve(['crux'], true)} write={write} nameOf={nameOf} sep={sep} />

      {ev.issues.length > 0 && (
        <section className="prio-block" aria-labelledby="dx-issues" data-testid="step-dx-issues">
          <h4 id="dx-issues" className="prio-label">{t('proj.dx.issuesLabel')}</h4>
          <p className="muted">{t('proj.dx.issuesLead')}</p>
          <table className="data-table compact">
            <thead><tr>
              <th scope="col">{t('proj.rob.col.issue')}</th><th scope="col">{t('proj.dx.col.data')}</th>
              <th scope="col">{t('proj.dx.col.framing')}</th><th scope="col">{t('proj.cod.col.action')}</th>
            </tr></thead>
            <tbody>
              {ev.issues.map((i) => {
                const confirmed = data.framings?.[i.id];
                const drafted = draft?.issues[i.id];
                const shown: Pick<IssueFraming, 'question' | 'owner' | 'hypothesis' | 'falsifier' | 'frame' | 'control' | 'reason'> | undefined = confirmed ?? drafted;
                const warnings = shown ? framingWarnings(shown, i) : (i.provisional ? ['provisionalRating' as const] : []);
                return (
                  <tr key={i.id} data-testid={`step-dx-row-${i.id}`} data-state={kindOf(confirmed, drafted)}>
                    <th scope="row"><EntityRef id={i.id} /></th>
                    <td><IssueData ctx={ctx} i={i} nameOf={nameOf} sep={sep} /></td>
                    <td>
                      <StateBadge kind={kindOf(confirmed, drafted)} testId={`step-dx-state-${i.id}`} />
                      {shown && (
                        <dl className="dx-framing">
                          <dt>{t('proj.dx.f.question')}</dt><dd data-testid={`step-dx-question-${i.id}`}>{shown.question}</dd>
                          <dt>{t('proj.dx.f.owner')}</dt><dd>{shown.owner}</dd>
                          <dt>{t('proj.dx.f.hypothesis')}</dt><dd>{shown.hypothesis}</dd>
                          <dt>{t('proj.dx.f.falsifier')}</dt><dd>{shown.falsifier}</dd>
                          <dt>{t('proj.dx.f.frame')}</dt><dd data-testid={`step-dx-frame-${i.id}`} data-frame={shown.frame}>{t(`proj.dx.frame.${shown.frame}`)}{' · '}{t(`proj.dx.control.${shown.control}`)}</dd>
                          <dt>{t('proj.dx.f.reason')}</dt><dd>{shown.reason}</dd>
                        </dl>
                      )}
                      {confirmed && <p className="muted">{savedBy(confirmed)}</p>}
                      {confirmed && drafted && !sameFraming(confirmed, drafted) && <p className="muted" data-testid={`step-dx-differs-${i.id}`}>{t('proj.dx.draftDiffers', { question: drafted.question })}</p>}
                      {warnings.length > 0 && (
                        <ul className="dx-warnings" data-testid={`step-dx-warnings-${i.id}`}>
                          {warnings.map((w) => <li key={w} data-warning={w}>{t(`proj.dx.warn.${w}`, { feasibility: i.feasibility })}</li>)}
                        </ul>
                      )}
                    </td>
                    <td>
                      {drafted && (!confirmed || !sameFraming(confirmed, drafted)) && (
                        <Button size="small" appearance="subtle" onClick={() => approve([`issue:${i.id}`], true)} aria-label={`${t('proj.dx.approve')}: ${nameOf(i.id)}`} data-testid={`step-dx-approve-${i.id}`}>{t('proj.dx.approve')}</Button>
                      )}
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setEditing(`issue:${i.id}`)} aria-label={`${t('proj.dx.edit')}: ${nameOf(i.id)}`} data-testid={`step-dx-edit-${i.id}`}>{t('proj.dx.edit')}</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {editIssue && (
        <FramingDialog name={nameOf(editIssue.id)} initial={data.framings?.[editIssue.id] ?? draft?.issues[editIssue.id]} onClose={() => setEditing(null)}
          onSave={(f) => { write((d) => setFraming(d, editIssue.id, { ...f, origin: 'human', ...meta() })); setEditing(null); }}
          onClear={data.framings?.[editIssue.id] ? () => { write((d) => setFraming(d, editIssue.id, null)); setEditing(null); } : undefined} />
      )}
    </Panel>
  );
}

type FramingCore = Omit<DraftFraming, 'origin'>;
const sameFraming = (a: FramingCore, b: FramingCore) =>
  a.question === b.question && a.owner === b.owner && a.hypothesis === b.hypothesis && a.falsifier === b.falsifier && a.frame === b.frame && a.control === b.control && a.reason === b.reason;

function IssueData({ ctx, i, nameOf, sep }: { ctx: CheckContext; i: IssueEvidence; nameOf: (id: string) => string; sep: string }) {
  const { t, fmt, lang } = useI18n();
  return (
    <ul className="dx-data">
      <li>{t('proj.dx.d.rating', { impact: i.impact, feasibility: i.feasibility })}{i.provisional ? ` ${t('proj.tri.provisional')}` : ''}</li>
      <li>{t('proj.dx.d.disposition', { disposition: t(`proj.tri.disp.${i.disposition}`), urgency: t(`proj.tri.urgency.${i.urgency ?? 'unrated'}`), growth: t(`proj.tri.growth.${i.growth}`) })}</li>
      {i.kpiIds.map((id) => {
        const k = ctx.pack.byId.get(id) as EntityOf<'kpi'>;
        return <li key={id}>{t('proj.dx.d.kpi', { name: nameOf(id), baseline: fmt.number(k.baseline), current: fmt.number(k.current), target: fmt.number(k.target), unit: loc(k.unit, lang) })}</li>;
      })}
      {i.kpiIds.length === 0 && <li>{t('proj.dx.d.noKpi')}</li>}
      <li>{i.causeIds.length ? t('proj.dx.d.causes', { names: i.causeIds.map(nameOf).join(sep) }) : t('proj.dx.d.noCause')}</li>
      <li>{t('proj.dx.d.sources', { n: i.sourceCount })}</li>
    </ul>
  );
}

type Write = (fn: (d: DeliverableData) => DeliverableData) => void;
interface SectionProps {
  ctx: CheckContext;
  ev: ReturnType<typeof diagnosisEvidence>;
  draft: SavedDiagnosis | undefined;
  kindOf: (c: { origin: JudgmentOrigin } | undefined, d: { origin: DraftOrigin } | undefined) => StateKind;
  savedBy: (x: { at: string; by: string }) => string;
  onApprove: () => void;
  write: Write;
  nameOf: (id: string) => string;
  sep: string;
}

function SituationSection({ ctx, ev, draft, kindOf, savedBy, onApprove, write, nameOf, sep }: SectionProps) {
  const { t } = useI18n();
  const confirmed = ctx.deliverables.situation;
  const drafted = draft?.situation;
  const [type, setType] = useState<Situation | ''>(confirmed?.type ?? '');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const worsening = ev.kpis.filter((k) => k.trend === 'worsening').map((k) => nameOf(k.id));
  const save = () => {
    setTried(true);
    if (!type || !reason.trim()) return;
    write((d) => setSituation(d, { type, reason: reason.trim(), origin: 'human', by: editor(), at: new Date().toISOString() }));
    setReason('');
    setTried(false);
  };
  return (
    <section className="prio-block" aria-labelledby="dx-situation" data-testid="step-dx-situation" data-confirmed={confirmed?.type ?? 'none'} data-draft={drafted?.type ?? 'none'} data-cycle={ev.triage.cycle}>
      <h4 id="dx-situation" className="prio-label">{t('proj.dx.situationLabel')}</h4>
      <p className="muted">{t('proj.dx.situationLead')}</p>
      <dl className="dx-evidence" data-testid="step-dx-situation-evidence">
        <dt>{t('proj.dx.e.kpis')}</dt>
        <dd>{t('proj.dx.e.kpisValue', { worsening: ev.trendCounts.worsening, flat: ev.trendCounts.flat, improving: ev.trendCounts.improving, unknown: ev.trendCounts.unknown })}{worsening.length ? ` ${t('proj.dx.e.worseningNames', { names: worsening.join(sep) })}` : ''}</dd>
        <dt>{t('proj.dx.e.swot')}</dt>
        <dd>{ev.swot ? t(`proj.dx.swot.${ev.swot.strategy}`) : t('proj.dx.e.noSwot')}</dd>
        <dt>{t('proj.dx.e.triage')}</dt>
        <dd>{t('proj.dx.e.triageValue', { act: ev.triage.counts.act, plan: ev.triage.counts.plan, unassessed: ev.triage.counts.unassessed, gated: ev.triage.gated.length })}</dd>
        <dt>{t('proj.dx.e.cycle')}</dt>
        <dd data-testid="step-dx-cycle">{t('proj.dx.e.cycleValue', { n: ev.triage.cycle })}</dd>
      </dl>
      <table className="data-table compact">
        <thead><tr><th scope="col">{t('proj.dx.col.situation')}</th><th scope="col">{t('proj.dx.col.meaning')}</th><th scope="col" className="num">{t('proj.dx.col.cycle')}</th><th scope="col">{t('proj.dx.col.state')}</th></tr></thead>
        <tbody>
          {SITUATIONS.map((s) => (
            <tr key={s} data-testid={`step-dx-situation-${s}`}>
              <th scope="row">{t(`proj.dx.sit.${s}`)}</th>
              <td>{t(`proj.dx.sit.${s}.def`)}</td>
              <td className="num">{SITUATION_CYCLE_MONTHS[s]}</td>
              <td>
                {confirmed?.type === s && <StateBadge kind={kindOf(confirmed, undefined)} />}
                {drafted?.type === s && <>{' '}<StateBadge kind={kindOf(undefined, drafted)} /></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirmed && <p data-testid="step-dx-situation-confirmed">{t('proj.dx.confirmedAs', { value: t(`proj.dx.sit.${confirmed.type}`), reason: confirmed.reason })}{' '}<span className="muted">{savedBy(confirmed)}</span></p>}
      {drafted && (!confirmed || confirmed.type !== drafted.type || confirmed.reason !== drafted.reason) && (
        <p data-testid="step-dx-situation-draft">
          {t('proj.dx.draftAs', { value: t(`proj.dx.sit.${drafted.type}`), reason: drafted.reason })}{' '}
          <Button size="small" appearance="subtle" onClick={onApprove} data-testid="step-dx-approve-situation">{t('proj.dx.approve')}</Button>
        </p>
      )}
      <details className="dec-edit" data-testid="step-dx-situation-own">
        <summary>{t('proj.dx.own')}</summary>
        <Field label={t('proj.dx.situationLabel')} validationState={tried && !type ? 'error' : 'none'} validationMessage={tried && !type ? t('proj.qualify.required') : undefined}>
          <RadioGroup value={type} onChange={(_, d) => setType(d.value as Situation)} data-testid="step-dx-situation-choice">
            {SITUATIONS.map((s) => <Radio key={s} value={s} label={t(`proj.dx.sit.${s}`)} />)}
          </RadioGroup>
        </Field>
        <Field label={t('proj.dx.f.reason')} required validationState={tried && !reason.trim() ? 'error' : 'none'} validationMessage={tried && !reason.trim() ? t('proj.qualify.required') : undefined}>
          <Textarea value={reason} onChange={(_, d) => setReason(d.value)} rows={2} resize="vertical" data-testid="step-dx-situation-reason" />
        </Field>
        <Button appearance="primary" onClick={save} data-testid="step-dx-situation-save">{t('proj.save')}</Button>
        {confirmed && <Button onClick={() => write((d) => setSituation(d, null))} data-testid="step-dx-situation-clear">{t('proj.dx.clear')}</Button>}
      </details>
    </section>
  );
}

function CruxSection({ ctx, ev, draft, kindOf, savedBy, onApprove, write, nameOf, sep }: SectionProps) {
  const { t } = useI18n();
  const confirmed = ctx.deliverables.crux;
  const drafted = draft?.crux;
  const causes = [...new Set(ev.issues.flatMap((i) => i.causeIds))];
  const [causeId, setCauseId] = useState('');
  const [reason, setReason] = useState('');
  const [addressable, setAddressable] = useState('');
  const [tried, setTried] = useState(false);
  const save = () => {
    setTried(true);
    if (!causeId || !reason.trim() || !addressable.trim()) return;
    const issueIds = ev.issues.filter((i) => i.causeIds.includes(causeId)).map((i) => i.id);
    write((d) => setCrux(d, { causeId, name: nameOf(causeId), issueIds, reason: reason.trim(), addressable: addressable.trim(), origin: 'human', by: editor(), at: new Date().toISOString() }));
    setTried(false);
  };
  const cruxText = (c: { name: string; issueIds: string[]; reason: string; addressable: string }) =>
    t('proj.dx.cruxValue', { name: c.name, issues: c.issueIds.map(nameOf).join(sep), reason: c.reason, addressable: c.addressable });
  return (
    <section className="prio-block" aria-labelledby="dx-crux" data-testid="step-dx-crux" data-confirmed={confirmed?.causeId ?? (confirmed ? 'hypothesis' : 'none')} data-shared={ev.shared.length}>
      <h4 id="dx-crux" className="prio-label">{t('proj.dx.cruxLabel')}</h4>
      <p className="muted">{t('proj.dx.cruxLead')}</p>
      {ev.shared.length === 0 ? <p data-testid="step-dx-noshared">{t('proj.dx.noShared')}</p> : (
        <table className="data-table compact" data-testid="step-dx-shared">
          <thead><tr>
            <th scope="col">{t('proj.dx.col.cause')}</th><th scope="col">{t('proj.dx.col.issues')}</th>
            <th scope="col" className="num">{t('proj.dx.col.impactSum')}</th><th scope="col" className="num">{t('proj.dx.col.pressing')}</th><th scope="col">{t('proj.dx.col.sourced')}</th>
          </tr></thead>
          <tbody>
            {ev.shared.map((s) => (
              <tr key={s.causeId} data-testid={`step-dx-shared-${s.causeId}`}>
                <th scope="row"><EntityRef id={s.causeId} /></th>
                <td>{s.issueIds.map(nameOf).join(sep)}</td>
                <td className="num">{s.impactSum}</td><td className="num">{s.pressing}</td>
                <td>{t(s.sourced ? 'proj.dx.yes' : 'proj.dx.no')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirmed && <p data-testid="step-dx-crux-confirmed"><StateBadge kind={kindOf(confirmed, undefined)} />{' '}{cruxText(confirmed)}{' '}<span className="muted">{savedBy(confirmed)}</span></p>}
      {drafted && (!confirmed || confirmed.name !== drafted.name || confirmed.reason !== drafted.reason) && (
        <p data-testid="step-dx-crux-draft">
          <StateBadge kind={kindOf(undefined, drafted)} />{' '}{cruxText(drafted)}{!drafted.causeId && ` ${t('proj.dx.cruxHypothesis')}`}{' '}
          <Button size="small" appearance="subtle" onClick={onApprove} data-testid="step-dx-approve-crux">{t('proj.dx.approve')}</Button>
        </p>
      )}
      {causes.length > 0 && (
        <details className="dec-edit" data-testid="step-dx-crux-own">
          <summary>{t('proj.dx.own')}</summary>
          <Field label={t('proj.dx.col.cause')} validationState={tried && !causeId ? 'error' : 'none'} validationMessage={tried && !causeId ? t('proj.qualify.required') : undefined}>
            <Select value={causeId} onChange={(_, d) => setCauseId(d.value)} data-testid="step-dx-crux-cause">
              <option value="">{t('proj.dx.choose')}</option>
              {causes.map((c) => <option key={c} value={c}>{nameOf(c)}</option>)}
            </Select>
          </Field>
          <Field label={t('proj.dx.f.cruxReason')} required validationState={tried && !reason.trim() ? 'error' : 'none'} validationMessage={tried && !reason.trim() ? t('proj.qualify.required') : undefined}>
            <Textarea value={reason} onChange={(_, d) => setReason(d.value)} rows={2} resize="vertical" data-testid="step-dx-crux-reason" />
          </Field>
          <Field label={t('proj.dx.f.addressable')} required validationState={tried && !addressable.trim() ? 'error' : 'none'} validationMessage={tried && !addressable.trim() ? t('proj.qualify.required') : undefined}>
            <Textarea value={addressable} onChange={(_, d) => setAddressable(d.value)} rows={2} resize="vertical" data-testid="step-dx-crux-addressable" />
          </Field>
          <Button appearance="primary" onClick={save} data-testid="step-dx-crux-save">{t('proj.save')}</Button>
          {confirmed && <Button onClick={() => write((d) => setCrux(d, null))} data-testid="step-dx-crux-clear">{t('proj.dx.clear')}</Button>}
        </details>
      )}
    </section>
  );
}

type FramingInput = Pick<IssueFraming, 'question' | 'owner' | 'hypothesis' | 'falsifier' | 'frame' | 'control' | 'reason'>;
const TEXT_FIELDS = ['question', 'owner', 'hypothesis', 'falsifier', 'reason'] as const;

function FramingDialog({ name, initial, onClose, onSave, onClear }: {
  name: string; initial: FramingInput | undefined; onClose: () => void; onSave: (f: FramingInput) => void; onClear?: () => void;
}) {
  const { t } = useI18n();
  const [f, setF] = useState<FramingInput>(initial ?? { question: '', owner: '', hypothesis: '', falsifier: '', frame: 'threat', control: 'partial', reason: '' });
  const [tried, setTried] = useState(false);
  const missing = (k: (typeof TEXT_FIELDS)[number]) => !f[k].trim() || (k === 'question' && !/[?？]$/.test(f.question.trim()));
  const save = () => {
    setTried(true);
    if (TEXT_FIELDS.some(missing)) return;
    onSave({ ...f, ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, f[k].trim()])) });
  };
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className="form-surface" data-testid="dx-framing-dialog">
        <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
          <DialogBody>
            <DialogTitle>{t('proj.dx.editTitle', { issue: name })}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p className="muted">{t('proj.dx.editLead')}</p>
              {TEXT_FIELDS.map((k) => (
                <Field key={k} label={t(`proj.dx.f.${k}`)} hint={t(`proj.dx.h.${k}`)} required validationState={tried && missing(k) ? 'error' : 'none'}
                  validationMessage={tried && missing(k) ? t(k === 'question' && f.question.trim() ? 'proj.dx.questionMark' : 'proj.qualify.required') : undefined}>
                  <Textarea value={f[k]} onChange={(_, d) => setF({ ...f, [k]: d.value })} rows={2} resize="vertical" data-testid={`dx-f-${k}`} />
                </Field>
              ))}
              <Field label={t('proj.dx.f.frame')}>
                <RadioGroup value={f.frame} onChange={(_, d) => setF({ ...f, frame: d.value as IssueFrame })} layout="horizontal" data-testid="dx-f-frame">
                  {ISSUE_FRAMES.map((x) => <Radio key={x} value={x} label={t(`proj.dx.frame.${x}`)} />)}
                </RadioGroup>
              </Field>
              <Field label={t('proj.dx.f.control')}>
                <RadioGroup value={f.control} onChange={(_, d) => setF({ ...f, control: d.value as IssueControl })} layout="horizontal" data-testid="dx-f-control">
                  {ISSUE_CONTROLS.map((x) => <Radio key={x} value={x} label={t(`proj.dx.control.${x}`)} />)}
                </RadioGroup>
              </Field>
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" data-testid="dx-f-save">{t('proj.save')}</Button>
              {onClear && <Button type="button" onClick={onClear} data-testid="dx-f-clear">{t('proj.dx.clear')}</Button>}
              <Button type="button" onClick={onClose}>{t('proj.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
