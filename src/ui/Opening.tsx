import { useEffect } from 'react';
import { Button } from '@fluentui/react-components';
import { PARAMS } from '../config/params.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion } from '../state/motion.ts';
import { useLaunch } from '../state/launch.ts';
import { sound } from '../audio/sound.ts';

export { OPENING_SEEN_KEY } from '../state/launch.ts';

/**
 * F-3.1.5 / FR-076 cinematic opening: letterbox, title reveal, light sweep. Shows the application name only
 * (no customer or project name). Skippable; never shown under reduced motion. Step 1 of the start-up sequence.
 */
export function Opening() {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const visible = useLaunch((s) => s.stage === 'opening');
  const close = useLaunch((s) => s.finishOpening);

  useEffect(() => {
    if (!visible) return;
    if (reduced) {
      close();
      return;
    }
    sound.play('open');
    const id = window.setTimeout(close, PARAMS.openingDurationMs);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('keydown', onKey);
    };
  }, [visible, reduced, close]);

  if (!visible || reduced) return null;
  return (
    <div className="opening" role="dialog" aria-modal="true" aria-label={t('opening.label')} data-testid="opening">
      <div className="opening-bar top" />
      <div className="opening-stage">
        <span className="opening-mark" aria-hidden />
        <h1 className="opening-title">{t('app.title')}</h1>
        <p className="opening-tagline">{t('opening.tagline')}</p>
        <span className="opening-sweep" aria-hidden />
      </div>
      <div className="opening-bar bottom" />
      <Button className="opening-skip" appearance="secondary" onClick={close} autoFocus>{t('opening.skip')}</Button>
    </div>
  );
}
