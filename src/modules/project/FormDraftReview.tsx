import { useState, type ReactNode } from 'react';
import { Button, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { Checkmark20Regular, Dismiss20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { MockBadge } from './common.tsx';
import type { FormDraft, FormDraftKind, FormDraftRequest } from './formDraft.ts';

type DraftOf<K extends FormDraftKind> = FormDraft[K];

interface Pending<K extends FormDraftKind> {
  draft: DraftOf<K>;
  mock: boolean;
  baseline: string;
}

/**
 * "Draft with Copilot" for one form: the draft is shown as a proposal next to the current input. Approving applies it
 * (the caller decides whether that fills the form or saves); discarding drops it. When the input the draft was built
 * from changes, approval is disabled until a new draft is made, so a stale proposal cannot overwrite newer work.
 */
export function FormDraftReview<K extends FormDraftKind>({ kind, testId, baseline, request, preview, onApprove, disabled }: {
  kind: K;
  testId: string;
  /** Signature of the input the draft is built from. */
  baseline: string;
  request: FormDraftRequest<K>;
  preview: (draft: FormDraft[K]) => ReactNode;
  onApprove: (draft: FormDraft[K]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending<K> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const stale = !!pending && pending.baseline !== baseline;

  const create = async () => {
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      const { response, draft } = await request();
      if (!draft) {
        setPending(null);
        setError(t('dlv.fd.unreadable'));
      } else setPending({ draft, mock: response.mode === 'mock', baseline });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dlv-form-draft" data-testid={testId} data-kind={kind}>
      <div className="proj-row">
        <Button icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={busy || disabled} onClick={() => void create()} data-testid={`${testId}-create`}>
          {pending ? t('dlv.fd.recreate') : t('dlv.fd.create')}
        </Button>
        {applied && <span role="status" data-testid={`${testId}-applied`}>{t(`dlv.fd.applied.${kind}`)}</span>}
      </div>
      {error && <p role="alert" className="proj-error" data-testid={`${testId}-error`}>{error}</p>}
      {pending && (
        <section className="dlv-form-draft-preview" aria-label={t('dlv.fd.preview')} data-testid={`${testId}-preview`} data-stale={stale}>
          <p>
            <strong>{t('dlv.fd.preview')}</strong>{' '}
            {pending.mock && <MockBadge />}
          </p>
          <p className="muted">{t('dlv.fd.notSaved')}</p>
          {preview(pending.draft)}
          {stale && (
            <MessageBar intent="warning" data-testid={`${testId}-stale`}>
              <MessageBarBody>{t('dlv.fd.stale')}</MessageBarBody>
            </MessageBar>
          )}
          <div className="proj-row">
            <Button
              appearance="primary"
              icon={<Checkmark20Regular />}
              disabled={stale}
              onClick={() => {
                onApprove(pending.draft);
                setPending(null);
                setApplied(true);
              }}
              data-testid={`${testId}-approve`}
            >
              {t(`dlv.fd.approve.${kind}`)}
            </Button>
            <Button icon={<Dismiss20Regular />} onClick={() => setPending(null)} data-testid={`${testId}-discard`}>{t('dlv.fd.discard')}</Button>
          </div>
        </section>
      )}
    </div>
  );
}
