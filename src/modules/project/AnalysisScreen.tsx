import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactElement } from 'react';
import {
  Badge, Button, Field, Input, MessageBar, MessageBarBody, Select, Slider, Tab, TabList, ToggleButton,
  Toolbar, ToolbarRadioButton, ToolbarRadioGroup, Tooltip,
} from '@fluentui/react-components';
import {
  Add16Regular, Add20Regular, ArrowMove24Regular, CheckmarkCircle20Filled, Circle20Regular, CursorClick20Regular,
  DataBarHorizontal20Regular, Delete20Regular, Dismiss16Regular, Edit16Regular, Flow16Regular, Flowchart24Regular,
  DataScatter20Regular, Grid20Regular, Grid24Regular, Link16Regular, PeopleTeam24Regular, Scales24Regular, Sparkle20Regular, Table20Regular,
} from '@fluentui/react-icons';
import { entitiesOf, getEntity, loaded } from '../../data/pack.ts';
import { translate } from '../../i18n/core.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { replaceQuery, useRoute } from '../../state/router.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { categoriesOf, categoryWeight, clampScore, computeAnalysis, newAnalysis, shownMethodsOf, validateItems, WEIGHT_MAX, WEIGHT_MIN, SCORE_MAX, SCORE_MIN } from './analysis.ts';
import { itemKey, relatedItems, type LinkSelection } from './analysisLinks.ts';
import { categoryKey, describeInsight, fmtScore, methodDescKey, methodKey } from './analysisText.ts';
import { AnalysisViewer, type LinkView, type Viewer } from './AnalysisViewer.tsx';
import { AuthorBadge, BackToHome, MockBadge, ScrollRegion } from './common.tsx';
import { KpiOkrPanel } from './KpiOkrPanel.tsx';
import { EngagementsPanel } from './EngagementsPanel.tsx';
import { requestAnalysisDraft } from './mocks.ts';
import { METHODS, newId, type Analysis, type AnalysisData, type AnalysisItem, type MethodId } from './model.ts';
import { useAnalyses, useProjUi } from './stores.ts';
import './project.css';

type Layout = 'split' | 'results' | 'stacked';

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

/** One recognisable shape per framework (Fluent system icons; no third-party artwork). */
const METHOD_ICON: Record<MethodId, ComponentType<{ 'aria-hidden'?: boolean; className?: string }>> = {
  swot: Grid24Regular,
  fiveForces: ArrowMove24Regular,
  valueChain: Flowchart24Regular,
  threeC: PeopleTeam24Regular,
  bsc: Scales24Regular,
};

/** The analysis a method's tile shows: the one being edited when it is of that method, else the latest. */
function tileAnalysis(data: AnalysisData, method: MethodId): Analysis | null {
  const own = data.analyses.filter((a) => a.method === method);
  const active = own.find((a) => a.id === data.activeId);
  if (active) return active;
  return own.reduce<Analysis | null>((best, a) => (!best || a.updatedAt >= best.updatedAt ? a : best), null);
}

