import { useMemo, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input,
  MessageBar, MessageBarBody, Radio, RadioGroup,
} from '@fluentui/react-components';
import { readLedger } from '../../ai/client.ts';
import { recordsOfScope, summarizeTokens } from '../../ai/tokenUsage.ts';
import { loaded } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc } from '../../state/text.ts';
import { currentScope } from '../../state/projects.ts';
import { useSettings, type Audience } from '../../state/settings.ts';
import { TokenTable } from '../ai/AiCommon.tsx';
import { useUseCases } from '../usecases/store.ts';
import { useTargetNames, downloadText } from './common.tsx';
import { themeCounts } from './discussion.ts';
import { defaultFileName, prepareExport, toFollowUp, toJson, toMarkdown, type ExportFormat } from './exportFormat.ts';
import { useAnalyses, useDiscussion, useProjTransient, useScopeKpis } from './stores.ts';

/** FR-051〜FR-055, FR-219: scope, preview, confidentiality check, format, follow-up, person confirmation. */
export function ExportDialog() {
  const { t } = useI18n();
  const open = useProjTransient((s) => s.exportOpen);
  const presetTheme = useProjTransient((s) => s.exportThemeId);
  const close = useProjTransient((s) => s.closeExport);
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) close(); }}>
      {open ? <ExportSurface key={presetTheme ?? 'all'} presetTheme={presetTheme} onClose={close} /> : <DialogSurface aria-label={t('proj.export.title')} />}
    </Dialog>
  );
}

