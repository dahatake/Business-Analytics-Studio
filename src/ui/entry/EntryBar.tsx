import { useState } from 'react';
import { Button, Select } from '@fluentui/react-components';
import { Add16Regular, Edit16Regular } from '@fluentui/react-icons';
import { entitiesOf, getEntity } from '../../data/pack.ts';
import { useI18n } from '../../i18n/index.ts';
import { useSettings } from '../../state/settings.ts';
import { usePackVersion } from '../../state/packEdits.ts';
import { isHidden } from '../cardSpecs.ts';
import { EntityEditorDialog } from './EntityEditorDialog.tsx';
import { isEditableKind, type EditableKind } from './entitySpecs.ts';

interface Props {
  /** Kinds that can be added from here. */
  kinds: EditableKind[];
  /** Kinds listed for editing (defaults to `kinds`). */
  editKinds?: EditableKind[];
  /** An entity selected in the view, offered as "edit selected". */
  selectedId?: string | null;
  testId?: string;
}

/** Add / edit toolbar shown above a data view (workspace components). */
export function EntryBar({ kinds, editKinds = kinds, selectedId = null, testId = 'entry-bar' }: Props) {
  const { t, tx } = useI18n();
  const audience = useSettings((s) => s.audience);
  usePackVersion((s) => s.version);
  const [open, setOpen] = useState<{ kind: EditableKind; id: string | null } | null>(null);
  const editable = editKinds.flatMap((k) => entitiesOf(k)).filter((e) => !isHidden(e, audience));
  const selected = selectedId ? getEntity(selectedId) : undefined;

  return (
    <div className="entry-bar" role="group" aria-label={t('entry.toolbar')} data-testid={testId}>
      {kinds.map((k) => (
        <Button key={k} size="small" icon={<Add16Regular />} onClick={() => setOpen({ kind: k, id: null })} data-testid={`entry-add-${k}`}>
          {t('entry.add', { kind: t(`kind.${k}`) })}
        </Button>
      ))}
      {editable.length > 0 && (
        <Select
          size="small"
          aria-label={t('entry.editPick')}
          value=""
          onChange={(_, d) => {
            const e = getEntity(d.value);
            if (e && isEditableKind(e.kind)) setOpen({ kind: e.kind, id: e.id });
          }}
          data-testid="entry-edit-pick"
        >
          <option value="">{t('entry.editPick')}</option>
          {editable.map((e) => <option key={e.id} value={e.id}>{`${t(`kind.${e.kind}`)}: ${tx(e.name)}`}</option>)}
        </Select>
      )}
      {selected && isEditableKind(selected.kind) && !isHidden(selected, audience) && (
        <Button size="small" icon={<Edit16Regular />} onClick={() => setOpen({ kind: selected.kind as EditableKind, id: selected.id })} data-testid="entry-edit-selected">
          {t('entry.editSelected', { name: tx(selected.name) })}
        </Button>
      )}
      <EntityEditorDialog kind={open?.kind ?? null} id={open?.id ?? null} onClose={() => setOpen(null)} />
    </div>
  );
}
