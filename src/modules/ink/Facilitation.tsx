import { useEffect, useState } from 'react';
import { Button, Field, Select, Text } from '@fluentui/react-components';
import { Play24Regular, Stop24Regular, LayoutColumnTwo24Regular, ThumbLike24Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { clusterByColor, type Note } from './model.ts';

const DURATIONS = [3, 5, 10];

/** FR-099 (MAY): clustering of sticky notes, dot voting (reset/total) and a facilitation timer. */
export function FacilitationPanel({ notes, onCluster, onResetVotes, announce }: {
  notes: Note[];
  onCluster: (notes: Note[]) => void;
  onResetVotes: () => void;
  announce: (text: string) => void;
}) {
  const { t } = useI18n();
  const [minutes, setMinutes] = useState(5);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const votes = notes.reduce((s, n) => s + n.votes, 0);

  useEffect(() => {
    if (endAt === null) return;
    const id = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= endAt) {
        setEndAt(null);
        announce(t('ink.timer.done'));
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [endAt, announce, t]);

  const left = endAt === null ? minutes * 60 : Math.max(0, Math.ceil((endAt - now) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div className="ink-facilitation">
      <h3 className="ink-sub">{t('ink.facilitation.title')}</h3>
      <div className="ink-facilitation-row">
        <Button icon={<LayoutColumnTwo24Regular />} disabled={notes.length < 2} onClick={() => {
          onCluster(clusterByColor(notes));
          announce(t('ink.cluster.done'));
        }}>{t('ink.cluster.action')}</Button>
        <Text>{t('ink.votes.total', { count: votes })}</Text>
        <Button icon={<ThumbLike24Regular />} disabled={votes === 0} onClick={onResetVotes}>{t('ink.votes.reset')}</Button>
      </div>
      <div className="ink-facilitation-row">
        <Field label={t('ink.timer.duration')} orientation="horizontal">
          <Select value={String(minutes)} disabled={endAt !== null} onChange={(_, d) => setMinutes(Number(d.value))}>
            {DURATIONS.map((m) => <option key={m} value={m}>{t('ink.timer.minutes', { count: m })}</option>)}
          </Select>
        </Field>
        <span role="timer" aria-label={t('ink.timer.label')} className="ink-timer" data-testid="ink-timer">{`${mm}:${ss}`}</span>
        {endAt === null ? (
          <Button icon={<Play24Regular />} onClick={() => {
            const n = Date.now();
            setNow(n);
            setEndAt(n + minutes * 60_000);
            announce(t('ink.timer.started'));
          }}>{t('ink.timer.start')}</Button>
        ) : (
          <Button icon={<Stop24Regular />} onClick={() => setEndAt(null)}>{t('ink.timer.stop')}</Button>
        )}
      </div>
    </div>
  );
}
