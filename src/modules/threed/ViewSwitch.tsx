import { useId } from 'react';
import { Radio, RadioGroup } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';

export type ViewMode = '2d' | '3d';

/**
 * FR-217: the shared 2D/3D switch. The selection lives outside (URL), so switching keeps it.
 * When 3D is unavailable (FR-065) the 3D option is disabled and the reason is referenced.
 */
export function ViewSwitch({ mode, onChange, disabled3d, reasonId }: { mode: ViewMode; onChange: (m: ViewMode) => void; disabled3d?: boolean; reasonId?: string }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="td-viewswitch">
      <span id={id} className="td-control-label">{t('td.view.label')}</span>
      <RadioGroup layout="horizontal" value={mode} aria-labelledby={id} aria-describedby={disabled3d ? reasonId : undefined}
        onChange={(_, d) => onChange(d.value === '3d' ? '3d' : '2d')} data-testid="td-viewswitch">
        <Radio value="3d" label={t('td.view.3d')} disabled={disabled3d} />
        <Radio value="2d" label={t('td.view.2d')} />
      </RadioGroup>
    </div>
  );
}
