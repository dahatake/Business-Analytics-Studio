import { useMemo, useState, type ReactElement } from 'react';
import { Badge, Button, Field, Input, Select } from '@fluentui/react-components';
import {
  Checkmark20Regular, Dismiss20Regular, DocumentCheckmark20Regular, Edit20Regular, PersonEdit20Regular, QuestionCircle20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { loaded } from '../../data/pack.ts';
import { useI18n, type MessageKey } from '../../i18n/index.ts';
import { commitPackChanges } from '../../state/packEdits.ts';
import { currentScope } from '../../state/projects.ts';
import { useSettings } from '../../state/settings.ts';
import { loc } from '../../state/text.ts';
import { isHidden } from '../../ui/cardSpecs.ts';
import { EntityRef } from '../../ui/EntityRef.tsx';
import { Panel } from '../../ui/Panel.tsx';
import { mergeFills, reviewFill, type FillProposal, type FillReview, type FillValue } from './dataFill.ts';
import {
  activeFill, FILL_VALUE_TYPE, normalizeDeliverables, type CheckContext, type FillBasis, type FillField, type FillRecord, type FillStatus, type FillValueType,
} from './deliverables.ts';
import { useDeliverables, useProjUi } from './stores.ts';

const BASIS_ICON: Record<FillBasis, ReactElement> = {
  evidence: <DocumentCheckmark20Regular />,
  estimate: <Sparkle20Regular />,
  unacquired: <QuestionCircle20Regular />,
  human: <PersonEdit20Regular />,
};
const BASIS_COLOR: Record<FillBasis, 'success' | 'warning' | 'danger' | 'brand'> = { evidence: 'success', estimate: 'warning', unacquired: 'danger', human: 'brand' };
const STATUS_COLOR: Record<FillStatus, 'informative' | 'success' | 'subtle'> = { pending: 'informative', approved: 'success', rejected: 'subtle' };

/** The label of one filled value: how it was obtained (icon + text, never colour alone). */
export function FillBasisBadge({ basis }: { basis: FillBasis }) {
  const { t } = useI18n();
  return <Badge appearance="tint" color={BASIS_COLOR[basis]} icon={BASIS_ICON[basis]} data-testid="dlv-fill-basis">{t(`dlv.fill.basis.${basis}` as MessageKey)}</Badge>;
}

function useValueText() {
  const { t, fmt, lang } = useI18n();
  return (field: FillField, value: FillValue | undefined) => {
    if (value === undefined) return t('dlv.fill.noValue');
    if (typeof value === 'object') return loc(value, lang);
    const type = FILL_VALUE_TYPE[field];
    if (type === 'site') {
      const site = loaded.byId.get(String(value));
      return site ? loc(site.name, lang) : String(value);
    }
    const n = Number(value);
    if (type === 'yen') return fmt.yen(n);
    if (type === 'tonnes') return t('dlv.fill.unit.tonnes', { n: fmt.number(n) });
    return t('dlv.fill.unit.degrees', { n: n.toFixed(4) });
  };
}

type FillLike = Pick<FillProposal, 'entityId' | 'field' | 'value' | 'note' | 'quote' | 'sourceIds'> & { basis: FillBasis; downgraded?: boolean };

/** What was filled, with the value, the reason and the cited text: everything a reviewer needs for one item. */
function FillDetails({ item }: { item: FillLike }) {
  const { t, lang } = useI18n();
  const valueText = useValueText();
  const sources = item.sourceIds.map((id) => loaded.byId.get(id)).filter((s) => s?.kind === 'source').map((s) => loc(s!.name, lang));
  return (
    <>
      <div className="dlv-fill-head">
        <EntityRef id={item.entityId} />
        <span className="muted">{t(`dlv.fill.field.${item.field}` as MessageKey)}</span>
        <FillBasisBadge basis={item.basis} />
      </div>
      <p className="dlv-fill-value" data-testid="dlv-fill-value">{valueText(item.field, item.value)}</p>
      <p className="dlv-fill-note">{loc(item.note, lang)}</p>
      {item.downgraded && <p className="muted" data-testid="dlv-fill-downgraded">{t('dlv.fill.downgraded')}</p>}
      {item.quote && <p className="muted">{t('dlv.fill.quote', { quote: item.quote })}</p>}
      {sources.length > 0 && <p className="muted">{t('dlv.fill.sources', { names: sources.join(lang === 'ja' ? '、' : ', ') })}</p>}
    </>
  );
}

/** The proposals shown in the draft dialog before they are applied. */
export function FillProposalList({ proposals }: { proposals: FillProposal[] }) {
  const { t } = useI18n();
  return (
    <section data-testid="dlv-fill-proposals" aria-label={t('dlv.fill.heading', { n: proposals.length })}>
      <h3>{t('dlv.fill.heading', { n: proposals.length })}</h3>
      <ul className="dlv-fill-list">
        {proposals.map((p) => (
          <li key={p.gapId} className="dlv-fill-item" data-testid={`dlv-fill-proposal-${p.entityId}-${p.field}`} data-basis={p.basis}>
            <FillDetails item={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const HINT: Record<FillValueType, MessageKey | undefined> = {
  yen: 'dlv.fill.yenHint', tonnes: 'dlv.fill.tonnesHint', lat: 'dlv.fill.latHint', lon: 'dlv.fill.lonHint', role: undefined, site: undefined,
};

function FillEditor({ field, onSave, onCancel }: { field: FillField; onSave: (value: string) => void; onCancel: () => void }) {
  const { t, lang } = useI18n();
  const audience = useSettings((s) => s.audience);
  const [text, setText] = useState('');
  const type = FILL_VALUE_TYPE[field];
  const label = t('dlv.fill.valueLabel', { field: t(`dlv.fill.field.${field}` as MessageKey) });
  const hint = HINT[type];
  const sites = type === 'site' ? loaded.pack.entities.filter((e) => e.kind === 'site' && !isHidden(e, audience)) : [];
  return (
    <div className="dlv-fill-editor">
      <Field label={label} hint={hint ? t(hint) : undefined}>
        {type === 'site'
          ? (
            <Select value={text} onChange={(_, d) => setText(d.value)} data-testid="dlv-fill-input">
              <option value="">{t('dlv.fill.chooseSite')}</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{loc(s.name, lang)}</option>)}
            </Select>
          )
          : <Input value={text} onChange={(_, d) => setText(d.value)} inputMode={type === 'role' ? 'text' : 'decimal'} data-testid="dlv-fill-input" />}
      </Field>
      <Button appearance="primary" size="small" disabled={!text.trim()} onClick={() => onSave(text)} data-testid="dlv-fill-save">{t('dlv.fill.save')}</Button>
      <Button size="small" onClick={onCancel}>{t('dlv.fill.cancel')}</Button>
    </div>
  );
}

/** Review of missing data: one row per filled field with its label and state; approve, reject (empty again) or enter a value. */
export function DataFillPanel({ ctx }: { ctx: CheckContext }) {
  const { t, fmt } = useI18n();
  const stamp = (iso: string) => `${fmt.date(iso.slice(0, 10))} ${fmt.time(new Date(iso))}`;
  const audience = useSettings((s) => s.audience);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => Object.entries(ctx.deliverables.fills ?? {}).flatMap(([key, record]) => {
    const entity = ctx.pack.byId.get(record.entityId);
    if (!entity || isHidden(entity, audience)) return [];
    return [{ key, record, active: activeFill(ctx.deliverables, entity, record.field) === record }];
  }), [ctx, audience]);
  if (!rows.length) return null;
  const count = (basis: FillBasis) => rows.filter((r) => r.record.basis === basis && r.record.status !== 'rejected').length;

  const review = async (key: string, action: FillReview) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const live = { ...ctx, pack: loaded, deliverables: normalizeDeliverables(useDeliverables.getState().value) };
      const r = reviewFill(live, key, action, useProjUi.getState().editor.trim(), new Date().toISOString());
      if (r.change) await commitPackChanges([r.change], currentScope(), live.pack);
      const record = r.data.fills?.[key];
      if (record) useDeliverables.getState().set((v) => mergeFills(normalizeDeliverables(v), { [key]: record }));
      setEditing(null);
    } catch (value) {
      setError(t('dlv.fill.reviewFailed', { detail: value instanceof Error ? value.message : String(value) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('dlv.fill.panel')} testId="dlv-fill-panel" className="span-full">
      <p className="muted">{t('dlv.fill.panelIntro')}</p>
      <p data-testid="dlv-fill-summary">{t('dlv.fill.summary', {
        evidence: count('evidence'), estimate: count('estimate'), unacquired: count('unacquired'), human: count('human'),
        pending: rows.filter((r) => r.active && r.record.status === 'pending').length,
      })}</p>
      {error && <p role="alert" data-testid="dlv-fill-error">{error}</p>}
      <ul className="dlv-fill-list">
        {rows.map(({ key, record, active }) => (
          <FillRow key={key} id={key} record={record} active={active} busy={busy} editing={editing === key}
            onEdit={() => setEditing(key)} onCancel={() => setEditing(null)} onReview={(a) => void review(key, a)} at={stamp(record.reviewed?.at ?? record.at)} />
        ))}
      </ul>
    </Panel>
  );
}

function FillRow({ id, record, active, busy, editing, onEdit, onCancel, onReview, at }: {
  id: string; record: FillRecord; active: boolean; busy: boolean; editing: boolean; at: string;
  onEdit: () => void; onCancel: () => void; onReview: (action: FillReview) => void;
}) {
  const { t } = useI18n();
  const rejected = record.status === 'rejected';
  return (
    <li className="dlv-fill-item" data-testid={`dlv-fill-${record.entityId}-${record.field}`} data-key={id} data-basis={record.basis} data-status={record.status} data-active={active}>
      <FillDetails item={record} />
      <Badge size="small" appearance="outline" color={STATUS_COLOR[record.status]} data-testid="dlv-fill-status">{t(`dlv.fill.status.${record.status}` as MessageKey)}</Badge>
      {record.reviewed && <span className="muted"> {t('dlv.fill.reviewed', { by: record.reviewed.by || '—', at })}</span>}
      {!active && !rejected && <p className="muted" data-testid="dlv-fill-stale">{t('dlv.fill.stale')}</p>}
      {active && !editing && (
        <div className="dlv-fill-actions">
          {record.status === 'pending' && record.value !== undefined && (
            <Button size="small" icon={<Checkmark20Regular />} disabled={busy} onClick={() => onReview({ kind: 'approve' })} data-testid="dlv-fill-approve">{t('dlv.fill.approve')}</Button>
          )}
          {record.status === 'pending' && (
            <Button size="small" icon={<Dismiss20Regular />} disabled={busy} onClick={() => onReview({ kind: 'reject' })} data-testid="dlv-fill-reject">{t('dlv.fill.reject')}</Button>
          )}
          <Button size="small" icon={<Edit20Regular />} disabled={busy} onClick={onEdit} data-testid="dlv-fill-edit">{t('dlv.fill.edit')}</Button>
        </div>
      )}
      {rejected && !editing && (
        <div className="dlv-fill-actions">
          <Button size="small" icon={<Edit20Regular />} disabled={busy} onClick={onEdit} data-testid="dlv-fill-edit">{t('dlv.fill.edit')}</Button>
        </div>
      )}
      {editing && <FillEditor field={record.field} onSave={(value) => onReview({ kind: 'set', value })} onCancel={onCancel} />}
    </li>
  );
}
