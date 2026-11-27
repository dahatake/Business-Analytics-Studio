import { Button } from '@fluentui/react-components';
import { Edit16Regular } from '@fluentui/react-icons';
import type { Entity } from '../../data/schema.ts';
import { useI18n } from '../../i18n/index.ts';
import { hrefFor } from '../../state/router.ts';
import { cardController } from '../cardController.ts';
import { isEditableKind } from './entitySpecs.ts';

export function EntityEditLink({ entity }: { entity: Entity }) {
  const { t, tx } = useI18n();
  if (!isEditableKind(entity.kind)) return null;

  return (
    <Button
      as="a"
      href={hrefFor('/relations', { edit: entity.id })}
      size="small"
      appearance="secondary"
      icon={<Edit16Regular />}
      data-testid={`entity-edit-${entity.id}`}
      onClick={() => cardController.closeNow()}
    >
      {t('entry.editItem', { name: tx(entity.name) })}
    </Button>
  );
}
