import { Button, Tooltip } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { CommandPalette, usePalette } from './palette.tsx';
import './workspace.css';

/** Opens the command palette (FR-111); the same as Ctrl+K / Cmd+K. */
export function TopBarSlot() {
  const { t } = useI18n();
  const setOpen = usePalette((s) => s.setOpen);
  return (
    <Tooltip content={t('ws.cmd.shortcut')} relationship="description">
      <Button appearance="subtle" icon={<Search20Regular />} onClick={() => setOpen(true)} data-testid="ws-palette-open">
        {t('ws.cmd.open')}
      </Button>
    </Tooltip>
  );
}

export function Overlay() {
  return <CommandPalette />;
}
