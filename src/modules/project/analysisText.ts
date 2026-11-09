import type { MessageKey, Vars } from '../../i18n/core.ts';
import type { AnalysisResult, CategoryId } from './analysis.ts';
import type { MethodId } from './model.ts';

type Tr = (key: MessageKey, vars?: Vars) => string;

export const methodKey = (m: MethodId): MessageKey => `proj.method.${m}`;
export const methodDescKey = (m: MethodId): MessageKey => `proj.methodDesc.${m}`;
export const categoryKey = (c: CategoryId | string): MessageKey => `proj.cat.${c as CategoryId}`;

export const fmtScore = (v: number | null) => (v === null ? '—' : (Math.round(v * 100) / 100).toFixed(2));

/** One-sentence reading of the result, shared by the screen and the export. */
export function describeInsight(r: AnalysisResult, t: Tr): string {
  const i = r.insight;
  switch (i.kind) {
    case 'swot':
      return t(`proj.insight.swot.${i.strategy}`, { internal: fmtScore(i.internal), external: fmtScore(i.external) });
    case 'fiveForces':
      return i.intensity === null || i.strongest === null
        ? t('proj.insight.empty')
        : t('proj.insight.fiveForces', { intensity: fmtScore(i.intensity), attractiveness: fmtScore(i.attractiveness), force: t(categoryKey(i.strongest)) });
    case 'valueChain':
      return i.strongest === null || i.weakest === null
        ? t('proj.insight.empty')
        : t('proj.insight.valueChain', { strongest: t(categoryKey(i.strongest)), weakest: t(categoryKey(i.weakest)) });
    case 'threeC':
      return i.advantage === null
        ? t('proj.insight.empty')
        : t(i.advantage >= 0 ? 'proj.insight.threeC.ahead' : 'proj.insight.threeC.behind', { gap: fmtScore(Math.abs(i.advantage)), customer: fmtScore(i.customer) });
    case 'bsc':
      return i.weakest === null ? t('proj.insight.empty') : t('proj.insight.bsc', { weakest: t(categoryKey(i.weakest)), spread: fmtScore(i.spread) });
  }
}
