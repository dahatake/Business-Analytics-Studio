import { Badge } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import type { GenStageKey, ReadinessItem } from './analysisReadiness.ts';
import type { CollectionRound, StopReason } from './packGenerate.ts';
import { ScrollRegion } from './common.tsx';

/** The app's own count of what the analysis needs, with the Work IQ follow-up log when there is one. */
export function ReadinessView({ items, rounds, stopReasons, testId }: {
  items: ReadinessItem[];
  rounds?: CollectionRound[];
  stopReasons?: Partial<Record<GenStageKey, StopReason>>;
  testId: string;
}) {
  const { t, fmt } = useI18n();
  const met = items.filter((i) => i.met).length;
  const stage = (s: GenStageKey) => t(`proj.ready.stage.${s}`);
  return (
    <div className="gen-readiness" data-testid={testId}>
      <p data-testid={`${testId}-summary`}>{t('proj.ready.summary', { met, total: items.length })}</p>
      <ScrollRegion label={t('proj.ready.title')}>
        <table className="data-table compact">
          <caption>{t('proj.ready.title')}</caption>
          <thead><tr>
            <th scope="col">{t('proj.ready.col.item')}</th>
            <th scope="col">{t('proj.ready.col.have')}</th>
            <th scope="col">{t('proj.ready.col.need')}</th>
            <th scope="col">{t('proj.ready.col.status')}</th>
          </tr></thead>
          <tbody>{items.map((i) => (
            <tr key={i.key} data-testid={`${testId}-${i.key}`} data-met={i.met}>
              <th scope="row">{t(`proj.ready.${i.key}`)}</th>
              <td>{fmt.integer(i.have)}</td>
              <td>{fmt.integer(i.need)}</td>
              <td><Badge appearance="tint" color={i.met ? 'success' : 'warning'}>{t(i.met ? 'proj.ready.met' : 'proj.ready.unmet')}</Badge></td>
            </tr>
          ))}</tbody>
        </table>
      </ScrollRegion>
      {rounds && rounds.length > 0 && (
        <>
          <p className="muted">{t('proj.ready.rounds')}</p>
          <ul className="muted" data-testid={`${testId}-rounds`}>
            {rounds.map((r) => (
              <li key={`${r.stage}-${r.round}`}>{t('proj.ready.round', {
                stage: stage(r.stage),
                round: r.round,
                unmet: r.unmet.map((k) => t(`proj.ready.${k}`)).join(t('ai.listSep')) || '—',
                topics: r.topics.length,
                sources: r.newSources.length,
                result: r.error ? t('proj.ready.result.error', { error: r.error })
                  : !r.rerun ? t('proj.ready.result.noNew')
                  : t(r.adopted ? 'proj.ready.result.adopted' : 'proj.ready.result.kept'),
              })}</li>
            ))}
          </ul>
        </>
      )}
      {stopReasons && Object.keys(stopReasons).length > 0 && (
        <ul className="muted" data-testid={`${testId}-stops`}>
          {(Object.entries(stopReasons) as [GenStageKey, StopReason][]).map(([s, reason]) => (
            <li key={s} data-stop={reason}>{t('proj.ready.stop', { stage: stage(s), reason: t(`proj.ready.stop.${reason}`) })}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
