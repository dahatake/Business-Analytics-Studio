import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Field, Input, Tab, TabList, Textarea } from '@fluentui/react-components';
import { ArrowDownload20Regular, Checkmark16Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { PARAMS } from '../../config/params.ts';
import { loadPack } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS, useActiveProject, type ImprovementStep } from '../../state/projects.ts';
import { hrefFor, replaceQuery, revisitRouteTarget, useRoute } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { AuthorBadge, BackToHome, downloadText, useTargetNames } from './common.tsx';
import {
  approveField, evaluateStep, fieldHintKey, fieldIsVague, fieldKey, hasDate, hasNumber, inputKey, normalizeDeliverables, paybackLimit, PAYBACK_LIMIT_RANGE, PAYBACK_MAX_YEARS, progressOf, resultKey,
  setField, setPaybackLimit, setSignOff, STEP_DEFS, type CheckContext, type TodoResult,
} from './deliverables.ts';
import { deliverableNameKey, Refs, StrategySummary, TodoItem, todayIn, todoHref, todoLabel, useCheckContext, usePaybackLimit } from './deliverablesUi.tsx';
import { inputCount } from './stepDashboard.ts';
import { DiscoveryAdvicePanel } from './DiscoveryAdvice.tsx';
import { useDeliverables, useFieldDrafts, useProjTransient, useProjUi } from './stores.ts';
import { KpiDefinitionPanel, SolutionDocsPanel, SolutionStrategyPanel, StrategyThreadPanel } from './StrategyPanels.tsx';
import { ChangeLogPanel, EvidencePanel, IssueSignalsPanel, RequirementLedgerPanel } from './RequirementsPanels.tsx';
import { simulateTaskImpact, type ImpactInputs } from './taskImpact.ts';
import './project.css';

const isStep = (s: string | null): s is ImprovementStep => !!s && (IMPROVEMENT_STEPS as readonly string[]).includes(s);

type ImpactField = Exclude<keyof ImpactInputs, 'years'>;