function AnalysisTab({ layout }: { layout: Layout }) {
  const { t, lang } = useI18n();
  const data = useAnalyses((s) => s.value);
  const set = useAnalyses((s) => s.set);
  const shown = shownMethodsOf(data);
  const active = data.analyses.find((a) => a.id === data.activeId) ?? null;
  const [selection, setSelection] = useState<LinkSelection | null>(null);

  const toggleMethod = (m: MethodId) => set((v) => {
    const cur = shownMethodsOf(v);
    return { ...v, shownMethods: cur.includes(m) ? cur.filter((x) => x !== m) : METHODS.filter((x) => x === m || cur.includes(x)) };
  });
  const start = (method: MethodId) => {
    const at = new Date().toISOString();
    const n = data.analyses.filter((a) => a.method === method).length + 1;
    const title = { ja: translate('ja', 'proj.an.newTitle', { method: translate('ja', methodKey(method)), n }), en: translate('en', 'proj.an.newTitle', { method: translate('en', methodKey(method)), n }) };
    const a = newAnalysis(method, title, newId('an'), at);
    set((v) => ({ ...v, analyses: [...v.analyses, a], activeId: a.id, shownMethods: METHODS.filter((x) => x === method || shownMethodsOf(v).includes(x)) }));
  };
  const open = (id: string) => set((v) => {
    const a = v.analyses.find((x) => x.id === id);
    if (!a) return v;
    return { ...v, activeId: id, shownMethods: METHODS.filter((x) => x === a.method || shownMethodsOf(v).includes(x)) };
  });

  // A selection survives edits but not the removal of its analysis, its items or its method's tile.
  const sel = useMemo(() => {
    if (!selection) return null;
    const a = data.analyses.find((x) => x.id === selection.analysisId);
    if (!a || !shown.includes(a.method) || tileAnalysis(data, a.method)?.id !== a.id) return null;
    const ids = selection.itemIds.filter((id) => a.items.some((i) => i.id === id));
    return ids.length ? { analysis: a, itemIds: ids } : null;
  }, [selection, data, shown]);
  const visible = useMemo(() => shown.map((m) => tileAnalysis(data, m)).filter((a): a is Analysis => !!a), [data, shown]);
  const related = useMemo(
    () => (sel ? relatedItems({ analysisId: sel.analysis.id, itemIds: sel.itemIds }, visible, loaded) : new Map()),
    [sel, visible],
  );
  const toggle = useCallback((analysisId: string, itemIds: string[]) => {
    setSelection((cur) => (cur && cur.analysisId === analysisId && cur.itemIds.length === itemIds.length && itemIds.every((id) => cur.itemIds.includes(id))
      ? null
      : { analysisId, itemIds }));
  }, []);
  const link: LinkView = useMemo(() => ({
    selected: new Set(sel ? sel.itemIds.map((id) => itemKey(sel.analysis.id, id)) : []),
    related,
    toggle,
    clear: () => setSelection(null),
    entityName: (id: string) => {
      const e = getEntity(id);
      return e ? loc(e.name, lang) : id;
    },
  }), [sel, related, toggle, lang]);

  useEffect(() => {
    if (!sel) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel]);

  const selLabel = (() => {
    if (!sel) return '';
    const items = sel.analysis.items.filter((i) => sel.itemIds.includes(i.id));
    if (items.length === 1) return loc(items[0]!.text, lang);
    const cats = [...new Set(items.map((i) => i.category))];
    return cats.map((c) => t(categoryKey(c))).join('・');
  })();
  const otherCount = sel ? [...related.keys()].filter((k) => !k.startsWith(`${sel.analysis.id}:`)).length : 0;

  const dashboard = (
    <Panel title={t('proj.an.dashboard')} rationale="proj.an.dashboardWhy" className={layout === 'split' && active ? 'proj-dash-panel' : 'span-full proj-dash-panel'} testId="proj-dashboard">
      <div className={`proj-link-status${sel ? ' active' : ''}`} role="status" aria-live="polite" data-testid="proj-link-status">
        {sel
          ? (
            <>
              <CursorClick20Regular aria-hidden className="proj-link-status-icon" />
              <span className="proj-link-status-text">{t('proj.link.status', { label: selLabel, count: related.size, other: otherCount })}</span>
              <span className="proj-link-legend" aria-hidden>
                <span className="proj-link-hint same"><Link16Regular /></span>{t('proj.link.legendSame')}
                <span className="proj-link-hint near"><Flow16Regular /></span>{t('proj.link.legendNear')}
              </span>
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={() => setSelection(null)} data-testid="proj-link-clear">{t('proj.link.clear')}</Button>
            </>
          )
          : <span className="muted">{t('proj.link.hint')}</span>}
      </div>
      {shown.length === 0
        ? <p className="muted">{t('proj.an.noneShown')}</p>
        : (
          <div className="proj-dash">
            {shown.map((m) => (
              <AnalysisTile
                key={m}
                method={m}
                analysis={tileAnalysis(data, m)}
                options={data.analyses.filter((a) => a.method === m)}
                editing={active?.method === m}
                link={link}
                relatedCount={(() => {
                  const a = tileAnalysis(data, m);
                  return a && sel ? [...related.keys()].filter((k) => k.startsWith(`${a.id}:`)).length : 0;
                })()}
                hasSelection={!!sel}
                onStart={() => start(m)}
                onOpen={open}
              />
            ))}
          </div>
        )}
    </Panel>
  );

  const editor = active
    ? <AnalysisEditor key={active.id} analysis={active} analyses={data.analyses} onOpen={open} link={link} split={layout === 'split'} />
    : null;

  return (
    <>
      <Panel title={t('proj.an.choose')} rationale="proj.an.chooseWhy" className="span-full" testId="proj-method-panel" id="proj-method-panel">
        <p className="proj-method-hint">{t('proj.an.chooseHint')}</p>
        <div role="group" aria-label={t('proj.an.shownMethods')} className="proj-methods">
          {METHODS.map((m) => {
            const Icon = METHOD_ICON[m];
            const on = shown.includes(m);
            const count = data.analyses.filter((a) => a.method === m).length;
            return (
              <ToggleButton
                key={m}
                checked={on}
                appearance="subtle"
                className={`proj-method-btn${on ? ' on' : ''}`}
                onClick={() => toggleMethod(m)}
                data-testid={`proj-method-${m}`}
              >
                <span className="proj-method-icon"><Icon aria-hidden /></span>
                <span className="proj-method-text">
                  <span className="proj-method-name">{t(methodKey(m))}</span>
                  <span className="proj-method-desc">{t(methodDescKey(m))}</span>
                </span>
                {count > 0 && <Badge appearance="tint" size="small" className="proj-method-count">{t('proj.an.methodCount', { count })}</Badge>}
                <span className="proj-method-check" aria-hidden>{on ? <CheckmarkCircle20Filled /> : <Circle20Regular />}</span>
              </ToggleButton>
            );
          })}
        </div>
        {data.analyses.length === 0 && <p className="muted">{t('proj.an.none')}</p>}
      </Panel>
      {layout === 'split' && editor
        ? <div className="proj-split span-full">{editor}{dashboard}</div>
        : layout === 'stacked' ? <>{editor}{dashboard}</> : <>{dashboard}{editor}</>}
    </>
  );
}

