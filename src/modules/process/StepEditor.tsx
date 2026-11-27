import { useMemo, useState, type ReactNode } from 'react';
import {
  Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Textarea,
} from '@fluentui/react-components';
import { Add16Regular, Delete16Regular } from '@fluentui/react-icons';
import {
  ARTIFACT_FORMS, artifactName, LOOP_KINDS, LOOP_STATES, METRIC_FIELDS, PARTY_SIDES, STEP_CHANGES,
  type Artifact, type ArtifactForm, type StepMetrics, type WorkflowExtension, type WorkflowStage,
} from '../../data/extensionSchemas.ts';
import { useI18n } from '../../i18n/index.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { formKey } from './format.ts';
import { setStageLoops, upsertStage } from './store.ts';

type Loop = NonNullable<WorkflowExtension['loops']>[number];
interface Row { name: string; form: ArtifactForm | ''; partyId: string }
interface HiddenRow { name: string; form: ArtifactForm | ''; participants: string; minutes: string }
interface LoopRow { id: string; to: string; kind: Loop['kind']; state: NonNullable<Loop['state']>; rate: string; cadence: string; label: string }
interface MetricForm { touch: string; wait: string; volume: string; firstPass: string; people: string; estimate: boolean }

const numText = (v: number | undefined) => (v === undefined ? '' : String(v));
const parseNum = (s: string, max?: number): number | undefined => {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return max === undefined ? n : Math.min(max, n);
};
const metricForm = (m: StepMetrics | undefined): MetricForm => ({
  touch: numText(m?.touchMinutes), wait: numText(m?.waitHours), volume: numText(m?.volumePerMonth),
  firstPass: numText(m?.firstPassPct), people: numText(m?.people), estimate: m?.basis === 'estimate',
});
function metricsOut(f: MetricForm, original: StepMetrics | undefined, lang: 'ja' | 'en'): StepMetrics | undefined {
  if (original && JSON.stringify(f) === JSON.stringify(metricForm(original))) return original;
  const m: StepMetrics = {
    ...(parseNum(f.touch) !== undefined ? { touchMinutes: parseNum(f.touch) } : {}),
    ...(parseNum(f.wait) !== undefined ? { waitHours: parseNum(f.wait) } : {}),
    ...(parseNum(f.volume) !== undefined ? { volumePerMonth: parseNum(f.volume) } : {}),
    ...(parseNum(f.firstPass, 100) !== undefined ? { firstPassPct: parseNum(f.firstPass, 100) } : {}),
    ...(parseNum(f.people) !== undefined ? { people: Math.round(parseNum(f.people)!) } : {}),
  };
  if (!Object.keys(m).length) return undefined;
  const evidence: NonNullable<StepMetrics['evidence']> = {};
  for (const field of METRIC_FIELDS) if (m[field] !== undefined) {
    evidence[field] = m[field] === original?.[field] && f.estimate === (original.basis === 'estimate') ? original.evidence?.[field] : {
      status: f.estimate ? 'estimate' : 'stated', method: lang === 'ja' ? '入力値です。実測の根拠は未確認です。' : 'User-entered value; actual measurement not verified', sourceIds: [],
    };
  }
  return { ...m, basis: f.estimate ? 'estimate' : 'stated', evidence };
}

/** Text the user did not change keeps its bilingual original; changed text is stored as typed (§3.2). */
const keep = (orig: Localizable | undefined, edited: string, lang: 'ja' | 'en'): Localizable | undefined => {
  const text = edited.trim();
  if (!text) return undefined;
  return orig !== undefined && loc(orig, lang) === text ? orig : text;
};

const partyKey = (s: WorkflowStage) => (s.partyId ? `party:${s.partyId}` : s.team ? `team:${typeof s.team === 'string' ? s.team : s.team.ja}` : '');
const NEW_LANE = 'new';

