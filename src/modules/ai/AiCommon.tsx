import type { ReactNode } from 'react';
import { Badge, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import type { TokenCount } from '../../ai/client.ts';
import { tokenLineLabel, type TokenLine, type TokenSummary } from '../../ai/tokenUsage.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useAiSettings } from './settingsStore.ts';
import './ai.css';

/** Reasons the UI can explain: the client gate's reasons plus the relay's own refusals. */
export const KNOWN_REASONS = [
  'liveDisabled', 'notConfirmed', 'notConfigured', 'budget', 'liveFailed',
  'relayUnreachable',
] as const;
export type KnownReason = (typeof KNOWN_REASONS)[number];

export function reasonKey(r: string): MessageKey {
  return (KNOWN_REASONS as readonly string[]).includes(r) ? `ai.reason.${r as KnownReason}` : 'ai.reason.unknown';
}

/** D-4: rights and contracts are assumed settled before the app starts. Shown in AI setup. */
export function D4Warning({ testId = 'ai-d4-warning' }: { testId?: string }) {
  const { t } = useI18n();
  return (
    <MessageBar intent="warning" layout="multiline" className="ai-d4-warning" data-testid={testId}>
      <MessageBarBody>
        <MessageBarTitle>{t('ai.d4.title')}</MessageBarTitle>
        {t('ai.d4.body')}
      </MessageBarBody>
    </MessageBar>
  );
}

/** FR-011 / NFR-LEGAL-002: every mock answer is visibly labelled, with the reasons the real connection was not used. */
export function MockNotice({ reasons, children }: { reasons: string[]; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="ai-mock" data-testid="ai-mock-label">
      <div className="ai-mock-head">
        <Badge appearance="filled" color="warning">{t('ai.mock.badge')}</Badge>
        <span>{t('ai.mock.explain')}</span>
      </div>
      {reasons.length > 0 && (
        <ul className="ai-reasons" aria-label={t('ai.mock.reasons')}>
          {reasons.map((r) => <li key={r} data-reason={r}>{t(reasonKey(r))}</li>)}
        </ul>
      )}
      {children}
    </div>
  );
}

/** Input / output / total tokens of one job as the provider reported them; any figure it did not report reads "unknown". */
export function TokensInline({ usage, testId = 'ai-live-tokens' }: { usage: TokenCount; testId?: string }) {
  const { t, fmt } = useI18n();
  const known = (v: number | null) => (v === null ? t('ai.tokens.unavailable') : fmt.integer(v));
  const total = usage.inputTokens === null || usage.outputTokens === null ? null : usage.inputTokens + usage.outputTokens;
  return (
    <p className="muted" data-testid={testId}>
      {t('ai.tokens.call', { total: known(total), input: known(usage.inputTokens), output: known(usage.outputTokens) })}
    </p>
  );
}

/** A real (live) answer: labelled "Live" with the tokens the provider reported (unknown when it reported none). */
export function LiveNotice({ usage, children }: { usage?: TokenCount; children?: ReactNode }) {
  const { t } = useI18n();
  const provider = useAiSettings((s) => s.provider);
  return (
    <div className="ai-live" data-testid="ai-live-label">
      <div className="ai-mock-head">
        <Badge appearance="filled" color="success">{t('ai.live.badge')}</Badge>
        <span>{t('ai.live.explain', { provider: t(`ai.provider.${provider}`) })}</span>
      </div>
      {usage && <TokensInline usage={usage} />}
      {children}
    </div>
  );
}

/**
 * Tokens per step and their total, as the provider reported them (the usage ledger is the only source).
 * `extraRows` are steps that used no generative AI (shown as 0 so the reader sees they were counted, not missed).
 */
export function TokenTable({ summary, extraRows = [], testId = 'ai-tokens', caption, lineLabel }: {
  summary: TokenSummary;
  extraRows?: string[];
  testId?: string;
  caption?: string;
  lineLabel?: (line: TokenLine) => string;
}) {
  const { t, fmt, lang } = useI18n();
  const tokens = (v: number | null) => v === null ? t('ai.tokens.unavailable') : fmt.integer(v);
  return (
    <table className="ai-token-table" data-testid={testId}>
      {caption && <caption>{caption}</caption>}
      <thead>
        <tr>
          <th scope="col">{t('ai.tokens.step')}</th>
          <th scope="col">{t('ai.tokens.calls')}</th>
          <th scope="col">{t('ai.tokens.input')}</th>
          <th scope="col">{t('ai.tokens.output')}</th>
          <th scope="col">{t('ai.tokens.total')}</th>
        </tr>
      </thead>
      <tbody>
        {summary.lines.map((l) => (
          <tr key={`${l.use}.${l.step ?? ''}`} data-testid={`${testId}-row`} data-use={l.use} data-step={l.step ?? ''}>
            <th scope="row">{lineLabel?.(l) ?? tokenLineLabel(l, lang)}{l.estimatedCalls > 0 ? ` ${t('ai.tokens.estimatedMark')}` : ''}</th>
            <td>{fmt.integer(l.calls)}</td>
            <td>{tokens(l.inputTokens)}</td>
            <td>{tokens(l.outputTokens)}</td>
            <td data-testid={`${testId}-row-total`}>{tokens(l.totalTokens)}</td>
          </tr>
        ))}
        {extraRows.map((label) => (
          <tr key={`extra.${label}`} data-testid={`${testId}-row`} data-use="none">
            <th scope="row">{label}</th>
            <td>0</td><td>0</td><td>0</td>
            <td data-testid={`${testId}-row-total`}>0</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr data-testid={`${testId}-total`}>
          <th scope="row">{t('ai.tokens.sum')}{summary.total.estimatedCalls > 0 ? ` ${t('ai.tokens.estimatedMark')}` : ''}</th>
          <td>{fmt.integer(summary.total.calls)}</td>
          <td>{tokens(summary.total.inputTokens)}</td>
          <td>{tokens(summary.total.outputTokens)}</td>
          <td data-testid={`${testId}-total-value`}>{tokens(summary.total.totalTokens)}</td>
        </tr>
      </tfoot>
    </table>
  );
}
