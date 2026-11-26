import { Suspense, lazy } from 'react';
import { Spinner, Tab, TabList } from '@fluentui/react-components';
import { Settings20Regular, KeyMultiple20Regular } from '@fluentui/react-icons';
import { useI18n } from '../i18n/index.ts';
import { AiSettingsContent } from '../modules/ai/AiSettingsPanel.tsx';
import { setSettingsTab, useSettingsDialog, type SettingsTab } from '../modules/ai/uiStore.ts';

const SettingsGeneral = lazy(() => import('./SettingsGeneral.tsx').then((m) => ({ default: m.SettingsGeneral })));

/** D-25: general settings and AI settings in one place, as vertical tabs (一般 / AI 設定). */
export function SettingsTabs() {
  const { t } = useI18n();
  const tab = useSettingsDialog((s) => s.tab);
  return (
    <div className="settings-tabs" data-testid="settings-tabs">
      <TabList
        vertical
        className="settings-tablist"
        selectedValue={tab}
        onTabSelect={(_, d) => setSettingsTab(d.value as SettingsTab)}
        aria-label={t('settings.tab.label')}
      >
        <Tab value="general" icon={<Settings20Regular />} data-testid="settings-tab-general">{t('settings.tab.general')}</Tab>
        <Tab value="ai" icon={<KeyMultiple20Regular />} data-testid="settings-tab-ai">{t('ai.nav.settings')}</Tab>
      </TabList>
      <div className="settings-tabpanel" role="tabpanel" data-testid={`settings-panel-${tab}`}>
        {tab === 'ai' ? (
          <div className="ai-settings-body ai-stack">
            <p className="muted">{t('ai.settings.subtitle')}</p>
            <AiSettingsContent />
          </div>
        ) : (
          <Suspense fallback={<Spinner label={t('app.loading')} />}><SettingsGeneral /></Suspense>
        )}
      </div>
    </div>
  );
}
