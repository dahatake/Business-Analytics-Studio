import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Badge, Button, Checkbox, Field, Input, MessageBar, MessageBarActions, MessageBarBody, Select, Spinner, Switch, Textarea,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowDownload20Regular, ArrowRedo20Regular, ArrowUndo20Regular, ArrowUpload20Regular, ChevronLeft20Regular,
  ChevronRight20Regular, Checkmark20Regular, Delete20Regular, Edit20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import type { Entity } from '../../data/schema.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { AuthorBadge, BackToHome, MockBadge, ScrollRegion } from './common.tsx';
import {
  addRecord, addTheme, adoptSuggestion, applyLens, DEMO_GLOSSARY, deleteRecord, deleteTheme, MIN_PER_THEME, parseGlossary,
  themeCounts, treeOrder, updateRecord, updateTheme, validateRecord, validateTheme, type FieldError, type GlossaryEntry,
} from './discussion.ts';
import { parseImport } from './exportFormat.ts';
import { requestSuggestions, suggestionRequest } from './mocks.ts';
import { isUseApproved, preflight, type AiRequest, type AiResponse } from '../../ai/client.ts';
import { LiveNotice, MockNotice, useLiveConfirm } from '../ai/AiCommon.tsx';
import { liveReady, useAiSettings } from '../ai/settingsStore.ts';
import type { DiscussionRecord, RecordKind, Theme } from './model.ts';
import {
  canUndoUseCaseImport, commitDiscussion, commitUseCaseImport, discussionEditor, redoDiscussion, undoDiscussion, undoUseCaseImport, useAnalyses,
  useChangeHistory, useDiscussion, useKpis,
  useProjTransient, useProjUi,
} from './stores.ts';
import { applyUseCaseSelection, classifyUseCases, type UseCaseCandidate, type UseCaseChoices } from './useCaseImport.ts';
import { UseCaseImportDialog } from './UseCaseImportDialog.tsx';
import { useUseCases } from '../usecases/store.ts';
import { usePackVersion } from '../../state/packEdits.ts';
import { EntityEditorDialog } from '../../ui/entry/EntityEditorDialog.tsx';
import { isEditableKind, type EditableKind } from '../../ui/entry/entitySpecs.ts';
import { AttachmentField, useMediaCapability } from '../../ui/entry/AttachmentField.tsx';
import { ensureSource, hashOfSource, itemOfSource, planAttachmentsForAi, summarizeForAi, type AttachmentItem } from '../../state/attachments.ts';
import './project.css';

/** Pack items a theme can be related to; new ones can be entered from the canvas and are saved in the pack data. */
const RELATABLE_KINDS = ['issue', 'solution', 'kpi', 'person'] as const satisfies readonly EditableKind[];
type EntryTarget = { kind: EditableKind; id: string | null };

/** FR-019: the pack's glossary (validated), or the bilingual demo glossary for the sample pack. */
function useGlossary(): GlossaryEntry[] {
  return useMemo(() => parseGlossary(loaded.pack.extensions?.glossary) ?? (loaded.pack.isSample ? DEMO_GLOSSARY : []), []);
}

const errKey = (e: FieldError) => `proj.err.${e}` as const;
const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.closest('input, textarea, select, [contenteditable="true"]') !== null);