function TaskImpactSimulation() {
  const { t, fmt } = useI18n();
  const [values, setValues] = useState<ImpactInputs>({ baselineBenefit: '', baselineCost: '', benefit: '', cost: '', investment: '', years: '' });
  const [alternative, setAlternative] = useState({ benefit: '', cost: '', investment: '' });
  const [compare, setCompare] = useState(false);
  const result = simulateTaskImpact(values);
  const other = simulateTaskImpact({ ...values, ...alternative });
  const years = (value: number) => new Intl.NumberFormat(fmt.locale, { maximumSignificantDigits: 3 }).format(value);
  const keys: ImpactField[] = ['baselineBenefit', 'baselineCost', 'benefit', 'cost', 'investment'];
  return (
    <section aria-labelledby="dlv-impact-title" data-testid="dlv-impact-simulation">
      <h3 id="dlv-impact-title">{t('dlv.impact.title')}</h3>
      <p>{t('dlv.impact.note')}</p>
      <div className="proj-form-row">
        {keys.map((key) => (
          <Field key={key} className="grow" label={t(`dlv.impact.${key}`)}>
            <Input type="number" min={0} max={10_000_000_000_000} step={1} value={values[key]} onChange={(_, d) => setValues((v) => ({ ...v, [key]: d.value }))} data-testid={`dlv-impact-${key}`} />
          </Field>
        ))}
        <Field className="grow" label={t('dlv.impact.years')}>
          <Input type="number" min={1} max={50} step={1} value={values.years} onChange={(_, d) => setValues((v) => ({ ...v, years: d.value }))} data-testid="dlv-impact-years" />
        </Field>
      </div>
      <Checkbox checked={compare} onChange={(_, d) => setCompare(d.checked === true)} label={t('dlv.impact.compare')} data-testid="dlv-impact-compare" />
      {compare && (
        <div className="proj-form-row">
          {(['benefit', 'cost', 'investment'] as const).map((key) => (
            <Field key={key} className="grow" label={t(`dlv.impact.alternative.${key}`)}>
              <Input type="number" min={0} max={10_000_000_000_000} step={1} value={alternative[key]} onChange={(_, d) => setAlternative((v) => ({ ...v, [key]: d.value }))} data-testid={`dlv-impact-alt-${key}`} />
            </Field>
          ))}
        </div>
      )}
      {!result.ok && <p role="status">{t('dlv.impact.inputHint')}</p>}
      {result.ok && (
        <div data-testid="dlv-impact-result">
          <p>{t('dlv.impact.baselineResult', { amount: fmt.yen(result.baselineAnnual) })}</p>
          <p>{t('dlv.impact.result', { option: t('dlv.impact.optionA'), annual: fmt.yen(result.scenarioAnnual), change: fmt.yen(result.annualChange), total: fmt.yen(result.totalChange) })}</p>
          <p>{result.paybackYears === null ? t('dlv.impact.noPayback') : t('dlv.impact.payback', { years: years(result.paybackYears) })}</p>
          {compare && !other.ok && <p role="status">{t('dlv.impact.inputHint')}</p>}
          {compare && other.ok && (
            <>
              <p data-testid="dlv-impact-alt-result">{t('dlv.impact.result', { option: t('dlv.impact.optionB'), annual: fmt.yen(other.scenarioAnnual), change: fmt.yen(other.annualChange), total: fmt.yen(other.totalChange) })}</p>
              <p>{other.paybackYears === null ? t('dlv.impact.noPayback') : t('dlv.impact.payback', { years: years(other.paybackYears) })}</p>
              <p>{t('dlv.impact.difference', { amount: fmt.yen(other.totalChange - result.totalChange) })}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TaskWorkbench({ result, ctx, step }: { result: TodoResult; ctx: CheckContext; step: ImprovementStep }) {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const ref = result.outcome?.refs?.find((r) => r.type === 'field');
  const field = ref?.type === 'field' ? ref : null;
  const query = new URLSearchParams(todoHref(result).split('?')[1] ?? '');
  const entity = ctx.pack.byId.get(query.get('edit') ?? '');
  const relationField = query.get('field');
  const relation = entity && !isHidden(entity, audience) && (
    (entity.kind === 'issue' && (relationField === 'causeIds' || relationField === 'kpiIds' || relationField === 'sourceIds'))
    || (entity.kind === 'cause' && relationField === 'sourceIds')
  ) ? relationField : null;
  const originalIds = entity && relation
    ? relation === 'sourceIds' ? entity.sourceIds : entity.kind === 'issue' ? (relation === 'causeIds' ? entity.causeIds : entity.kpiIds) : []
    : [];
  const originalKey = originalIds.join('\0');
  const [selectedIds, setSelectedIds] = useState(originalIds);
  const initial = field ? ctx.deliverables.docs[field.step]?.[field.id]?.text ?? '' : '';
  const [text, setText] = useState(initial);
  const [limit, setLimit] = useState(String(paybackLimit(ctx.deliverables)));
  const [signed, setSigned] = useState(result.done);
  useEffect(() => { setText(initial); setLimit(String(paybackLimit(ctx.deliverables))); setSigned(result.done); }, [result.todo.id, result.done, initial, ctx.deliverables]);
  useEffect(() => { setSelectedIds(originalKey ? originalKey.split('\0') : []); }, [entity?.id, relation, originalKey]);
  const n = Number(limit);
  const validLimit = limit.trim() !== '' && Number.isFinite(n) && n >= PAYBACK_LIMIT_RANGE.min && n <= PAYBACK_LIMIT_RANGE.max;
  let hypothetical = ctx.deliverables;
  if (field) hypothetical = setField(hypothetical, field.step, field.id, text ? { text, author: 'human', updatedAt: new Date().toISOString() } : null);
  if (result.todo.id === 'plan-payback' && validLimit) hypothetical = setPaybackLimit(hypothetical, { value: n, at: new Date().toISOString(), by: '' });
  if (result.todo.kind === 'manual') hypothetical = setSignOff(hypothetical, result.todo.id, signed ? { at: new Date().toISOString(), by: '' } : null);
  const kind = relation === 'sourceIds' ? 'source' : relation === 'causeIds' ? 'cause' : 'kpi';
  const candidates = relation ? ctx.pack.pack.entities.filter((e) => e.kind === kind && !isHidden(e, audience)) : [];
  const hypotheticalPack = entity && relation ? loadPack({
    ...ctx.pack.pack,
    entities: ctx.pack.pack.entities.map((e) => e.id === entity.id ? { ...e, [relation]: selectedIds } : e),
  }) : ctx.pack;
  const simulated = evaluateStep(step, { ...ctx, pack: hypotheticalPack, deliverables: hypothetical }).find((r) => r.todo.id === result.todo.id);
  const canSimulate = !!field || !!relation || result.todo.kind === 'manual' || (result.todo.id === 'plan-payback' && validLimit);
  return (
    <Panel title={t('dlv.task.workbench')} testId="dlv-task-workbench" id="dlv-task-workbench" className="span-full">
      <p>{t('dlv.task.workbenchNote')}</p>
      <ul className="dlv-todo-list"><TodoItem r={result} detailed /></ul>
      {result.done && <Refs refs={result.outcome?.refs ?? []} limit={Infinity} />}
      <p><a href={todoHref(result)} onClick={revisitRouteTarget}>{t('dlv.task.openAction')}</a></p>
      {field && <Field label={t('dlv.task.whatIf')}><Textarea value={text} onChange={(_, d) => setText(d.value)} data-testid="dlv-task-what-if" /></Field>}
      {result.todo.id === 'plan-payback' && <Field label={t('dlv.task.whatIfPayback')} validationState={validLimit ? 'none' : 'error'} validationMessage={validLimit ? undefined : t('dlv.criteria.paybackHint', PAYBACK_LIMIT_RANGE)}><Input type="number" value={limit} onChange={(_, d) => setLimit(d.value)} data-testid="dlv-task-what-if-limit" /></Field>}
      {result.todo.kind === 'manual' && <Checkbox checked={signed} onChange={(_, d) => setSigned(d.checked === true)} label={t('dlv.task.whatIfSign')} data-testid="dlv-task-what-if-sign" />}
      {relation && entity && (
        <fieldset data-testid="dlv-task-what-if-relations">
          <legend>{t('dlv.task.whatIfRelations', { name: loc(entity.name, lang) })}</legend>
          {candidates.map((candidate) => (
            <Checkbox
              key={candidate.id}
              checked={selectedIds.includes(candidate.id)}
              label={loc(candidate.name, lang)}
              onChange={(_, d) => setSelectedIds((ids) => d.checked === true ? [...ids, candidate.id] : ids.filter((id) => id !== candidate.id))}
              data-testid={`dlv-task-what-if-${candidate.id}`}
            />
          ))}
          {candidates.length === 0 && <p>{t('dlv.task.noCandidates')}</p>}
        </fieldset>
      )}
      {canSimulate && simulated && <p data-testid="dlv-task-what-if-result">{t('dlv.task.whatIfResult', { result: simulated.outcome ? t(resultKey(simulated.outcome.code), simulated.outcome.vars) : t(simulated.done ? 'dlv.status.done' : 'dlv.status.todo') })}</p>}
      {!canSimulate && <p>{t('dlv.task.whatIfUnavailable')}</p>}
      <a href={hrefFor('/deliverables', { step: 'solution', target: 'sol-sim' })} onClick={revisitRouteTarget}>{t('dlv.task.simLink')}</a>
      <TaskImpactSimulation />
    </Panel>
  );
}

/** The project's own payback hurdle (the plan check uses it); who set it and when is kept with the value. */
function PaybackCriterion() {
  const { t, fmt } = useI18n();
  const raw = useDeliverables((s) => s.value);
  const saved = useMemo(() => normalizeDeliverables(raw).criteria?.paybackMaxYears, [raw]);
  const limit = usePaybackLimit();
  const [draft, setDraft] = useState(String(limit));
  useEffect(() => setDraft(String(limit)), [limit]);
  const n = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(n) && n >= PAYBACK_LIMIT_RANGE.min && n <= PAYBACK_LIMIT_RANGE.max;
  const save = (value: number | null) => {
    const by = useProjUi.getState().editor.trim();
    useDeliverables.getState().set((v) => setPaybackLimit(normalizeDeliverables(v), value === null ? null : { value, at: new Date().toISOString(), by }));
  };
  const commit = () => { if (valid && n !== limit) save(n); };
  const date = saved ? fmt.date(todayIn(PARAMS.timeZone, new Date(saved.at))) : '';
  return (
    <Panel title={t('dlv.criteria.title')} testId="dlv-criteria" id="dlv-criteria" className="span-full">
      <Field
        label={t('dlv.criteria.payback')}
        hint={t('dlv.criteria.paybackHint', PAYBACK_LIMIT_RANGE)}
        validationState={valid ? 'none' : 'error'}
        validationMessage={valid ? undefined : t('dlv.criteria.paybackHint', PAYBACK_LIMIT_RANGE)}
      >
        <Input
          type="number"
          inputMode="decimal"
          min={PAYBACK_LIMIT_RANGE.min}
          max={PAYBACK_LIMIT_RANGE.max}
          step={0.5}
          value={draft}
          onChange={(_, d) => setDraft(d.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          data-testid="dlv-payback-limit"
        />
      </Field>
      <p className="muted" data-testid="dlv-payback-source">
        {saved
          ? (saved.by ? t('dlv.criteria.setBy', { date, by: saved.by, max: saved.value }) : t('dlv.criteria.setAnon', { date, max: saved.value }))
          : t('dlv.criteria.default', { max: PAYBACK_MAX_YEARS })}
      </p>
      {saved && <Button appearance="secondary" onClick={() => save(null)} data-testid="dlv-payback-reset">{t('dlv.criteria.reset')}</Button>}
    </Panel>
  );
}

/** The step deliverables: definition, exit criteria with live verdicts, existing inputs and the fields to add. */
export function DeliverablesScreen() {
  const { t, lang, fmt } = useI18n();
  const route = useRoute();
  const { step: activeStep } = useActiveProject();
  const q = route.query.get('step');
  const step: ImprovementStep = isStep(q) ? q : activeStep;
  const ctx = useCheckContext();
  const set = useDeliverables((s) => s.set);
  const openDraft = useProjTransient((s) => s.openDraft);
  const audience = useSettings((s) => s.audience);
  const savedDraft = useFieldDrafts((s) => s.value[`${audience}:${step}`]);
  const names = useTargetNames();
  const all = useMemo(() => Object.fromEntries(IMPROVEMENT_STEPS.map((s) => [s, evaluateStep(s, ctx)])) as Record<ImprovementStep, ReturnType<typeof evaluateStep>>, [ctx]);
  const results = all[step];
  const p = progressOf(results);
  const def = STEP_DEFS[step];
  const doc = ctx.deliverables.docs[step] ?? {};
  const limit = usePaybackLimit();
  const selectedTask = results.find((r) => r.todo.id === route.query.get('task'));

  const exportMd = () => {
    const lines = [
      `# ${names.company}-${names.project}: ${t(deliverableNameKey(step))}`,
      '',
      t('dlv.md.generated', { date: todayIn(), done: p.done, total: p.total }),
      '',
      `> ${t(`dlv.${step}.purpose`)}`,
      '',
      `## ${t('dlv.screen.exit')}`,
      '',
      ...results.map((r) => `- [${r.done ? 'x' : ' '}] ${todoLabel(t, r.todo.id, limit)} — ${r.outcome ? t(resultKey(r.outcome.code), r.outcome.vars) : t(r.done ? 'dlv.status.done' : 'dlv.waiting')}`),
      '',
      ...def.fields.flatMap((f) => [`## ${t(fieldKey(step, f.id))}`, '', doc[f.id]?.text.trim() || `_${t('dlv.screen.empty')}_`, '']),
    ];
    downloadText(`${names.company}-${names.project}-${t(deliverableNameKey(step))}.md`.replace(/[\\/:*?"<>|]/g, '_'), lines.join('\n'), 'text/markdown');
  };

  return (
    <div className="screen proj-screen dlv-screen">
      <PageHeader
        title={t('dlv.title')}
        subtitle={t('dlv.subtitle')}
        actions={(
          <>
            <BackToHome />
            <Button appearance="primary" icon={<Sparkle20Regular />} onClick={() => openDraft(step)} data-testid="dlv-screen-draft">{t(savedDraft?.lang === lang ? 'dlv.draft.review' : 'dlv.draft.button')}</Button>
            <Button appearance="secondary" icon={<ArrowDownload20Regular />} onClick={exportMd} data-testid="dlv-export">{t('dlv.screen.export')}</Button>
          </>
        )}
      />
      {names.isDemo && <p className="muted span-full">{t('dlv.screen.demoNote')}</p>}
      <TabList selectedValue={step} onTabSelect={(_, d) => replaceQuery({ step: String(d.value) })} aria-label={t('dlv.screen.stepTabs')} className="span-full dlv-tabs">
        {IMPROVEMENT_STEPS.map((s, i) => {
          const sp = progressOf(all[s]);
          return (
            <Tab key={s} value={s} data-testid={`dlv-tab-${s}`}>
              {i + 1}. {t(`proj.step.${s}`)} <Badge size="small" appearance="tint" color={sp.complete ? 'success' : 'informative'}>{sp.done}/{sp.total}</Badge>
            </Tab>
          );
        })}
      </TabList>

      <section className="span-full dlv-head" aria-labelledby="dlv-name">
        <h2 id="dlv-name" className="proj-h2" data-testid="dlv-name">{t(deliverableNameKey(step))}</h2>
        <p><strong>{t('dlv.screen.purpose')}:</strong> {t(`dlv.${step}.purpose`)}</p>
        <p><StrategySummary ctx={ctx} /></p>
      </section>

      <DiscoveryAdvicePanel step={step} ctx={ctx} />

      {selectedTask && <TaskWorkbench key={selectedTask.todo.id} result={selectedTask} ctx={ctx} step={step} />}

      <Panel title={t('dlv.screen.exit')} testId="dlv-exit" className="dlv-exit">
        <p data-testid="dlv-screen-progress">{p.complete ? t('dlv.band.complete') : t('dlv.band.progress', { done: p.done, total: p.total })}</p>
        <ul className="dlv-todo-list">
          {results.filter((r) => r.todo.id !== selectedTask?.todo.id).map((r) => <TodoItem key={r.todo.id} r={r} detailed />)}
        </ul>
      </Panel>

      {step === 'kpi' && <KpiDefinitionPanel ctx={ctx} />}
      {step === 'solution' && <SolutionStrategyPanel ctx={ctx} />}
      {step === 'deliverable' && <EvidencePanel ctx={ctx} />}
      {step === 'deliverable' && <SolutionDocsPanel ctx={ctx} />}
      {step === 'deliverable' && <RequirementLedgerPanel ctx={ctx} />}
      {step === 'deliverable' && <ChangeLogPanel ctx={ctx} />}
      {step === 'deliverable' && <PaybackCriterion />}

      <Panel title={t('dlv.screen.inputs')} testId="dlv-inputs" className="dlv-inputs">
        <ul className="dlv-input-list">
          {def.inputs.map((id) => (
            <li key={id}><span>{t(inputKey(id))}</span> <Badge appearance="outline">{t('dlv.screen.count', { n: inputCount(id, ctx) })}</Badge></li>
          ))}
        </ul>
      </Panel>

      <Panel title={t('dlv.screen.adds')} testId="dlv-fields" id="dlv-fields" className="span-full">
        <div className="dlv-fields">
          {def.fields.map((f) => {
            const v = doc[f.id];
            const text = v?.text ?? '';
            const missing = text.trim() !== '' && fieldIsVague(f, text);
            const message = missing ? t(f.quantified && !hasNumber(text) ? 'dlv.screen.needNumber' : f.timeBound && !hasDate(text) ? 'dlv.screen.needDate' : 'dlv.screen.needSpecific') : undefined;
            const label = t(fieldKey(step, f.id));
            const approvedDate = v?.approved ? fmt.date(todayIn(PARAMS.timeZone, new Date(v.approved.at))) : '';
            return (
              <div key={f.id} className="dlv-field" data-testid={`dlv-field-box-${f.id}`} data-author={v?.author ?? 'none'}>
              <Field
                label={{ children: (
                  <span className="dlv-field-label">
                    {label}
                    {v && !v.approved && <AuthorBadge author={v.author} mock={v.mock} />}
                    {v?.approved && (
                      <Badge appearance="filled" color="success" data-testid={`dlv-approved-${f.id}`}>{t('dlv.screen.approved')}</Badge>
                    )}
                  </span>
                ) }}
                hint={t(fieldHintKey(step, f.id))}
                validationState={missing ? 'warning' : 'none'}
                validationMessage={message}
              >
                <Textarea
                  id={`dlv-field-${f.id}`}
                  value={text}
                  resize="vertical"
                  rows={5}
                  onChange={(_, d) => set((prev) => setField(normalizeDeliverables(prev), step, f.id, d.value ? { text: d.value, author: 'human', updatedAt: new Date().toISOString() } : null))}
                  data-testid={`dlv-field-${f.id}`}
                />
              </Field>
              {v?.author === 'ai' && text.trim() !== '' && (
                <div className="dlv-field-actions">
                  <Button
                    size="small"
                    appearance="primary"
                    icon={<Checkmark16Regular />}
                    aria-label={t('dlv.screen.approveField', { field: label })}
                    onClick={() => set((prev) => approveField(normalizeDeliverables(prev), step, f.id, text, useProjUi.getState().editor.trim(), new Date().toISOString()))}
                    data-testid={`dlv-approve-${f.id}`}
                  >
                    {t('dlv.screen.approve')}
                  </Button>
                </div>
              )}
              {v?.approved && (
                <p className="muted dlv-field-approval" data-testid={`dlv-approval-${f.id}`}>
                  {t(v.approved.by ? 'dlv.screen.approvedBy' : 'dlv.screen.approvedAnon', { date: approvedDate, by: v.approved.by })}
                  {v.approved.mock ? ` ${t('dlv.screen.approvedMock')}` : ''}
                </p>
              )}
              </div>
            );
          })}
        </div>
      </Panel>

      {step === 'asis' && <IssueSignalsPanel ctx={ctx} />}
      <StrategyThreadPanel ctx={ctx} />
    </div>
  );
}
