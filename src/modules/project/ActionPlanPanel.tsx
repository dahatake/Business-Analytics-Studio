import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarBody, SpinButton } from '@fluentui/react-components';
import { ArrowDownload20Regular, DocumentText20Regular, Edit20Regular, FolderArrowRight20Regular } from '@fluentui/react-icons';
import type { EntityOf } from '../../data/schema.ts';
import { DeviceStorageError, saveProjectFile } from '../../data/deviceStorage.ts';
import { useI18n } from '../../i18n/index.ts';
import { Panel } from '../../ui/Panel.tsx';
import { EntityRef } from '../../ui/EntityRef.tsx';
import {
  ACTION_TYPES, addWeeks, DEFAULT_WEEKS, inferActions, isDevType, requirementsFileName, safeFileStem, scheduleActions,
  visibleSolutions, type ActionDef, type ActionPatch, type ActionsBySolution, type ActionType,
} from './actionPlan.ts';
import { normalizeActionPlan, normalizeWhatIf, useActionPlan, useWhatIf, type ActionPlanData } from './cockpitStore.ts';
import { ConfirmDialog, downloadText, ScrollRegion, useTargetNames } from './common.tsx';
import type { AppCheckContext } from './deliverables.ts';
import { buildProductionDoc } from './productionRequirements.ts';
import { ChartFigure, type NameOf } from './stepCharts.tsx';
import { solutionType } from './strategy.ts';
import { rank, type Candidate } from './whatIf.ts';
import './cockpit.css';

type Visible = (id: string) => boolean;
type Plan = ActionPlanData;

function useSolutions(ctx: AppCheckContext, visible: Visible): EntityOf<'solution'>[] {
  return useMemo(() => visibleSolutions(ctx.pack.pack.entities, visible), [ctx, visible]);
}

/** Actions of every solution: a person's list when there is one, else the inferred kinds. */
function useActions(ctx: AppCheckContext, solutions: EntityOf<'solution'>[], plan: Plan): ActionsBySolution {
  const { lang } = useI18n();
  return useMemo(() => Object.fromEntries(solutions.map((s) => [s.id, plan.actions[s.id] ?? inferActions(s, solutionType(s, ctx.strategy).type, lang)])), [ctx, solutions, plan, lang]);
}

/** The solutions in the plan, in priority order of the current solution scenario. */
function usePlanOrder(cands: Candidate[], plan: Plan): { order: string[]; lanes: number | null; ranking: ReturnType<typeof rank>; scenarioName: string } {
  const raw = useWhatIf((s) => s.value);
  const scenario = useMemo(() => normalizeWhatIf(raw).solution.current, [raw]);
  const ranking = useMemo(() => rank(cands, scenario), [cands, scenario]);
  const chosen = plan.selected ? new Set(plan.selected) : new Set(ranking.funded);
  return { order: ranking.rows.filter((r) => chosen.has(r.id)).map((r) => r.id), lanes: scenario.maxItems, ranking, scenarioName: scenario.name };
}

function TypeBadges({ actions }: { actions: ActionDef[] }) {
  const { t } = useI18n();
  return (
    <span className="ck-types">
      {actions.map((a) => (
        <Badge key={a.type} size="medium" appearance={isDevType(a.type) ? 'tint' : 'outline'} color={isDevType(a.type) ? 'brand' : 'informative'} data-type={a.type} data-origin={a.origin}>
          {t(`ck.type.${a.type}`)}
        </Badge>
      ))}
    </span>
  );
}

