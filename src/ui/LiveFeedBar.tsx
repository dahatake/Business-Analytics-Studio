import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Caption1, Tooltip } from '@fluentui/react-components';
import { Live24Regular, Pause16Regular, Play16Regular } from '@fluentui/react-icons';
import { PARAMS } from '../config/params.ts';
import { useI18n, type MessageKey } from '../i18n/index.ts';
import { freshness, percentile, runFeed, useFeed, type FeedEvent } from '../state/feed.ts';
import { EntityRef } from './EntityRef.tsx';

/** Substitute {placeholders} in a translated template with React nodes. */
export function renderTemplate(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{\w+\})/g).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && m[1]! in nodes ? <span key={i}>{nodes[m[1]!]}</span> : <span key={i}>{part}</span>;
  });
}

function FeedMessage({ e }: { e: FeedEvent }) {
  const { t, fmt } = useI18n();
  const key: MessageKey = `feed.${e.kind}`;
  const nodes: Record<string, ReactNode> = {
    entity: <EntityRef id={e.entityId} />,
    secondary: e.secondaryId ? <EntityRef id={e.secondaryId} /> : null,
    value: fmt.number(e.value),
  };
  return <>{renderTemplate(t(key), nodes)}</>;
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** F-3.4.1: live status bar. Shows update time, freshness, the "simulation" label and measured latency. */
export function LiveFeedBar() {
  const { t, fmt } = useI18n();
  const events = useFeed((s) => s.events);
  const paused = useFeed((s) => s.paused);
  const loadRate = useFeed((s) => s.loadRate);
  const latencies = useFeed((s) => s.latencies);
  const setPaused = useFeed((s) => s.setPaused);
  const recordLatency = useFeed((s) => s.recordLatency);
  const now = useNow(1000);
  const [frozen, setFrozen] = useState<FeedEvent | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const latest = events[0] ?? null;
  const shown = frozen ?? latest;

  useEffect(() => {
    runFeed();
  }, [paused, loadRate]);

  useLayoutEffect(() => {
    // The first event is measured during app boot, so it is excluded as warm-up.
    if (!latest || frozen || latest.seq === 1) return;
    const id = requestAnimationFrame(() => recordLatency(performance.now() - latest.perf));
    return () => cancelAnimationFrame(id);
  }, [latest, frozen, recordLatency]);

  const interval = loadRate ? 1000 / loadRate : PARAMS.liveFeedIntervalMs;
  const state = freshness(latest?.at ?? null, now, paused, interval);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  // Hovering or focusing inside the bar freezes the displayed message so references stay usable (WCAG 2.2.2).
  const freeze = () => setFrozen((f) => f ?? latest);
  const unfreeze = (e: React.FocusEvent | React.PointerEvent) => {
    const next = 'relatedTarget' in e ? (e.relatedTarget as Node | null) : null;
    if (next && barRef.current?.contains(next)) return;
    setFrozen(null);
  };

  return (
    <div
      ref={barRef}
      className="live-feed"
      role="region"
      aria-label={t('feed.region')}
      data-freshness={state}
      data-latency-p95={Number.isNaN(p95) ? '' : p95.toFixed(1)}
      data-latency-count={latencies.length}
      onPointerEnter={freeze}
      onPointerLeave={unfreeze}
      onFocus={freeze}
      onBlur={unfreeze}
    >
      <span className="live-feed-label"><Live24Regular aria-hidden /> {t('feed.live')}</span>
      <Badge appearance="outline" color="warning" className="live-feed-sim">{t('feed.simulation')}</Badge>
      <span className="live-feed-message" data-testid="feed-message">
        {shown ? <FeedMessage e={shown} /> : t('feed.waiting')}
      </span>
      <span className="live-feed-meta">
        <Caption1>{t('feed.updatedAt', { time: shown ? fmt.time(new Date(shown.at)) : '—' })}</Caption1>
        <Badge appearance="tint" color={state === 'fresh' ? 'success' : state === 'stale' ? 'warning' : state === 'paused' ? 'informative' : 'danger'} data-testid="feed-freshness">
          {t(`freshness.${state}`)}
        </Badge>
        <Tooltip content={t('feed.latencyHelp', { budget: PARAMS.liveFeedLatencyBudgetP95Ms })} relationship="description">
          <Caption1 tabIndex={0} className="live-feed-latency">
            {t('feed.latency', { p50: Number.isNaN(p50) ? '—' : fmt.number(p50), p95: Number.isNaN(p95) ? '—' : fmt.number(p95), n: latencies.length })}
          </Caption1>
        </Tooltip>
        <Button
          size="small"
          appearance="subtle"
          icon={paused ? <Play16Regular /> : <Pause16Regular />}
          data-testid="feed-pause"
          onClick={() => setPaused(!paused)}
        >
          {paused ? t('feed.resume') : t('feed.pause')}
        </Button>
      </span>
    </div>
  );
}

