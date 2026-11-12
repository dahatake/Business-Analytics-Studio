import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody,
  ProgressBar, Spinner, Textarea,
} from '@fluentui/react-components';
import {
  ArrowUpload20Regular, BotSparkle20Regular, CheckmarkCircle20Filled, Delete20Regular, DismissCircle20Filled, Open20Regular, Settings20Regular,
} from '@fluentui/react-icons';
import { AiLiveError, aiLive, preflight, readLedger, rebindLedgerScope } from '../../ai/client.ts';
import { jstDay, jstMonth } from '../../ai/budget.ts';
import { PACK_BUILD_TIMEOUT_MS, PER_USE_LIMITS } from '../../ai/policy.ts';
import { recordsOfScope, summarizeTokens, type TokenTotals } from '../../ai/tokenUsage.ts';
import { isReadableFile } from '../../data/packImport.ts';
import { anchorFreshness } from '../../data/companyAnchor.ts';
import { NewsRequest } from '../../data/news.ts';
import { importedPackMeta, loadImportedPack, saveImportedPack } from '../../data/packStore.ts';
import { useI18n, type Lang } from '../../i18n/index.ts';
import { MAX_PROJECTS_PER_COMPANY, useProjects } from '../../state/projects.ts';
import { latestCompanyAnchor } from '../../state/companyAnchors.ts';
import { useSettings } from '../../state/settings.ts';
import { AiReadiness, AiSettingsDialog } from '../ai/AiConnectionForm.tsx';
import { D4Warning, TokenTable, yenFine } from '../ai/AiCommon.tsx';
import { askWorkIqSections, fetchNewsHeadlines, fetchSitePages, type WorkIqAspect } from '../ai/relayClient.ts';
import { liveReady, useAiSettings, workIqReady } from '../ai/settingsStore.ts';
import '../ai/liveTransport.ts';
import {
  DEFAULT_WORKIQ_ROUNDS, generatePack, materialSources, MAX_MATERIAL_CHARS, MAX_WORKIQ_ROUNDS, missingRequired, PackGenError, prefillFromPack, runPlan, stageAPrompt,
  type GenResult, type Material, type PackGenInput, type ProgressEvent, type RequiredField, type StepId, type StepStatus,
} from './packGenerate.ts';
import { ReadinessView } from './ReadinessView.tsx';
import { invalidateProjectEvidence } from './companyAlignment.ts';

/** Where the generated pack goes: an existing project, or a company/project created when the pack is saved. */
export type PackGenTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'new'; companyName: string; projectName: string };

const STEPS: StepId[] = ['collect', 'foundation', 'business', 'verify', 'finalize'];
/** PARAM-142 applies to each attached file, as for imports. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Phase =
  | { kind: 'form' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'saved'; result: GenResult; projectId: string }
  | { kind: 'error'; code: PackGenError['code'] | 'saveFailed'; detail: string; costJpy: number | null; tokens: TokenTotals };

function todayJst(): string {
  return jstDay(new Date());
}

/** One pack per project: when the project already has a generated pack, its recorded inputs (with the files) come back. */
export async function generatePrefillFor(projectId: string): Promise<Partial<PackGenInput> | null> {
  if (!importedPackMeta(projectId)) return null;
  try {
    return prefillFromPack(await loadImportedPack(projectId));
  } catch {
    return null;
  }
}

/** A new company/project name pair that addProject would accept (checked before spending anything). */
function newTargetProblem(companyName: string, projectName: string): 'duplicateProject' | 'limit' | null {
  const { companies, projects } = useProjects.getState();
  const company = companies.find((c) => c.name === companyName.trim());
  if (!company) return null;
  const list = projects.filter((p) => p.companyId === company.id);
  if (list.some((p) => p.name === projectName.trim())) return 'duplicateProject';
  return list.length >= MAX_PROJECTS_PER_COMPANY ? 'limit' : null;
}

/**
 * FR-311 (D-12): "Create the customer pack with Copilot". Required and optional inputs (missing required ones are listed
 * from the start), readiness of the configured LLM with the AI settings one click away, the estimate and the
 * confirmations C-03 requires, then a progress bar over the stages; the verified pack is saved with everything that
 * went into it (inputs, retrieved sources, generation record, cost) and can be opened.
 */
