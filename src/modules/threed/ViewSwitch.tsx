import { useId } from 'react';
import { Radio, RadioGroup } from '@fluentui/react-components';
import { useI18n } from '../../i18n/index.ts';
import './viewSwitch.css';

export type ViewMode = '2d' | '3d';
type ViewFormat = ViewMode | 'graph';

/**
 * FR-217: the shared 2D/3D switch. The selection lives outside (URL), so switching keeps it.
 * When 3D is unavailable (FR-065) the 3D option is disabled and the reason is referenced.
 */
export function ViewSwitch({ mode, onChange, disabled3d, reasonId, includeGraph, testId = 'td-viewswitch' }: {
  mode: ViewFormat;
  onChange: (m: ViewFormat) => void;
  disabled3d?: boolean;
  reasonId?: string;
  includeGraph?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="view-switch">
      <span id={id} className="view-switch-label">{t('graph.format')}</span>
      <RadioGroup className="view-switch-options" layout="horizontal" value={mode} aria-labelledby={id} aria-describedby={disabled3d ? reasonId : undefined}
        onChange={(_, d) => {
          if (d.value === '2d' || d.value === '3d' || (includeGraph && d.value === 'graph')) onChange(d.value);
        }} data-testid={testId}>
        <Radio value="2d" label={t('td.view.2d')} />
        <Radio value="3d" label={t('td.view.3d')} disabled={disabled3d} />
        {includeGraph && <Radio value="graph" label={t('graph.format.graph')} />}
      </RadioGroup>
    </div>
  );
}