function AnalysisTile({ method, analysis, options, editing, link, relatedCount, hasSelection, onStart, onOpen }: {
  method: MethodId;
  analysis: Analysis | null;
  options: Analysis[];
  editing: boolean;
  link: LinkView;
  relatedCount: number;
  hasSelection: boolean;
  onStart: () => void;
  onOpen: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  const [viewer, setViewer] = useState<Viewer>('plot');
  const result = useMemo(() => (analysis ? computeAnalysis(analysis) : null), [analysis]);
  const Icon = METHOD_ICON[method];
  const name = t(methodKey(method));
  const headingId = `proj-tile-h-${method}`;
  const viewers: { id: Viewer; label: string; icon: ReactElement }[] = [
    { id: 'plot', label: t('proj.viewer.plot'), icon: <DataScatter20Regular /> },
    { id: 'matrix', label: t('proj.viewer.matrix'), icon: <Grid20Regular /> },
    { id: 'table', label: t('proj.viewer.table'), icon: <Table20Regular /> },
    { id: 'chart', label: t('proj.viewer.chart'), icon: <DataBarHorizontal20Regular /> },
  ];
  return (
    <section className={`proj-tile${editing ? ' editing' : ''}`} aria-labelledby={headingId} data-testid={`proj-tile-${method}`}>
      <header className="proj-tile-head">
        <span className="proj-method-icon"><Icon aria-hidden /></span>
        <div className="proj-tile-titles">
          <h3 id={headingId} className="proj-tile-title">{name}</h3>
          {analysis && options.length > 1
            ? (
              <Select size="small" value={analysis.id} onChange={(_, d) => onOpen(d.value)} aria-label={t('proj.an.tileAnalysis', { method: name })} data-testid={`proj-tile-select-${method}`}>
                {options.map((a) => <option key={a.id} value={a.id}>{loc(a.title, lang)}</option>)}
              </Select>
            )
            : analysis && <p className="proj-result-title">{loc(analysis.title, lang)}</p>}
        </div>
        <div className="proj-tile-actions">
          {editing && <Badge appearance="filled" color="brand" size="small">{t('proj.an.editing')}</Badge>}
          {hasSelection && analysis && <Badge appearance="tint" color={relatedCount ? 'brand' : 'informative'} size="small" data-testid={`proj-link-count-${method}`}>{t('proj.link.count', { count: relatedCount })}</Badge>}
          {analysis && !editing && (
            <Tooltip content={t('proj.an.edit')} relationship="description">
              <Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => onOpen(analysis.id)} data-testid={`proj-edit-${method}`}>{t('proj.an.edit')}</Button>
            </Tooltip>
          )}
          {analysis && (
            <Tooltip content={t('proj.an.newOf', { method: name })} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add16Regular />} onClick={onStart} data-testid={`proj-new-${method}`} />
            </Tooltip>
          )}
        </div>
      </header>
      {analysis && result
        ? (
          <>
            <p className="proj-insight" data-testid="proj-insight">{describeInsight(result, t)}</p>
            {result.overall !== null && <p className="proj-overall" data-testid="proj-overall">{t('proj.an.overall', { score: fmtScore(result.overall) })}</p>}
            <Toolbar
              size="small"
              aria-label={t('proj.viewer.label')}
              checkedValues={{ viewer: [viewer] }}
              onCheckedValueChange={(_, d) => d.checkedItems[0] && setViewer(d.checkedItems[0] as Viewer)}
              className="proj-tile-viewers"
            >
              <ToolbarRadioGroup>
                {viewers.map((v) => (
                  <Tooltip key={v.id} content={v.label} relationship="label">
                    <ToolbarRadioButton name="viewer" value={v.id} appearance="subtle" icon={v.icon} />
                  </Tooltip>
                ))}
              </ToolbarRadioGroup>
            </Toolbar>
            <AnalysisViewer analysis={analysis} result={result} viewer={viewer} link={link} />
          </>
        )
        : (
          <div className="proj-tile-empty">
            <p className="muted">{t('proj.an.tileEmpty', { method: name })}</p>
            <Button appearance="primary" icon={<Add20Regular />} onClick={onStart} data-testid={`proj-start-${method}`}>{t('proj.an.start')}</Button>
          </div>
        )}
    </section>
  );
}

