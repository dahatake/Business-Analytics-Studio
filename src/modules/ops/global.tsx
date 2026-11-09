import { useEffect } from 'react';
import { fontStack } from './brand.ts';
import { useResolvedBrand } from './theme.ts';

/** Global mounts of the 'ops' module. TopBarSlot renders inside the top bar; Overlay renders once at the app root. */
export function TopBarSlot() {
  return null;
}

/**
 * FR-062 / FR-063: apply the brand font stack (with Fluent fallbacks) and expose the brand tone to the whole app.
 * The colour ramp itself reaches the app through useBrandVariants() (theme.ts).
 */
export function Overlay() {
  const brand = useResolvedBrand();
  useEffect(() => {
    document.documentElement.dataset.brandTone = brand.tone;
  }, [brand.tone]);
  if (!brand.fonts) return null;
  const css = `.fui-FluentProvider { --fontFamilyBase: ${fontStack(brand.fonts)} !important; }`;
  return <style data-ops-brand-font>{css}</style>;
}
