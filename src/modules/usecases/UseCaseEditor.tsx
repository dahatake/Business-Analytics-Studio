import { useState } from 'react';
import { Button, Field, Input, Select, Textarea } from '@fluentui/react-components';
import { Add16Regular, ArrowDown16Regular, ArrowUp16Regular, Delete16Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { ALL_PERSONAS, personaLabel, type Persona } from '../../state/personas.ts';
import { loc, type Localizable } from '../../state/text.ts';
import { MAX_USECASE_STEPS, newUseCaseId, type UseCase } from './store.ts';

interface Draft {
  name: string;
  summary: string;
  persona: Persona;
  effect: string;
  steps: { title: string; description: string }[];
}

/** Keep the bilingual original when the user did not change the text shown in the current language. */
function keep(orig: Localizable | undefined, edited: string, lang: 'ja' | 'en'): Localizable {
  if (orig !== undefined && loc(orig, lang) === edited) return orig;
  return edited.trim();
}

/** FR-158: register / edit a use case (name, summary, persona, ordered steps ≤ PARAM-046, optional effect). */
export function UseCaseEditor({ initial, onSave, onCancel, onDelete }: {
  initial: UseCase | null;
  onSave: (uc: UseCase) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t, lang } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: initial ? loc(initial.name, lang) : '',
    summary: initial ? loc(initial.summary, lang) : '',
    persona: initial?.persona ?? 'business',
    effect: initial?.effect ? loc(initial.effect, lang) : '',
    steps: initial ? initial.steps.map((s) => ({ title: loc(s.title, lang), description: loc(s.description, lang) })) : [],
  }));
  const [tried, setTried] = useState(false);
  const nameError = tried && draft.name.trim() === '';
  const stepErrors = draft.steps.map((s) => tried && s.title.trim() === '');
  const full = draft.steps.length >= MAX_USECASE_STEPS;

  const setStep = (i: number, patch: Partial<Draft['steps'][number]>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const move = (i: number, by: -1 | 1) =>
    setDraft((d) => {
      const steps = [...d.steps];
      const j = i + by;
      if (j < 0 || j >= steps.length) return d;
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      return { ...d, steps };
    });
  const focusStep = (i: number) => requestAnimationFrame(() => document.getElementById(`uc-step-title-${i}`)?.focus());

  const save = () => {
    setTried(true);
    if (draft.name.trim() === '' || draft.steps.some((s) => s.title.trim() === '')) return;
    const base = initial?.origin === 'registered' ? initial : null;
    const src = initial;
    onSave({
      id: base?.id ?? newUseCaseId(),
      name: keep(src?.name, draft.name, lang),
      summary: keep(src?.summary, draft.summary, lang),
      persona: draft.persona,
      steps: draft.steps.map((s, i) => ({
        title: keep(src?.steps[i]?.title, s.title, lang),
        description: keep(src?.steps[i]?.description, s.description, lang),
      })),
      effect: draft.effect.trim() === '' ? undefined : keep(src?.effect, draft.effect, lang),
      relatedIds: src?.relatedIds ?? [],
      origin: 'registered',
      updatedAt: new Date().toISOString(),
      derivedFrom: src?.derivedFrom,
    });
  };

  return (
    <form
      className="uc-editor"
      aria-label={t('uc.editor.form')}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Field label={t('uc.field.name')} required validationMessage={nameError ? t('uc.editor.nameRequired') : undefined}>
        <Input id="uc-name" value={draft.name} onChange={(_, d) => setDraft((x) => ({ ...x, name: d.value }))} />
      </Field>
      <Field label={t('uc.field.summary')}>
        <Textarea id="uc-summary" value={draft.summary} resize="vertical" onChange={(_, d) => setDraft((x) => ({ ...x, summary: d.value }))} />
      </Field>
      <Field label={t('uc.field.persona')}>
        <Select id="uc-persona" value={draft.persona} onChange={(_, d) => setDraft((x) => ({ ...x, persona: d.value as Persona }))}>
          {ALL_PERSONAS.map((p) => <option key={p} value={p}>{t(personaLabel(p))}</option>)}
        </Select>
      </Field>

      <fieldset className="uc-steps">
        <legend>{t('uc.field.steps', { n: draft.steps.length, max: MAX_USECASE_STEPS })}</legend>
        {draft.steps.length === 0 && <p className="muted">{t('uc.editor.noSteps')}</p>}
        <ol className="uc-step-list">
          {draft.steps.map((s, i) => (
            <li key={i} className="uc-step-edit">
              <div className="uc-step-head">
                <span className="uc-step-no" aria-hidden>{i + 1}</span>
                <Field className="grow" label={t('uc.field.stepTitle', { n: i + 1 })} required validationMessage={stepErrors[i] ? t('uc.editor.stepTitleRequired') : undefined}>
                  <Input id={`uc-step-title-${i}`} value={s.title} onChange={(_, d) => setStep(i, { title: d.value })} />
                </Field>
              </div>
              <Field label={t('uc.field.stepDescription', { n: i + 1 })}>
                <Textarea id={`uc-step-desc-${i}`} value={s.description} resize="vertical" onChange={(_, d) => setStep(i, { description: d.value })} />
              </Field>
              <div className="toolbar">
                <Button size="small" icon={<ArrowUp16Regular />} disabled={i === 0} onClick={() => move(i, -1)}>{t('uc.editor.up', { n: i + 1 })}</Button>
                <Button size="small" icon={<ArrowDown16Regular />} disabled={i === draft.steps.length - 1} onClick={() => move(i, 1)}>{t('uc.editor.down', { n: i + 1 })}</Button>
                <Button size="small" icon={<Delete16Regular />} onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, k) => k !== i) }))}>{t('uc.editor.removeStep', { n: i + 1 })}</Button>
              </div>
            </li>
          ))}
        </ol>
        <Button
          icon={<Add16Regular />}
          disabled={full}
          onClick={() => {
            setDraft((d) => ({ ...d, steps: [...d.steps, { title: '', description: '' }] }));
            focusStep(draft.steps.length);
          }}
        >
          {t('uc.editor.addStep')}
        </Button>
        {full && <p className="muted" role="status">{t('uc.editor.maxSteps', { max: MAX_USECASE_STEPS })}</p>}
      </fieldset>

      <Field label={t('uc.field.effect')} hint={t('uc.field.effectHint')}>
        <Textarea id="uc-effect" value={draft.effect} resize="vertical" onChange={(_, d) => setDraft((x) => ({ ...x, effect: d.value }))} />
      </Field>
      <div className="toolbar">
        <Button appearance="primary" type="submit">{initial?.origin === 'registered' ? t('uc.editor.save') : t('uc.editor.register')}</Button>
        <Button onClick={onCancel}>{t('uc.editor.cancel')}</Button>
        {onDelete && <Button icon={<Delete16Regular />} onClick={onDelete}>{t('uc.editor.delete')}</Button>}
      </div>
    </form>
  );
}
