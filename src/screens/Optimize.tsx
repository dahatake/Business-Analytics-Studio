import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Caption1, Label, MessageBar, MessageBarBody, Slider, Spinner } from '@fluentui/react-components';
import { Flash24Regular } from '@fluentui/react-icons';
import { apiGet } from '../api/client.ts';
import { getEntity, loaded } from '../data/pack.ts';
import type { OptimizationInput } from '../data/schema.ts';
import type { OptimizationResult } from '../domain/optimize.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { replaceQuery, useRoute } from '../state/router.ts';
import { sound } from '../audio/sound.ts';
import { BeforeAfterChart, type Comparison } from '../charts/BeforeAfterChart.tsx';
import { PageHeader, Panel } from '../ui/Panel.tsx';
import { EntityRef } from '../ui/EntityRef.tsx';

interface OptimizeResponse {
  lang: string;
  period: string;
  message: string;
  params: { growth: number; carbon: number };
  result: OptimizationResult;
  error?: { message: string };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A pack without optimization input (FR-241) shows why the screen is empty instead of invented numbers. */
export function Optimize() {
  const { t } = useI18n();
  const input = loaded.pack.optimization;
  if (!input) {
    return (
      <div className="screen screen-optimize">
        <PageHeader title={t('optimize.title')} subtitle={t('optimize.subtitle')} />
        <MessageBar intent="info" data-testid="optimize-unavailable"><MessageBarBody>{t('optimize.unavailable')}</MessageBarBody></MessageBar>
      </div>
    );
  }
  return <OptimizeBody input={input} />;
}

function OptimizeBody({ input }: { input: OptimizationInput }) {
  const { t, tx, fmt, lang } = useI18n();
  const route = useRoute();
  const audience = useSettings((s) => s.audience);
  const growthPct = clamp(Number(route.query.get('growth') ?? 0) || 0, -10, 15);
  const carbon = clamp(Number(route.query.get('carbon') ?? 10000) || 0, 0, 20000);
  const [draft, setDraft] = useState({ growthPct, carbon });
  const [resp, setResp] = useState<{ body: OptimizeResponse; via: 'http' | 'inline'; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft({ growthPct, carbon }), [growthPct, carbon]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const started = performance.now();
    void apiGet<OptimizeResponse>('/api/optimize', { lang, growth: growthPct / 100, carbon, audience }).then((r) => {
      if (cancelled) return;
      setResp({ body: r.body, via: r.via, ms: performance.now() - started });
      setBusy(false);
    });
    return () => { cancelled = true; };
  }, [lang, growthPct, carbon, audience]);

  const run = () => {
    sound.play('success');
    replaceQuery({ growth: String(draft.growthPct), carbon: String(draft.carbon) });
  };

  const result = resp?.body.result;
  const plantNames = input.plants.map((p) => { const e = getEntity(p.siteId); return e ? tx(e.name) : p.siteId; });
  const regionNames = loaded.pack.regions.map((r) => tx(r.name));

  const metrics: Comparison[] = useMemo(() => {
    if (!result?.feasible) return [];
    const b = result.beforeMetrics, a = result.afterMetrics;
    return [
      { id: 'cost', label: t('optimize.metric.cost'), unit: t('unit.millionYenPerMonth'), before: b.totalCostJpy / 1e6, after: a.totalCostJpy / 1e6, lowerIsBetter: true, format: (v) => fmt.number(v) },
      { id: 'co2', label: t('optimize.metric.co2'), unit: t('unit.tCo2PerMonth'), before: b.co2T, after: a.co2T, lowerIsBetter: true, format: (v) => fmt.number(v) },
      { id: 'lead', label: t('optimize.metric.lead'), unit: t('unit.days'), before: b.avgLeadTimeDays, after: a.avgLeadTimeDays, lowerIsBetter: true, format: (v) => fmt.number(v) },
    ];
  }, [result, t, fmt]);

  const totalDemand = result ? result.demandT.reduce((x, y) => x + y, 0) : 0;
  const population = t('optimize.population', { plants: input.plants.length, regions: input.regionDemandT.length, demand: fmt.integer(totalDemand) });

