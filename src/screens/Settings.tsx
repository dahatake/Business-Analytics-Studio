import { useI18n } from '../i18n/index.ts';
import { PageHeader } from '../ui/Panel.tsx';
import { SettingsTabs } from './SettingsTabs.tsx';

export function SettingsScreen() {
  const { t } = useI18n();
  return (
    <div className="screen screen-settings">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <SettingsTabs />
    </div>
  );
}
