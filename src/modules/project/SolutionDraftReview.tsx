import { useState } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { Sparkle20Regular } from '@fluentui/react-icons';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import type { AppCheckContext } from './deliverables.ts';
import { attachmentCandidates, sectionKey } from './solutionDocs.ts';
import {
  applySolutionDraft, requestSolutionDraft, solutionBaseline, solutionDraftKey, type SavedSolutionDraft,
} from './solutionDraft.ts';
import { entityVisible } from './deliverableDraft.ts';
import { threadOf } from './deliverables.ts';
import { useSolutionDrafts } from './stores.ts';
import { normalizeStrategy, type StrategyData } from './strategy.ts';
import { getEntity } from '../../data/pack.ts';
import { useProjUi, useStrategy } from './stores.ts';

const by = () => useProjUi.getState().editor.trim();

/** Copilot's proposal for one solution: its type and every open section. Nothing changes until the person approves. */
export function SolutionDraftReview({ solutionId, ctx }: { solutionId: string; ctx: AppCheckContext }) {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const setStrategy = useStrategy((s) => s.set);
  const write = (fn: (d: StrategyData) => StrategyData) => setStrategy((prev) => fn(normalizeStrategy(prev)));
  const drafts = useSolutionDrafts((s) => s.value);
  const setDrafts = useSolutionDrafts((s) => s.set);
  const key = solutionDraftKey(audience, solutionId);
  const draft: SavedSolutionDraft | undefined = drafts[key];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thread = threadOf(ctx);
  const ts = thread.solutions.find((x) => x.id === solutionId);
  const solution = getEntity(solutionId);
  if (!ts || solution?.kind !== 'solution') return null;
  const strategy = normalizeStrategy(ctx.strategy);
  const changed = !!draft && draft.baseline !== solutionBaseline(strategy, solutionId);
  const candidates = attachmentCandidates(solution, ts, ctx, lang, entityVisible(ctx, audience), audience === 'internal');

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await requestSolutionDraft({ solutionId, ctx, lang, audience });
      const saved: SavedSolutionDraft = { ...result.draft, lang, at: new Date().toISOString(), mock: result.mock, baseline: solutionBaseline(strategy, solutionId) };
      setDrafts((value) => ({ ...value, [key]: saved }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const discard = () => setDrafts((value) => {
    const next = { ...value };
    delete next[key];
    return next;
  });
  const approve = () => {
    if (!draft) return;
    write((d) => applySolutionDraft(d, solutionId, draft, candidates, { by: by(), at: new Date().toISOString() }));
    discard();
  };

  return (
    <div className="sol-draft" data-testid={`sol-draft-${solutionId}`}>
      <div className="proj-row">
        <Button icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={busy} onClick={() => void generate()} data-testid={`sol-draft-generate-${solutionId}`}>
          {busy ? t('sol.draft.busy') : t('sol.draft.button')}
        </Button>
      </div>
      {error && <p role="alert" data-testid={`sol-draft-error-${solutionId}`}>{t('sol.draft.error', { detail: error })}</p>}
      {draft && (
        <section aria-label={t('sol.draft.title')} className="sol-draft-body" data-testid={`sol-draft-review-${solutionId}`} data-mode={draft.mock ? 'mock' : 'live'}>
          <h4 className="proj-h3">
            {t('sol.draft.title')}{' '}
            {draft.mock && <Badge size="small" appearance="tint" color="warning">{t('sol.draft.mock')}</Badge>}
          </h4>
          <p className="muted">{t('sol.draft.note')}</p>
          {changed && <MessageBar intent="warning" data-testid={`sol-draft-changed-${solutionId}`}><MessageBarBody>{t('sol.draft.changed')}</MessageBarBody></MessageBar>}
          <p data-testid={`sol-draft-type-${solutionId}`} data-type={draft.type}>
            {t('sol.draft.type', { type: t(`sol.type.${draft.type}`), current: t(`sol.type.${ts.type}`) })}
          </p>
          <p>{t('sol.draft.reason', { reason: draft.reason })}</p>
          <details open>
            <summary>{t('sol.draft.sections', { n: Object.keys(draft.sections).length })}</summary>
            {Object.entries(draft.sections).map(([id, text]) => (
              <div key={id} data-testid={`sol-draft-section-${solutionId}-${id}`}>
                <strong>{t(sectionKey(id) as MessageKey)}</strong>
                <pre className="dlv-form-draft-text">{text}</pre>
              </div>
            ))}
          </details>
          {!!draft.attachmentIds?.length && (
            <div data-testid={`sol-draft-attachments-${solutionId}`}>
              <strong>{t('sol.draft.attachments')}</strong>
              <ul>{candidates.filter((a) => draft.attachmentIds!.includes(a.id)).map((a) => <li key={a.id}>{`${a.file} — ${a.description}`}</li>)}</ul>
            </div>
          )}
          <div className="proj-row">
            <Button appearance="primary" onClick={approve} data-testid={`sol-draft-approve-${solutionId}`}>{t('sol.draft.approve')}</Button>
            <Button onClick={discard} data-testid={`sol-draft-discard-${solutionId}`}>{t('sol.draft.discard')}</Button>
          </div>
        </section>
      )}
    </div>
  );
}
