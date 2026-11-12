import { useMemo, useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody, Radio, RadioGroup, Spinner, Textarea } from '@fluentui/react-components';
import { Search20Regular, Send20Regular } from '@fluentui/react-icons';
import { aiComplete, type AiResponse } from '../../ai/client.ts';
import { C03_TABLE, isApproved } from '../../ai/policy.ts';
import { selectOutbound } from '../../ai/redact.ts';
import { loaded } from '../../data/pack.ts';
import type { Entity } from '../../data/schema.ts';
import { useI18n } from '../../i18n/index.ts';
import { createScopedStore } from '../../state/projects.ts';
import { hrefFor } from '../../state/router.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { useUseCases } from '../usecases/store.ts';
import { MockNotice, usePersonConfirm } from './AiCommon.tsx';
import { CHAT_CONTEXT_PAIRS, buildIndex, chatPrompt, search, type ChatTurn } from './search.ts';
import { isConfigured, useAiSettings } from './settingsStore.ts';
import { StoryVideoSection } from './StoryVideo.tsx';
import { TimeoutError, USAGE_MAX_CHARS, USAGE_TIMEOUT_MS, withTimeout } from './usage.ts';
import './mocks.ts';
import './ai.css';

/** PARAM-125: AI import file size cap. */
export const IMPORT_MAX_MB = 10;

/** Chat history per project (G-007). Only the last PARAM-123 pairs are sent as context. */
const useChat = createScopedStore<ChatTurn[]>('ai.chat', () => []);

function SearchAndChat() {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const useCases = useUseCases((s) => s.value);
  const history = useChat((s) => s.value);
  const setHistory = useChat((s) => s.set);
  const { dialog, confirm } = usePersonConfirm();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const index = useMemo(
    () => buildIndex(loaded.pack.entities.filter((e) => !isHidden(e, audience)), useCases),
    [audience, useCases],
  );
  const hits = useMemo(() => search(index, submitted), [index, submitted]);

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setCancelled(false);
    const grounding = search(index, q, 5)
      .filter((h) => h.type === 'entity')
      .map((h) => loaded.byId.get(h.id))
      .filter((e): e is Entity => Boolean(e));
    if (!(await confirm(grounding, t('ai.scope.chat')))) {
      setCancelled(true);
      return;
    }
    setBusy(true);
    const res: AiResponse = await aiComplete({ use: 'chat', lang, prompt: chatPrompt(q, history), entities: grounding, personConfirmed: true });
    const citations = selectOutbound(grounding, loaded.byId).included.map((e) => e.id);
    setHistory((h) => [...h, { q, a: res.text, citations, reasons: res.blockedReasons }]);
    setQuestion('');
    setBusy(false);
  };

  return (
    <div className="grid-2">
      <Panel title={t('ai.search.title')} testId="ai-search">
        <form
          className="ai-row"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query);
          }}
        >
          <Field label={t('ai.search.label')}>
            <Input value={query} onChange={(_, d) => setQuery(d.value)} data-testid="ai-search-input" />
          </Field>
          <Button type="submit" icon={<Search20Regular />}>{t('ai.search.go')}</Button>
        </form>
        {submitted && (
          <p role="status" className="muted">{t('ai.search.count', { count: hits.length })}</p>
        )}
        <ul className="ref-list ai-hits" data-testid="ai-search-results">
          {hits.map((h) => {
            if (h.type === 'entity') return <li key={h.id}><EntityRef id={h.id} /></li>;
            const u = useCases.find((x) => x.id === h.id);
            return u ? (
              <li key={h.id}>
                <a href={hrefFor('/usecases', { id: u.id })}>{loc(u.name, lang)}</a> <Badge appearance="outline">{t('ai.search.useCase')}</Badge>
              </li>
            ) : null;
          })}
        </ul>
      </Panel>

      <Panel title={t('ai.chat.title')} testId="ai-chat">
        <div className="ai-stack">
          <p className="ai-status">
            <Badge appearance="tint" color="danger" data-testid="ai-chat-foundry">{t('ai.chat.foundryBlocked')}</Badge>
            <span className="muted">{t('ai.chat.contextNote', { pairs: CHAT_CONTEXT_PAIRS })}</span>
          </p>
          <ol className="ai-chat-log" data-testid="ai-chat-log">
            {history.map((turn, i) => (
              <li key={i} className="ai-turn">
                <p className="ai-q"><span className="ai-label">{t('ai.chat.you')}</span> {turn.q}</p>
                <MockNotice reasons={turn.reasons}>
                  <p className="ai-answer">{turn.a}</p>
                  {turn.citations.length > 0 && (
                    <div className="ai-cites">
                      <span className="ai-label">{t('ai.chat.sources')}</span>
                      {turn.citations.map((id) => <EntityRef key={id} id={id} />)}
                    </div>
                  )}
                </MockNotice>
              </li>
            ))}
          </ol>
          {cancelled && <p role="status">{t('ai.person.cancelled')}</p>}
          <form
            className="ai-row"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <Field label={t('ai.chat.label')}>
              <Input value={question} onChange={(_, d) => setQuestion(d.value)} data-testid="ai-chat-input" />
            </Field>
            <Button type="submit" appearance="primary" icon={<Send20Regular />} disabled={busy || question.trim() === ''}>{t('ai.chat.send')}</Button>
            {history.length > 0 && <Button onClick={() => setHistory([])}>{t('ai.chat.clear')}</Button>}
          </form>
          {busy && <Spinner size="tiny" label={t('ai.loading')} />}
        </div>
      </Panel>
      {dialog}
    </div>
  );
}

