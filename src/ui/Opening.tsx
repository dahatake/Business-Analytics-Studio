import { useEffect, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { PARAMS } from '../config/params.ts';
import { useI18n } from '../i18n/index.ts';
import { useReducedMotion } from '../state/motion.ts';
import { loaded } from '../data/pack.ts';
import { sound } from '../audio/sound.ts';

export const OPENING_SEEN_KEY = 'bas.openingSeen';

/** F-3.1.5 cinematic opening: letterbox, title reveal, light sweep. Skippable; never shown under reduced motion. */
export function Opening() {
  const { t, tx } = useI18n();
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(() => sessionStorage.getItem(OPENING_SEEN_KEY) !== '1');

  const close = () => {
    sessionStorage.setItem(OPENING_SEEN_KEY, '1');
    setVisible(false);
  };

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
  }, [visible, reduced]);

  if (!visible || reduced) return null;
  return (
    <div className="opening" role="dialog" aria-modal="true" aria-label={t('opening.label')} data-testid="opening">
      <div className="opening-bar top" />
      <div className="opening-stage">
        <span className="opening-mark" aria-hidden />
        <p className="opening-kicker">{tx(loaded.pack.company.name)}</p>
        <h1 className="opening-title">{t('app.title')}</h1>
        <p className="opening-tagline">{t('opening.tagline')}</p>
        <span className="opening-sweep" aria-hidden />
      </div>
      <div className="opening-bar bottom" />
      <Button className="opening-skip" appearance="secondary" onClick={close} autoFocus>{t('opening.skip')}</Button>
    </div>
  );
}
