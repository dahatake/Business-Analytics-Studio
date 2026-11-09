import { useMemo } from 'react';
import { scaleBand, scaleLinear } from 'd3';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { SCORE_MAX, type AnalysisResult } from './analysis.ts';
import { categoryKey, fmtScore } from './analysisText.ts';
import type { Analysis } from './model.ts';
import { ScrollRegion } from './common.tsx';

export type Viewer = 'table' | 'matrix' | 'chart';

/** FR-135: the same result as a table, a matrix or a chart. */
export function AnalysisViewer({ analysis, result, viewer }: { analysis: Analysis; result: AnalysisResult; viewer: Viewer }) {
  if (viewer === 'table') return <ResultTable analysis={analysis} result={result} />;
  if (viewer === 'chart') return <ResultChart result={result} />;
  return <ResultMatrix analysis={analysis} result={result} />;
}

function ResultTable({ analysis, result }: { analysis: Analysis; result: AnalysisResult }) {
  const { t, lang } = useI18n();
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
          {result.categories.map((c) => (
            <tr key={c.id}>
              <th scope="row">{t(categoryKey(c.id))}</th>
              <td className="num" data-testid={`proj-score-${c.id}`}>{fmtScore(c.score)}</td>
              <td className="num">{c.weight}</td>
              <td className="num">{c.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function ResultMatrix({ analysis, result }: { analysis: Analysis; result: AnalysisResult }) {
  const { t, lang } = useI18n();
  const swot = analysis.method === 'swot';
  return (
    <div className={swot ? 'proj-matrix proj-matrix-swot' : 'proj-matrix'} data-testid="proj-result-matrix">
      {swot && (
        <>
          <span className="proj-matrix-axis col1" aria-hidden>{t('proj.viewer.positive')}</span>
          <span className="proj-matrix-axis col2" aria-hidden>{t('proj.viewer.negative')}</span>
        </>
      )}
      {result.categories.map((c) => (
        <section key={c.id} className={`proj-matrix-cell cat-${c.id}`} aria-label={t(categoryKey(c.id))}>
          <h3 className="proj-h3">
            {t(categoryKey(c.id))}
            <span className="proj-matrix-score">{t('proj.viewer.scoreShort', { score: fmtScore(c.score) })}</span>
          </h3>
          <ul>
            {analysis.items.filter((i) => i.category === c.id).map((i) => (
              <li key={i.id}>{loc(i.text, lang)}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ResultChart({ result }: { result: AnalysisResult }) {
  const { t } = useI18n();
  const width = 520;
  const rowH = 30;
  const labelW = 170;
  const height = result.categories.length * rowH + 30;
  const { x, y } = useMemo(() => ({
    x: scaleLinear().domain([0, SCORE_MAX]).range([labelW, width - 50]),
    y: scaleBand().domain(result.categories.map((c) => c.id)).range([10, height - 20]).padding(0.25),
  }), [result.categories, height]);
  const summary = result.categories.map((c) => `${t(categoryKey(c.id))} ${fmtScore(c.score)}`).join(', ');
  return (
    <div className="chart-scroll">
      <svg className="proj-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('proj.viewer.chartLabel', { summary })} data-testid="proj-result-chart">
        {x.ticks(SCORE_MAX).map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={10} y2={height - 20} className="proj-chart-grid" />
            <text x={x(v)} y={height - 6} className="proj-chart-tick" textAnchor="middle">{v}</text>
          </g>
        ))}
        {result.categories.map((c) => {
          const yy = y(c.id) ?? 0;
          return (
            <g key={c.id}>
              <text x={labelW - 8} y={yy + y.bandwidth() / 2} dy="0.35em" textAnchor="end" className="proj-chart-label">{t(categoryKey(c.id))}</text>
              <rect x={labelW} y={yy} width={Math.max(0, x(c.score ?? 0) - labelW)} height={y.bandwidth()} rx={3} className="proj-chart-bar" />
              <text x={x(c.score ?? 0) + 6} y={yy + y.bandwidth() / 2} dy="0.35em" className="proj-chart-value">{fmtScore(c.score)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
