import { lazy, Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import { MessageBar, MessageBarBody, Spinner } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import { replaceQuery, useRoute } from '../../state/router.ts';
import type { TabKey } from './model.ts';
import { ViewSwitch } from './ViewSwitch.tsx';

const ThreeDScreen = lazy(() => import('./ThreeDScreen.tsx').then((m) => ({ default: m.ThreeDScreen })));
export type UnavailableReason = 'webglUnavailable' | 'engineFailed';

/** Native 2D content stays mounted; the 3D engine is loaded only when requested. */
export function ContextualScene({ tab, children }: { tab: TabKey; children?: ReactNode }) {
  const { t } = useI18n();
  const route = useRoute();
  const reasonId = useId();
  const [unavailable, setUnavailable] = useState<UnavailableReason | null>(null);
  const mode = !unavailable && route.query.get('mode') === '3d' ? '3d' : '2d';
  const [opened3d, setOpened3d] = useState(mode === '3d');
  useEffect(() => {
    if (mode === '3d') setOpened3d(true);
  }, [mode]);
  return (
    <div className="span-full contextual-scene">
      <ViewSwitch mode={mode} onChange={(value) => replaceQuery({ mode: value })} disabled3d={!!unavailable} reasonId={reasonId} />
      {unavailable && (
        <MessageBar intent="warning">
          <MessageBarBody id={reasonId}>{t(`td.${unavailable}`)}</MessageBarBody>
        </MessageBar>
      )}
      {children && <div hidden={mode !== '2d'}>{children}</div>}
      {(!children || opened3d || mode === '3d') && (
        <div hidden={!!children && mode === '2d'}>
          <Suspense fallback={<Spinner label={t('app.loading')} />}>
            <ThreeDScreen fixedTab={tab} embedded onUnavailable={setUnavailable} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
