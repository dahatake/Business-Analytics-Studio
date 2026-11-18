import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Input, Link, MessageBar, MessageBarBody, Spinner, Switch } from '@fluentui/react-components';
import { Add20Regular, Checkmark20Regular, Delete20Regular, Dismiss20Regular, Sparkle20Regular, Wand20Regular } from '@fluentui/react-icons';
import { aiLive, AiLiveError, preflight } from '../../ai/client.ts';
import { PER_USE_LIMITS } from '../../ai/policy.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { reasonKey, yenFine } from '../ai/AiCommon.tsx';
import { openAiSettings } from '../ai/uiStore.ts';
import '../ai/liveTransport.ts';
import { ScrollRegion } from './common.tsx';
import { newId } from './model.ts';
import type { NameOf } from './stepCharts.tsx';
import { useProjUi, useValueModel } from './stores.ts';
import {
  addActual, addGroup, adoptDraftGroup, adoptDraftLine, adoptDraftRate, adoptDraftReviewed, adoptVerifiedDraft, discardDraftGroup, discardDraftLine, discardDraftRate,
  discardDraftReviewed, dismissSuggestion, normalizeValue, parseValueDraft, removeActual, removeGroup, ruleDraft, setDraft, suggestGroups, valueDraftPrompt,
  type BenefitLine, type BuiltValueModel, type DraftContext, type RealizationSummary, type ValueData, type ValueDraft,
} from './valueModel.ts';

/*
 * FR-335: the app resolves the value model's open items itself. Rules draft what the pack's own figures support; Copilot
 * drafts the rest (AI use valueDraft, D-35). Every drafted number is recomputed by the app before a person adopts it.
 */

type Notice = { intent: 'success' | 'warning' | 'error'; text: string; settings?: boolean };
const by = () => useProjUi.getState().editor.trim();
const MILLION = 1_000_000;

function useWrite() {
  const set = useValueModel((s) => s.set);
  return (fn: (d: ValueData) => ValueData) => set((prev) => fn(normalizeValue(prev)));
}

/* ---------- Draft: Copilot and rules ---------- */