export function PackGenerateDialog({ open, target, prefill, onClose, onOpenProject }: {
  open: boolean;
  target: PackGenTarget;
  /** The previous run's inputs, when re-fetching for a project that already has a generated pack. */
  prefill?: Partial<PackGenInput> | null;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
}) {
  const { t, lang, fmt } = useI18n();
  const companies = useProjects((s) => s.companies);
  const projects = useProjects((s) => s.projects);
  const audience = useSettings((s) => s.audience);
  const ai = useAiSettings();
  const existing = target.kind === 'project' ? projects.find((p) => p.id === target.projectId) : undefined;
  const existingCompany = existing ? companies.find((c) => c.id === existing.companyId) : undefined;

  const [companyName, setCompanyName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [asOf, setAsOf] = useState(todayJst());
  const [industry, setIndustry] = useState('');
  const [officialUrl, setOfficialUrl] = useState('');
  const [focus, setFocus] = useState('');
  const [useNews, setUseNews] = useState(true);
  const [publicWebTopic, setPublicWebTopic] = useState('');
  const [publicTopicOk, setPublicTopicOk] = useState(false);
  const [includeAnchor, setIncludeAnchor] = useState(true);
  const [useWorkIq, setUseWorkIq] = useState(true);
  const [workIqRounds, setWorkIqRounds] = useState(DEFAULT_WORKIQ_ROUNDS);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const [researchNote, setResearchNote] = useState('');
  const [approved, setApproved] = useState(false);
  const [costOk, setCostOk] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [steps, setSteps] = useState<Record<StepId, StepStatus>>(() => Object.fromEntries(STEPS.map((s) => [s, 'pending'])) as Record<StepId, StepStatus>);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCompanyName(existingCompany?.name ?? (target.kind === 'new' ? target.companyName : ''));
    setProjectName(existing?.name ?? (target.kind === 'new' ? target.projectName : ''));
    setPhase({ kind: 'form' });
    setApproved(false);
    setCostOk(false);
    setPublicTopicOk(false);
    setIncludeAnchor(true);
    // The pack's recorded inputs first, then what the user has since entered for the project, then the shared company profile.
    const brief = existing?.brief ?? {};
    const from = { ...(prefill ?? {}), ...brief };
    if (prefill || existing?.brief) {
      setPurpose(from.purpose ?? '');
      setFocus(from.focus ?? '');
      setResearchNote(from.researchNote ?? '');
      setMaterials(prefill?.materials ?? []);
      setUseNews(from.useNews ?? true);
      setPublicWebTopic(from.publicWebTopic ?? '');
      setUseWorkIq(from.useWorkIq ?? true);
      setWorkIqRounds(from.workIqRounds ?? DEFAULT_WORKIQ_ROUNDS);
      // Re-fetching collects as of today; a first run keeps the date the user chose for the project.
      setAsOf(prefill ? todayJst() : brief.asOf ?? todayJst());
    }
    const company = existingCompany ?? (target.kind === 'new' ? companies.find((c) => c.name === target.companyName.trim()) : undefined);
    setIndustry(company?.industry ?? prefill?.industry ?? '');
    setOfficialUrl(company?.officialUrl ?? prefill?.officialUrl ?? '');
    void useAiSettings.getState().refreshRelay();
    if (useAiSettings.getState().provider === 'copilotSdk') void useAiSettings.getState().checkCopilot();
    // Only when the dialog opens or its target changes; the user's edits must survive re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.kind, target.kind === 'project' ? target.projectId : `${target.companyName}\u0000${target.projectName}`]);

  // A company registered earlier brings its shared profile, so it is not entered again for every project.
  const knownCompany = existingCompany ?? companies.find((c) => c.name === companyName.trim());
  const anchorLoad = useMemo(() => {
    if (!knownCompany) return { value: null, error: false };
    try { return { value: latestCompanyAnchor(knownCompany.id), error: false }; }
    catch { return { value: null, error: true }; }
  }, [knownCompany?.id, knownCompany?.anchorRef?.version]);
  useEffect(() => {
    if (!open || !knownCompany || target.kind === 'project') return;
    setIndustry((v) => v || knownCompany.industry || '');
    setOfficialUrl((v) => v || knownCompany.officialUrl || '');
    // Only when the typed name starts matching another registered company.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, knownCompany?.id]);
  const hasPack = target.kind === 'project' && importedPackMeta(target.projectId) !== null;

  useEffect(() => {
    if (phase.kind !== 'running') return;
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - phase.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // D-14: Work IQ is part of the Microsoft Foundry path only; with GitHub Copilot it is neither shown nor sent.
  const workIqShown = ai.provider === 'foundry';
  const workIqOn = workIqShown && workIqReady(ai) && useWorkIq;
  const topic = useNews ? publicWebTopic.trim() : '';
  const topicInvalid = !!topic && !NewsRequest.safeParse({ company: companyName, lang, topic, topicConfirmed: true }).success;
  const anchorEnabled = audience === 'internal' && includeAnchor;
  const input: PackGenInput = {
    companyName, projectName, purpose, asOf, lang, industry, officialUrl, focus, materials, researchNote, useNews, useWorkIq: workIqOn,
    ...(workIqOn ? { workIqRounds } : {}),
    ...(topic ? { publicWebTopic: topic, webTopicConfirmed: publicTopicOk } : {}),
    ...(anchorEnabled && anchorLoad.value ? { companyAnchor: anchorLoad.value, alignments: existing?.alignments ?? [] } : {}),
  };
  const freshness = input.companyAnchor ? anchorFreshness(input.companyAnchor.anchor, new Date()) : null;
  const needsAlignmentReview = !input.companyAnchor || !input.alignments?.length || input.alignments.some((entry) =>
    entry.status === 'draft' || entry.kind === 'unaligned' || entry.anchorVersion !== input.companyAnchor?.version
    || entry.assessedPurpose.trim() !== purpose.trim()
    || entry.sourceIds.some((id) => !input.companyAnchor?.anchor.sources.some((source) => source.id === id)));
  const anchorPreview = input.companyAnchor
    ? materialSources({ ...input, materials: [], researchNote: '' }, [], [], '', new Date(), null)
      .filter((entry) => entry.item.kind === 'anchor').map((entry) => ({ source: entry.item, summary: entry.body }))
    : [];
  useEffect(() => {
    setApproved(false);
    setCostOk(false);
  }, [companyName, projectName, purpose, asOf, industry, officialUrl, focus, materials, researchNote, useNews, publicWebTopic, includeAnchor, audience, anchorLoad.value?.version, workIqOn, workIqRounds, ai.provider]);
  useEffect(() => { setPublicTopicOk(false); }, [companyName, lang, useNews]);
  const missing = missingRequired(input);
  const targetProblem = target.kind === 'new' && companyName.trim() && projectName.trim() ? newTargetProblem(companyName, projectName) : null;
  const chars = materials.reduce((a, m) => a + m.text.length, 0) + researchNote.length;
  const tooMuch = chars > MAX_MATERIAL_CHARS;

  const estimate = useMemo(() => {
    const plan = runPlan(input);
    const prompt = stageAPrompt(input, []) + materials.map((m) => m.text).join('\n') + researchNote + ' '.repeat(Math.max(0, plan.promptChars - chars));
    const pf = preflight({ use: 'packBuild', lang, prompt, maxOutputTokens: PER_USE_LIMITS.packBuild?.maxOutputTokens, userConfirmed: true, personConfirmed: true });
    const ledger = readLedger();
    const month = jstMonth(new Date());
    const spent = ledger.filter((r) => jstMonth(new Date(r.at)) === month).reduce((a, r) => a + (r.costJpy ?? 0), 0);
    return {
      calls: plan.maxCalls,
      perCall: pf.estimatedCostJpy,
      max: pf.estimatedCostJpy === null ? null : pf.estimatedCostJpy * plan.maxCalls,
      min: pf.estimatedCostJpy === null ? null : pf.estimatedCostJpy * 2,
      spent,
      tokens: pf.estimatedInputTokens,
      inputTooLarge: pf.budget.reasons.includes('inputTooLarge'),
      // D-15: the daily count refuses a call partway through a run; warn before it starts.
      callsLeft: Math.max(0, (PER_USE_LIMITS.packBuild?.dailyCalls ?? Infinity) - pf.budget.todayCalls),
    };
    // Recomputed when what is sent or the price settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyName, projectName, purpose, asOf, industry, officialUrl, focus, useNews, publicWebTopic, includeAnchor, audience, anchorLoad.value?.version, workIqOn, workIqRounds, materials, researchNote, lang, ai.provider, ai.copilotPricePerRequest, ai.copilotModel, ai.copilotStatus, open]);
  const overBudget = estimate.max !== null && estimate.spent + estimate.max > ai.monthlyBudgetJpy;
  const ready = liveReady(ai);
  const canStart = missing.length === 0 && !targetProblem && !tooMuch && !estimate.inputTooLarge && ready && approved && costOk && !overBudget
    && (!workIqShown || workIqReady(ai)) && !topicInvalid && (!topic || publicTopicOk) && (!anchorEnabled || !anchorLoad.error);

  const addFiles = async (files: FileList) => {
    const notes: string[] = [];
    const added: Material[] = [];
    for (const f of Array.from(files)) {
      if (!isReadableFile(f.name, f.type)) { notes.push(t('proj.gen.fileUnsupported', { name: f.name })); continue; }
      if (f.size > MAX_FILE_BYTES) { notes.push(t('proj.gen.fileTooLarge', { name: f.name })); continue; }
      added.push({ name: f.name, text: (await f.text()).replace(/^\uFEFF/, '') });
    }
    setMaterials((m) => [...m, ...added.filter((a) => !m.some((x) => x.name === a.name))]);
    setFileNotes(notes);
  };

  /** The project to save into; for a new target, also what was created so a failed save can undo exactly that. */
  const resolveProject = (): { projectId: string; created: { companyId?: string; projectId?: string } } | null => {
    if (target.kind === 'project') return { projectId: target.projectId, created: {} };
    const { addCompany, addProject, deleteCompany } = useProjects.getState();
    const name = companyName.trim();
    let companyId = useProjects.getState().companies.find((c) => c.name === name)?.id;
    let newCompany: string | undefined;
    if (!companyId) {
      const r = addCompany(name);
      if (!r.ok) return null;
      companyId = r.id;
      newCompany = r.id;
    }
    const r = addProject(companyId, projectName.trim());
    if (!r.ok) {
      if (newCompany) deleteCompany(newCompany);
      return null;
    }
    return { projectId: r.id, created: { ...(newCompany ? { companyId: newCompany } : {}), projectId: r.id } };
  };

  const rollback = (created: { companyId?: string; projectId?: string }) => {
    const { deleteCompany, deleteProject } = useProjects.getState();
    if (created.companyId) deleteCompany(created.companyId);
    else if (created.projectId) deleteProject(created.projectId);
  };

  /** Keep what was entered with the company (shared) and the project, so neither is typed again. */
  const remember = (projectId: string) => {
    const s = useProjects.getState();
    const project = s.projects.find((p) => p.id === projectId);
    if (!project) return;
    s.updateCompanyProfile(project.companyId, { officialUrl, industry });
    s.updateProjectBrief(projectId, {
      purpose, focus, asOf, researchNote, useNews, publicWebTopic, useWorkIq, workIqRounds, materialNames: materials.map((m) => m.name),
    });
  };

  const start = async () => {
    if (target.kind === 'project') remember(target.projectId);
    const controller = new AbortController();
    abortRef.current = controller;
    // The run's ledger records stay under this scope until the project they were spent for is known.
    const runScope = `gen-run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const runTokens = () => summarizeTokens(recordsOfScope(readLedger(), runScope)).total;
    setSteps(Object.fromEntries(STEPS.map((s) => [s, 'pending'])) as Record<StepId, StepStatus>);
    setProgress(null);
    setElapsed(0);
    setPhase({ kind: 'running', startedAt: Date.now() });
    const settings = useAiSettings.getState();
    let result: GenResult;
    try {
      result = await generatePack(input, {
        provider: settings.provider,
        ...(settings.provider === 'copilotSdk' ? (settings.copilotModel ? { model: settings.copilotModel } : {}) : { model: settings.relayConnection?.deployment ?? settings.deployment }),
        complete: (prompt, signal, stage) => aiLive({
          use: 'packBuild', lang: lang as Lang, prompt, userConfirmed: true, personConfirmed: true,
          maxOutputTokens: PER_USE_LIMITS.packBuild?.maxOutputTokens, timeoutMs: PACK_BUILD_TIMEOUT_MS, scope: runScope, stage,
        }, signal),
        fetchSite: (url, signal) => fetchSitePages(url, signal),
        fetchNews: (company, l, signal, publicTopic) => fetchNewsHeadlines(company, l, signal, publicTopic),
        ...(settings.provider === 'foundry' && input.useWorkIq ? {
          fetchWorkIq: (q, signal) => askWorkIqSections({ ...q, aspects: (q.aspects ?? []) as WorkIqAspect[], topics: q.topics ?? [], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }, signal),
        } : {}),
      }, (e) => {
        setProgress(e);
        setSteps((s) => ({ ...s, [e.step]: e.status }));
      }, controller.signal);
    } catch (err) {
      const e = err instanceof PackGenError ? err : null;
      const reasons = err instanceof AiLiveError ? err.reasons.join(', ') : '';
      const tokens = runTokens();
      if (target.kind === 'project') rebindLedgerScope(runScope, target.projectId);
      setSteps((s) => Object.fromEntries(STEPS.map((k) => [k, s[k] === 'running' ? 'failed' : s[k]])) as Record<StepId, StepStatus>);
      setPhase({ kind: 'error', code: e?.code ?? 'callFailed', detail: e?.detail ?? (reasons || (err as Error).message), costJpy: e ? e.costJpy : null, tokens });
      return;
    } finally {
      abortRef.current = null;
    }
    const resolved = resolveProject();
    if (!resolved) {
      setPhase({ kind: 'error', code: 'saveFailed', detail: t('proj.err.duplicateProject'), costJpy: result.report.costJpy, tokens: runTokens() });
      return;
    }
    const { projectId, created } = resolved;
    try {
      await saveImportedPack({
        projectId,
        packId: String(result.pack.packId),
        company: { name: result.summary.company.name ?? { ja: companyName, en: companyName }, industry: result.summary.company.industry ?? { ja: '—', en: '—' } },
        isSample: false,
        entities: result.summary.entities,
        importedAt: new Date().toISOString(),
        files: [`generated:${settings.provider}`, ...materials.map((m) => m.name)],
      }, result.pack);
    } catch (err) {
      const tokens = runTokens();
      rollback(created);
      if (target.kind === 'project') rebindLedgerScope(runScope, target.projectId);
      setPhase({ kind: 'error', code: 'saveFailed', detail: (err as Error).message, costJpy: result.report.costJpy, tokens });
      return;
    }
    rebindLedgerScope(runScope, projectId);
    remember(projectId);
    const savedProject = useProjects.getState().projects.find((project) => project.id === projectId);
    if (savedProject?.alignments?.length) {
      useProjects.getState().setProjectAlignments(projectId, invalidateProjectEvidence(savedProject.alignments, anchorLoad.value?.anchor ?? null));
    }
    setPhase({ kind: 'saved', result, projectId });
  };

  const close = () => {
    if (phase.kind === 'running') return;
    onClose();
  };

  const labelOf = (f: RequiredField) => t(`proj.gen.field.${f}`);
  const running = phase.kind === 'running';
  const yen = (v: number | null) => v === null ? t('ai.cost.unavailable') : yenFine(fmt.locale, v);
  const stepIcon = (s: StepStatus) => (s === 'done' ? <CheckmarkCircle20Filled className="gen-ok" /> : s === 'failed' ? <DismissCircle20Filled className="gen-fail" /> : s === 'running' ? <Spinner size="extra-tiny" /> : <span className="gen-dot" aria-hidden />);

  return (
    <>
      <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) close(); }} modalType={running ? 'alert' : 'modal'}>
        <DialogSurface className="gen-dialog" data-testid="gen-dialog" aria-describedby="gen-lead">
          <DialogBody>
            <DialogTitle>{t('proj.gen.title')}</DialogTitle>
            <DialogContent tabIndex={phase.kind === 'saved' ? 0 : undefined}>
              {phase.kind === 'form' && (
                <div className="gen-form">
                  <p id="gen-lead" className="muted">{t('proj.gen.lead')}</p>
                  {prefill && (
                    <MessageBar intent="info" data-testid="gen-prefilled"><MessageBarBody>{t('proj.gen.prefilled')}</MessageBarBody></MessageBar>
                  )}
                  {missing.length > 0 && (
                    <MessageBar intent="warning" data-testid="gen-missing">
                      <MessageBarBody>{t('proj.gen.missing', { fields: missing.map(labelOf).join(t('ai.listSep')) })}</MessageBarBody>
                    </MessageBar>
                  )}
                  {hasPack && (
                    <MessageBar intent="warning" data-testid="gen-replaces"><MessageBarBody>{t('proj.gen.replaces')}</MessageBarBody></MessageBar>
                  )}
                  <section aria-labelledby="gen-company-h" data-testid="gen-company-section">
                    <h3 id="gen-company-h" className="proj-h2">{t('proj.gen.companySection')}</h3>
                    <p className="muted" data-testid="gen-company-note">{t(knownCompany ? 'proj.gen.companyKnown' : 'proj.gen.companyNew')}</p>
                    {audience === 'internal' && anchorLoad.error && <MessageBar intent="error"><MessageBarBody>{t('proj.anchor.storageError')}</MessageBarBody></MessageBar>}
                    {audience === 'internal' && (anchorLoad.value || anchorLoad.error) && (
                      <div>
                        <Checkbox checked={includeAnchor} onChange={(_, d) => setIncludeAnchor(d.checked === true)} label={t('proj.anchor.useInPack')} data-testid="gen-use-anchor" />
                        {input.companyAnchor && (
                          <details data-testid="gen-anchor-preview">
                            <summary>{t('proj.anchor.sendPreview', { version: input.companyAnchor.version, date: input.companyAnchor.anchor.asOf })}</summary>
                            <pre className="proj-prewrap">{JSON.stringify(anchorPreview, null, 2)}</pre>
                          </details>
                        )}
                        {(freshness?.stale || freshness?.future) && <MessageBar intent="warning"><MessageBarBody>{t('proj.anchor.stale')}</MessageBarBody></MessageBar>}
                        {audience === 'internal' && needsAlignmentReview && (
                          <MessageBar intent="warning" data-testid="gen-alignment-warning">
                            <MessageBarBody>{t('proj.align.generationWarning')} {t('proj.align.question', { project: projectName || 'Project' })}</MessageBarBody>
                          </MessageBar>
                        )}
                      </div>
                    )}
                    <div className="gen-grid">
                      <Field label={labelOf('companyName')} required validationState={missing.includes('companyName') ? 'warning' : 'none'}>
                        <Input value={companyName} onChange={(_, d) => setCompanyName(d.value)} readOnly={target.kind === 'project'} data-testid="gen-company" />
                      </Field>
                      <Field label={t('proj.gen.field.industry')}>
                        <Input value={industry} onChange={(_, d) => setIndustry(d.value)} data-testid="gen-industry" />
                      </Field>
                      <Field label={t('proj.gen.field.officialUrl')} hint={t('proj.gen.officialUrlHint')} className="gen-wide">
                        <Input type="url" value={officialUrl} placeholder="https://www.example.co.jp" onChange={(_, d) => setOfficialUrl(d.value)} data-testid="gen-url" />
                      </Field>
                    </div>
                  </section>
                  <section aria-labelledby="gen-required">
                    <h3 id="gen-required" className="proj-h2">{t('proj.gen.projectSection')} <Badge appearance="tint" color="danger">{t('proj.gen.requiredBadge')}</Badge></h3>
                    <div className="gen-grid">
                      <Field
                        label={labelOf('projectName')}
                        required
                        validationState={targetProblem ? 'error' : missing.includes('projectName') ? 'warning' : 'none'}
                        validationMessage={targetProblem ? t(targetProblem === 'limit' ? 'proj.err.limit' : 'proj.err.duplicateProject', { max: MAX_PROJECTS_PER_COMPANY }) : undefined}
                      >
                        <Input value={projectName} onChange={(_, d) => setProjectName(d.value)} readOnly={target.kind === 'project'} data-testid="gen-project" />
                      </Field>
                      <Field label={labelOf('asOf')} required validationState={missing.includes('asOf') ? 'warning' : 'none'}>
                        <Input type="date" value={asOf} onChange={(_, d) => setAsOf(d.value)} data-testid="gen-asof" />
                      </Field>
                      <Field label={labelOf('purpose')} required hint={t('proj.gen.purposeHint')} validationState={missing.includes('purpose') ? 'warning' : 'none'} className="gen-wide">
                        <Textarea value={purpose} onChange={(_, d) => setPurpose(d.value)} resize="vertical" rows={5} data-testid="gen-purpose" />
                      </Field>
                      <Field label={t('proj.gen.field.focus')} className="gen-wide">
                        <Input value={focus} onChange={(_, d) => setFocus(d.value)} data-testid="gen-focus" />
                      </Field>
                    </div>
                  </section>
                  <section aria-labelledby="gen-optional">
                    <h3 id="gen-optional" className="proj-h2">{t('proj.gen.optional')}</h3>
                    <div className="gen-grid">
                      <Checkbox className="gen-wide" checked={useNews} onChange={(_, d) => setUseNews(d.checked === true)} label={t('proj.gen.useNews')} data-testid="gen-news" />
                      {useNews && (
                        <div className="gen-wide">
                          <Field label={t('proj.anchor.publicTopic')} hint={t('proj.anchor.publicTopicHint')} validationState={topicInvalid ? 'error' : 'none'} validationMessage={topicInvalid ? t('proj.anchor.publicTopicInvalid') : undefined}>
                            <Input value={publicWebTopic} maxLength={100} onChange={(_, d) => { setPublicWebTopic(d.value); setPublicTopicOk(false); }} data-testid="gen-public-topic" />
                          </Field>
                          {!!topic && <Checkbox checked={publicTopicOk} onChange={(_, d) => setPublicTopicOk(d.checked === true)} label={t('proj.anchor.publicTopicConsent', { company: companyName, topic })} data-testid="gen-public-topic-consent" />}
                        </div>
                      )}
                      {workIqShown && (
                        <div className="gen-wide" data-testid="gen-workiq-section">
                          <Checkbox
                            checked={workIqOn}
                            disabled={!workIqReady(ai)}
                            onChange={(_, d) => setUseWorkIq(d.checked === true)}
                            label={t('proj.gen.useWorkIq')}
                            data-testid="gen-workiq"
                          />
                          <p className="muted" data-testid="gen-workiq-note">
                            {!workIqReady(ai) ? t('proj.gen.workIqNotReady') : ai.workiq?.method === 'cli' ? t('proj.gen.workIqHintCli') : t('proj.gen.workIqHint', { account: ai.workiq?.account ?? '—' })}
                          </p>
                          {workIqOn && (
                            <Field label={t('proj.gen.workIqRounds')} hint={t('proj.gen.workIqRoundsHint', { max: MAX_WORKIQ_ROUNDS })}>
                              <Input
                                type="number"
                                min={1}
                                max={MAX_WORKIQ_ROUNDS}
                                value={String(workIqRounds)}
                                onChange={(_, d) => {
                                  const n = Math.round(Number(d.value));
                                  if (Number.isFinite(n)) setWorkIqRounds(Math.min(MAX_WORKIQ_ROUNDS, Math.max(1, n)));
                                }}
                                data-testid="gen-workiq-rounds"
                              />
                            </Field>
                          )}
                        </div>
                      )}
                      <div className="gen-wide gen-files">
                        <span className="ai-label">{t('proj.gen.field.materials')}</span>
                        <p className="muted">{t('proj.gen.materialsHint', { max: fmt.integer(MAX_MATERIAL_CHARS) })}</p>
                        <div className="proj-row">
                          <Button icon={<ArrowUpload20Regular />} onClick={() => fileRef.current?.click()} data-testid="gen-add-files">{t('proj.gen.addFiles')}</Button>
                        </div>
                        <input
                          ref={fileRef}
                          type="file"
                          multiple
                          accept=".txt,.md,.csv,.tsv,.json,.html,.htm,text/*,application/json"
                          className="visually-hidden"
                          tabIndex={-1}
                          aria-label={t('proj.gen.addFiles')}
                          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
                          data-testid="gen-files"
                        />
                        {materials.length > 0 && (
                          <ul className="gen-file-list" data-testid="gen-file-list">
                            {materials.map((m) => (
                              <li key={m.name}>
                                <span>{m.name}</span>
                                <span className="muted">{t('proj.gen.chars', { count: fmt.integer(m.text.length) })}</span>
                                <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('proj.gen.removeFile', { name: m.name })} onClick={() => setMaterials((x) => x.filter((y) => y.name !== m.name))} />
                              </li>
                            ))}
                          </ul>
                        )}
                        {fileNotes.map((n) => <p key={n} className="muted" role="status">{n}</p>)}
                      </div>
                      <Field label={t('proj.gen.field.researchNote')} hint={t('proj.gen.researchNoteHint')} className="gen-wide">
                        <Textarea value={researchNote} onChange={(_, d) => setResearchNote(d.value)} resize="vertical" rows={3} data-testid="gen-note" />
                      </Field>
                      {tooMuch && <MessageBar intent="error" className="gen-wide"><MessageBarBody>{t('proj.gen.tooMuch', { count: fmt.integer(chars), max: fmt.integer(MAX_MATERIAL_CHARS) })}</MessageBarBody></MessageBar>}
                    </div>
                  </section>
                  <section aria-labelledby="gen-llm" className="gen-llm" data-testid="gen-llm">
                    <h3 id="gen-llm" className="proj-h2">{t('proj.gen.llm')}</h3>
                    <p>
                      {t('proj.gen.provider', {
                        provider: t(`ai.provider.${ai.provider}`),
                        model: (ai.provider === 'copilotSdk' ? ai.copilotModel : ai.relayConnection?.deployment) ?? t('ai.conn.notSaved'),
                      })}
                    </p>
                    <AiReadiness />
                    <div className="proj-row">
                      <Button icon={<Settings20Regular />} onClick={() => setSettingsOpen(true)} data-testid="gen-open-settings">{t('proj.gen.openSettings')}</Button>
                    </div>
                    <dl className="gen-estimate" data-testid="gen-estimate">
                      <dt>{t('proj.gen.calls')}</dt><dd>{t('proj.gen.callsValue', { min: 2, max: estimate.calls })}</dd>
                      <dt>{t('proj.gen.cost')}</dt>
                      <dd>{estimate.max === null ? t(ai.provider === 'foundry' ? 'ai.cost.unknown' : 'proj.gen.noPrice') : t('proj.gen.costValue', { min: yen(estimate.min!), max: yen(estimate.max) })}</dd>
                      <dt>{t('proj.gen.month')}</dt><dd>{t('proj.gen.monthValue', { spent: yen(estimate.spent), budget: fmt.yen(ai.monthlyBudgetJpy) })}</dd>
                    </dl>
                    {overBudget && <MessageBar intent="error" data-testid="gen-over-budget"><MessageBarBody>{t('proj.gen.overBudget')}</MessageBarBody></MessageBar>}
                    {estimate.inputTooLarge && <MessageBar intent="error"><MessageBarBody>{t('proj.gen.inputTooLarge')}</MessageBarBody></MessageBar>}
                    {estimate.callsLeft < estimate.calls && <MessageBar intent="warning" data-testid="gen-daily-short"><MessageBarBody>{t('proj.gen.dailyShort', { left: estimate.callsLeft, max: estimate.calls })}</MessageBarBody></MessageBar>}
                    <p className="muted" data-testid="gen-sends">{t('proj.gen.sends')}{workIqOn ? ` ${t('proj.gen.sendsWorkIq')}` : ''}{input.companyAnchor ? ` ${t('proj.anchor.sendNote')}` : ''}</p>
                    <D4Warning testId="gen-d4" />
                    <Checkbox checked={approved} onChange={(_, d) => setApproved(d.checked === true)} label={t('proj.gen.checkApproved')} data-testid="gen-check-approved" />
                    <Checkbox checked={costOk} onChange={(_, d) => setCostOk(d.checked === true)} label={t('proj.gen.checkCost')} data-testid="gen-check-cost" />
                  </section>
                </div>
              )}

              {(phase.kind === 'running' || phase.kind === 'error') && (
                <div className="gen-progress" data-testid="gen-progress" aria-live="polite">
                  <ProgressBar value={progress?.ratio ?? 0} thickness="large" aria-label={t('proj.gen.progressLabel')} data-testid="gen-progress-bar" />
                  <p className="muted">
                    {t('proj.gen.progressNow', { percent: fmt.percent(progress?.ratio ?? 0), elapsed: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`, cost: yen(progress ? progress.costJpy : 0), tokens: fmt.integer(progress?.tokens ?? 0) })}
                  </p>
                  <ol className="gen-steps">
                    {STEPS.map((s) => (
                      <li key={s} data-step={s} data-status={steps[s]}>
                        {stepIcon(steps[s])}
                        <span>{t(`proj.gen.step.${s}`)}</span>
                        {s === 'verify' && progress?.step === 'verify' && progress.round ? <span className="muted">{t('proj.gen.round', { round: progress.round, errors: progress.errors ?? 0 })}</span> : null}
                        {s === progress?.step && progress.collectRound ? <span className="muted" data-testid="gen-collect-round">{t('proj.gen.collectRound', { round: progress.collectRound, unmet: progress.unmet?.length ?? 0 })}</span> : null}
                      </li>
                    ))}
                  </ol>
                  {phase.kind === 'error' && (
                    <MessageBar intent="error" data-testid="gen-error">
                      <MessageBarBody>
                        {t(`proj.gen.error.${phase.code}`)}
                        <span className="gen-detail" lang="en">{phase.detail}</span>
                        {t('proj.gen.errorCost', { cost: yen(phase.costJpy), tokens: fmt.integer(phase.tokens.totalTokens) })}
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </div>
              )}

              {phase.kind === 'saved' && <SavedSummary result={phase.result} />}
            </DialogContent>
            <DialogActions>
              {phase.kind === 'form' && (
                <>
                  <Button appearance="primary" icon={<BotSparkle20Regular />} disabled={!canStart} onClick={() => void start()} data-testid="gen-start">{t('proj.gen.start')}</Button>
                  <Button onClick={close}>{t('ai.person.cancel')}</Button>
                </>
              )}
              {phase.kind === 'running' && <Button onClick={() => abortRef.current?.abort()} data-testid="gen-cancel">{t('proj.gen.cancel')}</Button>}
              {phase.kind === 'error' && (
                <>
                  <Button appearance="primary" onClick={() => setPhase({ kind: 'form' })} data-testid="gen-back">{t('proj.gen.back')}</Button>
                  <Button onClick={close}>{t('ai.dialog.close')}</Button>
                </>
              )}
              {phase.kind === 'saved' && (
                <>
                  <Button appearance="primary" icon={<Open20Regular />} onClick={() => onOpenProject(phase.projectId)} data-testid="gen-open">{t('proj.gen.open')}</Button>
                  <Button onClick={close}>{t('ai.dialog.close')}</Button>
                </>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <AiSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

function SavedSummary({ result }: { result: GenResult }) {
  const { t, fmt } = useI18n();
  const { summary, report } = result;
  const kinds = Object.entries(summary.byKind).filter(([, n]) => (n ?? 0) > 0);
  const tokens = summarizeTokens(report.calls.map((c) => ({ at: report.finishedAt, use: 'packBuild', stage: c.stage, inputTokens: c.inputTokens, outputTokens: c.outputTokens, costJpy: c.costJpy })));
  return (
    <div className="gen-saved" data-testid="gen-saved">
      <MessageBar intent="success"><MessageBarBody>{t('proj.gen.saved', { entities: summary.entities })}</MessageBarBody></MessageBar>
      <dl className="gen-estimate">
        <dt>{t('proj.gen.sum.kinds')}</dt>
        <dd data-testid="gen-kinds">{kinds.map(([k, n]) => `${k} ${n}`).join(' / ')}</dd>
        <dt>{t('proj.gen.sum.classification')}</dt>
        <dd>{t('proj.gen.sum.classificationValue', { internal: summary.internal, shareable: summary.shareable })}</dd>
        <dt>{t('proj.gen.sum.sources')}</dt>
        <dd>{t('proj.gen.sum.sourcesValue', { web: report.retrieved.filter((r) => r.kind === 'web' || r.kind === 'news').length, other: report.retrieved.filter((r) => r.kind === 'material' || r.kind === 'note' || r.kind === 'workiq').length })}</dd>
        <dt>{t('proj.gen.sum.checks')}</dt>
        <dd data-testid="gen-checks">{t('proj.gen.sum.checksValue', { rounds: report.fixRounds, removed: report.removed.length, dropped: report.droppedSources.length })}</dd>
        <dt>{t('proj.gen.sum.cost')}</dt>
        <dd data-testid="gen-cost">{t('proj.gen.sum.costValue', { cost: report.costJpy === null ? t('ai.cost.unavailable') : yenFine(fmt.locale, report.costJpy), calls: report.calls.length })}</dd>
      </dl>
      <TokenTable summary={tokens} testId="gen-tokens" caption={t('proj.gen.sum.tokens')} />
      {report.ungrounded.length > 0 && (
        <MessageBar intent="warning" data-testid="gen-ungrounded">
          <MessageBarBody>
            {t('proj.gen.sum.ungrounded', { count: report.ungrounded.length })}
            <ul>{report.ungrounded.slice(0, 10).map((u) => <li key={`${u.id}.${u.field}`} lang="en">{`${u.id}.${u.field} = ${u.value}`}</li>)}</ul>
          </MessageBarBody>
        </MessageBar>
      )}
      {summary.people > 0 && <p className="muted">{t('proj.gen.sum.people', { count: summary.people })}</p>}
      {(() => {
        const wiq = report.retrieved.filter((r) => r.kind === 'workiq');
        if (!wiq.length) return null;
        const urls = new Set(wiq.flatMap((r) => (r.citations ?? []).map((c) => c.url)));
        const labels = [...new Set(wiq.map((r) => r.sensitivity).filter((l): l is string => !!l))];
        return (
          <div data-testid="gen-sum-workiq">
            <p className="muted">{t('proj.gen.sum.workIq', { sections: wiq.length, citations: urls.size, label: labels.join(', ') || '—' })}</p>
            <ul className="muted" data-testid="gen-sum-workiq-sections">
              {wiq.map((r) => <li key={r.sourceId}>{`${r.title} — ${t('proj.gen.sum.workIqCitations', { count: r.citations?.length ?? 0 })}`}</li>)}
            </ul>
          </div>
        );
      })()}
      {report.readiness && (
        <section aria-label={t('proj.ready.title')}>
          <h3 className="proj-h2">{t('proj.ready.title')}</h3>
          <ReadinessView items={report.readiness} rounds={report.collectionRounds} stopReasons={report.stopReasons} testId="gen-readiness" />
        </section>
      )}
      {report.retrievalErrors.some((e) => e.what === 'workiq') && <p className="muted" data-testid="gen-sum-workiq-failed">{t('proj.gen.sum.workIqFailed', { error: report.retrievalErrors.filter((e) => e.what === 'workiq').map((e) => e.error).join(' / ') })}</p>}
      {report.retrievalErrors.length > 0 && <p className="muted">{t('proj.gen.sum.retrievalErrors', { count: report.retrievalErrors.length })}</p>}
      <p className="muted">{t('proj.gen.sum.next')}</p>
    </div>
  );
}
