import { useEffect, useRef } from 'react';
import { attachCardTrigger } from './cardController.ts';

/** An SVG <g> that behaves like EntityRef: card on hover/focus/touch, `onActivate` on click/Enter/Space. */
export function SvgEntityNode({ id, onActivate, label, className, transform, children, selected, role = 'button' }: {
  id: string;
  onActivate: () => void;
  label: string;
  className?: string;
  transform?: string;
  selected?: boolean;
  /** 'button' = selects (aria-pressed), 'link' = drills through. */
  role?: 'button' | 'link';
  children: React.ReactNode;
}) {
  const ref = useRef<SVGGElement>(null);
  const activate = useRef(onActivate);
  activate.current = onActivate;
  useEffect(() => {
    if (!ref.current) return;
    return attachCardTrigger(ref.current, id, () => activate.current());
  }, [id]);
  return (
    <g
      ref={ref}
      tabIndex={0}
      role={role}
      aria-label={label}
      aria-pressed={role === 'button' ? (selected ?? false) : undefined}
      className={`svg-node ${className ?? ''}`}
      transform={transform}
      data-entity-ref={id}
    >
      {children}
    </g>
  );
}

