import { entitiesOf, loaded } from '../data/pack.ts';
import { isLang, makeFormatters, pick, translate, type Lang } from '../i18n/core.ts';
import { chooseKpiVisual, kpiProgress } from '../domain/kpi.ts';
import { optimize } from '../domain/optimize.ts';
import { executiveSummary } from '../domain/summary.ts';

export interface ApiResult {
  status: number;
  lang: Lang;
  body: unknown;
}

/** lang query param > Accept-Language > ja (default UI language, §3.2). */
export function resolveLang(param: string | null, acceptLanguage?: string | string[]): Lang {
  if (isLang(param)) return param;
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(',') : acceptLanguage ?? '';
  const first = header.split(',').map((s) => s.trim().slice(0, 2).toLowerCase()).find((s) => s === 'ja' || s === 'en');
  return isLang(first) ? first : 'ja';
}

function num(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number | null {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) return null;
  return v;
}

export const OPTIMIZE_LIMITS = { growth: { min: -0.2, max: 0.3 }, carbon: { min: 0, max: 50_000 } } as const;

/**
 * Local API (F-3.5.1: responses in both languages). Pure function so the same code serves
 * the Vite dev/preview middleware and the in-browser fallback, and is unit-testable.
 */
export function handleApiRequest(pathname: string, params: URLSearchParams, acceptLanguage?: string | string[]): ApiResult {
  const lang = resolveLang(params.get('lang'), acceptLanguage);
  const audience = params.get('audience') === 'external' ? 'external' : 'internal';
  const ok = (body: unknown): ApiResult => ({ status: 200, lang, body: { lang, ...(body as object) } });
  const fail = (status: number, key: 'api.error.notFound' | 'api.error.badParam', vars?: Record<string, string | number>): ApiResult => ({
    status, lang, body: { lang, error: { code: status === 404 ? 'not_found' : 'bad_request', message: translate(lang, key, vars) } },
  });

  switch (pathname) {
    case '/api/health':
      return ok({ status: 'ok', message: translate(lang, 'api.health') });
    case '/api/summary':
      return ok({ sentences: executiveSummary(lang, audience) });
    case '/api/kpis': {
      const kpis = entitiesOf('kpi').filter((k) => audience === 'internal' || k.classification === 'shareable');
      return ok({
        kpis: kpis.map((k) => {
          const visual = chooseKpiVisual(k);
          return {
            id: k.id,
            name: pick(lang, k.name),
            unit: pick(lang, k.unit),
            baseline: k.baseline, current: k.current, target: k.target,
            direction: translate(lang, `direction.${k.direction}`),
            progress: kpiProgress(k),
            visual: visual.kind,
            reason: visual.kind === 'bullet' ? translate(lang, `kpi.reason.${visual.reason}`) : translate(lang, 'kpi.reason.ring'),
          };
        }),
      });
    }
    case '/api/optimize': {
      const growth = num(params, 'growth', 0, OPTIMIZE_LIMITS.growth.min, OPTIMIZE_LIMITS.growth.max);
      if (growth === null) return fail(400, 'api.error.badParam', { name: 'growth', min: OPTIMIZE_LIMITS.growth.min, max: OPTIMIZE_LIMITS.growth.max });
      const carbon = num(params, 'carbon', 0, OPTIMIZE_LIMITS.carbon.min, OPTIMIZE_LIMITS.carbon.max);
      if (carbon === null) return fail(400, 'api.error.badParam', { name: 'carbon', min: OPTIMIZE_LIMITS.carbon.min, max: OPTIMIZE_LIMITS.carbon.max });
      const input = loaded.pack.optimization;
      const result = optimize(input, { demandGrowth: growth, carbonPriceJpyPerT: carbon });
      const fmt = makeFormatters(lang);
      let message: string;
      if (!result.feasible) {
        message = translate(lang, 'optimize.infeasible', { demand: fmt.integer(result.totalDemandT), capacity: fmt.integer(result.totalCapacityT) });
      } else {
        const saving = result.beforeMetrics.totalCostJpy - result.afterMetrics.totalCostJpy;
        message = translate(lang, 'optimize.resultMessage', {
          saving: fmt.yenCompact(saving),
          savingPct: fmt.percent(saving / result.beforeMetrics.totalCostJpy),
          co2: fmt.number(result.beforeMetrics.co2T - result.afterMetrics.co2T),
          lead: fmt.number(result.beforeMetrics.avgLeadTimeDays - result.afterMetrics.avgLeadTimeDays),
        });
      }
      return ok({ period: pick(lang, input.period), params: { growth, carbon }, message, result });
    }
    default:
      return fail(404, 'api.error.notFound', { path: pathname });
  }
}
