import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Badge, Button, Tooltip } from '@fluentui/react-components';
import { ChevronDown20Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n/index.ts';
import { useDeferredCheckContext } from '../modules/project/deliverablesUi.tsx';
import { OutcomeDetail, OutcomeSummaryCard, outcomeSignature, useOutcomeItems, type OutcomeItem } from '../modules/project/OutcomeCards.tsx';
import { outcomeHref } from '../modules/project/simulationHref.ts';
import { useProjUi } from '../modules/project/stores.ts';
import { useFeed } from '../state/feed.ts';
import { useReducedMotion } from '../state/motion.ts';
import { useSettings, type Audience } from '../state/settings.ts';
import { loc } from '../state/text.ts';

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

function OutcomePreview({ highlight, audience }: { highlight: OutcomeItem | null; audience: Audience }) {
  const { t, lang, fmt } = useI18n();
  const summary = highlight?.kind === 'kpi'
    ? highlight.outcome.simulation
      ? t('proj.outcomes.previewForecast', { name: loc(highlight.outcome.definition.name, lang), p50: fmt.number(highlight.outcome.simulation.p50), unit: loc(highlight.outcome.definition.unit, lang), probability: fmt.percent(highlight.outcome.simulation.probability) })
      : t('proj.outcomes.previewKpi', { name: loc(highlight.outcome.definition.name, lang), current: fmt.number(highlight.outcome.definition.current), target: fmt.number(highlight.outcome.definition.target), unit: loc(highlight.outcome.definition.unit, lang) })
    : highlight?.kind === 'solution'
      ? t('proj.outcomes.previewBenefit', { name: loc(highlight.solution.name, lang), amount: fmt.yenCompact(highlight.solution.annualBenefitJpy) })
      : highlight?.kind === 'issue'
        ? t('proj.outcomes.previewIssue', { name: loc(highlight.issue.name, lang) })
        : t('proj.outcomes.noData');
  return (
    <Tooltip content={{ children: highlight ? <OutcomeDetail item={highlight} audience={audience} /> : <p>{t('proj.outcomes.noData')}</p>, className: 'outcome-popup' }} relationship="description">
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

/** FR-382: a compact summary card; hovering or focusing it pops up the full detail, and selecting it opens the outcome in Step 2. */
function StripCard({ item, index, change, gen, audience }: { item: OutcomeItem; index: number; change: Change | undefined; gen: number; audience: Audience }) {
  const { t } = useI18n();
  return (
    <li className="outcome-strip-item" style={{ '--i': index } as CSSProperties} data-change={change} data-testid={`outcome-item-${item.key}`}>
      <Tooltip
        content={{ children: <OutcomeDetail item={item} audience={audience} testId={`outcome-popup-${item.key}`} />, className: 'outcome-popup' }}
        relationship="description"
        positioning="below-start"
        withArrow
      >
        <OutcomeSummaryCard item={item} href={outcomeHref(item.key)} testId={`outcome-${item.key}`} />
      </Tooltip>
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
  const { items } = useOutcomeItems(ctx, lang, audience);
  const simulatedKpi = items.find((item) => item.kind === 'kpi' && item.outcome.simulation);
  const highlight: OutcomeItem | null = simulatedKpi
    ?? items.find((item) => item.kind === 'solution')
    ?? items.find((item) => item.kind === 'kpi')
    ?? items.find((item) => item.kind === 'issue')
    ?? null;
  const signatures = useMemo(() => new Map(items.map((item) => [item.key, outcomeSignature(item)])), [items]);
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
        <strong className="business-outcomes-title chrome-section-label">{t('proj.outcomes.title')}</strong>
        <OutcomePreview highlight={highlight} audience={audience} />
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
                      <StripCard key={item.key} item={item} index={index} change={marks.byKey.get(item.key)} gen={marks.gen} audience={audience} />
                    ))}
                  </ul>
                </div>
              )
              : <p role="status">{t('proj.outcomes.noData')}</p>}
          </div>
        </div>
      </div>
      <FeedLatencyRecorder />
    </>
  );
}
