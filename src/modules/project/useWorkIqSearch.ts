import { useCallback } from 'react';
import { useI18n } from '../../i18n/index.ts';
import { askWorkIqSections, RelayError, type WorkIqAspect, type WorkIqProvider } from '../ai/relayClient.ts';
import { useAiSettings, workIqReady } from '../ai/settingsStore.ts';
import { useTargetNames } from './common.tsx';
import { todayIn } from './deliverablesUi.tsx';

export interface WorkIqFinding {
  /** The question the relay asked, so the evidence can be traced back. */
  question: string;
  answer: string;
  citations: { title: string; url: string }[];
}

export type WorkIqSearchError = { code: string };

/**
 * Searches Work IQ for the material a requirements definition needs (rules, current systems, user voices). It reads
 * only; nothing is saved until a person adopts a finding as evidence.
 */
export function useWorkIqSearch(): { ready: boolean; search: (aspect: WorkIqAspect, signal?: AbortSignal) => Promise<WorkIqFinding[]> } {
  const { t, lang } = useI18n();
  const ai = useAiSettings();
  const { company, project } = useTargetNames();
  const ready = workIqReady(ai);
  const provider = ai.provider;
  const search = useCallback(async (aspect: WorkIqAspect, signal?: AbortSignal): Promise<WorkIqFinding[]> => {
    try {
      const sections = await askWorkIqSections({
        company, project, purpose: t('sol.ev.purpose'), focus: '', asOf: todayIn(), lang,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        provider: provider as WorkIqProvider, aspects: [aspect], topics: [],
      }, signal);
      const found = sections.flatMap((s) => ('error' in s ? [] : [{ question: s.question, answer: s.answer.trim(), citations: s.citations }]));
      if (found.length === 0 && sections.length > 0) throw Object.assign(new Error('workiq'), { code: (sections[0] as { error?: string }).error ?? 'unknown' });
      return found.filter((f) => f.answer !== '');
    } catch (e) {
      if (e instanceof RelayError) throw Object.assign(new Error(e.code), { code: e.code });
      throw e;
    }
  }, [company, project, lang, provider, t]);
  return { ready, search };
}

export const errorCodeOf = (e: unknown): string => (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : 'unknown');