function AnalysisEditor({ analysis, analyses, onOpen, link, split }: { analysis: Analysis; analyses: Analysis[]; onOpen: (id: string) => void; link: LinkView; split: boolean }) {
  const { t, lang } = useI18n();
  const set = useAnalyses((s) => s.set);
  const [draftNote, setDraftNote] = useState<{ count: number; mock: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => validateItems(analysis.items), [analysis.items]);
  const cats = categoriesOf(analysis.method);

  const update = (fn: (a: Analysis) => Analysis) => set((v) => ({ ...v, analyses: v.analyses.map((a) => (a.id === analysis.id ? { ...fn(a), updatedAt: new Date().toISOString() } : a)) }));
  const updateItem = (id: string, patch: Partial<AnalysisItem>) => update((a) => ({ ...a, items: a.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const addItem = () => update((a) => ({ ...a, items: [...a.items, { id: newId('item'), category: cats[0]!, text: '', score: 3, weight: 1, author: 'human' }] }));
  const removeAnalysis = () => set((v) => {
    const rest = v.analyses.filter((a) => a.id !== analysis.id);
    return { ...v, analyses: rest, activeId: rest.find((a) => a.method === analysis.method)?.id ?? rest[0]?.id ?? null };
  });
  const draft = async () => {
    setBusy(true);
    try {
      const ents = [...entitiesOf('issue'), ...entitiesOf('solution')];
      const { response, items } = await requestAnalysisDraft(analysis.method, lang, ents);
      update((a) => ({ ...a, items: [...a.items, ...items.map((d) => ({ id: newId('item'), category: d.category, text: d.text, score: clampScore(d.score), weight: 1, author: 'ai' as const, mock: response.mode === 'mock' }))] }));
      setDraftNote({ count: items.length, mock: response.mode === 'mock' });
    } finally {
      setBusy(false);
    }
  };
  const rowMark = (id: string) => {
    if (link.selected.size === 0) return '';
    const key = itemKey(analysis.id, id);
    if (link.selected.has(key)) return 'is-selected';
    return link.related.has(key) ? 'is-related' : '';
  };

  return (
    <Panel title={`${t('proj.an.params')} — ${loc(analysis.title, lang)}`} rationale="proj.an.paramsWhy" testId="proj-params" className={split ? '' : 'span-full'} id="proj-editor">
      <Field label={t('proj.an.editTarget')} className="proj-existing">
        <Select value={analysis.id} onChange={(_, d) => onOpen(d.value)} data-testid="proj-analysis-select">
          {analyses.map((a) => <option key={a.id} value={a.id}>{`${loc(a.title, lang)} — ${t(methodKey(a.method))}`}</option>)}
        </Select>
      </Field>
      <h3 className="proj-h3">{t('proj.an.weights')}</h3>
      <div className="proj-weights">
        {cats.map((c) => (
          <Field key={c} label={t(categoryKey(c))} hint={t('proj.an.weightHint', { min: WEIGHT_MIN, max: WEIGHT_MAX })}>
            <div className="proj-slider-control">
              <Slider
                min={WEIGHT_MIN}
                max={WEIGHT_MAX}
                step={0.5}
                value={categoryWeight(analysis, c)}
                onChange={(_, d) => update((a) => ({ ...a, weights: { ...a.weights, [c]: d.value } }))}
                aria-label={t(categoryKey(c))}
                data-testid={`proj-weight-${c}`}
              />
              <output className="proj-slider-value">{categoryWeight(analysis, c)}</output>
            </div>
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
                <tr key={i.id} className={rowMark(i.id)}>
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
                    <div className="proj-slider-control">
                      <Slider
                        min={SCORE_MIN}
                        max={SCORE_MAX}
                        step={0.5}
                        value={i.score}
                        onChange={(_, d) => updateItem(i.id, { score: d.value })}
                        aria-label={t('proj.an.itemScore', { n: idx + 1 })}
                        data-testid={`proj-item-score-${idx + 1}`}
                      />
                      <output className="proj-slider-value">{i.score}</output>
                    </div>
                  </td>
                  <td>
                    <div className="proj-slider-control">
                      <Slider
                        min={WEIGHT_MIN}
                        max={WEIGHT_MAX}
                        step={0.5}
                        value={i.weight}
                        onChange={(_, d) => updateItem(i.id, { weight: d.value })}
                        aria-label={t('proj.an.itemWeight', { n: idx + 1 })}
                      />
                      <output className="proj-slider-value">{i.weight}</output>
                    </div>
                  </td>
                  <td><AuthorBadge author={i.author} mock={i.mock ?? i.author === 'ai'} /></td>
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
}
