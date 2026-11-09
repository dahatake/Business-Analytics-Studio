import { useMemo, useRef, useState } from 'react';
import { Badge, Button, Radio, RadioGroup, Select, Switch, Tab, TabList } from '@fluentui/react-components';
import { Add20Regular, ArrowRedo20Regular, ArrowUndo20Regular, FullScreenMaximize20Regular, Play20Regular } from '@fluentui/react-icons';
import { getEntity } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { UndoStack } from '../../state/history.ts';
import { PERSONA_VIEWS, personaLabel, type Persona } from '../../state/personas.ts';
import { useCurrentScope } from '../../state/projects.ts';
import { hrefFor, replaceQuery, useRoute } from '../../state/router.ts';
import { useReducedMotion } from '../../state/motion.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { isHidden } from '../../ui/cardSpecs.ts';
import { PageHeader, Panel } from '../../ui/Panel.tsx';
import { AnimationPlayer } from './AnimationPlayer.tsx';
import { MockApp } from './MockApp.tsx';
import { StoryPlayer } from './StoryPlayer.tsx';
import { UseCaseEditor } from './UseCaseEditor.tsx';
import { openCandidates } from './derive.ts';
import { generateMockApp } from './mockapp.ts';
import { buildAnimation, buildStoryboard, SCENE_MS } from './scenes.ts';
import { speechSupported, useReadAloud } from './speech.ts';
import {
  madeState, newUseCaseId, STORY_STYLES, useAnimations, useStoryboards, useUseCases, type StoryStyle, type UseCase,
} from './store.ts';
import './usecases.css';

type TabKey = 'edit' | 'animation' | 'storyboard' | 'mock';
const TABS: TabKey[] = ['edit', 'animation', 'storyboard', 'mock'];

const stacks = new Map<string, UndoStack<UseCase[]>>();

function MadeBadge({ state }: { state: 'none' | 'latest' | 'stale' }) {
  const { t } = useI18n();
  return <Badge appearance="outline" color={state === 'stale' ? 'warning' : state === 'latest' ? 'success' : 'informative'}>{t(`uc.made.${state}`)}</Badge>;
}

function AnimationTab({ uc, readAloud }: { uc: UseCase; readAloud: boolean }) {
  const { t } = useI18n();
  const records = useAnimations((s) => s.value);
  const setRecords = useAnimations((s) => s.set);
  const [createdNow, setCreatedNow] = useState(0);
  const rec = records[uc.id];
  const state = madeState(uc, rec);
  const timeline = useMemo(() => (rec ? buildAnimation(uc) : null), [rec, uc]);
  return (
    <div className="stack">
      <div className="toolbar">
        <MadeBadge state={state} />
        <Button appearance="primary" icon={<Play20Regular />} onClick={() => {
          setRecords((r) => ({ ...r, [uc.id]: { createdAt: new Date().toISOString() } }));
          setCreatedNow((n) => n + 1);
        }}>
          {state === 'none' ? t('uc.anim.create') : t('uc.anim.recreate')}
        </Button>
        <span className="muted">{t('uc.anim.hint', { sec: SCENE_MS / 1000 })}</span>
      </div>
      {state === 'stale' && <p className="muted" role="status">{t('uc.made.staleHint')}</p>}
      {timeline && <AnimationPlayer key={`${uc.id}-${createdNow}`} timeline={timeline} autoPlay={createdNow > 0} readAloud={readAloud} />}
    </div>
  );
}

