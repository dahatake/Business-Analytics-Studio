import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Badge, Button, Caption1, Text } from '@fluentui/react-components';
import { LockClosed16Regular, Open16Regular } from '@fluentui/react-icons';
import { getEntity } from '../data/pack.ts';
import { useI18n } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { hrefFor, navigate } from '../state/router.ts';
import { CARD_ID, cardController, useCardStore } from './cardController.ts';
import { isHidden, routeFor, specFor, type CardContext, type CardField } from './cardSpecs.ts';
import { EntityImage } from './EntityImage.tsx';
import { kindIcon } from './icons.ts';
import type { Entity } from '../data/schema.ts';

const GAP = 8;
const MARGIN = 8;

function place(trigger: Element, card: HTMLElement) {
  const r = trigger.getBoundingClientRect();
  const w = card.offsetWidth;
  const hgt = card.offsetHeight;
  const below = r.bottom + GAP + hgt <= window.innerHeight - MARGIN;
  const top = below ? r.bottom + GAP : Math.max(MARGIN, r.top - GAP - hgt);
  const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - w - MARGIN));
  return { top, left, placement: below ? 'below' : 'above' };
}

/** The single detail card for the whole app (F-3.2.1). Content: WCAG 1.4.13 dismissible / hoverable / persistent. */
export function DetailCardHost() {
  const open = useCardStore((s) => s.open);
  const { t, tx, fmt } = useI18n();
  const audience = useSettings((s) => s.audience);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: string } | null>(null);

  useLayoutEffect(() => {
    if (!open || !cardRef.current) {
      setPos(null);
      return;
    }
    const update = () => {
      if (!open.trigger.isConnected) {
        cardController.closeNow();
        return;
      }
      if (cardRef.current) setPos(place(open.trigger, cardRef.current));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, audience]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cardController.closeNow();
        if (open.trigger instanceof HTMLElement || open.trigger instanceof SVGElement) {
          if (cardRef.current?.contains(document.activeElement)) (open.trigger as HTMLElement).focus();
        }
      }
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (cardRef.current?.contains(target) || open.trigger.contains(target)) return;
      cardController.closeNow();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  if (!open) return null;
  const entity = getEntity(open.entityId);
  if (!entity) return null;
  const restricted = isHidden(entity, audience);
  const route = restricted ? null : routeFor(entity);
  const spec = specFor(entity.kind);
  const fields = (spec.fields as CardField[]).filter((f) => !(f.internal && audience === 'external'));
  const hiddenCount = spec.fields.length - fields.length;
  const KindIcon = kindIcon[entity.kind];
  const titleId = `${CARD_ID}-title`;

  return (
    <div
      id={CARD_ID}
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="detail-card"
      data-entity-id={entity.id}
      data-via={open.via}
      data-placement={pos?.placement ?? 'below'}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onPointerEnter={() => cardController.keepOpen()}
      onPointerLeave={(e) => { if (open.via === 'hover' && e.pointerType !== 'touch') cardController.scheduleClose(); }}
    >
      {restricted ? (
        <div className="detail-card-restricted">
          <LockClosed16Regular aria-hidden />
          <Text weight="semibold" id={titleId}>{t('card.restrictedName')}</Text>
          <Caption1>{t('card.restrictedBody')}</Caption1>
        </div>
      ) : (
        <CardBody entity={entity} titleId={titleId} fields={fields} hiddenCount={hiddenCount} KindIcon={KindIcon} ctx={{ t, tx, fmt }} />
      )}
      <div className="detail-card-footer">
        <Caption1 className="detail-card-hint">{route ? t('card.hintLink') : t('card.hintNoLink')}</Caption1>
        {route && (
          <Button
            size="small"
            appearance="primary"
            icon={<Open16Regular />}
            onClick={() => {
              cardController.closeNow();
              navigate(hrefFor(route));
            }}
          >
            {t('card.open')}
          </Button>
        )}
      </div>
    </div>
  );
}

function CardBody({ entity, titleId, fields, hiddenCount, KindIcon, ctx }: {
  entity: Entity;
  titleId: string;
  fields: CardField[];
  hiddenCount: number;
  KindIcon: (typeof kindIcon)[keyof typeof kindIcon];
  ctx: CardContext;
}) {
  const { t, tx } = ctx;
  return (
    <>
      <div className="detail-card-header">
        <EntityImage entity={entity} size={56} />
        <div className="detail-card-title">
          <span className="detail-card-kind"><KindIcon aria-hidden /> {t(`kind.${entity.kind}`)}</span>
          <Text weight="semibold" size={400} id={titleId}>{tx(entity.name)}</Text>
          <div className="detail-card-badges">
            {entity.author === 'sample' && <Badge size="small" appearance="tint" color="informative">{t('badge.sample')}</Badge>}
            {entity.classification === 'internal' && <Badge size="small" appearance="tint" color="warning" icon={<LockClosed16Regular />}>{t('badge.internal')}</Badge>}
          </div>
        </div>
      </div>
      <p className="detail-card-desc">{tx(entity.description)}</p>
      <dl className="detail-card-fields">
        {fields.map((f) => (
          <div key={f.label} className="detail-card-field">
            <dt>{t(f.label)}</dt>
            <dd>{f.value(entity as never, ctx)}</dd>
          </div>
        ))}
      </dl>
      {hiddenCount > 0 && (
        <Caption1 className="detail-card-hidden-note"><LockClosed16Regular aria-hidden /> {t('card.fieldsHidden', { count: hiddenCount })}</Caption1>
      )}
    </>
  );
}


