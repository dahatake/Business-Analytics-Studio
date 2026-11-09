import { useEffect, useRef } from 'react';
import { attachCardTrigger, cardController, useCardStore } from '../../ui/cardController.ts';
import type { SceneNode } from './scene.ts';

/** Toggle the shared entity card from a click/Enter: open (pinned) on first activation, close on the next (FR-247). */
export function toggleEntityCard(el: Element, entityId: string) {
  const open = useCardStore.getState().open;
  if (open?.trigger === el && open.via === 'touch') cardController.closeNow();
  else cardController.openNow(entityId, el, 'touch');
}

/** An SVG node: entity nodes reuse the shared detail card (attachCardTrigger); others call `onToggle` for the module card. */
export function GraphNodeEl({ node, transform, tabIndex, className, onToggle, onSelect, onFocusItem, children }: {
  node: SceneNode;
  transform: string;
  tabIndex: number;
  className: string;
  onToggle: (el: Element) => void;
  onSelect: (id: string) => void;
  onFocusItem: (id: string) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<SVGGElement>(null);
  const cb = useRef({ onToggle, onSelect });
  cb.current = { onToggle, onSelect };
  const entityId = node.entityId;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (entityId) {
      return attachCardTrigger(el, entityId, () => {
        toggleEntityCard(el, entityId);
        cb.current.onSelect(entityId);
      });
    }
    const click = () => cb.current.onToggle(el);
    const key = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ' ') {
        ke.preventDefault();
        cb.current.onToggle(el);
      }
    };
    el.addEventListener('click', click);
    el.addEventListener('keydown', key);
    el.setAttribute('aria-haspopup', 'dialog');
    return () => {
      el.removeEventListener('click', click);
      el.removeEventListener('keydown', key);
    };
  }, [entityId]);
  return (
    <g
      ref={ref}
      role="button"
      tabIndex={tabIndex}
      aria-label={node.aria}
      className={className}
      transform={transform}
      data-node-id={node.id}
      data-entity-ref={entityId}
      onFocus={() => onFocusItem(node.id)}
    >
      {children}
    </g>
  );
}
