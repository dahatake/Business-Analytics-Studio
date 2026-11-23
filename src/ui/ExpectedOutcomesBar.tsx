import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Button, Tooltip } from '@fluentui/react-components';
import { ChevronDown20Regular } from '@fluentui/react-icons';
import { getEntity } from '../data/pack.ts';
import type { EntityOf } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useDeferredCheckContext } from '../modules/project/deliverablesUi.tsx';
import { expectedOutcomes, type ExpectedOutcomes, type KpiOutcome } from '../modules/project/expectedOutcomes.ts';
import { useProjUi } from '../modules/project/stores.ts';
import { useFeed } from '../state/feed.ts';
import { useReducedMotion } from '../state/motion.ts';
import { useSettings } from '../state/settings.ts';
import { loc } from '../state/text.ts';
import { isHidden } from './cardSpecs.ts';
import { NewsFeedBar } from './NewsFeedBar.tsx';

type Highlight =
  | { kind: 'kpi'; outcome: KpiOutcome }
  | { kind: 'solution'; solution: ExpectedOutcomes['solutions'][number] }
  | { kind: 'issue'; issue: ExpectedOutcomes['issues'][number] };

function outcomeName(outcome: KpiOutcome, lang: 'ja' | 'en') {
  return loc(outcome.definition.name, lang);
}

function sourceNames(outcome: KpiOutcome, lang: 'ja' | 'en') {
  return (outcome.definition.sourceIds ?? [])
    .map((id) => getEntity(id))
    .filter((e) => e?.kind === 'source')
    .map((e) => loc(e.name, lang));
}

function OutcomeTooltip({ highlight }: { highlight: Highlight | null }) {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  if (!highlight) return <p>{t('proj.outcomes.noData')}</p>;

  if (highlight.kind === 'kpi') {
    const { definition: k, simulation: sim, contributions } = highlight.outcome;
    return (
      <div className="outcome-tooltip">
        <strong>{outcomeName(highlight.outcome, lang)}</strong>
        <p>{t('proj.outcomes.baseline', { baseline: fmt.number(k.baseline) })}</p>
        <p>{t('proj.outcomes.currentTarget', { current: fmt.number(k.current), target: fmt.number(k.target), unit: loc(k.unit, lang) })}</p>
        <p>{t('proj.outcomes.deadline', { date: k.deadline })}</p>
        {sim
          ? <p>{t('proj.outcomes.forecast', { p10: fmt.number(sim.p10), p50: fmt.number(sim.p50), p90: fmt.number(sim.p90), unit: loc(k.unit, lang), probability: fmt.percent(sim.probability) })}</p>
          : <p>{t('proj.outcomes.noEstimate')}</p>}
        {sim?.warnings.map((warning) => <p key={warning} className="outcome-warning">{t(`sol.warn.${warning}`)}</p>)}
        {contributions.map((contribution) => {
          const solution = getEntity(contribution.solutionId);
          return (
            <p key={contribution.id}>
              {solution && 'name' in solution ? loc(solution.name, lang) : contribution.solutionId}
              {contribution.lever && ` · ${contribution.lever}`}
              {` · ${t(`sol.c.basis.${contribution.basis}`)}`}
              {contribution.evidence && ` · ${contribution.evidence}`}
            </p>
          );
        })}
        <p className="muted">{t('proj.outcomes.sources', { sources: sourceNames(highlight.outcome, lang).join(lang === 'ja' ? '、' : ', ') || t('proj.outcomes.noSources') })}</p>
      </div>
    );
  }

  if (highlight.kind === 'solution') {
    const solution = highlight.solution;
    const relatedIssues = solution.issueIds
      .map((id) => getEntity(id))
      .filter((e): e is EntityOf<'issue'> => e?.kind === 'issue' && !isHidden(e, audience));
    return (
      <div className="outcome-tooltip">
        <strong>{loc(solution.name, lang)}</strong>
        <p>{loc(solution.description, lang)}</p>
        <p>{t('proj.outcomes.sourceBenefit', { amount: fmt.yenCompact(solution.annualBenefitJpy) })}</p>
        <p>{t('proj.outcomes.sourceCost', { amount: fmt.yenCompact(solution.costJpy) })}</p>
        {relatedIssues.length > 0 && <p>{t('proj.outcomes.relatedIssues', { issues: relatedIssues.map((issue) => loc(issue.name, lang)).join(lang === 'ja' ? '、' : ', ') })}</p>}
        <p className="muted">{t('proj.outcomes.sourceOnly')}</p>
      </div>
    );
  }

  return (
    <div className="outcome-tooltip">
      <strong>{loc(highlight.issue.name, lang)}</strong>
      <p>{loc(highlight.issue.description, lang)}</p>
      <p className="muted">{t('proj.outcomes.issueCandidate')}</p>
    </div>
  );
}