function ExportSurface({ presetTheme, onClose }: { presetTheme: string | null; onClose: () => void }) {
  const { t, lang } = useI18n();
  const settingsAudience = useSettings((s) => s.audience);
  const discussion = useDiscussion((s) => s.value);
  const kpi = useScopeKpis();
  const analysis = useAnalyses((s) => s.value);
  const useCases = useUseCases((s) => s.value);
  const names = useTargetNames();
  const [themeId, setThemeId] = useState<string | null>(presetTheme && discussion.themes.some((x) => x.id === presetTheme) ? presetTheme : null);
  const [include, setInclude] = useState({ kpi: true, analysis: true, useCases: true });
  const [audience, setAudience] = useState<Audience>(settingsAudience);
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [followUp, setFollowUp] = useState(true);
  const [customName, setCustomName] = useState<string | null>(null);
  const [step, setStep] = useState<'options' | 'persons'>('options');
  const now = useMemo(() => new Date(), []);
  const aiUsage = useMemo(() => summarizeTokens(recordsOfScope(readLedger(), currentScope())), []);

  const prepared = useMemo(
    () => prepareExport({ company: names.company, project: names.project, data: { discussion, kpi, analysis }, useCases, byId: loaded.byId, now }, { lang, audience, themeId, include }),
    [names.company, names.project, discussion, kpi, analysis, useCases, now, lang, audience, themeId, include],
  );
  const content = format === 'markdown' ? toMarkdown(prepared.bundle, aiUsage) : toJson(prepared.bundle);
  const defaultName = defaultFileName(names.company, names.project, now, 'discussion', format);
  const fileName = customName ?? defaultName;
  const counts = themeCounts(prepared.bundle.discussion);
  const met = counts.filter((c) => c.met).length;
  const scopeText = themeId ? loc(discussion.themes.find((x) => x.id === themeId)?.title ?? '', lang) : t('proj.export.scope.all');

  const doExport = () => {
    downloadText(fileName.trim() || defaultName, content, format === 'markdown' ? 'text/markdown' : 'application/json');
    if (followUp) downloadText(defaultFileName(names.company, names.project, now, 'followup'), toFollowUp(prepared.bundle), 'text/markdown');
    onClose();
  };
  const onExport = () => {
    if (prepared.personCount > 0 && step === 'options') setStep('persons');
    else doExport();
  };

  if (step === 'persons') {
    return (
      <DialogSurface data-testid="proj-persons-confirm" aria-describedby="proj-persons-body">
        <DialogBody>
          <DialogTitle>{t('proj.persons.title')}</DialogTitle>
          <DialogContent>
            <p id="proj-persons-body">{t('proj.persons.body', { count: prepared.personCount, scope: scopeText })}</p>
            <ul>
              {prepared.related.filter((e) => e.kind === 'person').map((e) => <li key={e.id}>{e.name[lang]}</li>)}
            </ul>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={doExport}>{t('proj.persons.continue')}</Button>
            <Button appearance="secondary" onClick={() => setStep('options')}>{t('proj.cancel')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    );
  }

  return (
    <DialogSurface className="proj-export-surface" data-testid="proj-export-dialog">
      <DialogBody>
        <DialogTitle>{t('proj.export.title')}</DialogTitle>
        <DialogContent className="proj-export-content">
          <div className="proj-export-options">
            <Field label={t('proj.export.scope')}>
              <RadioGroup value={themeId ?? '__all'} onChange={(_, d) => setThemeId(d.value === '__all' ? null : d.value)}>
                <Radio value="__all" label={t('proj.export.scope.all')} />
                {discussion.themes.map((th) => <Radio key={th.id} value={th.id} label={t('proj.export.scope.theme', { theme: loc(th.title, lang) })} />)}
              </RadioGroup>
            </Field>
            <Field label={t('proj.export.sections')}>
              <div className="proj-checks">
                <Checkbox checked={include.kpi} onChange={(_, d) => setInclude({ ...include, kpi: !!d.checked })} label={t('proj.export.include.kpi')} />
                <Checkbox checked={include.analysis} onChange={(_, d) => setInclude({ ...include, analysis: !!d.checked })} label={t('proj.export.include.analysis')} />
                <Checkbox checked={include.useCases} onChange={(_, d) => setInclude({ ...include, useCases: !!d.checked })} label={t('proj.export.include.useCases')} />
              </div>
            </Field>
            <Field label={t('proj.export.audience')}>
              <RadioGroup layout="horizontal" value={audience} onChange={(_, d) => setAudience(d.value as Audience)}>
                <Radio value="internal" label={t('proj.export.audience.internal')} />
                <Radio value="external" label={t('proj.export.audience.external')} />
              </RadioGroup>
            </Field>
            <Field label={t('proj.export.format')}>
              <RadioGroup layout="horizontal" value={format} onChange={(_, d) => { setFormat(d.value as ExportFormat); setCustomName(null); }}>
                <Radio value="markdown" label={t('proj.export.format.markdown')} />
                <Radio value="json" label={t('proj.export.format.json')} />
              </RadioGroup>
            </Field>
            <Checkbox checked={followUp} onChange={(_, d) => setFollowUp(!!d.checked)} label={t('proj.export.followUp')} />
            <Field label={t('proj.export.fileName')}>
              <Input value={fileName} onChange={(_, d) => setCustomName(d.value)} data-testid="proj-export-filename" />
            </Field>
            {audience === 'external' && prepared.excludedInternal > 0 && (
              <MessageBar intent="info" layout="multiline"><MessageBarBody>{t('proj.export.excluded', { count: prepared.excludedInternal })}</MessageBarBody></MessageBar>
            )}
            {audience === 'internal' && prepared.internalIncluded > 0 && (
              <MessageBar intent="warning" layout="multiline"><MessageBarBody>{t('proj.export.internalWarning', { count: prepared.internalIncluded })}</MessageBarBody></MessageBar>
            )}
            {prepared.personCount > 0 && (
              <MessageBar intent="warning" layout="multiline"><MessageBarBody>{t('proj.export.personsNote', { count: prepared.personCount })}</MessageBarBody></MessageBar>
            )}
            <p className="proj-goal-line" data-testid="proj-export-goal">{t('proj.export.goal', { met, total: counts.length })}</p>
            <section className="proj-export-tokens" aria-labelledby="proj-export-tokens-title" data-testid="proj-export-tokens">
              <h3 className="proj-h3" id="proj-export-tokens-title">{t('proj.export.tokens.title')}</h3>
              <TokenTable summary={aiUsage} extraRows={[t('proj.export.tokens.export')]} testId="proj-export-tokens-table" />
              <p className="muted">{t('proj.export.tokens.note')}</p>
            </section>
          </div>
          <div className="proj-export-preview">
            <h3 className="proj-h3" id="proj-export-preview-title">{t('proj.export.preview')}</h3>
            <pre className="proj-preview" tabIndex={0} aria-labelledby="proj-export-preview-title" data-testid="proj-export-preview">{content}</pre>
          </div>
        </DialogContent>
        <DialogActions>
          <Button appearance="primary" onClick={onExport} data-testid="proj-export-confirm">{t('proj.export.run')}</Button>
          <Button appearance="secondary" onClick={onClose}>{t('proj.cancel')}</Button>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  );
}
