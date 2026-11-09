import type { Entity } from '../data/schema.ts';
import { Portrait } from './art/Portrait.tsx';
import { CustomerArt, ProductArt } from './art/Illustrations.tsx';
import { kindColor, kindIcon } from './icons.ts';

export function hasIllustration(e: Entity): boolean {
  return e.kind === 'person' || e.kind === 'customer' || e.kind === 'product';
}

/** Portrait / illustration for people, customers and products; a kind icon badge for everything else. */
export function EntityImage({ entity, size = 32, label }: { entity: Entity; size?: number; label?: string }) {
  switch (entity.kind) {
    case 'person':
      return <Portrait spec={entity.portrait} ageBand={entity.ageBand} gender={entity.gender} size={size} {...(label ? { label } : {})} />;
    case 'customer':
      return <CustomerArt spec={entity.illustration} size={size} {...(label ? { label } : {})} />;
    case 'product':
      return <ProductArt spec={entity.illustration} size={size} {...(label ? { label } : {})} />;
    default: {
      const Icon = kindIcon[entity.kind];
      return (
        <span className="kind-badge" style={{ width: size, height: size, ['--kind' as string]: kindColor[entity.kind] }} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
          <Icon fontSize={Math.round(size * 0.55)} />
        </span>
      );
    }
  }
}
