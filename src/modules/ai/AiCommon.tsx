import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import { selectOutbound } from '../../ai/redact.ts';
import { AI_LIMITS } from '../../ai/policy.ts';
import type { Entity } from '../../data/schema.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';

/** Reasons the UI can explain: the client gate's reasons plus the relay's own refusals. */
export const KNOWN_REASONS = [
  'c03NotApproved', 'liveDisabled', 'notConfirmed', 'notConfigured', 'noUnitPrice', 'budget', 'personNotConfirmed', 'liveFailed',
  'relayUnreachable',
] as const;
export type KnownReason = (typeof KNOWN_REASONS)[number];

export function reasonKey(r: string): MessageKey {
  return (KNOWN_REASONS as readonly string[]).includes(r) ? `ai.reason.${r as KnownReason}` : 'ai.reason.unknown';
}

/** Yen with up to 2 decimals: live calls usually cost less than 1 JPY. */
export function yenFine(locale: string, v: number): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'JPY', maximumFractionDigits: 2 }).format(v);
}

/** D-4: rights and contracts are assumed settled before the app starts. Shown wherever a real send can be started. */
export function D4Warning({ testId = 'ai-d4-warning' }: { testId?: string }) {
  const { t } = useI18n();
  return (
    <MessageBar intent="warning" layout="multiline" data-testid={testId}>
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

/** A real (live) answer: labelled "Live" with the recorded cost. */
export function LiveNotice({ costJpy, children }: { costJpy: number; children?: ReactNode }) {
  const { t, fmt } = useI18n();
  return (
    <div className="ai-live" data-testid="ai-live-label">
      <div className="ai-mock-head">
        <Badge appearance="filled" color="success">{t('ai.live.badge')}</Badge>
        <span>{t('ai.live.explain', { cost: yenFine(fmt.locale, costJpy) })}</span>
      </div>
      {children}
    </div>
  );
}

type ConfirmResult = Promise<boolean>;
type ConfirmFn = (entities: Entity[], scope: string) => ConfirmResult;

/**
 * FR-219: before anything that would send "person" entities, ask with the count and the scope.
 * Resolves true when the user continues (or when there is no person), false on cancel.
 */
export function usePersonConfirm(): { dialog: ReactNode; confirm: ConfirmFn } {
  const { t } = useI18n();
  const [pending, setPending] = useState<{ count: number; scope: string } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback<ConfirmFn>((entities, scope) => {
    const count = selectOutbound(entities, loaded.byId).personCount;
    if (count === 0) return Promise.resolve(true);
    return new Promise((resolve: (ok: boolean) => void) => {
      resolver.current = resolve;
      setPending({ count, scope });
    });
  }, []);
  const close = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setPending(null);
  };
  const dialog = (
    <Dialog open={pending !== null} modalType="alert" onOpenChange={(_, d) => { if (!d.open) close(false); }}>
      <DialogSurface data-testid="ai-person-confirm">
        <DialogBody>
          <DialogTitle>{t('ai.person.title')}</DialogTitle>
          <DialogContent className="ai-stack">
            <p>{t('ai.person.body', { count: pending?.count ?? 0, scope: pending?.scope ?? '' })}</p>
            <p className="muted">{t('ai.person.note')}</p>
            <D4Warning />
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={() => close(true)}>{t('ai.person.continue')}</Button>
            <Button onClick={() => close(false)}>{t('ai.person.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
  return { dialog, confirm };
}

/** What the live send confirmation shows, built from preflight() (C-03: content and cost confirmed by the user). */
export interface LiveConfirmInfo {
  use: MessageKey;
  scope: string;
  itemCount: number;
  internalCount: number;
  personCount: number;
  estimatedCostJpy: number;
  monthSpentJpy: number;
  monthBudgetJpy: number;
}

export interface LiveDecision {
  ok: boolean;
  personConfirmed: boolean;
}

/** Send confirmation for a real call: content, internal/person counts (D-2, FR-219), estimated cost, budget and D-4. */
type LiveConfirmResult = Promise<LiveDecision>;
type LiveConfirmFn = (info: LiveConfirmInfo) => LiveConfirmResult;

export function useLiveConfirm(): { dialog: ReactNode; confirmLive: LiveConfirmFn } {
  const { t, fmt } = useI18n();
  const [pending, setPending] = useState<LiveConfirmInfo | null>(null);
  const [personChecked, setPersonChecked] = useState(false);
  const resolver = useRef<((d: LiveDecision) => void) | null>(null);
  const confirmLive = useCallback<LiveConfirmFn>((info) => new Promise((resolve: (d: LiveDecision) => void) => {
    resolver.current = resolve;
    setPersonChecked(false);
    setPending(info);
  }), []);
  const close = (ok: boolean) => {
    const needsPerson = (pending?.personCount ?? 0) > 0;
    resolver.current?.({ ok, personConfirmed: ok && (!needsPerson || personChecked) });
    resolver.current = null;
    setPending(null);
  };
  const p = pending;
  const blocked = p !== null && p.personCount > 0 && !personChecked;
  const dialog = (
    <Dialog open={p !== null} modalType="alert" onOpenChange={(_, d) => { if (!d.open) close(false); }}>
      <DialogSurface data-testid="ai-live-confirm">
        <DialogBody>
          <DialogTitle>{t('ai.live.title')}</DialogTitle>
          <DialogContent className="ai-stack">
            {p && (
              <>
                <p>{t('ai.live.lead', { use: t(p.use) })}</p>
                <ul className="ai-reasons" data-testid="ai-live-content">
                  <li>{t('ai.live.items', { count: p.itemCount, scope: p.scope })}</li>
                  <li data-testid="ai-live-internal">{t('ai.live.internal', { count: p.internalCount })}</li>
                  <li data-testid="ai-live-persons">{t('ai.live.persons', { count: p.personCount })}</li>
                </ul>
                <p data-testid="ai-live-cost">{t('ai.live.cost', { cost: yenFine(fmt.locale, p.estimatedCostJpy), factor: AI_LIMITS.estimateSafetyFactor })}</p>
                <p data-testid="ai-live-month">{t('ai.live.month', { spent: yenFine(fmt.locale, p.monthSpentJpy), budget: fmt.yen(p.monthBudgetJpy) })}</p>
                {p.personCount > 0 && (
                  <Checkbox
                    checked={personChecked}
                    onChange={(_, d) => setPersonChecked(d.checked === true)}
                    label={t('ai.live.personCheck', { count: p.personCount })}
                    data-testid="ai-live-person-check"
                  />
                )}
                <p className="muted">{t('ai.live.noRecord')}</p>
                <D4Warning />
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={blocked} onClick={() => close(true)} data-testid="ai-live-send">{t('ai.live.send')}</Button>
            <Button onClick={() => close(false)}>{t('ai.person.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
  return { dialog, confirmLive };
}