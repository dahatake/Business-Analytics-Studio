import { useEffect, useRef } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowLeft20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n/index.ts';
import { setPortalReturn, usePortalReturn } from '../state/portalReturn.ts';
import { useRoute } from '../state/router.ts';

/**
 * FR-347: after leaving the strategy map through one of its items, a link back to that item stays in the sticky header
 * (counted in --chrome-h, so it never covers a focused target). Arriving back at the map's screen clears it.
 */
export function PortalReturnBar() {
  const { t } = useI18n();
  const route = useRoute();
  const value = usePortalReturn((s) => s.value);
  const previous = useRef(route.path);
  useEffect(() => {
    // The click that records the return happens on the map's own screen; clear only on a later arrival there.
    if (value && route.path === value.path && previous.current !== value.path) setPortalReturn(null);
    previous.current = route.path;
  }, [route.path, value]);
  if (!value || route.path === value.path) return null;
  return (
    <nav className="portal-return" aria-label={t('stg.portal.back')} data-testid="portal-return">
      <Button as="a" href={value.href} appearance="primary" size="small" icon={<ArrowLeft20Regular />} data-testid="portal-return-link">
        {t('stg.portal.backTo', { item: value.label })}
      </Button>
      <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} aria-label={t('stg.portal.dismiss')} onClick={() => setPortalReturn(null)} data-testid="portal-return-dismiss" />
    </nav>
  );
}