function OutcomeStatus({ outcome }: { outcome: KpiOutcome }) {
  const { t } = useI18n();
  if (outcome.simulation) return <Badge appearance="tint" color="success">{t('proj.outcomes.simulated')}</Badge>;
  if (outcome.definition.origin === 'proposed') return <Badge appearance="outline" color="warning">{t('proj.outcomes.proposed')}</Badge>;
  return <Badge appearance="outline" color="informative">{t('proj.outcomes.unestimated')}</Badge>;
}

function KpiCard({ outcome }: { outcome: KpiOutcome }) {
  const { t, lang, fmt } = useI18n();
  const { definition: k, simulation: sim, contributions } = outcome;
  const sources = sourceNames(outcome, lang);
  return (
    <article className="outcome-card" data-testid={`outcome-kpi-${k.id}`}>
      <span className="outcome-card-kind">{t('proj.outcomes.kindKpi')}</span>
      <header className="outcome-card-header">
        <h4>{outcomeName(outcome, lang)}</h4>
        <OutcomeStatus outcome={outcome} />
      </header>
      <p>{t('proj.outcomes.baseline', { baseline: fmt.number(k.baseline) })}</p>
      <p>{t('proj.outcomes.currentTarget', { current: fmt.number(k.current), target: fmt.number(k.target), unit: loc(k.unit, lang) })}</p>
      <p>{t('proj.outcomes.deadline', { date: k.deadline })}</p>
      {sim
        ? <>
          <p><strong>{t('proj.outcomes.forecastLabel')}</strong> {t('proj.outcomes.forecast', { p10: fmt.number(sim.p10), p50: fmt.number(sim.p50), p90: fmt.number(sim.p90), unit: loc(k.unit, lang), probability: fmt.percent(sim.probability) })}</p>
          {sim.warnings.length > 0 && <ul className="outcome-warnings">{sim.warnings.map((warning) => <li key={warning}>{t(`sol.warn.${warning}`)}</li>)}</ul>}
        </>
        : <p className="muted">{t('proj.outcomes.noEstimate')}</p>}
      <p className="muted">{t('proj.outcomes.sources', { sources: sources.join(lang === 'ja' ? '、' : ', ') || t('proj.outcomes.noSources') })}</p>
      {contributions.length > 0 && (
        <ul className="outcome-contributions">
          {contributions.map((contribution) => {
            const solution = getEntity(contribution.solutionId);
            return (
              <li key={contribution.id}>
                <strong>{solution && 'name' in solution ? loc(solution.name, lang) : contribution.solutionId}</strong>
                {contribution.lever && ` · ${contribution.lever}`}
                {` · ${t(`sol.c.basis.${contribution.basis}`)}`}
                {contribution.evidence && ` · ${contribution.evidence}`}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function OkrCard({ outcome }: { outcome: ExpectedOutcomes['okrs'][number] }) {
  const { t, lang, fmt } = useI18n();
  return (
    <article className="outcome-card" data-testid={`outcome-okr-${outcome.definition.id}`}>
      <span className="outcome-card-kind">{t('proj.outcomes.kindOkr')}</span>
      <header className="outcome-card-header">
        <h4>{loc(outcome.definition.objective, lang)}</h4>
        {outcome.definition.origin === 'proposed' && <Badge appearance="outline" color="warning">{t('proj.outcomes.proposed')}</Badge>}
      </header>
      <ul className="outcome-key-results">
        {outcome.keyResults.map((kr, index) => (
          <li key={`${outcome.definition.id}-${index}`}>
            <strong>{kr.kpi ? outcomeName(kr.kpi, lang) : kr.text}</strong>
            {kr.kpi?.simulation
              ? <span> — {t('proj.outcomes.forecast', { p10: fmt.number(kr.kpi.simulation.p10), p50: fmt.number(kr.kpi.simulation.p50), p90: fmt.number(kr.kpi.simulation.p90), unit: loc(kr.kpi.definition.unit, lang), probability: fmt.percent(kr.kpi.simulation.probability) })}</span>
              : kr.kpi
                ? <span className="muted"> — {t('proj.outcomes.unestimated')}</span>
                : <span className="muted"> — {t('proj.outcomes.missingKpi')}</span>}
          </li>
        ))}
      </ul>
      <p className="muted">{t('proj.outcomes.noOkrAggregate')}</p>
    </article>
  );
}

function SolutionCard({ solution }: { solution: ExpectedOutcomes['solutions'][number] }) {
  const { t, lang, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const relatedIssues = solution.issueIds
    .map((id) => getEntity(id))
    .filter((e): e is EntityOf<'issue'> => e?.kind === 'issue' && !isHidden(e, audience))
    .map((e) => loc(e.name, lang));
  const sources = solution.sourceIds
    .map((id) => getEntity(id))
    .filter((e): e is EntityOf<'source'> => e?.kind === 'source')
    .map((e) => loc(e.name, lang));
  return (
    <article className="outcome-card" data-testid={`outcome-solution-${solution.id}`}>
      <span className="outcome-card-kind">{t('proj.outcomes.kindSolution')}</span>
      <header className="outcome-card-header">
        <h4>{loc(solution.name, lang)}</h4>
        <Badge appearance="outline" color="informative">{t('proj.outcomes.sourceLabel')}</Badge>
      </header>
      <p>{loc(solution.description, lang)}</p>
      <p><strong>{t('proj.outcomes.sourceBenefit', { amount: fmt.yenCompact(solution.annualBenefitJpy) })}</strong></p>
      <p>{t('proj.outcomes.sourceCost', { amount: fmt.yenCompact(solution.costJpy) })}</p>
      {relatedIssues.length > 0 && <p>{t('proj.outcomes.relatedIssues', { issues: relatedIssues.join(lang === 'ja' ? '、' : ', ') })}</p>}
      <p className="muted">{t('proj.outcomes.sources', { sources: sources.join(lang === 'ja' ? '、' : ', ') || t('proj.outcomes.noSources') })}</p>
      <p className="muted">{t('proj.outcomes.sourceOnly')}</p>
    </article>
  );
}

function IssueCard({ issue }: { issue: ExpectedOutcomes['issues'][number] }) {
  const { t, lang } = useI18n();
  return (
    <article className="outcome-card" data-testid={`outcome-issue-${issue.id}`}>
      <span className="outcome-card-kind">{t('proj.outcomes.kindIssue')}</span>
      <header className="outcome-card-header">
        <h4>{loc(issue.name, lang)}</h4>
        <Badge appearance="outline" color="warning">{t('proj.outcomes.proposed')}</Badge>
      </header>
      <p>{loc(issue.description, lang)}</p>
      <p className="muted">{t('proj.outcomes.issueCandidate')}</p>
    </article>
  );
}

function FeedLatencyRecorder() {
  const latest = useFeed((s) => s.events[0] ?? null);
  const recordLatency = useFeed((s) => s.recordLatency);

  useLayoutEffect(() => {
    if (!latest || latest.seq === 1) return;
    const id = requestAnimationFrame(() => recordLatency(performance.now() - latest.perf));
    return () => cancelAnimationFrame(id);
  }, [latest, recordLatency]);

  return null;
}

function OutcomePreview({ highlight }: { highlight: Highlight | null }) {
  const { t, lang, fmt } = useI18n();
  const summary = highlight?.kind === 'kpi'
    ? highlight.outcome.simulation
      ? t('proj.outcomes.previewForecast', { name: outcomeName(highlight.outcome, lang), p50: fmt.number(highlight.outcome.simulation.p50), unit: loc(highlight.outcome.definition.unit, lang), probability: fmt.percent(highlight.outcome.simulation.probability) })
      : t('proj.outcomes.previewKpi', { name: outcomeName(highlight.outcome, lang), current: fmt.number(highlight.outcome.definition.current), target: fmt.number(highlight.outcome.definition.target), unit: loc(highlight.outcome.definition.unit, lang) })
    : highlight?.kind === 'solution'
      ? t('proj.outcomes.previewBenefit', { name: loc(highlight.solution.name, lang), amount: fmt.yenCompact(highlight.solution.annualBenefitJpy) })
      : highlight?.kind === 'issue'
        ? t('proj.outcomes.previewIssue', { name: loc(highlight.issue.name, lang) })
        : t('proj.outcomes.noData');
  return (
    <Tooltip content={<OutcomeTooltip highlight={highlight} />} relationship="description">
      <span className="outcome-preview" tabIndex={0} data-testid="outcome-preview">
        {/* Re-keyed so a new headline slides in instead of silently replacing the old one. */}
        <span key={summary} className="outcome-preview-text">{summary}</span>
      </span>
    </Tooltip>
  );
}

type Change = 'changed' | 'new';
interface Marks { gen: number; byKey: ReadonlyMap<string, Change> }
const NO_MARKS: Marks = { gen: 0, byKey: new Map() };
/** How long a changed or new card stays highlighted. */
const CHANGE_HIGHLIGHT_MS = 2600;

/** Compares language-independent value signatures between renders and marks the cards whose values changed or that appeared. */
function useChangeMarks(signatures: ReadonlyMap<string, string>): Marks {
  const previous = useRef<ReadonlyMap<string, string> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const key = JSON.stringify([...signatures]);
  useEffect(() => {
    const before = previous.current;
    previous.current = signatures;
    if (!before) return;
    const byKey = new Map<string, Change>();
    for (const [id, signature] of signatures) {
      const old = before.get(id);
      if (old === undefined) byKey.set(id, 'new');
      else if (old !== signature) byKey.set(id, 'changed');
    }
    if (!byKey.size) return;
    window.clearTimeout(timer.current);
    setMarks((m) => ({ gen: m.gen + 1, byKey }));
    timer.current = window.setTimeout(() => setMarks((m) => ({ gen: m.gen, byKey: new Map() })), CHANGE_HIGHLIGHT_MS);
    // `key` is the serialized form of `signatures`, so this runs only when a value really changes.
  }, [key]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return marks;
}

interface StripItem { key: string; node: ReactNode }

function StripCard({ item, index, change, gen }: { item: StripItem; index: number; change: Change | undefined; gen: number }) {
  const { t } = useI18n();
  return (
    <li className="outcome-strip-item" style={{ '--i': index } as CSSProperties} data-change={change} data-testid={`outcome-item-${item.key}`}>
      {item.node}
      {change && (
        <>
          <span key={`flash-${gen}`} className="outcome-flash" aria-hidden />
          <Badge key={`badge-${gen}`} className="outcome-change-badge" appearance="filled" color={change === 'new' ? 'success' : 'brand'} size="small">
            {t(change === 'new' ? 'proj.outcomes.badgeNew' : 'proj.outcomes.badgeChanged')}
          </Badge>
        </>
      )}
    </li>
  );
}

export function ExpectedOutcomesBar() {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const ctx = useDeferredCheckContext();
  const open = useProjUi((s) => s.outcomesOpen);
  const setOpen = useProjUi((s) => s.setOutcomesOpen);
  const reduced = useReducedMotion();
  const stripId = useId();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const data = useMemo(() => expectedOutcomes(ctx, lang), [ctx, lang]);
  const visible = useMemo(() => {
    const entityIsVisible = (id: string) => {
      const entity = getEntity(id);
      return !entity || !isHidden(entity, audience);
    };
    const kpis = data.kpis.filter((k) =>
      entityIsVisible(k.definition.id)
      && (k.definition.sourceIds ?? []).every(entityIsVisible)
      && k.contributions.every((c) => entityIsVisible(c.solutionId)));
    const kpiIds = new Set(kpis.map((k) => k.definition.id));
    const okrs = data.okrs.map((okr) => ({
      ...okr,
      keyResults: okr.keyResults.filter((kr) => !kr.kpi || kpiIds.has(kr.kpi.definition.id)),
    })).filter((okr) => okr.keyResults.length > 0);
    const solutions = data.solutions.filter((solution) =>
      entityIsVisible(solution.id) && solution.sourceIds.every(entityIsVisible));
    const issues = data.issues.filter((issue) => entityIsVisible(issue.id));
    return { kpis, okrs, solutions, issues };
  }, [audience, data]);
  const simulatedKpi = visible.kpis.find((k) => k.simulation);
  const highlight: Highlight | null = simulatedKpi
    ? { kind: 'kpi', outcome: simulatedKpi }
    : visible.solutions[0]
      ? { kind: 'solution', solution: visible.solutions[0] }
      : visible.kpis[0]
        ? { kind: 'kpi', outcome: visible.kpis[0] }
        : visible.issues[0]
          ? { kind: 'issue', issue: visible.issues[0] }
          : null;

  const { items, signatures } = useMemo(() => {
    const list: StripItem[] = [];
    const sig = new Map<string, string>();
    const simSig = (o: KpiOutcome) => o.simulation ? [o.simulation.p10, o.simulation.p50, o.simulation.p90, o.simulation.probability, o.simulation.warnings] : null;
    for (const o of visible.kpis) {
      const k = o.definition;
      const key = `kpi-${k.id}`;
      list.push({ key, node: <KpiCard outcome={o} /> });
      sig.set(key, JSON.stringify([k.baseline, k.current, k.target, k.deadline, k.origin, k.sourceIds ?? [], simSig(o), o.contributions.map((c) => [c.id, c.basis, c.evidence])]));
    }
    for (const o of visible.okrs) {
      const key = `okr-${o.definition.id}`;
      list.push({ key, node: <OkrCard outcome={o} /> });
      sig.set(key, JSON.stringify([o.definition.origin, o.keyResults.map((kr) => kr.kpi ? [kr.kpi.definition.id, simSig(kr.kpi)] : kr.text)]));
    }
    for (const s of visible.solutions) {
      const key = `solution-${s.id}`;
      list.push({ key, node: <SolutionCard solution={s} /> });
      sig.set(key, JSON.stringify([s.annualBenefitJpy, s.costJpy, s.issueIds, s.sourceIds]));
    }
    for (const issue of visible.issues) {
      const key = `issue-${issue.id}`;
      list.push({ key, node: <IssueCard issue={issue} /> });
      sig.set(key, '');
    }
    return { items: list, signatures: sig };
  }, [visible]);
  const marks = useChangeMarks(signatures);
  const changed = [...marks.byKey.values()].filter((c) => c === 'changed').length;
  const added = marks.byKey.size - changed;

  // Bring the first changed card into view so the change is seen, not just marked.
  useEffect(() => {
    if (!open || !marks.byKey.size) return;
    const first = items.find((item) => marks.byKey.has(item.key));
    const el = first && scrollRef.current?.querySelector<HTMLElement>(`[data-testid="outcome-item-${first.key}"]`);
    el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
  }, [marks.gen]);

  return (
    <>
      <div className="business-outcomes-bar" role="region" aria-label={t('proj.outcomes.title')} data-testid="business-outcomes">
        <strong className="business-outcomes-title">{t('proj.outcomes.title')}</strong>
        <OutcomePreview highlight={highlight} />
        <Button
          size="small"
          appearance="subtle"
          className="outcomes-toggle"
          icon={<ChevronDown20Regular className="outcomes-toggle-icon" />}
          aria-expanded={open}
          aria-controls={stripId}
          data-open={open}
          onClick={() => setOpen(!open)}
          data-testid="outcomes-expand"
        >
          {t(open ? 'proj.outcomes.collapse' : 'proj.outcomes.expand')}
          <span key={items.length} className="outcomes-count">{t('proj.outcomes.count', { n: items.length })}</span>
        </Button>
        <span className="visually-hidden" role="status">{marks.byKey.size ? t('proj.outcomes.announce', { changed, added }) : ''}</span>
      </div>
      <div
        id={stripId}
        className="outcome-strip"
        data-open={open}
        data-testid="outcomes-strip"
        role="region"
        aria-label={t('proj.outcomes.listLabel')}
        inert={!open}
      >
        <div className="outcome-strip-inner">
          <div className="outcome-strip-body">
            <p className="outcome-strip-intro">{t('proj.outcomes.intro')}</p>
            {items.length > 0
              ? (
                <div className="outcome-strip-scroll" ref={scrollRef} tabIndex={open ? 0 : undefined}>
                  <ul className="outcome-strip-list">
                    {items.map((item, index) => (
                      <StripCard key={item.key} item={item} index={index} change={marks.byKey.get(item.key)} gen={marks.gen} />
                    ))}
                  </ul>
                </div>
              )
              : <p role="status">{t('proj.outcomes.noData')}</p>}
          </div>
        </div>
      </div>
      <NewsFeedBar />
      <FeedLatencyRecorder />
    </>
  );
}
