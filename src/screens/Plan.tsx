import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import { ToggleButton } from '@fluentui/react-components';
import { PARAMS } from '../config/params.ts';
import { entitiesOf, getEntity } from '../data/pack.ts';
import type { EntityOf } from '../data/schema.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor, navigate, replaceQuery, useRoute } from '../state/router.ts';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';
import { SvgEntityNode } from '../ui/SvgEntityNode.tsx';
import { isHidden } from '../ui/cardSpecs.ts';

type Init = EntityOf<'initiative'>;
const LABEL_W = 0, ROW_H = 40, GROUP_H = 30, TOP = 34;
const day = (iso: string) => new Date(`${iso}T00:00:00+09:00`);

export function Plan() {
  const { t, tx, fmt, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const route = useRoute();
  const zoom = route.query.get('zoom') === '2' ? 2 : 1;
  const axisRef = useRef<SVGGElement>(null);

  const rows = useMemo(() => {
    const visible = entitiesOf('initiative').filter((i) => !isHidden(i, audience));
    const groups = d3.groups(visible, (i) => i.solutionId);
    const out: ({ type: 'group'; solutionId: string; y: number } | { type: 'bar'; init: Init; y: number })[] = [];
    let y = TOP;
    for (const [solutionId, inits] of groups) {
      out.push({ type: 'group', solutionId, y });
      y += GROUP_H;
      for (const init of inits.sort((a, b) => a.start.localeCompare(b.start))) {
        out.push({ type: 'bar', init, y });
        y += ROW_H;
      }
    }
    return { out, height: y + 10, inits: visible };
  }, [audience]);

  const width = 900 * zoom;
  const x = useMemo(() => {
    const starts = rows.inits.map((i) => day(i.start));
    const ends = rows.inits.map((i) => day(i.end));
    return d3.scaleTime().domain([d3.timeMonth.floor(d3.min(starts)!), d3.timeMonth.ceil(d3.max(ends)!)]).range([LABEL_W + 36, width - 36]);
  }, [rows, width]);

  useEffect(() => {
    d3.select(axisRef.current!).call(
      d3.axisTop<Date>(x).ticks(d3.timeMonth.every(1)).tickFormat((d) => fmt.month(d)).tickSizeOuter(0),
    );
  }, [x, fmt, lang]);

  const asOf = x(day(PARAMS.asOfDate));
  const barY = new Map(rows.out.filter((r) => r.type === 'bar').map((r) => [(r as { init: Init }).init.id, r.y] as const));

  return (
    <div className="screen screen-plan">
      <PageHeader
        title={t('plan.title')}
        subtitle={t('plan.subtitle', { date: fmt.date(PARAMS.asOfDate) })}
        actions={(
          <div role="group" aria-label={t('plan.zoom')} className="toggle-group">
            <ToggleButton checked={zoom === 1} onClick={() => replaceQuery({ zoom: undefined })}>{t('plan.zoom.fit')}</ToggleButton>
            <ToggleButton checked={zoom === 2} onClick={() => replaceQuery({ zoom: '2' })}>{t('plan.zoom.wide')}</ToggleButton>
          </div>
        )}
      />
      <Panel title={t('plan.panel')} rationale="visual.gantt" testId="gantt-panel" id="gantt-panel">
        <div className="chart-scroll">
          <svg viewBox={`0 0 ${width} ${rows.height}`} width={width} className="gantt" role="group" aria-label={t('plan.aria')}>
            <g ref={axisRef} transform={`translate(0,${TOP - 8})`} className="axis" />
            <defs>
              <marker id="gantt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="gantt-arrow-head" />
              </marker>
            </defs>
            {rows.out.map((r) => r.type === 'group' ? (
              <text key={`g-${r.solutionId}`} x={12} y={r.y + 20} className="gantt-group">{getEntity(r.solutionId) ? tx(getEntity(r.solutionId)!.name) : r.solutionId}</text>
            ) : null)}
            {rows.inits.flatMap((i) => i.dependsOn.filter((d) => barY.has(d)).map((d) => {
              const pred = getEntity(d) as Init;
              const x1 = x(day(pred.end)), y1 = barY.get(d)! + ROW_H / 2 - 4;
              const x2 = x(day(i.start)), y2 = barY.get(i.id)! + ROW_H / 2 - 4;
              return <path key={`${d}-${i.id}`} d={`M${x1},${y1} C${x1 + 30},${y1} ${x2 - 30},${y2} ${x2},${y2}`} className="gantt-dep" markerEnd="url(#gantt-arrow)" />;
            }))}
            {rows.out.map((r) => {
              if (r.type !== 'bar') return null;
              const { init } = r;
              const x0 = x(day(init.start)), x1 = x(day(init.end));
              const w = Math.max(4, x1 - x0);
              const label = t('plan.barAria', { name: tx(init.name), start: fmt.date(init.start), end: fmt.date(init.end), progress: fmt.percent(init.progress) });
              return (
                <SvgEntityNode key={init.id} id={init.id} label={label} transform={`translate(${x0},${r.y})`} onActivate={() => navigate(hrefFor(`/entity/${init.id}`))} className="gantt-row" role="link">
                  <rect width={w} height={ROW_H - 12} rx={6} className="gantt-bar" />
                  <rect width={w * init.progress} height={ROW_H - 12} rx={6} className="gantt-progress" />
                  <text x={8} y={(ROW_H - 12) / 2} dy="0.35em" className="gantt-label">{tx(init.name)} · {fmt.percent(init.progress)}</text>
                </SvgEntityNode>
              );
            })}
            <line x1={asOf} x2={asOf} y1={TOP - 6} y2={rows.height} className="gantt-today" />
            <text x={asOf + 4} y={TOP + 6} className="gantt-today-label">{t('plan.today')}</text>
          </svg>
        </div>
      </Panel>
      <Panel title={t('plan.tableTitle')} rationale="visual.planTable" id="plan-table">
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr>
              <th scope="col">{t('field.name')}</th><th scope="col">{t('kind.solution')}</th><th scope="col">{t('field.start')}</th><th scope="col">{t('field.end')}</th><th scope="col" className="num">{t('field.progress')}</th><th scope="col">{t('field.owner')}</th><th scope="col">{t('field.dependsOn')}</th>
            </tr></thead>
            <tbody>
              {rows.inits.map((i) => (
                <tr key={i.id}>
                  <td><EntityRef id={i.id} /></td>
                  <td><EntityRef id={i.solutionId} /></td>
                  <td>{fmt.date(i.start)}</td>
                  <td>{fmt.date(i.end)}</td>
                  <td className="num">{fmt.percent(i.progress)}</td>
                  <td><EntityRef id={i.ownerId} image /></td>
                  <td>{i.dependsOn.length ? i.dependsOn.map((d) => <EntityRef key={d} id={d} />) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