export function StepEditor({ workflow, stageId, defaultChange, onSave, onDelete, onClose }: {
  workflow: WorkflowExtension;
  /** Absent = a new step. */
  stageId: string | null;
  defaultChange: 'keep' | 'new';
  onSave: (next: WorkflowExtension) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const original = workflow.stages.find((s) => s.id === stageId);
  const id = useMemo(() => original?.id ?? `st-${Date.now().toString(36)}`, [original]);
  const [name, setName] = useState(original ? loc(original.name, lang) : '');
  const [description, setDescription] = useState(original?.description ? loc(original.description, lang) : '');
  const [lane, setLane] = useState(original ? partyKey(original) : workflow.parties?.[0] ? `party:${workflow.parties[0].id}` : NEW_LANE);
  const [newLane, setNewLane] = useState({ name: '', side: 'internal' as (typeof PARTY_SIDES)[number] });
  const [phase, setPhase] = useState(original?.phaseId ?? workflow.phases?.[0]?.id ?? '');
  const [next, setNext] = useState<string[]>(original?.next ?? []);
  const [asIs, setAsIs] = useState(metricForm(original?.asIs));
  const [change, setChange] = useState<(typeof STEP_CHANGES)[number]>(original?.toBe?.change ?? defaultChange);
  const [into, setInto] = useState(original?.toBe?.into ?? '');
  const [toBe, setToBe] = useState(metricForm(original?.toBe?.metrics));
  const [note, setNote] = useState(original?.toBe?.note ? loc(original.toBe.note, lang) : '');
  const [stated, setStated] = useState(original?.toBe?.basis === 'stated');
  const toRows = (list: Artifact[] | undefined): Row[] => (list ?? []).map((a) => ({
    name: loc(artifactName(a), lang),
    form: typeof a === 'object' && 'name' in a && typeof a.form === 'string' ? a.form : '',
    partyId: typeof a === 'object' && 'name' in a && typeof a.partyId === 'string' ? a.partyId : '',
  }));
  const [inputs, setInputs] = useState<Row[]>(toRows(original?.inputs));
  const [outputs, setOutputs] = useState<Row[]>(toRows(original?.outputs));
  const [hidden, setHidden] = useState<HiddenRow[]>((original?.hiddenWork ?? []).map((h) => ({ name: loc(h.name, lang), form: h.form ?? '', participants: numText(h.participants), minutes: numText(h.minutes) })));
  const [loops, setLoops] = useState<LoopRow[]>((workflow.loops ?? []).filter((l) => l.from === id).map((l) => ({
    id: l.id, to: l.to, kind: l.kind, state: l.state ?? 'both', rate: numText(l.ratePct), cadence: l.cadence ? loc(l.cadence, lang) : '', label: l.label ? loc(l.label, lang) : '',
  })));
  const others = workflow.stages.filter((s) => s.id !== id);
  const parties = workflow.parties ?? [];
  const teams = [...new Set(workflow.stages.filter((s) => !s.partyId && s.team).map((s) => (typeof s.team === 'string' ? s.team : s.team!.ja)))];
  const valid = name.trim() !== '' && (lane !== NEW_LANE || newLane.name.trim() !== '');

  const save = () => {
    let w = workflow;
    let partyId: string | undefined;
    let team: Localizable | undefined;
    if (lane === NEW_LANE) {
      const used = new Set(parties.map((p) => p.id));
      let n = parties.length + 1;
      while (used.has(`party-${n}`)) n++;
      partyId = `party-${n}`;
      w = { ...w, parties: [...parties, { id: partyId, name: newLane.name.trim(), side: newLane.side, kind: newLane.side === 'external' ? 'customer' : 'department' }] };
    } else if (lane.startsWith('party:')) partyId = lane.slice(6);
    else if (lane.startsWith('team:')) team = original?.team && loc(original.team, 'ja') === lane.slice(5) ? original.team : lane.slice(5);
    const artifactsOut = (rows: Row[], orig: Artifact[] | undefined): Artifact[] => rows.filter((r) => r.name.trim()).map((r, i) => {
      const o = orig?.[i];
      const nameL = keep(o ? artifactName(o) : undefined, r.name, lang)!;
      return r.form || r.partyId ? { name: nameL, ...(r.form ? { form: r.form } : {}), ...(r.partyId ? { partyId: r.partyId } : {}) } : nameL;
    });
    const asIsOut = change === 'new' ? undefined : metricsOut(asIs, original?.asIs, lang);
    const toBeMetrics = change === 'remove' || change === 'combine' ? undefined : metricsOut(toBe, original?.toBe?.metrics, lang);
    const noteOut = keep(original?.toBe?.note, note, lang);
    const toBeOut = change === 'keep' && !toBeMetrics && !noteOut ? undefined : {
      change, ...(toBeMetrics ? { metrics: toBeMetrics } : {}), ...(noteOut ? { note: noteOut } : {}),
      ...(change === 'combine' && into ? { into } : {}), basis: stated ? 'stated' as const : 'hypothesis' as const,
    };
    const base: Record<string, unknown> = { ...(original ?? {}) };
    for (const k of ['partyId', 'team', 'phaseId', 'description', 'asIs', 'toBe', 'hiddenWork']) delete base[k];
    const stage = {
      ...base,
      id,
      name: keep(original?.name, name, lang)!,
      ...(partyId ? { partyId } : {}),
      ...(team ? { team } : {}),
      ...(phase ? { phaseId: phase } : {}),
      ...(keep(original?.description, description, lang) ? { description: keep(original?.description, description, lang) } : {}),
      inputs: artifactsOut(inputs, original?.inputs),
      activities: original?.activities ?? [],
      outputs: artifactsOut(outputs, original?.outputs),
      next: next.filter((n) => n !== id && w.stages.some((s) => s.id === n)),
      ...(hidden.some((h) => h.name.trim()) ? {
        hiddenWork: hidden.filter((h) => h.name.trim()).map((h, i) => ({
          name: keep(original?.hiddenWork?.[i]?.name, h.name, lang)!,
          ...(h.form ? { form: h.form } : {}),
          ...(parseNum(h.participants) !== undefined ? { participants: Math.round(parseNum(h.participants)!) } : {}),
          ...(parseNum(h.minutes) !== undefined ? { minutes: parseNum(h.minutes) } : {}),
          minutesEvidence: parseNum(h.minutes) === original?.hiddenWork?.[i]?.minutes ? original?.hiddenWork?.[i]?.minutesEvidence : undefined,
          participantsEvidence: parseNum(h.participants) === original?.hiddenWork?.[i]?.participants ? original?.hiddenWork?.[i]?.participantsEvidence : undefined,
        })),
      } : {}),
      ...(asIsOut ? { asIs: asIsOut } : {}),
      ...(toBeOut ? { toBe: toBeOut } : {}),
    } as WorkflowStage;
    w = upsertStage(w, stage);
    const loopsOut: Loop[] = loops.filter((l) => l.to && w.stages.some((s) => s.id === l.to)).map((l, i) => {
      const prev = workflow.loops?.find((x) => x.id === l.id);
      return {
        id: l.id || `loop-${id}-${i + 1}`, from: id, to: l.to, kind: l.kind, state: l.state,
        ...(parseNum(l.rate, 100) !== undefined ? { ratePct: parseNum(l.rate, 100) } : {}),
        rateEvidence: parseNum(l.rate, 100) === prev?.ratePct ? prev?.rateEvidence : undefined,
        ...(keep(prev?.cadence, l.cadence, lang) ? { cadence: keep(prev?.cadence, l.cadence, lang) } : {}),
        ...(keep(prev?.label, l.label, lang) ? { label: keep(prev?.label, l.label, lang) } : {}),
        ...(prev?.sourceIds ? { sourceIds: prev.sourceIds } : {}),
      };
    });
    onSave(setStageLoops(w, id, loopsOut));
  };

  const metricFields = (f: MetricForm, set: (f: MetricForm) => void, prefix: string, estimateLabel: ReactNode) => (
    <div className="bp-ed-metrics">
      <Field label={t('bp.ed.touch')}><Input type="number" min={0} value={f.touch} onChange={(_, d) => set({ ...f, touch: d.value })} data-testid={`${prefix}-touch`} /></Field>
      <Field label={t('bp.ed.wait')}><Input type="number" min={0} value={f.wait} onChange={(_, d) => set({ ...f, wait: d.value })} data-testid={`${prefix}-wait`} /></Field>
      <Field label={t('bp.ed.volume')}><Input type="number" min={0} value={f.volume} onChange={(_, d) => set({ ...f, volume: d.value })} data-testid={`${prefix}-volume`} /></Field>
      <Field label={t('bp.ed.firstPass')}><Input type="number" min={0} max={100} value={f.firstPass} onChange={(_, d) => set({ ...f, firstPass: d.value })} /></Field>
      <Field label={t('bp.ed.people')}><Input type="number" min={0} value={f.people} onChange={(_, d) => set({ ...f, people: d.value })} /></Field>
      {estimateLabel}
    </div>
  );

  const rowsEditor = (rows: Row[], set: (r: Row[]) => void, label: string, testId: string) => (
    <fieldset className="bp-ed-rows" data-testid={testId}>
      <legend>{label}</legend>
      {rows.map((r, i) => (
        <div key={i} className="bp-ed-row">
          <Input aria-label={t('bp.ed.itemName', { n: i + 1 })} value={r.name} onChange={(_, d) => set(rows.map((x, j) => (j === i ? { ...x, name: d.value } : x)))} />
          <Select aria-label={t('bp.ed.form')} value={r.form} onChange={(_, d) => set(rows.map((x, j) => (j === i ? { ...x, form: d.value as ArtifactForm | '' } : x)))}>
            <option value="">{t('bp.ed.formUnknown')}</option>
            {ARTIFACT_FORMS.map((f) => <option key={f} value={f}>{t(formKey(f))}</option>)}
          </Select>
          <Select aria-label={t('bp.ed.party')} value={r.partyId} onChange={(_, d) => set(rows.map((x, j) => (j === i ? { ...x, partyId: d.value } : x)))}>
            <option value="">{t('bp.ed.partyNone')}</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{loc(p.name, lang)}</option>)}
          </Select>
          <Button size="small" icon={<Delete16Regular />} aria-label={t('bp.ed.removeRow', { n: i + 1 })} onClick={() => set(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="small" icon={<Add16Regular />} onClick={() => set([...rows, { name: '', form: '', partyId: '' }])}>{t('bp.ed.addRow')}</Button>
    </fieldset>
  );

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface className="form-surface" data-testid="bp-editor">
        <DialogBody>
          <DialogTitle>{original ? t('bp.ed.titleEdit', { name: loc(original.name, lang) }) : t('bp.ed.titleNew')}</DialogTitle>
          <DialogContent className="bp-ed-content">
            <section>
              <h3>{t('bp.ed.section.basic')}</h3>
              <Field label={t('bp.ed.name')} required><Input value={name} onChange={(_, d) => setName(d.value)} data-testid="bp-ed-name" /></Field>
              <Field label={t('bp.ed.description')}><Textarea value={description} onChange={(_, d) => setDescription(d.value)} resize="vertical" /></Field>
              <div className="bp-ed-grid">
                <Field label={t('bp.ed.lane')}>
                  <Select value={lane} onChange={(_, d) => setLane(d.value)} data-testid="bp-ed-lane">
                    {parties.map((p) => <option key={p.id} value={`party:${p.id}`}>{`${t(`bp.side.${p.side}`)} · ${loc(p.name, lang)}`}</option>)}
                    {teams.map((tm) => <option key={tm} value={`team:${tm}`}>{tm}</option>)}
                    <option value={NEW_LANE}>{t('bp.ed.newLane')}</option>
                  </Select>
                </Field>
                <Field label={t('bp.ed.phase')}>
                  <Select value={phase} onChange={(_, d) => setPhase(d.value)}>
                    <option value="">{t('bp.ed.phaseNone')}</option>
                    {(workflow.phases ?? []).map((p) => <option key={p.id} value={p.id}>{loc(p.name, lang)}</option>)}
                  </Select>
                </Field>
              </div>
              {lane === NEW_LANE && (
                <div className="bp-ed-grid">
                  <Field label={t('bp.ed.newLaneName')} required><Input value={newLane.name} onChange={(_, d) => setNewLane({ ...newLane, name: d.value })} data-testid="bp-ed-newlane" /></Field>
                  <Field label={t('bp.ed.newLaneSide')}>
                    <Select value={newLane.side} onChange={(_, d) => setNewLane({ ...newLane, side: d.value as typeof newLane.side })}>
                      {PARTY_SIDES.map((s) => <option key={s} value={s}>{t(`bp.side.${s}`)}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              <fieldset className="bp-ed-next">
                <legend>{t('bp.ed.next')}</legend>
                {others.length === 0 ? <p className="muted">{t('bp.card.none')}</p> : others.map((s) => (
                  <Checkbox key={s.id} label={loc(s.name, lang)} checked={next.includes(s.id)} onChange={(_, d) => setNext(d.checked ? [...next, s.id] : next.filter((n) => n !== s.id))} />
                ))}
              </fieldset>
            </section>

            {change !== 'new' && (
              <section>
                <h3>{t('bp.ed.section.asIs')}</h3>
                {metricFields(asIs, setAsIs, 'bp-ed-asis', <Checkbox label={t('bp.ed.estimate')} checked={asIs.estimate} onChange={(_, d) => setAsIs({ ...asIs, estimate: !!d.checked })} />)}
              </section>
            )}

            <section>
              <h3>{t('bp.ed.section.toBe')}</h3>
              <div className="bp-ed-grid">
                <Field label={t('bp.ed.change')}>
                  <Select value={change} onChange={(_, d) => setChange(d.value as typeof change)} data-testid="bp-ed-change">
                    {STEP_CHANGES.map((c) => <option key={c} value={c}>{t(`bp.change.${c}`)}</option>)}
                  </Select>
                </Field>
                {change === 'combine' && (
                  <Field label={t('bp.ed.into')}>
                    <Select value={into} onChange={(_, d) => setInto(d.value)}>
                      <option value="">{t('bp.ed.partyNone')}</option>
                      {others.map((s) => <option key={s.id} value={s.id}>{loc(s.name, lang)}</option>)}
                    </Select>
                  </Field>
                )}
              </div>
              <p className="muted">{t(`bp.changeHelp.${change}`)}</p>
              {change !== 'remove' && change !== 'combine' && metricFields(toBe, setToBe, 'bp-ed-tobe', null)}
              <Field label={t('bp.ed.note')} hint={t('bp.ed.noteHint')}><Textarea value={note} onChange={(_, d) => setNote(d.value)} resize="vertical" data-testid="bp-ed-note" /></Field>
              <Checkbox label={t('bp.ed.stated')} checked={stated} onChange={(_, d) => setStated(!!d.checked)} />
            </section>

            <section>
              <h3>{t('bp.ed.section.io')}</h3>
              <p className="muted">{t('bp.ed.ioHint')}</p>
              {rowsEditor(inputs, setInputs, t('bp.card.inputs'), 'bp-ed-inputs')}
              {rowsEditor(outputs, setOutputs, t('bp.card.outputs'), 'bp-ed-outputs')}
              <fieldset className="bp-ed-rows" data-testid="bp-ed-hidden">
                <legend>{t('bp.card.hidden')}</legend>
                <p className="muted">{t('bp.ed.hiddenHint')}</p>
                {hidden.map((h, i) => (
                  <div key={i} className="bp-ed-row">
                    <Input aria-label={t('bp.ed.itemName', { n: i + 1 })} value={h.name} onChange={(_, d) => setHidden(hidden.map((x, j) => (j === i ? { ...x, name: d.value } : x)))} />
                    <Select aria-label={t('bp.ed.form')} value={h.form} onChange={(_, d) => setHidden(hidden.map((x, j) => (j === i ? { ...x, form: d.value as ArtifactForm | '' } : x)))}>
                      <option value="">{t('bp.ed.formUnknown')}</option>
                      {ARTIFACT_FORMS.map((f) => <option key={f} value={f}>{t(formKey(f))}</option>)}
                    </Select>
                    <Input type="number" min={0} aria-label={t('bp.ed.participants')} placeholder={t('bp.ed.participants')} value={h.participants} onChange={(_, d) => setHidden(hidden.map((x, j) => (j === i ? { ...x, participants: d.value } : x)))} />
                    <Input type="number" min={0} aria-label={t('bp.ed.minutes')} placeholder={t('bp.ed.minutes')} value={h.minutes} onChange={(_, d) => setHidden(hidden.map((x, j) => (j === i ? { ...x, minutes: d.value } : x)))} />
                    <Button size="small" icon={<Delete16Regular />} aria-label={t('bp.ed.removeRow', { n: i + 1 })} onClick={() => setHidden(hidden.filter((_, j) => j !== i))} />
                  </div>
                ))}
                <Button size="small" icon={<Add16Regular />} onClick={() => setHidden([...hidden, { name: '', form: '', participants: '', minutes: '' }])}>{t('bp.ed.addRow')}</Button>
              </fieldset>
            </section>

            <section>
              <h3>{t('bp.ed.section.loops')}</h3>
              <p className="muted">{t('bp.ed.loopsHint')}</p>
              {loops.map((l, i) => (
                <div key={i} className="bp-ed-row is-loop">
                  <Select aria-label={t('bp.ed.loopTo')} value={l.to} onChange={(_, d) => setLoops(loops.map((x, j) => (j === i ? { ...x, to: d.value } : x)))}>
                    <option value="">{t('bp.ed.loopTo')}</option>
                    {workflow.stages.map((s) => <option key={s.id} value={s.id}>{loc(s.name, lang)}</option>)}
                  </Select>
                  <Select aria-label={t('bp.ed.loopKind')} value={l.kind} onChange={(_, d) => setLoops(loops.map((x, j) => (j === i ? { ...x, kind: d.value as Loop['kind'] } : x)))}>
                    {LOOP_KINDS.map((k) => <option key={k} value={k}>{t(`bp.loop.${k}`)}</option>)}
                  </Select>
                  <Select aria-label={t('bp.ed.loopState')} value={l.state} onChange={(_, d) => setLoops(loops.map((x, j) => (j === i ? { ...x, state: d.value as LoopRow['state'] } : x)))}>
                    {LOOP_STATES.map((k) => <option key={k} value={k}>{t(`bp.loopState.${k}`)}</option>)}
                  </Select>
                  <Input type="number" min={0} max={100} aria-label={t('bp.ed.loopRate')} placeholder={t('bp.ed.loopRate')} value={l.rate} onChange={(_, d) => setLoops(loops.map((x, j) => (j === i ? { ...x, rate: d.value } : x)))} />
                  <Input aria-label={t('bp.ed.loopCadence')} placeholder={t('bp.ed.loopCadence')} value={l.cadence} onChange={(_, d) => setLoops(loops.map((x, j) => (j === i ? { ...x, cadence: d.value } : x)))} />
                  <Button size="small" icon={<Delete16Regular />} aria-label={t('bp.ed.removeRow', { n: i + 1 })} onClick={() => setLoops(loops.filter((_, j) => j !== i))} />
                </div>
              ))}
              <Button size="small" icon={<Add16Regular />} onClick={() => setLoops([...loops, { id: '', to: '', kind: 'rework', state: 'both', rate: '', cadence: '', label: '' }])}>{t('bp.ed.addLoop')}</Button>
            </section>
          </DialogContent>
          <DialogActions>
            {original && onDelete && <Button appearance="subtle" icon={<Delete16Regular />} onClick={onDelete} data-testid="bp-ed-delete">{t('bp.ed.delete')}</Button>}
            <Button appearance="secondary" onClick={onClose}>{t('bp.ed.cancel')}</Button>
            <Button appearance="primary" disabled={!valid} onClick={save} data-testid="bp-ed-save">{t('bp.ed.save')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
