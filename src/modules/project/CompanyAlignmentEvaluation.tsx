import { useMemo, useState } from 'react';
import { Button, Checkbox, Field, MessageBar, MessageBarBody, Textarea } from '@fluentui/react-components';
import { appStorage } from '../../data/deviceStorage.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { alignmentEvaluationKey, AlignmentEvaluationCasesSchema, AlignmentEvaluationDocumentSchema, evaluateAlignmentCases } from './companyAlignment.ts';
import { downloadText } from './common.tsx';

const EXAMPLE = JSON.stringify([
  { id: 'case-01', expected: 'unaligned', observed: 'unaligned', negativeControl: true },
  { id: 'case-02', expected: 'direct', observed: 'indirect', negativeControl: false },
], null, 2);

export function CompanyAlignmentEvaluation({ companyId }: { companyId: string }) {
  const { t, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const stored = useMemo(() => {
    try {
      const raw = appStorage.getItem(alignmentEvaluationKey(companyId));
      if (!raw) return { text: '', error: false };
      const document = AlignmentEvaluationDocumentSchema.parse(JSON.parse(raw) as unknown);
      return { text: JSON.stringify(document.cases, null, 2), error: false };
    }
    catch { return { text: '', error: true }; }
  }, [companyId]);
  const [text, setText] = useState(stored.text);
  const [independent, setIndependent] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      const result = AlignmentEvaluationCasesSchema.safeParse(JSON.parse(text) as unknown);
      return result.success
        ? { cases: result.data, error: '' }
        : { cases: null, error: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    } catch (error) {
      return { cases: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [text]);
  const result = parsed?.cases ? evaluateAlignmentCases(parsed.cases) : null;
  const percent = (value: number | null) => value === null ? '—' : fmt.percent(value);

  if (audience === 'external') return null;

  const save = () => {
    if (!parsed?.cases || !independent) return;
    try {
      appStorage.setItem(alignmentEvaluationKey(companyId), JSON.stringify({
        format: 'bas-alignment-evaluation', version: 1, independentConfirmedAt: new Date().toISOString(), cases: parsed.cases,
      }));
      setIndependent(false);
      setMessage({ error: false, text: t('proj.align.eval.saved') });
    } catch (error) {
      setMessage({ error: true, text: `${t('proj.anchor.storageError')} ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  return (
    <details className="proj-company-info" data-testid={`alignment-evaluation-${companyId}`}>
      <summary>{t('proj.align.eval.title')}</summary>
      <p>{t('proj.align.eval.intro')}</p>
      {stored.error && <MessageBar intent="error"><MessageBarBody>{t('proj.anchor.storageError')}</MessageBarBody></MessageBar>}
      {message && <MessageBar intent={message.error ? 'error' : 'success'} role="status"><MessageBarBody>{message.text}</MessageBarBody></MessageBar>}
      <Field label={t('proj.align.eval.cases')} hint={t('proj.align.eval.hint')} validationState={parsed?.error ? 'error' : 'none'}>
        <Textarea value={text} onChange={(_, data) => { setText(data.value); setIndependent(false); setMessage(null); }}
          placeholder={EXAMPLE} rows={7} resize="vertical" data-testid="alignment-evaluation-json" />
      </Field>
      {parsed?.error && <p role="alert" lang="en">{parsed.error}</p>}
      {result && (
        <div data-testid="alignment-evaluation-result">
          <p>{t('proj.align.eval.negative', {
            count: result.negative.total, unaligned: result.negative.unaligned, rate: percent(result.negative.rate),
            status: t(result.negative.total ? (result.negative.meetsTarget ? 'proj.align.eval.targetMet' : 'proj.align.eval.targetMissed') : 'proj.align.eval.notMeasured'),
          })}</p>
          {result.negativeInterval && <p>{t('proj.align.eval.interval', { low: percent(result.negativeInterval.low), high: percent(result.negativeInterval.high) })}</p>}
          <p>{t('proj.align.eval.falseDirect', { count: result.negative.falseDirect })}</p>
          <p>{t('proj.align.eval.agreement', {
            matches: result.matches, count: result.total, rate: percent(result.agreement),
            kappa: result.kappa === null ? '—' : result.kappa.toFixed(2),
          })}</p>
          {result.agreementInterval && <p>{t('proj.align.eval.interval', { low: percent(result.agreementInterval.low), high: percent(result.agreementInterval.high) })}</p>}
          {result.kappaInterval
            ? <p>{t('proj.align.eval.kappaInterval', { low: result.kappaInterval.low.toFixed(2), high: result.kappaInterval.high.toFixed(2) })}</p>
            : <p>{t('proj.align.eval.kappaIntervalUnavailable')}</p>}
          <p>{t('proj.align.eval.distribution', { direct: result.direct, count: result.total, rate: percent(result.directRate) })}</p>
          {result.directInterval && <p>{t('proj.align.eval.interval', { low: percent(result.directInterval.low), high: percent(result.directInterval.high) })}</p>}
          {result.directWarning && <MessageBar intent="warning"><MessageBarBody>{t('proj.align.eval.directWarning')}</MessageBarBody></MessageBar>}
          <p className="muted">{t('proj.align.eval.limits')}</p>
        </div>
      )}
      <Checkbox checked={independent} onChange={(_, data) => setIndependent(data.checked === true)} label={t('proj.align.eval.independent')} data-testid="alignment-evaluation-independent" />
      <div className="proj-row">
        <Button appearance="primary" disabled={!parsed?.cases || !independent || stored.error} onClick={save} data-testid="alignment-evaluation-save">{t('proj.save')}</Button>
        <Button disabled={!parsed?.cases} onClick={() => parsed?.cases && downloadText('alignment-evaluation.json', JSON.stringify(parsed.cases, null, 2), 'application/json')}>
          {t('proj.align.eval.export')}
        </Button>
      </div>
    </details>
  );
}