  return (
    <div className="screen screen-optimize">
      <PageHeader title={t('optimize.title')} subtitle={t('optimize.subtitle')} />
      <div className="grid-3">
        <Panel title={t('optimize.guide')} testId="optimize-guide">
          <ol className="guide-steps">
            <li>{t('optimize.guide.1')}</li>
            <li>{t('optimize.guide.2')}</li>
            <li>{t('optimize.guide.3')}</li>
            <li>{t('optimize.guide.4')}</li>
          </ol>
          <Caption1>{t('optimize.guide.model')}</Caption1>
        </Panel>
        <Panel title={t('optimize.params')} testId="optimize-params">
          <div className="control">
            <Label htmlFor="growth">{t('optimize.growth', { value: draft.growthPct })}</Label>
            <Slider id="growth" min={-10} max={15} step={1} value={draft.growthPct} onChange={(_, d) => setDraft((s) => ({ ...s, growthPct: d.value }))} />
          </div>
          <div className="control">
            <Label htmlFor="carbon">{t('optimize.carbon', { value: fmt.integer(draft.carbon) })}</Label>
            <Slider id="carbon" min={0} max={20000} step={1000} value={draft.carbon} onChange={(_, d) => setDraft((s) => ({ ...s, carbon: d.value }))} />
          </div>
          <Button appearance="primary" icon={<Flash24Regular />} onClick={run} data-testid="optimize-run">{t('optimize.run')}</Button>
        </Panel>
        <Panel title={t('optimize.summary')} testId="optimize-summary">
          {busy && !resp ? <Spinner size="small" label={t('optimize.running')} /> : resp && (
            <>
              {result && !result.feasible
                ? <MessageBar intent="warning"><MessageBarBody>{resp.body.message}</MessageBarBody></MessageBar>
                : <p className="optimize-message" data-testid="optimize-message">{resp.body.message}</p>}
              <dl className="meta-list">
                <div><dt>{t('optimize.period')}</dt><dd>{resp.body.period}</dd></div>
                <div><dt>{t('optimize.populationLabel')}</dt><dd>{population}</dd></div>
                <div><dt>{t('optimize.applied')}</dt><dd>{t('optimize.appliedValue', { growth: growthPct, carbon: fmt.integer(carbon) })}</dd></div>
              </dl>
              <Badge appearance="outline" color="informative">{t('optimize.via', { via: t(`optimize.via.${resp.via}`), ms: fmt.integer(resp.ms) })}</Badge>
            </>
          )}
        </Panel>
      </div>

      {result?.feasible && (
        <>
          <Panel title={t('optimize.compare')} rationale="visual.beforeAfter" testId="before-after" className="span-full">
            <p className="compare-meta">{t('optimize.compareMeta', { period: resp!.body.period, population })}</p>
            <div className="compare-grid">
              {metrics.map((m) => <BeforeAfterChart key={m.id} metric={m} />)}
            </div>
            <div className="table-scroll">
              <table className="data-table" data-testid="raw-numbers">
                <caption>{t('optimize.rawCaption')}</caption>
                <thead><tr>
                  <th scope="col">{t('optimize.col.metric')}</th><th scope="col">{t('optimize.col.unit')}</th><th scope="col" className="num">{t('compare.before')}</th><th scope="col" className="num">{t('compare.after')}</th><th scope="col" className="num">{t('optimize.col.delta')}</th><th scope="col" className="num">{t('optimize.col.deltaPct')}</th>
                </tr></thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={m.id}>
                      <th scope="row">{m.label}</th>
                      <td>{m.unit}</td>
                      <td className="num">{m.format(m.before)}</td>
                      <td className="num">{m.format(m.after)}</td>
                      <td className="num">{m.format(m.after - m.before)}</td>
                      <td className="num">{fmt.percent((m.after - m.before) / m.before)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title={t('optimize.capacity')} rationale="visual.capacity" testId="capacity-report" className="span-full">
            {result.beforeOverCapacity && (
              <MessageBar intent="warning"><MessageBarBody>{t('optimize.overCapacity')}</MessageBarBody></MessageBar>
            )}
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr>
                  <th scope="col">{t('kind.site')}</th><th scope="col" className="num">{t('field.capacity')}</th>
                  <th scope="col" className="num">{t('optimize.col.loadBefore')}</th><th scope="col">{t('optimize.col.utilBefore')}</th>
                  <th scope="col" className="num">{t('optimize.col.loadAfter')}</th><th scope="col">{t('optimize.col.utilAfter')}</th>
                </tr></thead>
                <tbody>
                  {input.plants.map((p, i) => (
                    <tr key={p.siteId}>
                      <th scope="row"><EntityRef id={p.siteId} /></th>
                      <td className="num">{t('unit.tPerMonth', { value: fmt.integer(p.capacityT) })}</td>
                      <td className="num">{fmt.integer(result.beforeMetrics.plantLoadT[i]!)} t</td>
                      <td><Utilization value={result.beforeMetrics.utilization[i]!} /></td>
                      <td className="num">{fmt.integer(result.afterMetrics.plantLoadT[i]!)} t</td>
                      <td><Utilization value={result.afterMetrics.utilization[i]!} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title={t('optimize.allocation')} rationale="visual.allocation" className="span-full">
            <div className="grid-2">
              {(['before', 'after'] as const).map((which) => (
                <div className="table-scroll" key={which}>
                  <table className="data-table compact">
                    <caption>{t(`compare.${which}`)} · {t('optimize.allocationUnit')}</caption>
                    <thead><tr><th scope="col">{t('kind.site')}</th>{regionNames.map((r) => <th key={r} scope="col" className="num">{r}</th>)}</tr></thead>
                    <tbody>
                      {result[which].map((row, i) => (
                        <tr key={i}><th scope="row">{plantNames[i]}</th>{row.map((q, j) => <td key={j} className="num">{q ? fmt.integer(q) : '·'}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function Utilization({ value }: { value: number }) {
  const { fmt } = useI18n();
  const over = value > 1;
  return (
    <span className={`util ${over ? 'over' : value > 0.9 ? 'high' : ''}`}>
      <span className="util-track" aria-hidden><span className="util-fill" style={{ width: `${Math.min(100, value * 100)}%` }} /></span>
      <span>{fmt.percent(value)}</span>
    </span>
  );
}