/** FR-012, FR-019, FR-042, FR-044〜FR-050, FR-056. */
export function DiscussionScreen() {
  const { t, lang } = useI18n();
  const data = useDiscussion((s) => s.value);
  const history = useChangeHistory((s) => s.value);
  useProjTransient((s) => s.undoVersion);
  const selectedId = useProjTransient((s) => s.selectedThemeId);
  const selectTheme = useProjTransient((s) => s.selectTheme);
  const openExport = useProjTransient((s) => s.openExport);
  const { editMode, setEditMode, lens, setLens, editor, setEditor } = useProjUi();
  const glossary = useGlossary();
  const ordered = useMemo(() => treeOrder(data), [data]);
  const selected = data.themes.find((x) => x.id === selectedId) ?? ordered[0]?.theme ?? null;
  const ed = discussionEditor();
  const L = (x: Localizable) => applyLens(loc(x, lang), glossary, lang, lens);
  const [importMsg, setImportMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);
  const [ucCandidates, setUcCandidates] = useState<UseCaseCandidate[] | null>(null);
  const [ucMsg, setUcMsg] = useState<string | null>(null);
  useUseCases((s) => s.value);
  const ucCanUndo = canUndoUseCaseImport();
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (file: File) => {
    const outcome = parseImport(await file.text());
    if (!outcome.ok) {
      setImportMsg({ intent: 'error', text: t(`proj.import.error.${outcome.error}`) });
      return;
    }
    const r = outcome.result;
    commitDiscussion(r.discussion, 'import', 'all', file.name);
    if (r.kpi) useKpis.getState().set(r.kpi);
    if (r.analysis) useAnalyses.getState().set(r.analysis);
    selectTheme(r.discussion.themes[0]?.id ?? null);
    setImportMsg({ intent: 'success', text: t('proj.import.done', { themes: r.discussion.themes.length, records: r.discussion.records.length }) });
    setUcMsg(null);
    if (r.useCases?.length) {
      const candidates = classifyUseCases(r.useCases, useUseCases.getState().value);
      if (candidates.some((c) => c.status !== 'identical')) setUcCandidates(candidates);
      else setUcMsg(t('proj.ucImport.allIdentical', { count: candidates.length }));
    }
  };

  const onUcApply = (choices: UseCaseChoices) => {
    if (!ucCandidates) return;
    const res = applyUseCaseSelection(useUseCases.getState().value, ucCandidates, choices, new Date());
    commitUseCaseImport(res.next);
    setUcCandidates(null);
    setUcMsg(t('proj.ucImport.done', { added: res.added, replaced: res.replaced, kept: res.kept, skipped: res.skipped }));
  };
  const onUcSkip = () => {
    setUcCandidates(null);
    setUcMsg(t('proj.ucImport.skipped'));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey || e.metaKey) || isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoDiscussion();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      redoDiscussion();
    }
  };

  return (
    <div className="screen proj-screen" onKeyDown={onKeyDown}>
      <PageHeader
        title={t('proj.nav.discussion')}
        subtitle={t('proj.disc.subtitle')}
        actions={(
          <>
            <BackToHome />
            <Switch checked={editMode} onChange={(_, d) => setEditMode(d.checked)} label={t('proj.disc.editMode')} data-testid="proj-edit-mode" />
            <div role="group" aria-label={t('proj.lens.label')} className="proj-lens">
              <Button appearance={lens === 'business' ? 'primary' : 'secondary'} aria-pressed={lens === 'business'} onClick={() => setLens('business')}>{t('proj.lens.business')}</Button>
              <Button appearance={lens === 'it' ? 'primary' : 'secondary'} aria-pressed={lens === 'it'} onClick={() => setLens('it')} data-testid="proj-lens-it">{t('proj.lens.it')}</Button>
            </div>
            <Button icon={<ArrowUndo20Regular />} disabled={!ed.stack.canUndo} onClick={undoDiscussion} aria-keyshortcuts="Control+Z" data-testid="proj-undo">{t('proj.undo')}</Button>
            <Button icon={<ArrowRedo20Regular />} disabled={!ed.stack.canRedo} onClick={redoDiscussion} aria-keyshortcuts="Control+Y" data-testid="proj-redo">{t('proj.redo')}</Button>
            <Button icon={<ArrowUpload20Regular />} onClick={() => fileRef.current?.click()} data-testid="proj-import-button">{t('proj.import.button')}</Button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.json,text/markdown,application/json"
              className="visually-hidden"
              tabIndex={-1}
              aria-label={t('proj.import.button')}
              data-testid="proj-import"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImport(f);
                e.target.value = '';
              }}
            />
            <Button appearance="primary" icon={<ArrowDownload20Regular />} onClick={() => openExport(selected?.id ?? null)} data-testid="proj-export">{t('proj.export.short')}</Button>
          </>
        )}
      />
      {!editMode && (
        <MessageBar intent="info" className="span-full" data-testid="proj-edit-off">
          <MessageBarBody>{t('entry.disc.editModeOff')}</MessageBarBody>
          <MessageBarActions>
            <Button icon={<Edit20Regular />} onClick={() => setEditMode(true)} data-testid="proj-edit-on">{t('entry.disc.turnOn')}</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {importMsg && <MessageBar intent={importMsg.intent} className="span-full" data-testid="proj-import-msg"><MessageBarBody>{importMsg.text}</MessageBarBody></MessageBar>}
      {ucMsg && (
        <MessageBar intent="info" layout="multiline" className="span-full" data-testid="proj-uc-import-msg">
          <MessageBarBody>{ucMsg}</MessageBarBody>
          {ucCanUndo && (
            <MessageBarActions>
              <Button icon={<ArrowUndo20Regular />} onClick={() => { undoUseCaseImport(); setUcMsg(t('proj.ucImport.undone')); }} data-testid="proj-uc-undo">{t('proj.ucImport.undo')}</Button>
            </MessageBarActions>
          )}
        </MessageBar>
      )}
      <UseCaseImportDialog candidates={ucCandidates} onApply={onUcApply} onSkip={onUcSkip} />
      <div className="proj-disc span-full">
        <TreePanel ordered={ordered} selected={selected} onSelect={(id) => selectTheme(id)} L={L} />
        <CanvasPanel theme={selected} ordered={ordered} onSelect={(id) => selectTheme(id)} L={L} />
        <div className="proj-side">
          <CountsPanel L={L} />
          <Panel title={t('proj.hist.title')} rationale="proj.hist.why" testId="proj-history">
            <Field label={t('proj.hist.editor')} hint={t('proj.hist.editorHint')}>
              <Input value={editor} onChange={(_, d) => setEditor(d.value)} />
            </Field>
            {history.length === 0 ? <p className="muted">{t('proj.hist.none')}</p> : (
              <ol className="proj-history" reversed>
                {[...history].reverse().slice(0, 30).map((h) => (
                  <li key={h.id}>
                    <span className="proj-history-what">{t(`proj.hist.op.${h.op}`, { target: t(`proj.hist.target.${h.target}`), label: loc(h.label, lang) })}</span>
                    <span className="muted">{t('proj.hist.meta', { who: h.who || t('proj.hist.anonymous'), when: new Date(h.at).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US') })}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          <Panel title={t('proj.glossary.title')} rationale="proj.glossary.why">
            {glossary.length === 0 ? <p className="muted">{t('proj.glossary.none')}</p> : (
              <dl className="proj-glossary">
                {glossary.map((g, i) => (
                  <div key={i}>
                    <dt>{lens === 'it' && g.it ? loc(g.it, lang) : loc(g.term, lang)}</dt>
                    <dd>{loc(g.definition, lang)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function TreePanel({ ordered, selected, onSelect, L }: { ordered: { theme: Theme; depth: number }[]; selected: Theme | null; onSelect: (id: string) => void; L: (x: Localizable) => string }) {
  const { t } = useI18n();
  const data = useDiscussion((s) => s.value);
  const editMode = useProjUi((s) => s.editMode);
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<FieldError | null>(null);
  const counts = themeCounts(data);

  const add = () => {
    const v = validateTheme(data, { title, parentId: parentId || null });
    if (v.title || v.parent) return setError(v.title ?? v.parent ?? null);
    const next = addTheme(data, { title, parentId: parentId || null, classification: internal ? 'internal' : 'shareable' });
    const created = next.themes[next.themes.length - 1]!;
    commitDiscussion(next, 'add', 'theme', created.title);
    onSelect(created.id);
    setTitle('');
    setInternal(false);
    setError(null);
  };

  return (
    <Panel title={t('proj.tree.title')} rationale="proj.tree.why" testId="proj-tree" id="proj-tree">
      {ordered.length === 0 && <p className="muted">{t('proj.tree.empty')}</p>}
      <ul className="proj-tree">
        {ordered.map(({ theme, depth }) => {
          const c = counts.find((x) => x.themeId === theme.id);
          return (
            <li key={theme.id} style={{ paddingInlineStart: `${depth * 16}px` }}>
              <button type="button" className="proj-tree-item" aria-current={selected?.id === theme.id ? 'true' : undefined} onClick={() => onSelect(theme.id)}>
                {depth > 0 && <span className="proj-tree-branch" aria-hidden>└</span>}
                <span className="proj-tree-title">{L(theme.title)}</span>
                {theme.classification === 'internal' && <Badge size="small" appearance="tint" color="danger">{t('badge.internal')}</Badge>}
                <span className="visually-hidden">{t('proj.tree.counts', { decisions: c?.decisions ?? 0, actions: c?.actions ?? 0 })}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {editMode && (
        <form className="proj-add-theme" onSubmit={(e) => { e.preventDefault(); add(); }} aria-label={t('proj.tree.add')}>
          <Field label={t('proj.tree.newTitle')} validationState={error ? 'error' : 'none'} validationMessage={error ? t(errKey(error), { max: 200 }) : undefined}>
            <Input value={title} onChange={(_, d) => setTitle(d.value)} data-testid="proj-theme-title" />
          </Field>
          <Field label={t('proj.tree.parent')}>
            <Select value={parentId} onChange={(_, d) => setParentId(d.value)}>
              <option value="">{t('proj.tree.noParent')}</option>
              {ordered.map(({ theme }) => <option key={theme.id} value={theme.id}>{L(theme.title)}</option>)}
            </Select>
          </Field>
          <Checkbox checked={internal} onChange={(_, d) => setInternal(!!d.checked)} label={t('proj.internal')} />
          <Button type="submit" appearance="primary" icon={<Add20Regular />} data-testid="proj-theme-add">{t('proj.tree.add')}</Button>
        </form>
      )}
    </Panel>
  );
}

const SECTIONS: { kind: RecordKind; title: 'proj.kind.decision' | 'proj.kind.suggestion' | 'proj.kind.action' | 'proj.kind.note' }[] = [
  { kind: 'decision', title: 'proj.kind.decision' },
  { kind: 'suggestion', title: 'proj.kind.suggestion' },
  { kind: 'action', title: 'proj.kind.action' },
  { kind: 'note', title: 'proj.kind.note' },
];

/** FR-012: a canvas centred on one theme that moves between themes (buttons, the strip, or ←/→). */
function CanvasPanel({ theme, ordered, onSelect, L }: { theme: Theme | null; ordered: { theme: Theme; depth: number }[]; onSelect: (id: string) => void; L: (x: Localizable) => string }) {
  const { t, lang } = useI18n();
  const data = useDiscussion((s) => s.value);
  const editMode = useProjUi((s) => s.editMode);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleError, setTitleError] = useState<FieldError | null>(null);
  const [busy, setBusy] = useState(false);
  const [entry, setEntry] = useState<EntryTarget | null>(null);
  usePackVersion((s) => s.version);
  const cap = useMediaCapability();
  const live = useAiSettings((s) => liveReady(s)) && isUseApproved('recommend');
  const { dialog: liveDialog, confirmLive } = useLiveConfirm();
  const [aiOutcome, setAiOutcome] = useState<AiResponse | 'cancelled' | null>(null);
  const idx = theme ? ordered.findIndex((o) => o.theme.id === theme.id) : -1;
  useEffect(() => {
    setEditingTitle(false);
    setAiOutcome(null);
  }, [theme?.id]);

  if (!theme) {
    return <Panel title={t('proj.canvas.title')} testId="proj-canvas" id="proj-canvas"><p className="muted">{t('proj.canvas.empty')}</p></Panel>;
  }
  const records = data.records.filter((r) => r.themeId === theme.id);
  const go = (d: number) => {
    const next = ordered[idx + d];
    if (next) onSelect(next.theme.id);
  };
  const saveTitle = () => {
    const v = validateTheme(data, { title: titleDraft, parentId: theme.parentId }, theme.id);
    if (v.title) return setTitleError(v.title);
    commitDiscussion(updateTheme(data, theme.id, { title: titleDraft.trim() }), 'update', 'theme', titleDraft.trim());
    setEditingTitle(false);
    setTitleError(null);
  };
  const askAi = async () => {
    const ents = theme.relatedIds.map((id) => loaded.byId.get(id)).filter((e): e is Entity => !!e);
    const plan = planAttachmentsForAi(attached, cap);
    const req = suggestionRequest(loc(theme.title, lang), lang, ents, plan);
    setAiOutcome(null);
    setBusy(true);
    try {
      let send: AiRequest = req;
      if (live) {
        const pf = preflight({ ...req, userConfirmed: true, personConfirmed: true });
        // Blocked for a reason a confirmation cannot fix (budget, interval…): answer with the mock, ask nothing.
        if (pf.allowed) {
          const decision = await confirmLive({
            use: 'ai.use.recommend', scope: t('proj.ai.scope', { theme: loc(theme.title, lang) }), itemCount: ents.length,
            internalCount: pf.internalCount, personCount: pf.personCount, estimatedCostJpy: pf.estimatedCostJpy,
            monthSpentJpy: pf.budget.monthSpentJpy, monthBudgetJpy: useAiSettings.getState().monthlyBudgetJpy,
            ...(attached.length ? { attachments: { sent: attached.map((a) => a.name).filter((n) => !plan.skipped.includes(n)), skipped: plan.skipped } } : {}),
          });
          if (!decision.ok) return setAiOutcome('cancelled');
          send = { ...req, userConfirmed: true, personConfirmed: decision.personConfirmed };
        }
      }
      const { response, lines } = await requestSuggestions(send);
      setAiOutcome(response);
      if (!lines.length) return;
      // Re-read: the theme may have changed while the confirmation was open.
      let next = useDiscussion.getState().value;
      for (const line of lines) next = addRecord(next, { themeId: theme.id, kind: 'suggestion', author: 'ai', text: line, mock: response.mode === 'mock', classification: theme.classification });
      commitDiscussion(next, 'add', 'record', lines[0] ?? '');
    } finally {
      setBusy(false);
    }
  };
  const isAttachment = (id: string) => hashOfSource(loaded.byId.get(id)) !== null;
  const attached = theme.relatedIds.map(itemOfSource).filter((x): x is AttachmentItem => x !== null);
  const aiPlan = attached.length ? summarizeForAi(attached, cap) : null;
  const attach = async (items: AttachmentItem[]) => {
    const ids: string[] = [];
    for (const it of items) ids.push(await ensureSource(it, theme.classification === 'shareable'));
    const latest = useDiscussion.getState().value;
    const current = latest.themes.find((x) => x.id === theme.id)?.relatedIds ?? theme.relatedIds;
    commitDiscussion(updateTheme(latest, theme.id, { relatedIds: [...current, ...ids.filter((id, i) => !current.includes(id) && ids.indexOf(id) === i)] }), 'update', 'theme', theme.title);
  };
  const relatable = loaded.pack.entities.filter((e) => ['issue', 'solution', 'kpi', 'person'].includes(e.kind) && !theme.relatedIds.includes(e.id));
  const relate = (id: string) => commitDiscussion(updateTheme(data, theme.id, { relatedIds: [...theme.relatedIds, id] }), 'update', 'theme', theme.title);

  return (
    <Panel title={t('proj.canvas.title')} rationale="proj.canvas.why" testId="proj-canvas" id="proj-canvas">
      <div
        className="proj-canvas"
        tabIndex={0}
        role="group"
        aria-label={t('proj.canvas.label', { n: idx + 1, total: ordered.length })}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        }}
      >
        <div className="proj-canvas-nav">
          <Button icon={<ChevronLeft20Regular />} disabled={idx <= 0} onClick={() => go(-1)}>{t('proj.canvas.prev')}</Button>
          <span className="muted">{t('proj.canvas.position', { n: idx + 1, total: ordered.length })}</span>
          <Button icon={<ChevronRight20Regular />} iconPosition="after" disabled={idx >= ordered.length - 1} onClick={() => go(1)}>{t('proj.canvas.next')}</Button>
        </div>
        <ul className="proj-strip" aria-label={t('proj.canvas.strip')}>
          {ordered.map(({ theme: th }) => (
            <li key={th.id}>
              <button type="button" className="proj-strip-card" aria-current={th.id === theme.id ? 'true' : undefined} onClick={() => onSelect(th.id)}>{L(th.title)}</button>
            </li>
          ))}
        </ul>
        <div className="proj-canvas-center">
          {editingTitle ? (
            <form className="proj-form-row" onSubmit={(e) => { e.preventDefault(); saveTitle(); }}>
              <Field label={t('proj.canvas.themeTitle')} validationState={titleError ? 'error' : 'none'} validationMessage={titleError ? t(errKey(titleError), { max: 200 }) : undefined}>
                <Input value={titleDraft} onChange={(_, d) => setTitleDraft(d.value)} />
              </Field>
              <Button type="submit" appearance="primary" icon={<Checkmark20Regular />}>{t('proj.save')}</Button>
              <Button onClick={() => setEditingTitle(false)}>{t('proj.cancel')}</Button>
            </form>
          ) : (
            <div className="proj-theme-head">
              <h3 className="proj-theme-title" data-testid="proj-canvas-title">{L(theme.title)}</h3>
              {theme.classification === 'internal' && <Badge appearance="tint" color="danger">{t('badge.internal')}</Badge>}
              {editMode && (
                <>
                  <Button size="small" icon={<Edit20Regular />} onClick={() => { setTitleDraft(loc(theme.title, lang)); setEditingTitle(true); }}>{t('proj.edit')}</Button>
                  <Button size="small" onClick={() => commitDiscussion(updateTheme(data, theme.id, { classification: theme.classification === 'internal' ? 'shareable' : 'internal' }), 'update', 'theme', theme.title)}>
                    {t(theme.classification === 'internal' ? 'proj.canvas.makeShareable' : 'proj.canvas.makeInternal')}
                  </Button>
                  <Button size="small" icon={<Delete20Regular />} onClick={() => { commitDiscussion(deleteTheme(data, theme.id), 'delete', 'theme', theme.title); onSelect(ordered[idx - 1]?.theme.id ?? ''); }}>{t('proj.delete')}</Button>
                </>
              )}
            </div>
          )}
          <div className="proj-related">
            <span className="muted">{t('proj.canvas.related')}</span>
            {theme.relatedIds.filter((id) => !isAttachment(id)).length === 0 && <span className="muted">{t('proj.canvas.noRelated')}</span>}
            {theme.relatedIds.filter((id) => !isAttachment(id)).map((id) => {
              const entity = loaded.byId.get(id);
              return (
                <span key={id} className="proj-related-item">
                  <EntityRef id={id} />
                  {editMode && entity && isEditableKind(entity.kind) && (
                    <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label={t('entry.disc.editRelated', { name: entity.name[lang] })}
                      onClick={() => setEntry({ kind: entity.kind as EditableKind, id })} data-testid={`proj-related-edit-${id}`} />
                  )}
                  {editMode && (
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={t('proj.canvas.unrelate', { name: entity?.name[lang] ?? id })}
                      onClick={() => commitDiscussion(updateTheme(data, theme.id, { relatedIds: theme.relatedIds.filter((x) => x !== id) }), 'update', 'theme', theme.title)} />
                  )}
                </span>
              );
            })}
            {editMode && relatable.length > 0 && (
              <Select
                aria-label={t('proj.canvas.relate')}
                value=""
                onChange={(_, d) => { if (d.value) relate(d.value); }}
                className="proj-relate-select"
              >
                <option value="">{t('proj.canvas.relate')}</option>
                {relatable.map((e) => <option key={e.id} value={e.id}>{`${t(`kind.${e.kind}`)}: ${e.name[lang]}`}</option>)}
              </Select>
            )}
            {editMode && (
              <Select
                aria-label={t('entry.disc.createRelate')}
                value=""
                onChange={(_, d) => { if (isEditableKind(d.value)) setEntry({ kind: d.value, id: null }); }}
                className="proj-relate-select"
                data-testid="proj-create-relate"
              >
                <option value="">{t('entry.disc.createRelate')}</option>
                {RELATABLE_KINDS.map((k) => <option key={k} value={k}>{t('entry.add', { kind: t(`kind.${k}`) })}</option>)}
              </Select>
            )}
            <EntityEditorDialog
              kind={entry?.kind ?? null}
              id={entry?.id ?? null}
              onClose={() => setEntry(null)}
              onSaved={(id) => { if (!theme.relatedIds.includes(id)) relate(id); }}
            />
          </div>
          <div className="proj-attachments">
            {editMode && <p className="muted entry-note">{t('entry.att.themeHint')}</p>}
            <AttachmentField
              items={attached}
              disabled={!editMode}
              onAdd={attach}
              onRemove={(it) => commitDiscussion(updateTheme(data, theme.id, { relatedIds: theme.relatedIds.filter((x) => x !== it.sourceId) }), 'update', 'theme', theme.title)}
              testId="proj-att"
            />
          </div>
          <div className="proj-sections">
            {SECTIONS.map(({ kind, title }) => {
              const list = records.filter((r) => r.kind === kind);
              return (
                <section key={kind} className={`proj-section kind-${kind}`} aria-labelledby={`proj-sec-${kind}`} data-testid={`proj-section-${kind}`}>
                  <h4 id={`proj-sec-${kind}`} className="proj-h4">
                    {t(title)}
                    <Badge appearance="tint" size="small">{list.length}</Badge>
                  </h4>
                  {kind === 'suggestion' && (
                    <Button size="small" icon={<Sparkle20Regular />} disabled={busy || !editMode} onClick={() => void askAi()} data-testid="proj-ask-ai">{t('proj.ai.ask')}</Button>
                  )}
                  {kind === 'suggestion' && (
                    <span className="proj-ai-mode">
                      <Badge appearance="outline" size="small" color={live ? 'success' : 'warning'} data-testid="proj-ai-mode">{live ? t('ai.live.badge') : t('ai.mock.badge')}</Badge>
                    </span>
                  )}
                  {kind === 'suggestion' && busy && <Spinner size="tiny" label={t('ai.loading')} />}
                  {kind === 'suggestion' && aiOutcome === 'cancelled' && <p role="status" data-testid="proj-ai-cancelled">{t('ai.person.cancelled')}</p>}
                  {kind === 'suggestion' && aiOutcome && aiOutcome !== 'cancelled' && (
                    <div role="status" data-testid="proj-ai-outcome">
                      {aiOutcome.mode === 'live'
                        ? <LiveNotice costJpy={aiOutcome.costJpy ?? null} usage={aiOutcome.usage} />
                        : <MockNotice reasons={aiOutcome.blockedReasons} />}
                    </div>
                  )}
                  {kind === 'suggestion' && aiPlan && (
                    <p className="muted entry-note" data-testid="proj-ai-attachments">
                      {t('entry.att.aiPlan', { media: aiPlan.media, text: aiPlan.text })}
                      {aiPlan.skipped.length > 0 && <> {t('entry.att.aiSkipped', { names: aiPlan.skipped.join(', ') })}</>}
                    </p>
                  )}
                  {list.length === 0 ? <p className="muted">{t('proj.rec.none')}</p> : (
                    <ul className="proj-records">
                      {list.map((r) => <RecordRow key={r.id} record={r} L={L} />)}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          {editMode && <AddRecordForm theme={theme} />}
        </div>
      </div>
      {liveDialog}
    </Panel>
  );
}

function RecordRow({ record, L }: { record: DiscussionRecord; L: (x: Localizable) => string }) {
  const { t, lang } = useI18n();
  const data = useDiscussion((s) => s.value);
  const editMode = useProjUi((s) => s.editMode);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [errors, setErrors] = useState<{ text?: FieldError; due?: FieldError }>({});
  const short = loc(record.text, lang).slice(0, 40);

  const save = () => {
    const v = validateRecord({ text, due });
    setErrors(v);
    if (v.text || v.due) return;
    const patch: Partial<DiscussionRecord> = { text: text.trim() };
    if (record.kind === 'action') {
      patch.owner = owner.trim() || undefined;
      patch.due = due || undefined;
    }
    commitDiscussion(updateRecord(data, record.id, patch), 'update', 'record', text.trim().slice(0, 40));
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="proj-record editing">
        <form onSubmit={(e) => { e.preventDefault(); save(); }} className="proj-record-form">
          <Field label={t('proj.rec.text')} validationState={errors.text ? 'error' : 'none'} validationMessage={errors.text ? t(errKey(errors.text), { max: 2000 }) : undefined}>
            <Textarea value={text} onChange={(_, d) => setText(d.value)} resize="vertical" />
          </Field>
          {record.kind === 'action' && (
            <div className="proj-form-row">
              <Field label={t('proj.rec.owner')}><Input value={owner} onChange={(_, d) => setOwner(d.value)} /></Field>
              <Field label={t('proj.rec.due')} validationState={errors.due ? 'error' : 'none'} validationMessage={errors.due ? t(errKey(errors.due)) : undefined}>
                <Input type="date" value={due} onChange={(_, d) => setDue(d.value)} />
              </Field>
            </div>
          )}
          <div className="proj-row">
            <Button type="submit" appearance="primary">{t('proj.save')}</Button>
            <Button onClick={() => setEditing(false)}>{t('proj.cancel')}</Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={`proj-record author-${record.author}`} data-testid="proj-record">
      <div className="proj-record-main">
        {record.kind === 'action' && (
          <Checkbox
            checked={!!record.done}
            disabled={!editMode}
            aria-label={t('proj.rec.doneLabel', { text: short })}
            onChange={(_, d) => commitDiscussion(updateRecord(data, record.id, { done: !!d.checked }), 'update', 'record', short)}
          />
        )}
        <span className={record.done ? 'proj-record-text done' : 'proj-record-text'}>{L(record.text)}</span>
      </div>
      <div className="proj-record-meta">
        <AuthorBadge author={record.author} mock={record.mock} decision={record.kind === 'decision'} />
        {record.classification === 'internal' && <Badge appearance="tint" color="danger" size="small">{t('badge.internal')}</Badge>}
        {record.owner && <span className="muted">{t('proj.rec.ownerIs', { owner: record.owner })}</span>}
        {record.due && <span className="muted">{t('proj.rec.dueIs', { due: record.due })}</span>}
        {editMode && (
          <span className="proj-row">
            {record.kind === 'suggestion' && (
              <Button size="small" appearance="primary" icon={<Checkmark20Regular />} onClick={() => commitDiscussion(adoptSuggestion(data, record.id), 'adopt', 'record', record.text)}>{t('proj.ai.adopt')}</Button>
            )}
            <Button size="small" icon={<Edit20Regular />} aria-label={t('proj.rec.editNamed', { text: short })} onClick={() => {
              setText(loc(record.text, lang)); setOwner(record.owner ?? ''); setDue(record.due ?? ''); setErrors({}); setEditing(true);
            }}>{t('proj.edit')}</Button>
            <Button size="small" icon={<Delete20Regular />} aria-label={t('proj.rec.deleteNamed', { text: short })} onClick={() => commitDiscussion(deleteRecord(data, record.id), 'delete', 'record', record.text)}>{t('proj.delete')}</Button>
          </span>
        )}
      </div>
    </li>
  );
}

function AddRecordForm({ theme }: { theme: Theme }) {
  const { t } = useI18n();
  const data = useDiscussion((s) => s.value);
  const [kind, setKind] = useState<RecordKind>('decision');
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [internal, setInternal] = useState(false);
  const [errors, setErrors] = useState<{ text?: FieldError; due?: FieldError }>({});

  const add = () => {
    const v = validateRecord({ text, due: kind === 'action' ? due : undefined });
    setErrors(v);
    if (v.text || v.due) return;
    const next = addRecord(data, {
      themeId: theme.id, kind, text, author: 'human', classification: internal || theme.classification === 'internal' ? 'internal' : 'shareable',
      ...(kind === 'action' ? { owner, due } : {}),
    });
    commitDiscussion(next, 'add', 'record', text.trim().slice(0, 40));
    setText('');
    setOwner('');
    setDue('');
  };

  return (
    <form className="proj-add-record" onSubmit={(e) => { e.preventDefault(); add(); }} aria-label={t('proj.rec.add')}>
      <h4 className="proj-h4">{t('proj.rec.add')}</h4>
      <div className="proj-form-row">
        <Field label={t('proj.rec.kind')}>
          <Select value={kind} onChange={(_, d) => setKind(d.value as RecordKind)} data-testid="proj-rec-kind">
            <option value="decision">{t('proj.kind.decision')}</option>
            <option value="action">{t('proj.kind.action')}</option>
            <option value="note">{t('proj.kind.note')}</option>
          </Select>
        </Field>
        <Field label={t('proj.rec.text')} className="grow" validationState={errors.text ? 'error' : 'none'} validationMessage={errors.text ? t(errKey(errors.text), { max: 2000 }) : undefined}>
          <Input value={text} onChange={(_, d) => setText(d.value)} data-testid="proj-rec-text" />
        </Field>
      </div>
      {kind === 'action' && (
        <div className="proj-form-row">
          <Field label={t('proj.rec.owner')}><Input value={owner} onChange={(_, d) => setOwner(d.value)} data-testid="proj-rec-owner" /></Field>
          <Field label={t('proj.rec.due')} validationState={errors.due ? 'error' : 'none'} validationMessage={errors.due ? t(errKey(errors.due)) : undefined}>
            <Input type="date" value={due} onChange={(_, d) => setDue(d.value)} />
          </Field>
        </div>
      )}
      <div className="proj-row">
        <Checkbox checked={internal} onChange={(_, d) => setInternal(!!d.checked)} label={t('proj.internal')} />
        <Button type="submit" appearance="primary" icon={<Add20Regular />} data-testid="proj-rec-add">{t('proj.rec.addButton')}</Button>
      </div>
    </form>
  );
}

/** G-001: decisions and next actions per theme vs PARAM-063. */
function CountsPanel({ L }: { L: (x: Localizable) => string }) {
  const { t } = useI18n();
  const data = useDiscussion((s) => s.value);
  const counts = themeCounts(data);
  const met = counts.filter((c) => c.met).length;
  return (
    <Panel title={t('proj.goal.title')} rationale="proj.goal.why" testId="proj-goal">
      <p data-testid="proj-goal-summary">{t('proj.export.goal', { met, total: counts.length })}</p>
      <ScrollRegion label={t('proj.goal.title')}>
        <table className="data-table compact">
          <caption className="visually-hidden">{t('proj.goal.caption', { min: MIN_PER_THEME })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('proj.md.theme')}</th>
              <th scope="col" className="num">{t('proj.goal.decisions')}</th>
              <th scope="col" className="num">{t('proj.goal.actions')}</th>
              <th scope="col">{t('proj.md.goal')}</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((c) => {
              const th = data.themes.find((x) => x.id === c.themeId)!;
              return (
                <tr key={c.themeId}>
                  <th scope="row">{L(th.title)}</th>
                  <td className="num">{c.decisions}</td>
                  <td className="num">{c.actions}</td>
                  <td>{c.met ? <Badge appearance="tint" color="success">{t('proj.goal.met')}</Badge> : <Badge appearance="tint" color="warning">{t('proj.goal.unmet')}</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="muted">{t('proj.goal.note', { min: MIN_PER_THEME })}</p>
      <MockNote />
    </Panel>
  );
}

function MockNote() {
  const { t } = useI18n();
  return <p className="muted proj-mock-note"><MockBadge /> {t('proj.ai.mockNote')}</p>;
}