function UsageAnalysis() {
  const { t, lang, fmt } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiResponse | null>(null);
  const [error, setError] = useState<'timeout' | 'failed' | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await withTimeout(aiComplete({ use: 'aiUsageAnalysis', lang, prompt: text.slice(0, USAGE_MAX_CHARS) }), USAGE_TIMEOUT_MS));
    } catch (e) {
      setError(e instanceof TimeoutError ? 'timeout' : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('ai.usageAnalysis.title')} testId="ai-usage-analysis">
      <div className="ai-stack">
        <p className="muted">{t('ai.usageAnalysis.lead', { seconds: USAGE_TIMEOUT_MS / 1000 })}</p>
        <Field label={t('ai.usageAnalysis.input')} hint={t('ai.usageAnalysis.count', { count: fmt.integer(text.length), max: fmt.integer(USAGE_MAX_CHARS) })}>
          <Textarea value={text} maxLength={USAGE_MAX_CHARS} resize="vertical" onChange={(_, d) => setText(d.value.slice(0, USAGE_MAX_CHARS))} data-testid="ai-usage-input" />
        </Field>
        <div>
          <Button onClick={() => void run()} disabled={busy || text.trim() === ''} data-testid="ai-usage-run">{t('ai.usageAnalysis.run')}</Button>
        </div>
        {busy && <Spinner size="tiny" label={t('ai.loading')} />}
        {error && <MessageBar intent="error"><MessageBarBody>{t(error === 'timeout' ? 'ai.usageAnalysis.timeout' : 'ai.usageAnalysis.failed')}</MessageBarBody></MessageBar>}
        {result && (
          <MockNotice reasons={result.blockedReasons}>
            <p className="ai-answer" data-testid="ai-usage-result">{result.text}</p>
          </MockNotice>
        )}
      </div>
    </Panel>
  );
}

function AiImport() {
  const { t } = useI18n();
  const settings = useAiSettings();
  const configured = isConfigured(settings);
  const approved = isApproved(C03_TABLE.import);
  const ready = configured && approved;
  return (
    <Panel title={t('ai.import.title')} testId="ai-import">
      <div className="ai-stack">
        <RadioGroup value="local" aria-labelledby="ai-lbl-import">
          <span id="ai-lbl-import" className="ai-label">{t('ai.import.method')}</span>
          <Radio value="local" label={t('ai.import.local')} />
          <Radio value="ai" label={t('ai.import.ai', { mb: IMPORT_MAX_MB })} disabled={!ready} data-testid="ai-import-ai" />
        </RadioGroup>
        {!ready && (
          <ul className="ai-reasons" data-testid="ai-import-reasons" aria-label={t('ai.import.why')}>
            {!configured && <li>{t('ai.reason.notConfigured')}</li>}
            {!approved && <li>{t('ai.reason.c03NotApproved')}</li>}
          </ul>
        )}
        <p className="muted">{t('ai.import.note', { mb: IMPORT_MAX_MB })}</p>
      </div>
    </Panel>
  );
}

/** /assistant: FR-017 search + chat, FR-284/285 usage analysis, FR-289 AI import, FR-291/292 story video. */
export function AssistantScreen() {
  const { t } = useI18n();
  return (
    <div className="screen ai-screen">
      <PageHeader title={t('ai.title')} subtitle={t('ai.subtitle')} />
      <p><a href={hrefFor('/ai-policy')}>{t('ai.policy.open')}</a></p>
      <SearchAndChat />
      <div className="grid-2">
        <UsageAnalysis />
        <AiImport />
      </div>
      <Panel title={t('ai.story.title')} testId="ai-story-panel">
        <StoryVideoSection />
      </Panel>
    </div>
  );
}
