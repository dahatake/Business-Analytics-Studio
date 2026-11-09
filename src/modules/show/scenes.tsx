import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { chapterEmptyKey, type BeforeAfterMetric, type Chapter, type Story, type StoryScene } from './model.ts';

const bar = (ratio: number): CSSProperties => ({ ['--show-bar' as string]: `${Math.max(0, Math.min(1, ratio)) * 100}%` });

function SceneHeading({ id, kicker, children }: { id: string; kicker?: string; children: ReactNode }) {
  return (
    <div className="show-scene-heading">
      {kicker && <p className="show-kicker">{kicker}</p>}
      <h2 id={id} className="show-scene-title">{children}</h2>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="show-empty" data-testid="show-empty">
      <p className="show-empty-title">{t('show.empty.title')}</p>
      <p>{text}</p>
    </div>
  );
}

function useMetricFormat() {
  const { t, fmt } = useI18n();
  return (m: BeforeAfterMetric, v: number) => {
    if (m.id === 'totalCost') return fmt.yenCompact(v);
    if (m.id === 'co2') return t('show.unit.tco2', { value: fmt.integer(v) });
    return t('show.unit.days', { value: fmt.number(v) });
  };
}

/** FR-077 / FR-079: one chapter of the program. */
export function ChapterScene({ chapter, headingId, title, onSkip }: { chapter: Chapter; headingId: string; title: string; onSkip: () => void }) {
  const { t, tx, fmt } = useI18n();
  const format = useMetricFormat();
  if (chapter.id === 'opening') {
    // FR-076: the opening shows the application name only (no customer or project name).
    return (
      <div className="show-opening">
        <span className="show-opening-mark" aria-hidden />
        <h2 id={headingId} className="show-opening-title">{t('app.title')}</h2>
        <span className="show-opening-sweep" aria-hidden />
        <button type="button" className="show-btn show-skip" onClick={onSkip} data-testid="show-skip">{t('show.opening.skip')}</button>
      </div>
    );
  }
  const heading = <SceneHeading id={headingId}>{title}</SceneHeading>;
  if (chapter.empty) return <>{heading}<Empty text={t(chapterEmptyKey(chapter.id))} /></>;
  switch (chapter.id) {
    case 'issues':
      return (
        <>
          {heading}
          <ol className="show-rank">
            {chapter.ranked.map((r) => (
              <li key={r.issue.id} className="show-rank-row" style={bar(r.score / 100)}>
                <span className="show-rank-no">{r.rank}</span>
                <span className="show-rank-name">{tx(r.issue.name)}</span>
                <span className="show-bar-track" aria-hidden><span className="show-bar-fill" /></span>
                <span className="show-rank-score">{t('show.issues.score', { score: r.score })}</span>
              </li>
            ))}
          </ol>
        </>
      );
    case 'beforeAfter':
      return (
        <>
          {heading}
          <div className="show-ba">
            {chapter.metrics.map((m) => {
              const max = Math.max(m.before, m.after) || 1;
              const change = m.before === 0 ? 0 : (m.after - m.before) / m.before;
              return (
                <div key={m.id} className="show-ba-metric">
                  <h3 className="show-ba-title">{t(`show.metric.${m.id}` as MessageKey)}</h3>
                  <dl className="show-ba-rows">
                    <div className="show-ba-row before" style={bar(m.before / max)}>
                      <dt>{t('show.ba.before')}</dt>
                      <dd><span className="show-bar-track" aria-hidden><span className="show-bar-fill" /></span>{format(m, m.before)}</dd>
                    </div>
                    <div className="show-ba-row after" style={bar(m.after / max)}>
                      <dt>{t('show.ba.after')}</dt>
                      <dd><span className="show-bar-track" aria-hidden><span className="show-bar-fill" /></span>{format(m, m.after)}</dd>
                    </div>
                  </dl>
                  <p className="show-ba-delta">{t('show.ba.delta', { pct: fmt.percent(change) })}</p>
                </div>
              );
            })}
          </div>
        </>
      );
    case 'roi': {
      const max = Math.max(...chapter.items.map((s) => Math.max(s.solution.costJpy, s.solution.annualBenefitJpy)), 1);
      return (
        <>
          {heading}
          <div className="show-roi-totals">
            <p><span className="show-big">{fmt.yenCompact(chapter.totalCostJpy)}</span><span>{t('show.roi.totalCost')}</span></p>
            <p><span className="show-big">{fmt.yenCompact(chapter.totalBenefitJpy)}</span><span>{t('show.roi.totalBenefit')}</span></p>
          </div>
          <table className="show-table">
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('show.roi.solution')}</th>
                <th scope="col">{t('show.roi.cost')}</th>
                <th scope="col">{t('show.roi.benefit')}</th>
                <th scope="col">{t('show.roi.payback')}</th>
              </tr>
            </thead>
            <tbody>
              {chapter.items.map((s) => (
                <tr key={s.solution.id}>
                  <th scope="row">{tx(s.solution.name)}</th>
                  <td style={bar(s.solution.costJpy / max)}><span className="show-bar-track cost" aria-hidden><span className="show-bar-fill" /></span>{fmt.yenCompact(s.solution.costJpy)}</td>
                  <td style={bar(s.solution.annualBenefitJpy / max)}><span className="show-bar-track" aria-hidden><span className="show-bar-fill" /></span>{fmt.yenCompact(s.solution.annualBenefitJpy)}</td>
                  <td>{t('show.roi.months', { months: fmt.integer(s.paybackMonths) })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
    }
    case 'kpis':
      return (
        <>
          {heading}
          <ul className="show-kpis">
            {chapter.kpis.map(({ kpi, status }) => (
              <li key={kpi.id} className={`show-kpi show-kpi-st-${status}`}>
                <span className="show-kpi-name">{tx(kpi.name)}</span>
                <span className="show-kpi-values">{t('show.kpi.values', { baseline: fmt.number(kpi.baseline), current: fmt.number(kpi.current), target: fmt.number(kpi.target), unit: tx(kpi.unit) })}</span>
                <span className="show-kpi-status">{t(`show.kpi.status.${status}` as MessageKey)}</span>
              </li>
            ))}
          </ul>
        </>
      );
    case 'solutions':
      return (
        <>
          {heading}
          <ol className="show-cards">
            {chapter.items.map((s, i) => (
              <li key={s.solution.id} className="show-card">
                <span className="show-card-rank">{i + 1}</span>
                <h3 className="show-card-title">{tx(s.solution.name)}</h3>
                {s.issue && <p>{t('show.solutions.resolves', { issue: tx(s.issue.name), score: s.score })}</p>}
                <p className="show-muted">{s.solution.msProducts.join(' · ')}</p>
              </li>
            ))}
          </ol>
        </>
      );
    case 'next':
      return (
        <>
          {heading}
          <ol className="show-next">
            {chapter.initiatives.map((i) => (
              <li key={i.id} className="show-next-row" style={bar(i.progress)}>
                <span className="show-next-name">{tx(i.name)}</span>
                <span className="show-muted">{t('show.next.period', { start: fmt.date(i.start), end: fmt.date(i.end) })}</span>
                <span className="show-bar-track" aria-hidden><span className="show-bar-fill" /></span>
                <span>{t('show.next.progress', { pct: fmt.percent(i.progress) })}</span>
              </li>
            ))}
          </ol>
        </>
      );
  }
}

/** FR-177〜179: one scene of a persona story. */
export function StorySceneView({ scene, story, headingId, title, lines }: { scene: StoryScene; story: Story; headingId: string; title: string; lines: string[] }) {
  const { t, tx, fmt, lang } = useI18n();
  switch (scene.kind) {
    case 'title':
      return (
        <div className="show-story-title">
          <p className="show-kicker">{t('show.story.kicker')}</p>
          <h2 id={headingId} className="show-opening-title">{title}</h2>
          <p className="show-lead">{lines[0]}</p>
        </div>
      );
    case 'solution':
      return (
        <>
          <SceneHeading id={headingId} kicker={t('show.story.rank', { rank: scene.rank, total: story.top.length })}>{tx(scene.item.solution.name)}</SceneHeading>
          <ul className="show-reasons">
            {scene.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
          <div className="show-roi-totals">
            <p><span className="show-big">{fmt.yenCompact(scene.item.solution.annualBenefitJpy)}</span><span>{t('show.roi.benefit')}</span></p>
            <p><span className="show-big">{fmt.yenCompact(scene.item.solution.costJpy)}</span><span>{t('show.roi.cost')}</span></p>
            <p><span className="show-big">{t('show.roi.months', { months: fmt.integer(scene.item.paybackMonths) })}</span><span>{t('show.roi.payback')}</span></p>
          </div>
        </>
      );
    case 'kpis':
      return (
        <>
          <SceneHeading id={headingId}>{title}</SceneHeading>
          <ul className="show-kpis">
            {scene.kpis.map((kpi) => (
              <li key={kpi.id} className="show-kpi">
                <span className="show-kpi-name">{tx(kpi.name)}</span>
                <span className="show-kpi-values">{t('show.kpi.values', { baseline: fmt.number(kpi.baseline), current: fmt.number(kpi.current), target: fmt.number(kpi.target), unit: tx(kpi.unit) })}</span>
              </li>
            ))}
          </ul>
          <p className="show-muted">{t('show.story.okrNote')}</p>
        </>
      );
    case 'usecases':
      return (
        <>
          <SceneHeading id={headingId}>{title}</SceneHeading>
          <ul className="show-cards">
            {scene.useCases.map((u) => (
              <li key={u.id} className="show-card">
                <h3 className="show-card-title">{loc(u.name, lang)}</h3>
                <p>{loc(u.summary, lang)}</p>
                <p className="show-muted">{t('show.story.steps', { count: u.steps.length })}</p>
                {u.effect && <p>{t('show.story.effect', { effect: loc(u.effect, lang) })}</p>}
              </li>
            ))}
          </ul>
        </>
      );
    case 'missing':
      return (
        <>
          <SceneHeading id={headingId}>{title}</SceneHeading>
          <div className="show-empty" data-testid="show-missing" data-missing={scene.what}>
            <p className="show-empty-title">{t(`show.missing.${scene.what}` as MessageKey)}</p>
            <p>{t(`show.missingHow.${scene.what}` as MessageKey)}</p>
          </div>
        </>
      );
    case 'closing':
      return (
        <div className="show-story-title">
          <h2 id={headingId} className="show-opening-title">{title}</h2>
          <p className="show-lead">{lines[0]}</p>
        </div>
      );
  }
}
