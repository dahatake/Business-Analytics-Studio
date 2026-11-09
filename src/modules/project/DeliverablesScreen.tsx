import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Input, Tab, TabList, Textarea } from '@fluentui/react-components';
import { ArrowDownload20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { PARAMS } from '../../config/params.ts';
import { useI18n } from '../../i18n/index.ts';
import { IMPROVEMENT_STEPS, useActiveProject, type ImprovementStep } from '../../state/projects.ts';
import { replaceQuery, useRoute } from '../../state/router.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { AuthorBadge, BackToHome, downloadText, useTargetNames } from './common.tsx';
import {
  evaluateStep, fieldHintKey, fieldKey, hasDate, hasNumber, inputKey, normalizeDeliverables, PAYBACK_LIMIT_RANGE, PAYBACK_MAX_YEARS, progressOf, resultKey,
  setField, setPaybackLimit, STEP_DEFS,
  type CheckContext,
} from './deliverables.ts';
import { deliverableNameKey, TodoItem, todayIn, todoLabel, useCheckContext, usePaybackLimit } from './deliverablesUi.tsx';
import { useDeliverables, useProjTransient, useProjUi } from './stores.ts';
import './project.css';

const isStep = (s: string | null): s is ImprovementStep => !!s && (IMPROVEMENT_STEPS as readonly string[]).includes(s);

/** How much of each existing input the step can use (so the user sees what is already there). */
function inputCount(id: string, c: CheckContext): number {
  const n = (kind: string) => c.pack.pack.entities.filter((e) => e.kind === kind).length;
  switch (id) {
    case 'issues': return n('issue');
    case 'causes': return n('cause');
    case 'sources': return n('source');
    case 'discussion': return c.discussion.themes.length + c.discussion.records.length;
    case 'analyses': return c.analysis.analyses.length;
    case 'kpis': return n('kpi');
    case 'flows': return n('deal') + n('deliverable') + n('invoice');
    case 'projectKpis': return c.kpi.kpis.length;
    case 'okrs': return c.kpi.okrs.length;
    case 'useCases': return c.useCases.filter((u) => u.origin === 'registered').length;
    case 'solutions': return n('solution');
    case 'personas': return new Set(c.useCases.map((u) => u.persona)).size;
    case 'initiatives': return n('initiative');
    case 'people': return n('person');
    default: return 0;
  }
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
    <Panel title={t('dlv.criteria.title')} testId="dlv-criteria" className="span-full">
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
  const { t } = useI18n();
  const route = useRoute();
  const { step: activeStep } = useActiveProject();
  const q = route.query.get('step');
  const step: ImprovementStep = isStep(q) ? q : activeStep;
  const ctx = useCheckContext();
  const set = useDeliverables((s) => s.set);
  const openDraft = useProjTransient((s) => s.openDraft);
  const names = useTargetNames();
  const all = useMemo(() => Object.fromEntries(IMPROVEMENT_STEPS.map((s) => [s, evaluateStep(s, ctx)])) as Record<ImprovementStep, ReturnType<typeof evaluateStep>>, [ctx]);
  const results = all[step];
  const p = progressOf(results);
  const def = STEP_DEFS[step];
  const doc = ctx.deliverables.docs[step] ?? {};
  const limit = usePaybackLimit();

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
            <Button appearance="primary" icon={<Sparkle20Regular />} onClick={() => openDraft(step)} data-testid="dlv-screen-draft">{t('dlv.draft.button')}</Button>
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
      </section>

      <Panel title={t('dlv.screen.exit')} testId="dlv-exit" className="dlv-exit">
        <p data-testid="dlv-screen-progress">{p.complete ? t('dlv.band.complete') : t('dlv.band.progress', { done: p.done, total: p.total })}</p>
        <ul className="dlv-todo-list">
          {results.map((r) => <TodoItem key={r.todo.id} r={r} detailed />)}
        </ul>
      </Panel>

      {step === 'plan' && <PaybackCriterion />}

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
            const missing = text.trim() !== '' && ((f.quantified && !hasNumber(text)) || (f.timeBound && !hasDate(text)));
            const message = missing ? t(f.quantified && !hasNumber(text) ? 'dlv.screen.needNumber' : 'dlv.screen.needDate') : undefined;
            return (
              <Field
                key={f.id}
                label={{ children: (
                  <span className="dlv-field-label">
                    {t(fieldKey(step, f.id))}
                    {v && <AuthorBadge author={v.author} mock={v.mock} />}
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
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