function StoryboardTab({ uc, readAloud }: { uc: UseCase; readAloud: boolean }) {
  const { t, lang } = useI18n();
  const records = useStoryboards((s) => s.value);
  const setRecords = useStoryboards((s) => s.set);
  const rec = records[uc.id];
  const [style, setStyle] = useState<StoryStyle>(rec?.style ?? 'cinematic');
  const [playing, setPlaying] = useState(false);
  const state = madeState(uc, rec);
  const timeline = useMemo(() => (rec ? buildStoryboard(uc, rec.style ?? 'cinematic') : null), [rec, uc]);
  return (
    <div className="stack">
      <div className="uc-style-picker">
        <h3 className="subhead" id="uc-style-label">{t('uc.sb.style')}</h3>
        <RadioGroup layout="horizontal" value={style} onChange={(_, d) => setStyle(d.value as StoryStyle)} aria-labelledby="uc-style-label">
          {STORY_STYLES.map((s) => <Radio key={s} value={s} label={`${t(`uc.sb.style.${s}`)} — ${t(`uc.sb.styleHint.${s}`)}`} />)}
        </RadioGroup>
      </div>
      <div className="toolbar">
        <MadeBadge state={state} />
        <Button appearance="primary" onClick={() => setRecords((r) => ({ ...r, [uc.id]: { createdAt: new Date().toISOString(), style } }))}>
          {state === 'none' ? t('uc.sb.create') : t('uc.sb.recreate')}
        </Button>
        {timeline && <Button icon={<FullScreenMaximize20Regular />} onClick={() => setPlaying(true)}>{t('uc.sb.play')}</Button>}
      </div>
      {state === 'stale' && <p className="muted" role="status">{t('uc.made.staleHint')}</p>}
      {timeline && rec && (
        <>
          <p data-testid="uc-sb-total" data-total-ms={timeline.totalMs}>
            {t('uc.sb.total', { sec: (timeline.totalMs / 1000).toFixed(1), n: timeline.scenes.length, style: t(`uc.sb.style.${rec.style ?? 'cinematic'}`) })}
          </p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={t('uc.sb.scenes')}>
            <table className="data-table compact">
              <caption className="visually-hidden">{t('uc.sb.scenes')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('uc.sb.col.no')}</th>
                  <th scope="col">{t('uc.sb.col.kind')}</th>
                  <th scope="col">{t('uc.sb.col.heading')}</th>
                  <th scope="col">{t('uc.sb.col.telop')}</th>
                  <th scope="col">{t('uc.sb.col.caption')}</th>
                  <th scope="col">{t('uc.sb.col.seconds')}</th>
                </tr>
              </thead>
              <tbody>
                {timeline.scenes.map((s, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>{s.kind === 'step' ? t('uc.anim.step', { n: s.stepNo ?? 0 }) : t(`uc.sb.kind.${s.kind}`)}</td>
                    <td>{loc(s.heading, lang)}</td>
                    <td><strong>{loc(s.telop, lang)}</strong></td>
                    <td>{loc(s.subtitle, lang)}</td>
                    <td>{(s.durationMs / 1000).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {playing && <StoryPlayer timeline={timeline} style={rec.style ?? 'cinematic'} readAloud={readAloud} onClose={() => setPlaying(false)} />}
        </>
      )}
    </div>
  );
}

function MockTab({ uc }: { uc: UseCase }) {
  const { t } = useI18n();
  const [gen, setGen] = useState(0);
  const screens = useMemo(() => (gen > 0 ? generateMockApp(uc) : null), [gen, uc]);
  return (
    <div className="stack">
      <div className="toolbar">
        <Button appearance="primary" onClick={() => setGen((g) => g + 1)}>{gen > 0 ? t('uc.mock.regenerate') : t('uc.mock.generate')}</Button>
        <span className="muted">{t('uc.mock.hint')}</span>
      </div>
      {screens && <MockApp key={gen} screens={screens} />}
    </div>
  );
}

/** /usecases — FR-158 registration and editing, FR-155〜157 animation, FR-163〜167 storyboard, FR-043 mock app. */
export function UseCasesScreen() {
  const { t, lang } = useI18n();
  const scope = useCurrentScope();
  const audience = useSettings((s) => s.audience);
  const reduced = useReducedMotion();
  const list = useUseCases((s) => s.value);
  const setList = useUseCases((s) => s.set);
  const route = useRoute();
  const [, bump] = useState(0);
  const [status, setStatus] = useState('');
  const [personaFilter, setPersonaFilter] = useState<'all' | Persona>('all');
  const [readAloud, setReadAloud] = useReadAloud();
  const detailRef = useRef<HTMLDivElement>(null);

  const selectedId = route.query.get('uc') ?? '';
  const tab: TabKey = (TABS as string[]).includes(route.query.get('tab') ?? '') ? (route.query.get('tab') as TabKey) : 'edit';
  const candidates = useMemo(
    () => openCandidates(list).filter((c) => {
      const src = c.derivedFrom ? getEntity(c.derivedFrom) : undefined;
      return !src || !isHidden(src, audience);
    }),
    [list, audience],
  );
  const selected = selectedId === 'new' ? null : list.find((u) => u.id === selectedId) ?? candidates.find((c) => c.id === selectedId);

  let stack = stacks.get(scope);
  if (!stack) {
    stack = new UndoStack(list);
    stacks.set(scope, stack);
  }
  if (!Object.is(stack.value, list)) stack.reset(list);
  const history = stack;

  const commit = (next: UseCase[], message: string) => {
    history.push(next);
    setList(next);
    setStatus(message);
  };
  const select = (id: string, nextTab: TabKey = tab) => {
    replaceQuery({ uc: id || undefined, tab: nextTab === 'edit' ? undefined : nextTab });
    requestAnimationFrame(() => (detailRef.current?.querySelector('input, button[role="tab"]') as HTMLElement | null)?.focus());
  };

  const save = (uc: UseCase) => {
    const exists = list.some((u) => u.id === uc.id);
    commit(exists ? list.map((u) => (u.id === uc.id ? uc : u)) : [...list, uc], t('uc.status.saved', { name: loc(uc.name, lang) }));
    replaceQuery({ uc: uc.id });
  };
  const registerAsIs = (c: UseCase) => {
    const uc: UseCase = { ...c, id: newUseCaseId(), origin: 'registered', updatedAt: new Date().toISOString() };
    commit([...list, uc], t('uc.status.registered', { name: loc(uc.name, lang) }));
    replaceQuery({ uc: uc.id });
  };
  const remove = (uc: UseCase) => {
    commit(list.filter((u) => u.id !== uc.id), t('uc.status.deleted', { name: loc(uc.name, lang) }));
    replaceQuery({ uc: undefined, tab: undefined });
  };
  const travel = (dir: 'undo' | 'redo') => {
    const v = dir === 'undo' ? history.undo() : history.redo();
    setList(v);
    setStatus(dir === 'undo' ? t('uc.status.undone') : t('uc.status.redone'));
    bump((n) => n + 1);
  };

  const visible = list.filter((u) => personaFilter === 'all' || u.persona === personaFilter);
  const visibleCandidates = candidates.filter((u) => personaFilter === 'all' || u.persona === personaFilter);
  const item = (u: UseCase) => (
    <li key={u.id}>
      <button
        type="button"
        className={`uc-list-item ${u.id === selectedId ? 'selected' : ''}`}
        aria-current={u.id === selectedId ? 'true' : undefined}
        onClick={() => select(u.id)}
        data-uc-id={u.id}
      >
        <span className="uc-list-name">{loc(u.name, lang)}</span>
        <span className="uc-list-meta">{t('uc.list.meta', { persona: t(personaLabel(u.persona)), n: u.steps.length })}</span>
      </button>
    </li>
  );

  return (
    <div className="screen uc-screen">
      <PageHeader
        title={t('uc.title')}
        subtitle={t('uc.subtitle')}
        actions={
          <>
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => select('new', 'edit')}>{t('uc.new')}</Button>
            <Button icon={<ArrowUndo20Regular />} disabled={!history.canUndo} onClick={() => travel('undo')}>{t('uc.undo')}</Button>
            <Button icon={<ArrowRedo20Regular />} disabled={!history.canRedo} onClick={() => travel('redo')}>{t('uc.redo')}</Button>
          </>
        }
      />
      <p role="status" className="uc-status" data-testid="uc-status">{status}</p>
      <div className="uc-layout">
        <Panel title={t('uc.list.title')} rationale="uc.list.rationale" testId="uc-list" id="uc-list">
          <div className="uc-filter">
            <label htmlFor="uc-persona-filter">{t('uc.list.filter')}</label>
            <Select id="uc-persona-filter" value={personaFilter} onChange={(_, d) => setPersonaFilter(d.value as 'all' | Persona)}>
              <option value="all">{t('uc.list.all')}</option>
              {PERSONA_VIEWS.map((p) => <option key={p} value={p}>{t(personaLabel(p))}</option>)}
            </Select>
          </div>
          <h3 className="subhead">{t('uc.list.registered', { n: visible.length })}</h3>
          {visible.length === 0 ? <p className="muted">{t('uc.list.empty')}</p> : <ul className="uc-list">{visible.map(item)}</ul>}
          <h3 className="subhead">{t('uc.list.candidates', { n: visibleCandidates.length })}</h3>
          <p className="muted">{t('uc.list.candidatesHint')}</p>
          {visibleCandidates.length === 0 ? <p className="muted">{t('uc.list.noCandidates')}</p> : <ul className="uc-list uc-candidates">{visibleCandidates.map(item)}</ul>}
        </Panel>

        <div ref={detailRef} className="uc-detail">
          {selectedId === 'new' ? (
            <Panel title={t('uc.new')} testId="uc-detail">
              <UseCaseEditor key="new" initial={null} onSave={save} onCancel={() => replaceQuery({ uc: undefined })} />
            </Panel>
          ) : selected ? (
            <Panel title={loc(selected.name, lang)} testId="uc-detail" rationale="uc.detail.rationale">
              <div className="uc-detail-meta">
                <Badge appearance="tint">{t(personaLabel(selected.persona))}</Badge>
                <Badge appearance="outline">{selected.origin === 'derived' ? t('uc.origin.derived') : t('uc.origin.registered')}</Badge>
                {selected.origin === 'derived' && <Button size="small" appearance="primary" onClick={() => registerAsIs(selected)}>{t('uc.registerAsIs')}</Button>}
              </div>
              {selected.relatedIds.some((id) => getEntity(id)) && (
                <div className="uc-related">
                  <span className="muted">{t('uc.related')}</span>
                  <ul className="ref-list">{selected.relatedIds.filter((id) => getEntity(id)).map((id) => <li key={id}><EntityRef id={id} /></li>)}</ul>
                </div>
              )}
              <div className="uc-read-aloud">
                <Switch checked={readAloud && speechSupported()} disabled={!speechSupported()} label={t('uc.speech.toggle')} onChange={(_, d) => setReadAloud(d.checked)} />
                <span className="muted">{speechSupported() ? t('uc.speech.local') : t('uc.speech.unsupported')}</span>
                <a href={hrefFor('/ai-settings')}>{t('uc.speech.azureLink')}</a>
              </div>
              <TabList selectedValue={tab} onTabSelect={(_, d) => replaceQuery({ tab: d.value === 'edit' ? undefined : String(d.value) })}>
                {TABS.map((k) => <Tab key={k} value={k}>{t(`uc.tab.${k}`)}</Tab>)}
              </TabList>
              <div className="uc-tab-body" role="tabpanel" aria-label={t(`uc.tab.${tab}`)}>
                {tab === 'edit' && (
                  <UseCaseEditor
                    key={`${selected.id}-${selected.updatedAt}-${lang}`}
                    initial={selected}
                    onSave={save}
                    onCancel={() => replaceQuery({ uc: undefined, tab: undefined })}
                    onDelete={selected.origin === 'registered' ? () => remove(selected) : undefined}
                  />
                )}
                {tab === 'animation' && <AnimationTab key={selected.id} uc={selected} readAloud={readAloud} />}
                {tab === 'storyboard' && <StoryboardTab key={selected.id} uc={selected} readAloud={readAloud} />}
                {tab === 'mock' && <MockTab key={selected.id} uc={selected} />}
              </div>
              {reduced && (tab === 'animation' || tab === 'storyboard') && <p className="muted">{t('uc.reducedNote')}</p>}
            </Panel>
          ) : (
            <Panel title={t('uc.detail.none')} testId="uc-detail">
              <p className="muted">{t('uc.detail.noneHint')}</p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
