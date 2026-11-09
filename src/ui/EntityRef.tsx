import { useRef } from 'react';
import { LockClosed16Regular } from '@fluentui/react-icons';
import { getEntity } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor } from '../state/router.ts';
import { sound } from '../audio/sound.ts';
import { CARD_ID, cardController, triggerHandlers, useCardStore } from './cardController.ts';
import { isHidden, routeFor } from './cardSpecs.ts';
import { kindIcon } from './icons.ts';
import { EntityImage } from './EntityImage.tsx';

export interface EntityRefProps {
  id: string;
  /** Show the portrait/illustration instead of the kind icon. */
  image?: boolean;
  imageSize?: number;
  /** Extra query to carry to the destination (e.g. where we came from). */
  className?: string;
}

/**
 * A read-only reference to an entity (F-3.2.1 / F-3.2.3):
 * - hover (after a delay), keyboard focus, or touch tap opens the detail card;
 * - click / Enter drills through when a related screen exists; otherwise it is a plain button, not a link;
 * - `internal` entities are masked for an external audience and never link anywhere.
 */
export function EntityRef({ id, image = false, imageSize = 24, className }: EntityRefProps) {
  const { t, tx } = useI18n();
  const audience = useSettings((s) => s.audience);
  const ref = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const expanded = useCardStore((s) => s.open !== null && s.open.trigger === ref.current);
  const entity = getEntity(id);
  if (!entity) return <span className="ref-missing">—</span>;

  if (isHidden(entity, audience)) {
    return (
      <span className={`ref ref-restricted ${className ?? ''}`} data-entity-ref={id} data-restricted="true">
        <LockClosed16Regular aria-hidden />
        <span>{t('card.restrictedName')}</span>
      </span>
    );
  }

  const h = triggerHandlers(id);
  const Icon = kindIcon[entity.kind];
  const content = (
    <>
      {image ? <EntityImage entity={entity} size={imageSize} /> : <Icon aria-hidden className="ref-icon" />}
      <span className="ref-text">{tx(entity.name)}</span>
    </>
  );
  const common = {
    ref,
    className: `ref ${className ?? ''}`,
    'data-entity-ref': id,
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': expanded,
    ...(expanded ? { 'aria-controls': CARD_ID } : {}),
    onPointerEnter: h.onPointerEnter,
    onPointerLeave: h.onPointerLeave,
    onPointerDown: h.onPointerDown,
    onFocus: h.onFocus,
    onBlur: h.onBlur,
    onKeyDown: h.onKeyDown,
  };

  const route = routeFor(entity);
  if (route) {
    return (
      <a
        {...common}
        href={hrefFor(route)}
        className={`${common.className} ref-link`}
        onClick={(e) => {
          if (h.onClick(e)) return;
          cardController.closeNow();
          sound.play('tap');
        }}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      {...common}
      type="button"
      className={`${common.className} ref-plain`}
      onClick={(e) => {
        if (h.onClick(e)) return;
        if (cardController.isOpenFor(e.currentTarget)) cardController.closeNow();
        else cardController.openNow(id, e.currentTarget, 'touch');
      }}
    >
      {content}
    </button>
  );
}