export function DraftBar({ draftCtx, scope }: { draftCtx: DraftContext; scope: string }) {
  const { t, lang } = useI18n();
  const write = useWrite();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abort.current?.abort(); };
  }, []);
  const request = { use: 'valueDraft' as const, lang, prompt: valueDraftPrompt(draftCtx), scope, maxOutputTokens: PER_USE_LIMITS.valueDraft?.maxOutputTokens };
  const estimate = preflight(request);
  const cost = estimate.estimatedCostJpy === null ? t('val.draft.costUnknown') : yenFine(lang === 'ja' ? 'ja-JP' : 'en-US', estimate.estimatedCostJpy);
  const summarize = (d: ValueDraft) => {
    const unverified = d.lines.filter((l) => l.provenance?.status === 'unverified').length;
    const parts = [
      t('val.draft.made', { lines: d.lines.length, reviewed: d.reviewed.length, groups: d.groups.length }),
      unverified ? t('val.draft.unverifiedN', { n: unverified }) : '',
      d.overclaim.length ? t('val.draft.overclaimN', { n: d.overclaim.length }) : '',
      d.rejected.length ? t('val.draft.rejectedN', { n: d.rejected.length }) : '',
    ].filter(Boolean);
    setNotice({ intent: d.lines.length + d.reviewed.length + d.groups.length > 0 || d.discountRate ? (unverified || d.overclaim.length ? 'warning' : 'success') : 'warning', text: parts.join(' ') });
  };
  const latest = (): DraftContext => ({ ...draftCtx, data: normalizeValue(useValueModel.getState().value), at: new Date().toISOString() });
  const rules = () => {
    const d = ruleDraft(latest());
    write((x) => setDraft(x, d));
    summarize(d);
  };
  const copilot = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const pf = preflight(request);
      if (!pf.allowed) throw new AiLiveError(pf.reasons, pf.budget.reasons.join(', '), pf.budget);
      abort.current = new AbortController();
      const result = await aiLive(request, abort.current.signal);
      if (!alive.current || useValueModel.getState().scope !== scope) return;
      let d: ValueDraft;
      try { d = parseValueDraft(result.text, latest(), 'copilot'); } catch { throw new Error(t('val.draft.badAnswer')); }
      write((x) => setDraft(x, d));
      summarize(d);
    } catch (e) {
      if (!alive.current) return;
      const blocked = e instanceof AiLiveError && e.reasons.some((r) => r !== 'liveFailed');
      const detail = e instanceof AiLiveError ? `${e.reasons.map((r) => t(reasonKey(r))).join(', ')}${e.message ? `: ${e.message}` : ''}` : e instanceof Error ? e.message : String(e);
      setNotice({ intent: 'error', text: `${t('val.draft.aiError')} ${detail}`, settings: blocked });
    } finally {
      abort.current = null;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="val-section val-resolve" aria-labelledby="val-resolve-title" data-testid="val-resolve">
      <h3 id="val-resolve-title" className="step-chart-title">{t('val.draft.title')}</h3>
      <p className="step-chart-read muted">{t('val.draft.read')}</p>
      <div className="proj-row" role="toolbar" aria-label={t('val.draft.title')}>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={busy} onClick={() => void copilot()} data-testid="val-draft-copilot">{t('val.draft.copilot')}</Button>
        <Button icon={<Wand20Regular />} disabled={busy} onClick={rules} data-testid="val-draft-rules">{t('val.draft.rules')}</Button>
        {busy && <Button onClick={() => abort.current?.abort()}>{t('proj.cancel')}</Button>}
      </div>
      <p className="muted" data-testid="val-draft-hint">{t('val.draft.hint', { cost })}</p>
      {notice && (
        <MessageBar intent={notice.intent} data-testid="val-draft-notice">
          <MessageBarBody>
            {notice.text}
            {notice.settings && <> <Link onClick={openAiSettings}>{t('val.draft.openSettings')}</Link></>}
          </MessageBarBody>
        </MessageBar>
      )}
    </section>
  );
}

const STATUS_COLOR = { derived: 'success', assumed: 'warning', unverified: 'danger', noNumber: 'informative' } as const;

