import { useEffect, useState } from 'react';
import { Badge, Button, Caption1 } from '@fluentui/react-components';
import { loaded } from '../data/pack.ts';
import { PARAMS } from '../config/params.ts';
import { NEWS_INTERVAL_MS, NewsFeed, type NewsArticle } from '../data/news.ts';
import { useI18n } from '../i18n/index.ts';
import { relayFetch } from '../modules/ai/relayClient.ts';
import { freshness, useFeed } from '../state/feed.ts';
import { useActiveProject } from '../state/projects.ts';

function Article({ article }: { article: NewsArticle }) {
  const { lang } = useI18n();
  const published = new Intl.DateTimeFormat(lang === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: PARAMS.timeZone,
  }).format(new Date(article.publishedAt));
  return (
    <>
      <a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}</a>
      {' — '}<span>{article.source}</span>{' · '}
      <time dateTime={article.publishedAt}>{published} JST</time>
    </>
  );
}

function CompanyNews({ company }: { company: string }) {
  const { lang, t, fmt } = useI18n();
  const paused = useFeed((s) => s.paused);
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    const update = async () => {
      setLoading(true);
      try {
        const response = await relayFetch('/relay/news', {
          method: 'POST',
          extraHeaders: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company, lang }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error(`news ${response.status}`);
        const next = NewsFeed.parse(await response.json());
        if (next.company !== company || next.lang !== lang) throw new Error('news target mismatch');
        if (!controller.signal.aborted) {
          setFeed(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), NEWS_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [company, lang, paused, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const state = freshness(feed ? Date.parse(feed.fetchedAt) : null, now, paused, NEWS_INTERVAL_MS);
  return (
    <div className="live-feed company-news" role="region" aria-label={t('news.region')} data-testid="news-feed">
      <Badge appearance="outline" color="informative">{t('news.label')}</Badge>
      <span className="company-news-target">{company}</span>
      <div className="live-feed-message">
        {feed?.articles[0] && <Article article={feed.articles[0]} />}
        {!feed && !error && <span role="status">{t(paused ? 'news.paused' : 'news.loading')}</span>}
        {feed && !feed.articles.length && <span role="status">{t('news.empty')}</span>}
        {error && <span role="status" className="company-news-error">{t(feed ? 'news.failedCached' : 'news.failed')}</span>}
      </div>
      <span className="live-feed-meta">
        {feed && <>
          <Caption1>{t('news.checkedAt', { time: fmt.time(new Date(feed.fetchedAt)) })}</Caption1>
          <Caption1>{feed.provider}</Caption1>
        </>}
        <Badge appearance="tint" color={paused ? 'informative' : error ? 'danger' : state === 'fresh' ? 'success' : 'warning'} data-testid="news-freshness">
          {paused ? t('freshness.paused') : error ? t('news.failedShort') : t(`freshness.${state}`)}
        </Badge>
        <Button size="small" appearance="subtle" disabled={paused || loading} onClick={() => setRefresh((n) => n + 1)} data-testid="news-refresh">
          {t('news.refresh')}
        </Button>
      </span>
      <details className="company-news-list">
        <summary>{feed?.articles.length ? t('news.more', { n: feed.articles.length }) : t('news.about')}</summary>
        <Caption1 className="company-news-notice">{t('news.notice')}</Caption1>
        {feed && <ul>{feed.articles.map((article) => <li key={article.url}><Article article={article} /></li>)}</ul>}
      </details>
    </div>
  );
}

export function NewsFeedBar() {
  const { lang, t } = useI18n();
  const { project, company } = useActiveProject();
  // A registered project is authoritative, even if its data still uses the sample pack.
  const name = (project ? company?.name : loaded.pack.isSample ? null : loaded.pack.company.name[lang])?.trim();
  if (!name) return (
    <div className="live-feed company-news" role="region" aria-label={t('news.region')}>
      <Badge appearance="outline" color="informative">{t('news.label')}</Badge>
      <span>{t('news.sample')}</span>
    </div>
  );
  return <CompanyNews key={JSON.stringify([name, lang])} company={name} />;
}
