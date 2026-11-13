import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { scaleBand, scaleLinear } from 'd3';
import { Flow16Regular, Link16Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { motionMs, useReducedMotion } from '../../state/motion.ts';
import { loc } from '../../state/text.ts';
import { SCORE_MAX, type AnalysisResult } from './analysis.ts';
import { categoryKey, fmtScore } from './analysisText.ts';
import { itemKey, type Link } from './analysisLinks.ts';
import { highlightedScore, layoutPlot, type PlotDot } from './analysisPlot.ts';
import { animateBars, joinDots, nextDot, paintDots, type DotEvents, type DotMark } from './analysisPlotRender.ts';
import type { Analysis, AnalysisItem } from './model.ts';
import { ScrollRegion } from './common.tsx';

export type Viewer = 'plot' | 'table' | 'matrix' | 'chart';

/** Shared selection of the linked views (BI-style cross-highlighting). */
export interface LinkView {
  /** itemKey()s of the selected items. */
  selected: ReadonlySet<string>;
  related: ReadonlyMap<string, Link>;
  /** Selects these items of the analysis, or clears the selection when they are exactly what is selected. */
  toggle: (analysisId: string, itemIds: string[]) => void;
  /** Clears the selection (a click on the empty area of a visual, as in BI tools). */
  clear: () => void;
  entityName: (id: string) => string;
}

type Mark = 'selected' | 'related' | 'dimmed' | null;

function itemMark(link: LinkView | undefined, key: string): Mark {
  if (!link || link.selected.size === 0) return null;
  if (link.selected.has(key)) return 'selected';
  return link.related.has(key) ? 'related' : 'dimmed';
}

/** A category is selected when all its items are, related when any of them is selected or related. */
function categoryMark(link: LinkView | undefined, analysis: Analysis, items: AnalysisItem[]): Mark {
  if (!link || link.selected.size === 0) return null;
  const keys = items.map((i) => itemKey(analysis.id, i.id));
  if (keys.length && keys.every((k) => link.selected.has(k))) return 'selected';
  return keys.some((k) => link.selected.has(k) || link.related.has(k)) ? 'related' : 'dimmed';
}

const markClass = (m: Mark) => (m ? ` is-${m}` : '');

function useCategoryItems(analysis: Analysis) {
  return useMemo(() => {
    const by = new Map<string, AnalysisItem[]>();
    for (const i of analysis.items) by.set(i.category, [...(by.get(i.category) ?? []), i]);
    return (id: string) => by.get(id) ?? [];
  }, [analysis.items]);
}

/** FR-135: the same result as a dot plot, a table, a matrix or a chart. With `link`, items and categories select and highlight across views. */
export function AnalysisViewer({ analysis, result, viewer, link }: { analysis: Analysis; result: AnalysisResult; viewer: Viewer; link?: LinkView }) {
  if (viewer === 'plot') return <ResultPlot analysis={analysis} link={link} />;
  if (viewer === 'table') return <ResultTable analysis={analysis} result={result} link={link} />;
  if (viewer === 'chart') return <ResultChart analysis={analysis} result={result} link={link} />;
  return <ResultMatrix analysis={analysis} result={result} link={link} />;
}

type T = ReturnType<typeof useI18n>['t'];

const relText = (rel: Link, link: LinkView, t: T) => (rel.entityId
  ? t(rel.kind === 'same' ? 'proj.link.same' : 'proj.link.near', { name: link.entityName(rel.entityId) })
  : t('proj.link.sameText'));

function RelatedHint({ rel, link }: { rel: Link | undefined; link: LinkView }) {
  const { t } = useI18n();
  if (!rel) return null;
  const text = relText(rel, link, t);
  return (
    <span className={`proj-link-hint ${rel.kind}`} title={text}>
      {rel.kind === 'same' ? <Link16Regular aria-hidden /> : <Flow16Regular aria-hidden />}
      <span className="visually-hidden">{text}</span>
    </span>
  );
}

function ResultTable({ analysis, result, link }: { analysis: Analysis; result: AnalysisResult; link?: LinkView }) {
  const { t, lang } = useI18n();
  const itemsOf = useCategoryItems(analysis);
  return (
    <ScrollRegion label={t('proj.viewer.tableCaption', { title: loc(analysis.title, lang) })}>
      <table className="data-table compact" data-testid="proj-result-table">
        <caption>{t('proj.viewer.tableCaption', { title: loc(analysis.title, lang) })}</caption>
        <thead>
          <tr>
            <th scope="col">{t('proj.an.category')}</th>
            <th scope="col" className="num">{t('proj.an.score')}</th>
            <th scope="col" className="num">{t('proj.an.weight')}</th>
            <th scope="col" className="num">{t('proj.an.count')}</th>
          </tr>
        </thead>
        <tbody>
          {result.categories.map((c) => {
            const items = itemsOf(c.id);
            const mark = categoryMark(link, analysis, items);
            return (
              <tr key={c.id} className={`proj-link-row${markClass(mark)}`}>
                <th scope="row">
                  {link && items.length > 0
                    ? (
                      <button type="button" className="proj-link-cat" aria-pressed={mark === 'selected'} onClick={() => link.toggle(analysis.id, items.map((i) => i.id))}>
                        {t(categoryKey(c.id))}
                      </button>
                    )
                    : t(categoryKey(c.id))}
                </th>
                <td className="num" data-testid={`proj-score-${c.id}`}>{fmtScore(c.score)}</td>
                <td className="num">{c.weight}</td>
                <td className="num">{c.count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function ResultMatrix({ analysis, result, link }: { analysis: Analysis; result: AnalysisResult; link?: LinkView }) {
  const { t, lang } = useI18n();
  const swot = analysis.method === 'swot';
  const itemsOf = useCategoryItems(analysis);
  return (
    <div className={swot ? 'proj-matrix proj-matrix-swot' : 'proj-matrix'} data-testid="proj-result-matrix">
      {swot && (
        <>
          <span className="proj-matrix-axis col1" aria-hidden>{t('proj.viewer.positive')}</span>
          <span className="proj-matrix-axis col2" aria-hidden>{t('proj.viewer.negative')}</span>
        </>
      )}
      {result.categories.map((c) => {
        const items = itemsOf(c.id);
        const mark = categoryMark(link, analysis, items);
        const label = t(categoryKey(c.id));
        return (
          <section key={c.id} className={`proj-matrix-cell cat-${c.id}${markClass(mark)}`} aria-label={label}>
            <h4 className="proj-h3">
              {link && items.length > 0
                ? <button type="button" className="proj-link-cat" aria-pressed={mark === 'selected'} onClick={() => link.toggle(analysis.id, items.map((i) => i.id))}>{label}</button>
                : label}
              <span className="proj-matrix-score">{t('proj.viewer.scoreShort', { score: fmtScore(c.score) })}</span>
            </h4>
            <ul className={link ? 'proj-link-list' : undefined}>
              {items.map((i) => {
                const key = itemKey(analysis.id, i.id);
                const m = itemMark(link, key);
                return link
                  ? (
                    <li key={i.id} className={`proj-link-li${markClass(m)}`}>
                      <button type="button" className="proj-link-item" aria-pressed={m === 'selected'} onClick={() => link.toggle(analysis.id, [i.id])} data-testid={`proj-link-item-${i.id}`}>
                        <span className="proj-link-text">{loc(i.text, lang)}</span>
                        <RelatedHint rel={link.related.get(key)} link={link} />
                      </button>
                    </li>
                  )
                  : <li key={i.id}>{loc(i.text, lang)}</li>;
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Selected or related items count as highlighted (Power BI-style cross-highlight). */
function useHighlighted(analysis: Analysis, link: LinkView | undefined) {
  return useMemo(() => {
    if (!link || link.selected.size === 0) return null;
    return (item: AnalysisItem) => {
      const k = itemKey(analysis.id, item.id);
      return link.selected.has(k) || link.related.has(k);
    };
  }, [analysis.id, link]);
}

function ResultChart({ analysis, result, link }: { analysis: Analysis; result: AnalysisResult; link?: LinkView }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const itemsOf = useCategoryItems(analysis);
  const highlighted = useHighlighted(analysis, link);
  const width = 520;
  const rowH = 30;
  const labelW = 170;
  const height = result.categories.length * rowH + 30;
  const { x, y } = useMemo(() => ({
    x: scaleLinear().domain([0, SCORE_MAX]).range([labelW, width - 70]),
    y: scaleBand().domain(result.categories.map((c) => c.id)).range([10, height - 20]).padding(0.25),
  }), [result.categories, height]);
  const hl = useMemo(
    () => new Map(result.categories.map((c) => [c.id, highlighted ? highlightedScore(analysis.items, c.id, highlighted) : null])),
    [result.categories, analysis.items, highlighted],
  );
  useEffect(() => {
    if (!ref.current) return;
    animateBars(ref.current, result.categories.map((c) => {
      const h = hl.get(c.id) ?? null;
      const w = Math.max(0, x(c.score ?? 0) - labelW);
      return { id: c.id, w, hlW: h === null ? 0 : Math.max(0, x(h) - labelW), textX: labelW + Math.max(w, h === null ? 0 : x(h) - labelW) + 6 };
    }), motionMs(reduced, 520));
  }, [result.categories, hl, x, reduced]);
  const summary = result.categories.map((c) => `${t(categoryKey(c.id))} ${fmtScore(c.score)}`).join(', ');
  const label = t('proj.viewer.chartLabel', { summary });
  return (
    <div className="chart-scroll">
      <svg ref={ref} className={`proj-chart${highlighted ? ' has-highlight' : ''}`} viewBox={`0 0 ${width} ${height}`} role={link ? 'group' : 'img'} aria-label={label} data-testid="proj-result-chart">
        {link && <rect className="proj-chart-bg" x={0} y={0} width={width} height={height} onClick={link.clear} aria-hidden />}
        {x.ticks(SCORE_MAX).map((v) => (
          <g key={v} aria-hidden>
            <line x1={x(v)} x2={x(v)} y1={10} y2={height - 20} className="proj-chart-grid" />
            <text x={x(v)} y={height - 6} className="proj-chart-tick" textAnchor="middle">{v}</text>
          </g>
        ))}
        {result.categories.map((c) => {
          const yy = y(c.id) ?? 0;
          const items = itemsOf(c.id);
          const mark = categoryMark(link, analysis, items);
          const interactive = !!link && items.length > 0;
          const h = hl.get(c.id) ?? null;
          const select = () => link?.toggle(analysis.id, items.map((i) => i.id));
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
          };
          const value = highlighted && h !== null ? t('proj.viewer.hlValue', { hl: fmtScore(h), all: fmtScore(c.score) }) : fmtScore(c.score);
          return (
            <g
              key={c.id}
              data-cat={c.id}
              className={`proj-chart-row${markClass(mark)}${interactive ? ' interactive' : ''}`}
              {...(interactive
                ? { role: 'button', tabIndex: 0, 'aria-pressed': mark === 'selected', 'aria-label': `${t(categoryKey(c.id))} ${value}`, onClick: select, onKeyDown: onKey }
                : {})}
            >
              <text x={labelW - 8} y={yy + y.bandwidth() / 2} dy="0.35em" textAnchor="end" className="proj-chart-label">{t(categoryKey(c.id))}</text>
              <rect x={labelW} y={yy} height={y.bandwidth()} rx={3} className="proj-chart-bar" />
              <rect x={labelW} y={yy + y.bandwidth() * 0.2} height={y.bandwidth() * 0.6} rx={2} className="proj-chart-hl" data-testid={`proj-chart-hl-${c.id}`} data-value={h ?? ''} />
              <text y={yy + y.bandwidth() / 2} dy="0.35em" className="proj-chart-value">{value}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Item-level dot plot (beeswarm): x = score, row = category, area = weight, line = category mean.
 * d3 owns the dots (keyed join with transitions); React owns the frame, labels and tooltip.
 */
function ResultPlot({ analysis, link }: { analysis: Analysis; link?: LinkView }) {
  const { t, lang } = useI18n();
  const reduced = useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const layout = useMemo(() => layoutPlot(analysis), [analysis]);
  const itemsOf = useCategoryItems(analysis);
  const [hover, setHover] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const live = useRef({ link, analysisId: analysis.id });
  useLayoutEffect(() => { live.current = { link, analysisId: analysis.id }; });

  const events = useMemo<DotEvents>(() => ({
    select: (id) => {
      setFocusId(id);
      live.current.link?.toggle(live.current.analysisId, [id]);
    },
    hover: setHover,
  }), []);

  useEffect(() => {
    if (ref.current) joinDots(ref.current, layout, motionMs(reduced, 480), events);
  }, [layout, reduced, events]);

  const byId = useMemo(() => new Map(analysis.items.map((i) => [i.id, i])), [analysis.items]);
  const selectedHere = link ? layout.dots.find((d) => link.selected.has(itemKey(analysis.id, d.itemId)))?.itemId : undefined;
  const tabStop = (focusId && layout.dots.some((d) => d.itemId === focusId) ? focusId : selectedHere ?? nextDot(layout, '', 'Home'));

  useEffect(() => {
    if (!ref.current) return;
    const mark = (d: PlotDot): DotMark => {
      if (!link || link.selected.size === 0) return null;
      const key = itemKey(analysis.id, d.itemId);
      if (link.selected.has(key)) return 'selected';
      const rel = link.related.get(key);
      return rel ? (rel.kind === 'same' ? 'related-same' : 'related-near') : 'dimmed';
    };
    const label = (d: PlotDot) => {
      const item = byId.get(d.itemId);
      const rel = link?.related.get(itemKey(analysis.id, d.itemId));
      return [
        t('proj.viewer.dotLabel', { text: item ? loc(item.text, lang) : d.itemId, category: t(categoryKey(d.category)), score: fmtScore(d.score), weight: d.weight }),
        d.weight > 0 ? '' : t('proj.viewer.dotIgnored'),
        rel && link ? relText(rel, link, t) : '',
      ].filter(Boolean).join(' ');
    };
    paintDots(ref.current, { mark, label, tabStop });
  }, [layout, link, analysis.id, byId, tabStop, t, lang]);

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const id = (e.target as Element).getAttribute?.('data-item-id');
    if (!id) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); events.select(id); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = nextDot(layout, id, e.key);
    if (!next) return;
    setFocusId(next);
    ref.current?.querySelector<SVGElement>(`circle[data-item-id="${CSS.escape(next)}"]:not(.exiting)`)?.focus();
  };

  const tipDot = hover ? layout.dots.find((d) => d.itemId === hover) : undefined;
  const tipItem = tipDot ? byId.get(tipDot.itemId) : undefined;
  const tipRel = tipDot && link ? link.related.get(itemKey(analysis.id, tipDot.itemId)) : undefined;
  const title = loc(analysis.title, lang);
  return (
    <div className="proj-plot" data-testid="proj-result-plot">
      <div className="proj-plot-frame">
        <svg
          ref={ref}
          className={`proj-plot-svg${link && link.selected.size ? ' has-selection' : ''}`}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={t('proj.viewer.plotLabel', { title })}
          onKeyDown={onKey}
        >
          <rect className="proj-plot-bg" x={0} y={0} width={layout.width} height={layout.height} onClick={link?.clear} aria-hidden />
          {layout.rows.map((r, k) => {
            const items = itemsOf(r.id);
            const mark = categoryMark(link, analysis, items);
            const interactive = !!link && items.length > 0;
            const name = t(categoryKey(r.id));
            const select = () => link?.toggle(analysis.id, items.map((i) => i.id));
            return (
              <g key={r.id} className={`proj-plot-row${k % 2 ? ' odd' : ''}${markClass(mark)}`}>
                <rect className="proj-plot-band" x={layout.left} y={r.y0} width={layout.right - layout.left} height={r.y1 - r.y0} aria-hidden />
                <g
                  className={`proj-plot-label${interactive ? ' interactive' : ''}`}
                  {...(interactive
                    ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-pressed': mark === 'selected',
                      'aria-label': t('proj.viewer.rowLabel', { category: name, score: fmtScore(r.mean), count: items.length }),
                      onClick: select,
                      onKeyDown: (e: KeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); select(); }
                      },
                    }
                    : { 'aria-hidden': true })}
                >
                  <text x={layout.left - 10} y={(r.y0 + r.y1) / 2} dy="0.35em" textAnchor="end">{name}</text>
                </g>
              </g>
            );
          })}
          <g aria-hidden>
            {layout.ticks.map((tk) => (
              <g key={tk.value}>
                <line className="proj-plot-grid" x1={tk.x} x2={tk.x} y1={layout.rows[0]?.y0 ?? 0} y2={layout.height - 20} />
                <text className="proj-plot-tick" x={tk.x} y={layout.height - 6} textAnchor="middle">{tk.value}</text>
              </g>
            ))}
          </g>
          <g className="proj-plot-means" aria-hidden />
          <g className="proj-plot-dots" />
        </svg>
        {tipDot && tipItem && (
          <div
            className={`proj-plot-tip${tipDot.y < 64 ? ' below' : ''}${tipDot.x > layout.width * 0.7 ? ' end' : ''}`}
            style={{ left: `${(tipDot.x / layout.width) * 100}%`, top: `${(tipDot.y / layout.height) * 100}%`, '--dot-r': `${tipDot.r}px` } as CSSProperties}
            aria-hidden
            data-testid="proj-plot-tip"
          >
            <span className="proj-plot-tip-text">{loc(tipItem.text, lang)}</span>
            <span className="proj-plot-tip-meta">{t('proj.viewer.tipMeta', { category: t(categoryKey(tipDot.category)), score: fmtScore(tipDot.score), weight: tipDot.weight })}</span>
            {tipRel && link && (
              <span className={`proj-plot-tip-rel ${tipRel.kind}`}>
                {tipRel.kind === 'same' ? <Link16Regular aria-hidden /> : <Flow16Regular aria-hidden />}
                {relText(tipRel, link, t)}
              </span>
            )}
          </div>
        )}
      </div>
      <p className="proj-plot-legend">
        <span className="proj-plot-key size" aria-hidden />
        {t('proj.viewer.legendSize')}
        <span className="proj-plot-key mean" aria-hidden />
        {t('proj.viewer.legendMean')}
        <span className="proj-plot-keys">{t('proj.viewer.legendKeys')}</span>
      </p>
    </div>
  );
}