export function DraftReview({ data, nameOf, kpiName }: { data: ValueData; nameOf: NameOf; kpiName: (id: string) => string | null }) {
  const { t, lang, fmt } = useI18n();
  const write = useWrite();
  const d = data.draft;
  if (!d) return null;
  const at = new Date().toISOString();
  const label = (l: BenefitLine) => loc(l.label, lang);
  const lineName = (id: string) => {
    const l = [...d.lines, ...data.benefits].find((x) => x.id === id);
    return l ? label(l) : id;
  };
  const verifiedN = d.lines.filter((l) => l.provenance?.status !== 'unverified').length;
  return (
    <section className="val-section val-draft" aria-labelledby="val-draft-review-title" data-testid="val-draft">
      <h3 id="val-draft-review-title" className="step-chart-title">{t(d.by === 'copilot' ? 'val.draft.reviewCopilot' : 'val.draft.reviewRules')}</h3>
      <p className="step-chart-read muted">{t('val.draft.reviewRead')}</p>
      <div className="proj-row">
        <Button appearance="primary" icon={<Checkmark20Regular />} disabled={verifiedN + d.reviewed.length + d.groups.length === 0 && !d.discountRate?.grounded} onClick={() => write((x) => adoptVerifiedDraft(x, by(), at))} data-testid="val-draft-adopt-all">{t('val.draft.adoptVerified')}</Button>
        <Button icon={<Dismiss20Regular />} onClick={() => write((x) => setDraft(x, null))} data-testid="val-draft-discard">{t('val.draft.discard')}</Button>
      </div>
      {d.overclaim.length > 0 && (
        <MessageBar intent="warning" data-testid="val-draft-overclaim"><MessageBarBody>{t('val.draft.overclaim', { names: d.overclaim.map(nameOf).join(', ') })}</MessageBarBody></MessageBar>
      )}
      {d.lines.length > 0 && (
        <ul className="val-draft-list" aria-label={t('val.draft.lines')}>
          {d.lines.map((l) => {
            const p = l.provenance;
            return (
              <li key={l.id} data-testid={`val-draft-line-${l.id}`} data-status={p?.status}>
                <div className="val-draft-head">
                  <strong>{label(l)}</strong>
                  <span className="muted">{`${nameOf(l.solutionId)} · ${t(`val.driver.${l.sign === 'disbenefit' ? 'disbenefit' : l.lever}` as MessageKey)} · ${t(`val.nature.${l.nature}` as MessageKey)}`}</span>
                  {p && <Badge appearance="tint" color={STATUS_COLOR[p.status]}>{t(`val.prov.${p.status}` as MessageKey)}</Badge>}
                </div>
                {l.amountJpy && (
                  <p className="muted">
                    {`${t('val.col.amount')}: ${[l.amountJpy.low, l.amountJpy.mode, l.amountJpy.high].map(fmt.yenCompact).join(' – ')}${l.timing === 'oneOff' ? ` ${t('val.timing.oneOffShort')}` : ''}`}
                    {` · ${t('val.form.conversion')}: ${[l.conversion.low, l.conversion.mode, l.conversion.high].map(fmt.percent).join(' – ')}`}
                    {l.kpiId ? ` · ${t('val.form.kpi')}: ${kpiName(l.kpiId) ?? l.kpiId}` : ''}
                  </p>
                )}
                {p && p.formula && (
                  <p className="val-formula">
                    <code>{p.formula}</code>{' '}
                    {p.inputs.map((i) => (
                      <span key={i.name} className="val-input" data-verified={i.verified}>
                        {`${i.name} = ${Math.abs(i.value) < 10 ? String(Math.round(i.value * 10_000) / 10_000) : fmt.number(i.value)} `}
                        <Badge size="small" appearance="outline" color={i.verified ? 'success' : i.ref ? 'danger' : 'warning'}>
                          {i.verified ? t('val.prov.fact', { ref: i.ref ?? '' }) : i.ref ? t('val.prov.mismatch', { ref: i.ref }) : t('val.prov.assumption')}
                        </Badge>
                      </span>
                    ))}
                  </p>
                )}
                {p && loc(p.rationale, lang) && <p className="muted">{loc(p.rationale, lang)}</p>}
                <div className="proj-row">
                  <Button size="small" icon={<Checkmark20Regular />} onClick={() => write((x) => adoptDraftLine(x, l.id))} data-testid={`val-draft-adopt-${l.id}`}>{t('val.draft.adopt')}</Button>
                  <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => write((x) => discardDraftLine(x, l.id))} data-testid={`val-draft-drop-${l.id}`}>{t('val.draft.drop')}</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {d.reviewed.length > 0 && (
        <ul className="val-list" aria-label={t('val.draft.reviewed')}>
          {d.reviewed.map((r, i) => (
            <li key={`${r.solutionId}:${r.column}`} data-testid={`val-draft-reviewed-${r.solutionId}-${r.column}`}>
              <Badge appearance="outline">{t('val.cell.reviewed')}</Badge>
              <span>{`${nameOf(r.solutionId)} · ${t(`val.column.${r.column}` as MessageKey)}`}</span>
              <span className="muted">{r.reason}</span>
              <Button size="small" icon={<Checkmark20Regular />} onClick={() => write((x) => adoptDraftReviewed(x, i))}>{t('val.draft.adopt')}</Button>
              <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => write((x) => discardDraftReviewed(x, i))}>{t('val.draft.drop')}</Button>
            </li>
          ))}
        </ul>
      )}
      {d.groups.length > 0 && (
        <ul className="val-list" aria-label={t('val.draft.groups')}>
          {d.groups.map((g, i) => (
            <li key={`${g.name}-${i}`} data-testid={`val-draft-group-${i}`}>
              <Badge appearance="outline" color="informative">{t('val.corr.groupBadge', { rho: fmt.number(g.rho) })}</Badge>
              <span>{g.lineIds.map(lineName).join(' / ')}</span>
              <span className="muted">{g.reason}</span>
              <Button size="small" icon={<Checkmark20Regular />} onClick={() => write((x) => adoptDraftGroup(x, i, by(), at))}>{t('val.draft.adopt')}</Button>
              <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => write((x) => discardDraftGroup(x, i))}>{t('val.draft.drop')}</Button>
            </li>
          ))}
        </ul>
      )}
      {d.discountRate && (
        <div className="val-list" data-testid="val-draft-rate">
          <span>{t('val.draft.rate', { value: fmt.percent(d.discountRate.value) })}</span>{' '}
          <Badge appearance="tint" color={d.discountRate.grounded ? 'success' : 'warning'}>{t(d.discountRate.grounded ? 'val.draft.rateGrounded' : 'val.draft.rateUngrounded')}</Badge>{' '}
          <span className="muted">{d.discountRate.rationale}</span>{' '}
          <Button size="small" icon={<Checkmark20Regular />} onClick={() => write(adoptDraftRate)} data-testid="val-draft-rate-adopt">{t('val.draft.adopt')}</Button>
          <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => write(discardDraftRate)}>{t('val.draft.drop')}</Button>
        </div>
      )}
    </section>
  );
}

/* ---------- Correlation groups ---------- */

export function GroupsSection({ data, built, lineLabel }: { data: ValueData; built: BuiltValueModel; lineLabel: (id: string) => string }) {
  const { t, fmt } = useI18n();
  const write = useWrite();
  const suggestions = suggestGroups(data, built);
  const [rho, setRho] = useState<Record<string, string>>({});
  if (suggestions.length === 0 && data.groups.length === 0) return null;
  return (
    <div className="val-groups" data-testid="val-groups">
      {suggestions.map((s) => {
        const v = rho[s.key] ?? '';
        const ok = v.trim() !== '' && Number(v) >= 0 && Number(v) <= 1;
        return (
          <div key={s.key} className="val-list" data-testid={`val-group-suggest-${s.kpiId}`}>
            <span>{t('val.corr.suggest', { lines: s.lineIds.map(lineLabel).join(' / ') })}</span>
            <Field label={t('val.corr.rho')} validationState={v && !ok ? 'error' : 'none'}>
              <Input type="number" min={0} max={1} step={0.1} value={v} onChange={(_, d) => setRho({ ...rho, [s.key]: d.value })} data-testid={`val-group-rho-${s.kpiId}`} />
            </Field>
            <Button size="small" icon={<Add20Regular />} disabled={!ok} onClick={() => write((x) => addGroup(x, { id: newId('vg'), name: s.kpiId, rho: Number(v), lineIds: s.lineIds, note: '', at: new Date().toISOString(), by: by() }))} data-testid={`val-group-add-${s.kpiId}`}>{t('val.corr.add')}</Button>
            <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => write((x) => dismissSuggestion(x, s.key))}>{t('val.links.dismiss')}</Button>
          </div>
        );
      })}
      {data.groups.length > 0 && (
        <ul className="val-list" aria-label={t('val.corr.groups')}>
          {data.groups.map((g) => (
            <li key={g.id} data-testid={`val-group-${g.id}`}>
              <Badge appearance="filled" color="brand">{t('val.corr.groupBadge', { rho: fmt.number(g.rho) })}</Badge>
              <span>{g.lineIds.map(lineLabel).join(' / ')}</span>
              <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => write((x) => removeGroup(x, g.id))} aria-label={t('val.corr.remove')} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Benefits realisation ---------- */

export function RealizationSection({ data, summary, today, nameOf, lineLabel, apply, onApply }: {
  data: ValueData; summary: RealizationSummary; today: string; nameOf: NameOf; lineLabel: (id: string) => string; apply: boolean; onApply: (v: boolean) => void;
}) {
  const { t, fmt } = useI18n();
  const write = useWrite();
  const { actuals } = data;
  const [form, setForm] = useState<{ lineId: string; date: string; amount: string } | null>(null);
  if (summary.rows.length === 0) return null;
  const ok = form && /^\d{4}-\d{2}-\d{2}$/.test(form.date) && form.date <= today && form.amount.trim() !== '' && Number(form.amount) >= 0;
  const save = () => {
    if (!form || !ok) return;
    write((x) => addActual(x, { id: newId('va'), lineId: form.lineId, date: form.date, amountJpy: Number(form.amount) * MILLION, note: '', at: new Date().toISOString(), by: by() }));
    setForm(null);
  };
  const ratio = (v: number | null) => (v === null ? '–' : fmt.percent(v));
  return (
    <section className="val-section" aria-labelledby="val-real-title" data-testid="val-realization">
      <h3 id="val-real-title" className="step-chart-title">
        {summary.factor === null ? t('val.real.titleNone') : t(summary.basis === 'actual' ? 'val.real.title' : 'val.real.titleProxy', { factor: fmt.percent(summary.factor), n: summary.n })}
      </h3>
      <p className="step-chart-read muted">{t('val.real.read')}</p>
      {summary.coverage !== null && <p data-testid="val-real-coverage">{t('val.real.coverage', { p: fmt.percent(summary.coverage) })}</p>}
      <Switch checked={apply} disabled={summary.factor === null} onChange={(_, d) => onApply(d.checked)} label={t('val.real.apply')} data-testid="val-real-apply" />
      <ScrollRegion label={t('val.real.table')}>
        <table className="data-table compact">
          <thead><tr>
            <th scope="col">{t('val.form.label')}</th>
            <th scope="col" className="num">{t('val.real.planned')}</th>
            <th scope="col" className="num">{t('val.real.actual')}</th>
            <th scope="col" className="num">{t('val.real.ratio')}</th>
            <th scope="col" className="num">{t('val.real.proxy')}</th>
            <th scope="col">{t('val.col.actions')}</th>
          </tr></thead>
          <tbody>
            {summary.rows.map((r) => {
              const mine = actuals.filter((a) => a.lineId === r.lineId).sort((a, b) => b.date.localeCompare(a.date));
              return (
                <tr key={r.lineId} data-line={r.lineId} data-in-range={r.inRange === null ? undefined : String(r.inRange)}>
                  <th scope="row">{lineLabel(r.lineId)} <span className="muted">{nameOf(r.solutionId)}</span></th>
                  <td className="num">{r.planned ? `${fmt.yenCompact(r.planned.mode)} (${fmt.yenCompact(r.planned.low)} – ${fmt.yenCompact(r.planned.high)})` : t('val.real.noStart')}</td>
                  <td className="num">{r.actual ? `${fmt.yenCompact(r.actual.amountJpy)} (${fmt.date(r.actual.date)})` : '–'}</td>
                  <td className="num">{ratio(r.ratio)}</td>
                  <td className="num">{ratio(r.proxy)}</td>
                  <td>
                    <Button size="small" icon={<Add20Regular />} onClick={() => setForm({ lineId: r.lineId, date: today, amount: '' })} data-testid={`val-real-add-${r.lineId}`} aria-label={t('val.real.add', { name: lineLabel(r.lineId) })} />
                    {mine[0] && <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => write((x) => removeActual(x, mine[0]!.id))} aria-label={t('val.real.remove', { name: lineLabel(r.lineId) })} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      {form && (
        <form className="val-form" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={t('val.real.form', { name: lineLabel(form.lineId) })} data-testid="val-real-form">
          <div className="proj-kpi-fields">
            <Field label={t('val.real.date')}><Input type="date" value={form.date} max={today} onChange={(_, d) => setForm({ ...form, date: d.value })} data-testid="val-real-date" /></Field>
            <Field label={t('val.real.amount')} hint={t('val.real.amountHint')}><Input type="number" min={0} value={form.amount} onChange={(_, d) => setForm({ ...form, amount: d.value })} data-testid="val-real-amount" /></Field>
          </div>
          <div className="proj-row">
            <Button type="submit" appearance="primary" disabled={!ok} data-testid="val-real-save">{t('proj.save')}</Button>
            <Button onClick={() => setForm(null)}>{t('proj.cancel')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
