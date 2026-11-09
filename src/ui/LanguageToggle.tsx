import { useI18n, type Lang } from '../i18n/index.ts';
import { useSettings } from '../state/settings.ts';
import { sound } from '../audio/sound.ts';

export function LanguageToggle() {
  const { t, lang } = useI18n();
  const setLang = useSettings((s) => s.setLang);
  const options: { value: Lang; label: string }[] = [
    { value: 'ja', label: '日本語' },
    { value: 'en', label: 'English' },
  ];
  return (
    <div role="group" aria-label={t('lang.label')} className="lang-toggle" data-testid="lang-toggle">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          className="lang-option"
          aria-pressed={lang === o.value}
          onClick={() => {
            setLang(o.value);
            sound.play('toggle');
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
