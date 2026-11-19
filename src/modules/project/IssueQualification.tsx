import { useState } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Radio, RadioGroup, Textarea,
} from '@fluentui/react-components';
import { PARAMS } from '../../config/params.ts';
import type { Entity, EntityOf } from '../../data/schema.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import {
  normalizeDeliverables, qualificationOf, QUALIFY_VERDICTS, setQualification, type CheckContext, type QualifyVerdict,
} from './deliverables.ts';
import { todayIn } from './deliverablesUi.tsx';
import { useDeliverables, useProjUi } from './stores.ts';

const VERDICT_COLOR: Record<QualifyVerdict, 'success' | 'warning' | 'danger'> = { pursue: 'success', notNow: 'warning', no: 'danger' };
const isKpi = (e: Entity | undefined): e is EntityOf<'kpi'> => e?.kind === 'kpi';

/** FR-347: the verdict of one issue (or "not qualified") and the button that opens the qualification. */
export function QualifyCell({ issue, ctx }: { issue: EntityOf<'issue'>; ctx: CheckContext }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const q = qualificationOf(ctx.deliverables, issue.id);
  const action = t(q ? 'proj.qualify.review' : 'proj.qualify.open');
  return (
    <span className="proj-qualify-cell" data-testid={`qualify-cell-${issue.id}`} data-verdict={q?.verdict ?? 'none'}>
      <Badge size="small" appearance="tint" color={q ? VERDICT_COLOR[q.verdict] : 'informative'}>
        {t(q ? `proj.qualify.verdict.${q.verdict}` : 'proj.qualify.unqualified')}
      </Badge>
      <Button size="small" appearance="subtle" onClick={() => setOpen(true)} aria-label={`${action}: ${loc(issue.name, lang)}`} data-testid={`qualify-open-${issue.id}`}>
        {action}
      </Button>
      {open && <QualifyDialog issue={issue} ctx={ctx} onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * Qualify one issue on its evidence: how it is measured, what it is now, what it should be (from its KPIs), its
 * sources and causes. "Not now" and "no" are results, not failures; a "pursue" must say what is different this time.
 */
function QualifyDialog({ issue, ctx, onClose }: { issue: EntityOf<'issue'>; ctx: CheckContext; onClose: () => void }) {
  const { t, lang, fmt } = useI18n();
  const saved = qualificationOf(ctx.deliverables, issue.id);
  const [verdict, setVerdict] = useState<QualifyVerdict | ''>(saved?.verdict ?? '');
  const [reason, setReason] = useState(saved?.reason ?? '');
  const [different, setDifferent] = useState(saved?.different ?? '');
  const [tried, setTried] = useState(false);
  const kpis = issue.kpiIds.map((id) => ctx.pack.byId.get(id)).filter(isKpi);
  const sources = issue.sourceIds.filter((id) => ctx.pack.byId.get(id)?.kind === 'source').length;
  const causes = issue.causeIds.filter((id) => ctx.pack.byId.get(id)?.kind === 'cause').length;
  const needsDifferent = verdict === 'pursue';
  const reasonMissing = reason.trim() === '';
  const differentMissing = needsDifferent && different.trim() === '';
  const name = loc(issue.name, lang);
  const write = (value: Parameters<typeof setQualification>[2]) => {
    useDeliverables.getState().set((v) => setQualification(normalizeDeliverables(v), issue.id, value));
    onClose();
  };
  const save = () => {
    setTried(true);
    if (!verdict || reasonMissing || differentMissing) return;
    write({
      verdict, reason: reason.trim(), ...(needsDifferent ? { different: different.trim() } : {}),
      at: new Date().toISOString(), by: useProjUi.getState().editor.trim(),
    });
  };
  const savedDate = saved ? fmt.date(todayIn(PARAMS.timeZone, new Date(saved.at))) : '';
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface data-testid="qualify-dialog">
        <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
          <DialogBody>
            <DialogTitle>{t('proj.qualify.title', { issue: name })}</DialogTitle>
            <DialogContent className="proj-edit-form">
              <p className="muted">{t('proj.qualify.lead')}</p>
              <section aria-labelledby="qualify-evidence-title" data-testid="qualify-evidence">
                <h3 id="qualify-evidence-title" className="step-dash-subhead">{t('proj.qualify.evidence')}</h3>
                {kpis.length === 0 ? <p>{t('proj.qualify.noKpi')}</p> : (
                  <ul>
                    {kpis.map((k) => (
                      <li key={k.id}>
                        {t('proj.qualify.kpiLine', {
                          kpi: loc(k.name, lang),
                          now: `${fmt.number(k.current)} ${loc(k.unit, lang)}`,
                          target: `${fmt.number(k.target)} ${loc(k.unit, lang)}`,
                          period: loc(k.period, lang),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
                <p>{t('proj.qualify.basis', { sources, causes })}</p>
              </section>
              <Field label={t('proj.qualify.verdict')} required validationState={tried && !verdict ? 'error' : 'none'} validationMessage={tried && !verdict ? t('proj.qualify.chooseVerdict') : undefined}>
                <RadioGroup value={verdict} onChange={(_, d) => setVerdict(d.value as QualifyVerdict)} data-testid="qualify-verdict">
                  {QUALIFY_VERDICTS.map((v) => <Radio key={v} value={v} label={t(`proj.qualify.option.${v}`)} data-testid={`qualify-verdict-${v}`} />)}
                </RadioGroup>
              </Field>
              <Field label={t('proj.qualify.reason')} hint={t('proj.qualify.reasonHint')} required validationState={tried && reasonMissing ? 'error' : 'none'} validationMessage={tried && reasonMissing ? t('proj.qualify.required') : undefined}>
                <Textarea value={reason} onChange={(_, d) => setReason(d.value)} resize="vertical" rows={4} data-testid="qualify-reason" />
              </Field>
              {needsDifferent && (
                <Field label={t('proj.qualify.different')} hint={t('proj.qualify.differentHint')} required validationState={tried && differentMissing ? 'error' : 'none'} validationMessage={tried && differentMissing ? t('proj.qualify.required') : undefined}>
                  <Textarea value={different} onChange={(_, d) => setDifferent(d.value)} resize="vertical" rows={3} data-testid="qualify-different" />
                </Field>
              )}
              {saved && (
                <p className="muted" data-testid="qualify-saved">
                  {saved.by ? t('proj.qualify.savedBy', { date: savedDate, by: saved.by }) : t('proj.qualify.savedAnon', { date: savedDate })}
                </p>
              )}
            </DialogContent>
            <DialogActions>
              <Button type="submit" appearance="primary" data-testid="qualify-save">{t('proj.save')}</Button>
              {saved && <Button type="button" onClick={() => write(null)} data-testid="qualify-clear">{t('proj.qualify.clear')}</Button>}
              <Button type="button" onClick={onClose}>{t('proj.cancel')}</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
