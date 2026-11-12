import { useMemo, useState } from 'react';
import {
  Button, Field, Input, MessageBar, MessageBarBody, Radio, RadioGroup, Select, Tab, TabList,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { entitiesOf } from '../../data/pack.ts';
import { translate } from '../../i18n/core.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { replaceQuery, useRoute } from '../../state/router.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { categoriesOf, categoryWeight, clampScore, computeAnalysis, newAnalysis, validateItems, WEIGHT_MAX, WEIGHT_MIN, SCORE_MAX, SCORE_MIN } from './analysis.ts';
import { categoryKey, describeInsight, fmtScore, methodDescKey, methodKey } from './analysisText.ts';
import { AnalysisViewer, type Viewer } from './AnalysisViewer.tsx';
import { AuthorBadge, BackToHome, MockBadge, ScrollRegion } from './common.tsx';
import { KpiOkrPanel } from './KpiOkrPanel.tsx';
import { EngagementsPanel } from './EngagementsPanel.tsx';
import { requestAnalysisDraft } from './mocks.ts';
import { METHODS, newId, type Analysis, type AnalysisItem, type MethodId } from './model.ts';
import { useAnalyses, useProjUi } from './stores.ts';
import './project.css';

/** FR-133〜FR-135, FR-140, FR-153/154, NFR-UX-006. */
export function AnalysisScreen() {
  const { t } = useI18n();
  const route = useRoute();
  const tab = route.query.get('tab') === 'kpi' ? 'kpi' : 'analysis';
  const layout = useProjUi((s) => s.analysisLayout);
  const setLayout = useProjUi((s) => s.setAnalysisLayout);
  return (
    <div className="screen proj-screen">
      <PageHeader
        title={t('proj.nav.analysis')}
        subtitle={t('proj.an.subtitle')}
        actions={(
          <>
            <BackToHome />
            <Field label={t('proj.layout.label')} orientation="horizontal">
              <Select value={layout} onChange={(_, d) => setLayout(d.value as typeof layout)} data-testid="proj-layout">
                <option value="split">{t('proj.layout.split')}</option>
                <option value="results">{t('proj.layout.results')}</option>
                <option value="stacked">{t('proj.layout.stacked')}</option>
              </Select>
            </Field>
          </>
        )}
      />
      <TabList selectedValue={tab} onTabSelect={(_, d) => replaceQuery({ tab: d.value === 'kpi' ? 'kpi' : undefined })} className="span-full">
        <Tab value="analysis">{t('proj.an.tab')}</Tab>
        <Tab value="kpi">{t('proj.kpi.tab')}</Tab>
      </TabList>
      {tab === 'kpi' ? <KpiOkrPanel /> : <><AnalysisTab layout={layout} /><EngagementsPanel /></>}
    </div>
  );
}

function AnalysisTab({ layout }: { layout: 'split' | 'results' | 'stacked' }) {
  const { t, lang } = useI18n();
  const data = useAnalyses((s) => s.value);
  const set = useAnalyses((s) => s.set);
  const [method, setMethod] = useState<MethodId>('swot');
  const active = data.analyses.find((a) => a.id === data.activeId) ?? null;

  const start = () => {
    const at = new Date().toISOString();
    const n = data.analyses.filter((a) => a.method === method).length + 1;
    const title = { ja: translate('ja', 'proj.an.newTitle', { method: translate('ja', methodKey(method)), n }), en: translate('en', 'proj.an.newTitle', { method: translate('en', methodKey(method)), n }) };
    const a = newAnalysis(method, title, newId('an'), at);
    set((v) => ({ analyses: [...v.analyses, a], activeId: a.id }));
  };

  return (
    <>
      <Panel title={t('proj.an.choose')} rationale="proj.an.chooseWhy" className="span-full" testId="proj-method-panel" id="proj-method-panel">
        <div className="proj-method-row">
          <RadioGroup value={method} onChange={(_, d) => setMethod(d.value as MethodId)} aria-label={t('proj.an.method')} className="proj-methods">
            {METHODS.map((m) => (
              <Radio key={m} value={m} label={<span><strong>{t(methodKey(m))}</strong><span className="proj-method-desc">{t(methodDescKey(m))}</span></span>} />
            ))}
          </RadioGroup>
          <Button appearance="primary" icon={<Add20Regular />} onClick={start} data-testid="proj-start-analysis">{t('proj.an.start')}</Button>
        </div>
        {data.analyses.length > 0 && (
          <Field label={t('proj.an.existing')} className="proj-existing">
            <Select value={active?.id ?? ''} onChange={(_, d) => set((v) => ({ ...v, activeId: d.value || null }))} data-testid="proj-analysis-select">
              {data.analyses.map((a) => <option key={a.id} value={a.id}>{`${loc(a.title, lang)} — ${t(methodKey(a.method))}`}</option>)}
            </Select>
          </Field>
        )}
        {data.analyses.length === 0 && <p className="muted">{t('proj.an.none')}</p>}
      </Panel>
      {active && <ActiveAnalysis key={active.id} analysis={active} layout={layout} />}
    </>
  );
}

function ActiveAnalysis({ analysis, layout }: { analysis: Analysis; layout: 'split' | 'results' | 'stacked' }) {
  const { t, lang } = useI18n();
  const set = useAnalyses((s) => s.set);
  const [viewer, setViewer] = useState<Viewer>('matrix');
  const [draftNote, setDraftNote] = useState<{ count: number; mock: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => computeAnalysis(analysis), [analysis]);
  const issues = useMemo(() => validateItems(analysis.items), [analysis.items]);
  const cats = categoriesOf(analysis.method);

  const update = (fn: (a: Analysis) => Analysis) => set((v) => ({ ...v, analyses: v.analyses.map((a) => (a.id === analysis.id ? { ...fn(a), updatedAt: new Date().toISOString() } : a)) }));
  const updateItem = (id: string, patch: Partial<AnalysisItem>) => update((a) => ({ ...a, items: a.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const addItem = () => update((a) => ({ ...a, items: [...a.items, { id: newId('item'), category: cats[0]!, text: '', score: 3, weight: 1, author: 'human' }] }));
  const removeAnalysis = () => set((v) => {
    const analyses = v.analyses.filter((a) => a.id !== analysis.id);
    return { analyses, activeId: analyses[0]?.id ?? null };
  });
  const num = (raw: string, min: number, max: number): number | null => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
  };
  const draft = async () => {
    setBusy(true);
    try {
      const ents = [...entitiesOf('issue'), ...entitiesOf('solution')];
      const { response, items } = await requestAnalysisDraft(analysis.method, lang, ents);
      update((a) => ({ ...a, items: [...a.items, ...items.map((d) => ({ id: newId('item'), category: d.category, text: d.text, score: clampScore(d.score), weight: 1, author: 'ai' as const }))] }));
      setDraftNote({ count: items.length, mock: response.mode === 'mock' });
    } finally {
      setBusy(false);
    }
  };

  const editor = (
    <Panel title={t('proj.an.params')} rationale="proj.an.paramsWhy" testId="proj-params" className={layout === 'split' ? '' : 'span-full'}>
      <h3 className="proj-h3">{t('proj.an.weights')}</h3>
      <div className="proj-weights">
        {cats.map((c) => (
          <Field key={c} label={t(categoryKey(c))} hint={t('proj.an.weightHint', { min: WEIGHT_MIN, max: WEIGHT_MAX })}>
            <Input
              type="number"
              min={WEIGHT_MIN}
              max={WEIGHT_MAX}
              step={0.5}
              value={String(categoryWeight(analysis, c))}
              onChange={(_, d) => {
                const n = num(d.value, WEIGHT_MIN, WEIGHT_MAX);
                if (n !== null) update((a) => ({ ...a, weights: { ...a.weights, [c]: n } }));
              }}
              data-testid={`proj-weight-${c}`}
            />
          </Field>
        ))}
      </div>
      <h3 className="proj-h3">{t('proj.an.items')}</h3>
      <ScrollRegion label={t('proj.an.items')}>
        <table className="data-table compact proj-items">
          <caption className="visually-hidden">{t('proj.an.items')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('proj.an.category')}</th>
              <th scope="col">{t('proj.an.text')}</th>
              <th scope="col">{t('proj.an.scoreRange', { min: SCORE_MIN, max: SCORE_MAX })}</th>
              <th scope="col">{t('proj.an.weight')}</th>
              <th scope="col">{t('proj.an.author')}</th>
              <th scope="col"><span className="visually-hidden">{t('proj.delete')}</span></th>
            </tr>
          </thead>
          <tbody>
            {analysis.items.length === 0 && <tr><td colSpan={6} className="empty">{t('proj.an.noItems')}</td></tr>}
            {analysis.items.map((i, idx) => {
              const bad = (f: 'text' | 'score' | 'weight') => issues.some((x) => x.itemId === i.id && x.field === f);
              return (
                <tr key={i.id}>
                  <td>
                    <Select aria-label={t('proj.an.itemCategory', { n: idx + 1 })} value={i.category} onChange={(_, d) => updateItem(i.id, { category: d.value })}>
                      {cats.map((c) => <option key={c} value={c}>{t(categoryKey(c))}</option>)}
                    </Select>
                  </td>
                  <td>
                    <Input
                      aria-label={t('proj.an.itemText', { n: idx + 1 })}
                      aria-invalid={bad('text') || undefined}
                      value={loc(i.text, lang)}
                      onChange={(_, d) => updateItem(i.id, { text: d.value })}
                      placeholder={t('proj.an.textPlaceholder')}
                    />
                  </td>
                  <td>
                    <Input
                      type="number" min={SCORE_MIN} max={SCORE_MAX} step={0.5} className="proj-num"
                      aria-label={t('proj.an.itemScore', { n: idx + 1 })}
                      value={String(i.score)}
                      onChange={(_, d) => { const n = num(d.value, SCORE_MIN, SCORE_MAX); if (n !== null) updateItem(i.id, { score: n }); }}
                      data-testid={`proj-item-score-${idx + 1}`}
                    />
                  </td>
                  <td>
                    <Input
                      type="number" min={WEIGHT_MIN} max={WEIGHT_MAX} step={0.5} className="proj-num"
                      aria-label={t('proj.an.itemWeight', { n: idx + 1 })}
                      value={String(i.weight)}
                      onChange={(_, d) => { const n = num(d.value, WEIGHT_MIN, WEIGHT_MAX); if (n !== null) updateItem(i.id, { weight: n }); }}
                    />
                  </td>
                  <td><AuthorBadge author={i.author} mock={i.author === 'ai'} /></td>
                  <td>
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('proj.an.itemDelete', { n: idx + 1 })} onClick={() => update((a) => ({ ...a, items: a.items.filter((x) => x.id !== i.id) }))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      {issues.some((x) => x.field === 'text') && <p className="proj-error" role="alert">{t('proj.an.textRequired')}</p>}
      <div className="proj-row">
        <Button icon={<Add20Regular />} onClick={addItem} data-testid="proj-add-item">{t('proj.an.addItem')}</Button>
        <Button icon={<Sparkle20Regular />} onClick={() => void draft()} disabled={busy} data-testid="proj-ai-draft">{t('proj.an.aiDraft')}</Button>
        <Button icon={<Delete20Regular />} onClick={removeAnalysis}>{t('proj.an.deleteAnalysis')}</Button>
      </div>
      {draftNote && (
        <MessageBar intent="info" className="proj-gap" data-testid="proj-ai-note">
          <MessageBarBody>
            {draftNote.mock && <MockBadge />} {t('proj.an.aiAdded', { count: draftNote.count })}
          </MessageBarBody>
        </MessageBar>
      )}
    </Panel>
  );

  const results = (
    <Panel title={t('proj.an.results')} rationale="proj.an.resultsWhy" testId="proj-results" className={layout === 'split' ? '' : 'span-full'}>
      <p className="proj-result-title">{loc(analysis.title, lang)}</p>
      <p className="proj-insight" data-testid="proj-insight" aria-live="polite">{describeInsight(result, t)}</p>
      {result.overall !== null && <p className="proj-overall" data-testid="proj-overall">{t('proj.an.overall', { score: fmtScore(result.overall) })}</p>}
      <RadioGroup layout="horizontal" value={viewer} onChange={(_, d) => setViewer(d.value as Viewer)} aria-label={t('proj.viewer.label')}>
        <Radio value="table" label={t('proj.viewer.table')} />
        <Radio value="matrix" label={t('proj.viewer.matrix')} />
        <Radio value="chart" label={t('proj.viewer.chart')} />
      </RadioGroup>
      <AnalysisViewer analysis={analysis} result={result} viewer={viewer} />
    </Panel>
  );

  if (layout === 'split') return <div className="proj-split span-full">{editor}{results}</div>;
  return layout === 'results' ? <>{results}{editor}</> : <>{editor}{results}</>;
}