/** Step 5 decision data: every solution with the kinds of action it needs, and whether it is in the plan. */
export function SolutionActionsPanel({ ctx, visible, nameOf, cands }: { ctx: AppCheckContext; visible: Visible; nameOf: NameOf; cands: Candidate[] }) {
  const { t, lang } = useI18n();
  const raw = useActionPlan((s) => s.value);
  const setPlan = useActionPlan((s) => s.set);
  const plan = useMemo(() => normalizeActionPlan(raw), [raw]);
  const solutions = useSolutions(ctx, visible);
  const actions = useActions(ctx, solutions, plan);
  const { order, ranking } = usePlanOrder(cands, plan);
  const [editing, setEditing] = useState<string | null>(null);
  const inPlan = new Set(order);
  const write = (fn: (p: Plan) => Plan) => setPlan((v) => fn(normalizeActionPlan(v)));
  const toggleSolution = (id: string, on: boolean) => write((p) => {
    const current = p.selected ?? order;
    return { ...p, selected: on ? [...new Set([...current, id])] : current.filter((x) => x !== id) };
  });
  const toggleType = (s: EntityOf<'solution'>, type: ActionType, on: boolean) => write((p) => {
    const list = p.actions[s.id] ?? inferActions(s, solutionType(s, ctx.strategy).type, lang);
    const next = on ? [...list, { type, origin: 'user' as const, reason: '' }] : list.filter((a) => a.type !== type);
    return { ...p, actions: { ...p.actions, [s.id]: ACTION_TYPES.filter((x) => next.some((a) => a.type === x)).map((x) => next.find((a) => a.type === x)!) } };
  });
  const rankOf = new Map(ranking.rows.map((r) => [r.id, r]));
  const dev = solutions.reduce((a, s) => a + (actions[s.id] ?? []).filter((x) => isDevType(x.type)).length, 0);
  return (
    <Panel title={t('ck.sol.title')} rationale="ck.sol.why" testId="ck-solutions" className="span-full">
      <p className="ck-chart-title" data-testid="ck-solutions-title">{t('ck.sol.headline', { n: solutions.length, dev, plan: order.length })}</p>
      <p className="muted ck-small">{t('ck.sol.read')}</p>
      {solutions.length === 0 ? <p className="muted">{t('ck.sol.empty')}</p> : (
        <ScrollRegion label={t('ck.sol.title')}>
          <table className="data-table compact ck-sol-table">
            <thead><tr>
              <th scope="col">{t('ck.sol.col.plan')}</th>
              <th scope="col" className="num">{t('ck.sol.col.rank')}</th>
              <th scope="col">{t('ck.sol.col.solution')}</th>
              <th scope="col">{t('ck.sol.col.types')}</th>
              <th scope="col">{t('ck.sol.col.edit')}</th>
            </tr></thead>
            <tbody>
              {solutions.map((s) => {
                const r = rankOf.get(s.id);
                const list = actions[s.id] ?? [];
                return (
                  <tr key={s.id} data-solution={s.id} data-in-plan={inPlan.has(s.id)}>
                    <td>
                      <Checkbox checked={inPlan.has(s.id)} onChange={(_, d) => toggleSolution(s.id, !!d.checked)}
                        aria-label={t('ck.sol.include', { name: nameOf(s.id) })} data-testid={`ck-sol-include-${s.id}`} />
                    </td>
                    <td className="num">{r && !r.excluded ? r.rank : '—'}</td>
                    <th scope="row"><EntityRef id={s.id} /></th>
                    <td data-testid={`ck-sol-types-${s.id}`}>
                      <TypeBadges actions={list} />
                      {list.filter((a) => a.origin === 'inferred' && !['type', 'adoption', 'default'].includes(a.reason)).length > 0 && (
                        <span className="muted ck-small ck-reasons">
                          {t('ck.sol.reasons', { list: list.filter((a) => a.origin === 'inferred' && !['type', 'adoption', 'default'].includes(a.reason)).map((a) => `${t(`ck.type.${a.type}`)}: ${a.reason}`).join(lang === 'ja' ? '、' : ', ') })}
                        </span>
                      )}
                      {editing === s.id && (
                        <fieldset className="ck-type-editor" data-testid={`ck-sol-editor-${s.id}`}>
                          <legend>{t('ck.sol.editLegend', { name: nameOf(s.id) })}</legend>
                          {ACTION_TYPES.map((type) => (
                            <Checkbox key={type} label={t(`ck.type.${type}`)} checked={list.some((a) => a.type === type)}
                              onChange={(_, d) => toggleType(s, type, !!d.checked)} data-testid={`ck-sol-type-${s.id}-${type}`} />
                          ))}
                        </fieldset>
                      )}
                    </td>
                    <td>
                      <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-expanded={editing === s.id}
                        onClick={() => setEditing(editing === s.id ? null : s.id)} data-testid={`ck-sol-edit-${s.id}`}>{t('ck.sol.edit')}</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      <p className="muted ck-small">{t('ck.sol.legend')}</p>
    </Panel>
  );
}

const projectFolder = (company: string, project: string) => safeFileStem(`${company}-${project}`);

/** Step 5: the plan built from the chosen solutions, and a production requirements definition per software solution. */
export function ActionPlanPanel({ ctx, visible, nameOf, cands }: { ctx: AppCheckContext; visible: Visible; nameOf: NameOf; cands: Candidate[] }) {
  const { t, fmt, lang } = useI18n();
  const names = useTargetNames();
  const raw = useActionPlan((s) => s.value);
  const setPlan = useActionPlan((s) => s.set);
  const plan = useMemo(() => normalizeActionPlan(raw), [raw]);
  const solutions = useSolutions(ctx, visible);
  const actions = useActions(ctx, solutions, plan);
  const { order, lanes, ranking, scenarioName } = usePlanOrder(cands, plan);
  const start = plan.start ?? ctx.today;
  const schedule = useMemo(() => scheduleActions(order, actions, lanes), [order, actions, lanes]);
  const totalWeeks = Math.max(1, ...schedule.map((x) => x.endWeek));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const write = (fn: (p: Plan) => Plan) => setPlan((v) => fn(normalizeActionPlan(v)));
  const setAction = (s: EntityOf<'solution'>, type: ActionType, patch: ActionPatch) => write((p) => {
    const list = p.actions[s.id] ?? inferActions(s, solutionType(s, ctx.strategy).type, lang);
    return { ...p, actions: { ...p.actions, [s.id]: list.map((a) => (a.type === type ? { ...a, ...patch } : a)) } };
  });
  const docFor = (solutionId: string) => {
    const s = solutions.find((x) => x.id === solutionId);
    if (!s) return null;
    const row = ranking.rows.find((r) => r.id === solutionId);
    return buildProductionDoc({
      solution: s, actions: actions[solutionId] ?? [], schedule, ctx, lang, company: names.company, project: names.project, planStart: start, visible,
      ...(row ? { priority: { row, scenario: scenarioName || t('ck.cmp.now'), of: ranking.rows.filter((r) => !r.excluded).length } } : {}),
    });
  };
  const withDocs = order.filter((id) => (actions[id] ?? []).some((a) => isDevType(a.type)));
  /** Saves the documents; files that already exist are collected and confirmed once before they are replaced. */
  const save = async (ids: string[], overwrite: boolean) => {
    setBusy(ids.join(','));
    setMessage(null);
    const exists: string[] = [];
    const paths: string[] = [];
    try {
      for (const solutionId of ids) {
        const doc = docFor(solutionId);
        if (!doc) continue;
        try {
          const path = await saveProjectFile(projectFolder(names.company, names.project), requirementsFileName(doc.fileTitle), doc.markdown, overwrite);
          paths.push(path);
          write((p) => ({ ...p, saved: { ...p.saved, [solutionId]: { path, at: new Date().toISOString(), toFill: doc.toFill.length } } }));
        } catch (error) {
          if (error instanceof DeviceStorageError && error.code === 'fileExists') exists.push(solutionId);
          else throw error;
        }
      }
      if (paths.length) setMessage({ intent: 'success', text: t('ck.doc.saved', { n: paths.length, path: paths[paths.length - 1]! }) });
      if (exists.length) setConfirm(exists);
    } catch (error) {
      setMessage({ intent: 'error', text: t('ck.doc.failed', { code: error instanceof DeviceStorageError ? (error.code ?? 'deviceUnavailable') : String(error) }) });
    } finally {
      setBusy(null);
    }
  };
  const solById = new Map(solutions.map((s) => [s.id, s]));
  const end = schedule.length ? addWeeks(start, totalWeeks) : null;

  return (
    <Panel title={t('ck.plan.title')} rationale="ck.plan.why" testId="ck-plan" className="span-full">
      <p className="muted ck-small">{t('ck.plan.lead', { scenario: scenarioName || t('ck.cmp.now') })}</p>
      <div className="ck-plan-head">
        <Field size="small" label={t('ck.plan.start')}>
          <Input size="small" type="date" value={start} onChange={(_, d) => write((p) => ({ ...p, start: /^\d{4}-\d{2}-\d{2}$/.test(d.value) ? d.value : null }))} data-testid="ck-plan-start" />
        </Field>
        <p className="muted ck-small">{lanes === null ? t('ck.plan.lanesAll') : t('ck.plan.lanes', { n: lanes })}</p>
        {plan.selected && <Button size="small" onClick={() => write((p) => ({ ...p, selected: null }))} data-testid="ck-plan-auto">{t('ck.plan.auto')}</Button>}
      </div>
      {schedule.length === 0 ? <p className="muted" data-testid="ck-plan-empty">{t('ck.plan.empty')}</p> : (
        <ChartFigure
          id="ck-plan-gantt"
          title={t('ck.plan.chartTitle', { n: schedule.length, end: end ? fmt.date(end) : '—', weeks: totalWeeks })}
          read={t('ck.plan.chartRead')}
          legend={<span className="ck-legend"><span className="ck-key is-dev" />{t('ck.plan.legendDev')}<span className="ck-key is-nondev" />{t('ck.plan.legendNonDev')}</span>}
          visual={(
            <div className="ck-rank" data-testid="ck-plan-rows">
              {schedule.map((x) => (
                <div key={x.key} className="ck-rank-row is-gantt" data-key={x.key} data-start={x.startWeek} data-end={x.endWeek}>
                  <span className="ck-rank-name">{`${nameOf(x.solutionId)} — ${t(`ck.type.${x.type}`)}`}</span>
                  <span className="ck-rank-track is-plain">
                    <span className={`ck-gantt-bar ${isDevType(x.type) ? 'is-dev' : 'is-nondev'}`} style={{ left: `${(100 * x.startWeek) / totalWeeks}%`, width: `${(100 * x.weeks) / totalWeeks}%` }} />
                  </span>
                  <span className="ck-rank-value">{t('ck.plan.when', { start: fmt.date(addWeeks(start, x.startWeek)), weeks: x.weeks })}</span>
                </div>
              ))}
            </div>
          )}
          table={(
            <table className="data-table compact">
              <thead><tr>
                <th scope="col">{t('ck.plan.col.solution')}</th><th scope="col">{t('ck.plan.col.type')}</th>
                <th scope="col">{t('ck.plan.col.start')}</th><th scope="col">{t('ck.plan.col.end')}</th>
                <th scope="col" className="num">{t('ck.plan.col.weeks')}</th><th scope="col">{t('ck.plan.col.after')}</th>
              </tr></thead>
              <tbody>
                {schedule.map((x) => (
                  <tr key={x.key}>
                    <th scope="row">{nameOf(x.solutionId)}</th><td>{t(`ck.type.${x.type}`)}</td>
                    <td>{addWeeks(start, x.startWeek)}</td><td>{addWeeks(start, x.endWeek)}</td><td className="num">{x.weeks}</td>
                    <td>{x.dependsOn.map((k) => t(`ck.type.${k.split(':').pop() as ActionType}`)).join(t('ck.sep')) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        />
      )}
      {schedule.length > 0 && (
        <details className="ck-edit" data-testid="ck-plan-edit">
          <summary>{t('ck.plan.edit')}</summary>
          <ScrollRegion label={t('ck.plan.edit')}>
            <table className="data-table compact">
              <thead><tr><th scope="col">{t('ck.plan.col.solution')}</th><th scope="col">{t('ck.plan.col.type')}</th><th scope="col">{t('ck.plan.col.weeks')}</th><th scope="col">{t('ck.plan.col.owner')}</th></tr></thead>
              <tbody>
                {order.flatMap((id) => (actions[id] ?? []).map((a) => {
                  const s = solById.get(id)!;
                  return (
                    <tr key={`${id}:${a.type}`}>
                      <th scope="row">{nameOf(id)}</th>
                      <td>{t(`ck.type.${a.type}`)}</td>
                      <td>
                        <SpinButton size="small" min={1} max={260} value={a.weeks ?? DEFAULT_WEEKS[a.type]} aria-label={t('ck.plan.weeksOf', { name: nameOf(id), type: t(`ck.type.${a.type}`) })}
                          onChange={(_, d) => { const v = Math.round(d.value ?? Number(d.displayValue)); if (Number.isFinite(v) && v >= 1 && v <= 260) setAction(s, a.type, { weeks: v }); }}
                          data-testid={`ck-plan-weeks-${id}-${a.type}`} />
                      </td>
                      <td>
                        <Input size="small" value={a.owner ?? ''} aria-label={t('ck.plan.ownerOf', { name: nameOf(id), type: t(`ck.type.${a.type}`) })}
                          onChange={(_, d) => setAction(s, a.type, { owner: d.value.slice(0, 120) })} />
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </ScrollRegion>
          <p className="muted ck-small">{t('ck.plan.weeksNote')}</p>
        </details>
      )}

      <h3 className="ck-subhead">{t('ck.doc.title')}</h3>
      <p className="muted ck-small">{t('ck.doc.lead', { folder: projectFolder(names.company, names.project) })}</p>
      {message && (
        <MessageBar intent={message.intent} data-testid="ck-doc-message" role={message.intent === 'error' ? 'alert' : 'status'}>
          <MessageBarBody>{message.text}</MessageBarBody>
        </MessageBar>
      )}
      {withDocs.length === 0 ? <p className="muted" data-testid="ck-doc-none">{t('ck.doc.none')}</p> : (
        <>
          <Button appearance="primary" icon={<FolderArrowRight20Regular />} disabled={busy !== null} onClick={() => void save(withDocs, false)} data-testid="ck-doc-save-all">{t('ck.doc.saveAll', { n: withDocs.length })}</Button>
          <ul className="ck-docs">
            {withDocs.map((id) => {
              const doc = docFor(id);
              const saved = plan.saved[id];
              if (!doc) return null;
              const file = requirementsFileName(doc.fileTitle);
              return (
                <li key={id} className="ck-doc" data-testid={`ck-doc-${id}`}>
                  <div className="ck-doc-head">
                    <DocumentText20Regular aria-hidden />
                    <span className="ck-doc-file" data-testid={`ck-doc-file-${id}`}>{file}</span>
                    <Badge appearance="outline" color={doc.toFill.length ? 'warning' : 'success'} data-testid={`ck-doc-tofill-${id}`} data-n={doc.toFill.length}>{t('ck.doc.toFill', { n: doc.toFill.length })}</Badge>
                    {saved && <Badge appearance="tint" color="success" data-testid={`ck-doc-saved-${id}`}>{t('ck.doc.savedAt', { at: fmt.date(saved.at.slice(0, 10)) })}</Badge>}
                  </div>
                  <TypeBadges actions={(actions[id] ?? []).filter((a) => isDevType(a.type))} />
                  {saved && <p className="muted ck-small ck-path" data-testid={`ck-doc-path-${id}`}>{saved.path}</p>}
                  <div className="ck-actions">
                    <Button size="small" appearance="primary" icon={<FolderArrowRight20Regular />} disabled={busy !== null} onClick={() => void save([id], false)} data-testid={`ck-doc-save-${id}`}>{t('ck.doc.save')}</Button>
                    <Button size="small" icon={<ArrowDownload20Regular />} onClick={() => downloadText(file, doc.markdown, 'text/markdown')} data-testid={`ck-doc-download-${id}`}>{t('ck.doc.download')}</Button>
                  </div>
                  <details className="ck-edit">
                    <summary>{t('ck.doc.preview')}</summary>
                    <pre className="ck-preview" tabIndex={0} data-testid={`ck-doc-preview-${id}`}>{doc.markdown}</pre>
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t('ck.doc.existsTitle')}
        body={t('ck.doc.existsBody', { list: (confirm ?? []).map(nameOf).join(t('ck.sep')) })}
        confirmLabel={t('ck.doc.overwrite')}
        onConfirm={() => { const ids = confirm; setConfirm(null); if (ids) void save(ids, true); }}
        onCancel={() => setConfirm(null)}
        testId="ck-doc-exists"
      />
    </Panel>
  );
}
