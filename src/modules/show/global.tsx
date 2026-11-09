import { lazy, Suspense } from 'react';
import { Button } from '@fluentui/react-components';
import { SlideText24Regular } from '@fluentui/react-icons';
import { useI18n } from '../../i18n/index.ts';
import { useShowRun } from './store.ts';
import './aiOutline.ts';
import './show.css';

const ShowPlayer = lazy(async () => ({ default: (await import('./ShowPlayer.tsx')).ShowPlayer }));

/** FR-016: start the presentation from any screen. */
export function TopBarSlot() {
  const { t } = useI18n();
  const start = useShowRun((s) => s.start);
  return (
    <Button appearance="subtle" icon={<SlideText24Regular />} onClick={() => start({ kind: 'show' })} data-testid="show-start-topbar">
      {t('show.title')}
    </Button>
  );
}

export function Overlay() {
  const program = useShowRun((s) => s.program);
  if (!program) return null;
  return (
    <Suspense fallback={null}>
      <ShowPlayer key={JSON.stringify(program)} program={program} />
    </Suspense>
  );
}
