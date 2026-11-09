import { useEffect, useId, useRef } from 'react';
import { Button } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import type { InfoRow } from './scene.ts';
import { topN } from './model.ts';

export interface InfoCardData {
  /** Node or edge id the card belongs to. */
  itemId: string;
  kind: 'node' | 'edge';
  title: string;
  rows: InfoRow[];
  relations: string[];
  /** Position relative to the stage (CSS px). */
  x: number;
  y: number;
  action?: { label: string; run: () => void };
}

/** FR-247: the module's own card for edges, clusters and spatial areas. Shows ≤ PARAM-105 relations, then "N more". */
export function InfoCard({ card, onClose, stageWidth }: { card: InfoCardData; onClose: () => void; stageWidth: number }) {
  const { t } = useI18n();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const { shown, more } = topN(card.relations);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const el = ref.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  }, [onClose]);
  const left = Math.max(8, Math.min(card.x + 12, stageWidth - 300));
  return (
    <div
      ref={ref}
      className="graph-infocard"
      role="dialog"
      aria-labelledby={id}
      data-testid="graph-infocard"
      data-card-kind={card.kind}
      data-card-for={card.itemId}
      style={{ left, top: Math.max(48, card.y + 12) }}
    >
      <div className="graph-infocard-head">
        <h3 id={id} className="graph-infocard-title">{card.title}</h3>
        <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label={t('graph.card.close')} onClick={onClose} />
      </div>
      {card.rows.length > 0 && (
        <dl className="graph-infocard-rows">
          {card.rows.map((r) => (
            <div key={r.label} className="graph-infocard-row"><dt>{r.label}</dt><dd>{r.value}</dd></div>
          ))}
        </dl>
      )}
      {shown.length > 0 && (
        <>
          <p className="graph-infocard-sub">{t('graph.card.relations')}</p>
          <ul className="graph-infocard-list">
            {shown.map((r, i) => <li key={`${i}-${r}`}>{r}</li>)}
          </ul>
          {more > 0 && <p className="muted graph-infocard-more">{t('graph.card.more', { count: more })}</p>}
        </>
      )}
      {card.action && <Button size="small" appearance="primary" onClick={card.action.run}>{card.action.label}</Button>}
    </div>
  );
}
